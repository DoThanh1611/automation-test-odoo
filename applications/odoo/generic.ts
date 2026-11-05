import type { AdapterManifest, AdapterModel } from '../../core/adapters/manifest';
import type { DataPlan, Recipe } from '../../core/testdata/factory';
import type { OdooRpc } from './factory';
import { modelMeta, type FieldMeta, type ModelMeta } from './introspect';

/**
 * Test Data Factory TỰ THÍCH ỨNG cho mọi model Odoo: công thức sinh từ cấu trúc model thực tế (fields_get) và adapter, không từ mã cố định.
 *  - Trường bắt buộc: lấy mặc định của Odoo (default_get), phần còn lại điền giá trị AUTOTEST theo kiểu.
 *  - Trường many2one bắt buộc: bản ghi tham chiếu cấu hình (công ty, tiền tệ, đơn vị tính, kho...) được CHỌN (chỉ đọc);
 *    mọi quan hệ khác được TẠO MỚI bằng công thức chung (đệ quy có giới hạn độ sâu) và đăng ký registry. Không dùng bản ghi có sẵn chỉ vì trùng tên.
 *  - Không tự dựng được dữ liệu hợp lệ (one2many bắt buộc, quan hệ vòng, không có bản ghi tham chiếu) ⇒ UnresolvedData ⇒ test BLOCKED kèm nguyên nhân.
 * Giới hạn: giá trị do onchange tính (không có trong default_get) và wizard đặc thù chưa được kiểm chứng trên Odoo thật; cần công thức curated nếu gặp.
 */
export class UnresolvedData extends Error {}

/** Model cấu hình: được CHỌN (chỉ đọc), không bao giờ tạo hay sửa. */
export const REFERENCE_MODELS = new Set([
  'res.company', 'res.currency', 'uom.uom', 'uom.category', 'res.country', 'res.country.state', 'res.lang', 'stock.warehouse', 'stock.location',
  'stock.picking.type', 'account.journal', 'product.category', 'account.account', 'account.tax', 'account.payment.method.line', 'crm.team',
]);
const REFERENCE_DOMAIN: Record<string, unknown[]> = { 'stock.location': [['usage', '=', 'internal']] };
const MAX_DEPTH = 3;
const KIND_PREFIX = 'model:';

export const modelKind = (model: string) => `${KIND_PREFIX}${model}`;

const today = () => new Date().toISOString().slice(0, 10);

function scalarValue(name: string, f: FieldMeta, ref: string, seq: number): unknown {
  switch (f.type) {
    case 'char': case 'text': case 'html': return name === 'name' ? `${ref} ${seq}` : `${ref} ${name}`;
    case 'integer': case 'float': case 'monetary': return 1;
    case 'boolean': return false;
    case 'date': return today();
    case 'datetime': return `${today()} 00:00:00`;
    case 'selection': return (f.selection ?? [])[0]?.[0];
    default: return undefined;
  }
}

/** Trường bắt buộc mà Odoo không tự điền: dùng để kiểm tra trước và để lập kế hoạch quan hệ. */
export function requiredFields(meta: ModelMeta): [string, FieldMeta][] {
  return Object.entries(meta).filter(([n, f]) => f.required && !f.readonly && f.store !== false && n !== 'id');
}

export interface GenericParams {
  /** Giá trị ghi đè/bổ sung (ưu tiên cao nhất). */
  vals?: Record<string, unknown>;
  /** trường many2one -> khoá node trong kế hoạch cung cấp bản ghi. */
  links?: Record<string, string>;
  /** trường many2one tham chiếu -> domain chọn bản ghi cấu hình. */
  refDomains?: Record<string, unknown[]>;
  /** Các bước nghiệp vụ theo adapter, theo thứ tự (ví dụ ['confirm','validate']). */
  steps?: string[];
  /** Bản ghi con tự sinh cần đăng ký: { model, field } tìm theo field = id bản ghi. */
  children?: { model: string; field: string }[];
}

interface Resolved {
  meta: ModelMeta;
  adapter?: AdapterModel;
}

async function pickReference(rpc: OdooRpc, relation: string, domain: unknown[] | undefined, field: string): Promise<number> {
  const [rec] = await rpc.searchRead<{ id: number }>(relation, domain ?? REFERENCE_DOMAIN[relation] ?? [], ['id'], { limit: 1 });
  if (!rec) throw new UnresolvedData(`trường "${field}" cần bản ghi cấu hình ${relation} nhưng môi trường không có bản ghi nào`);
  return rec.id;
}

function genericRecipe(model: string, r: Resolved): Recipe<OdooRpc, GenericParams> {
  return {
    kind: modelKind(model),
    model,
    async create(ctx, p, deps) {
      const vals: Record<string, unknown> = {};
      const params = p ?? {};
      const required = requiredFields(r.meta);
      const defaults = required.length ? await ctx.rpc.call<Record<string, unknown>>(model, 'default_get', [required.map(([n]) => n)]) : {};
      for (const [name, f] of required) {
        if (params.vals && name in params.vals) continue;
        if (defaults && defaults[name] !== undefined && defaults[name] !== false) continue;
        if (f.type === 'many2one') {
          const link = params.links?.[name];
          const dep = link ? deps[link] : Object.values(deps).find((d) => d.model === f.relation);
          if (dep) vals[name] = dep.id;
          else if (f.relation && REFERENCE_MODELS.has(f.relation)) vals[name] = await pickReference(ctx.rpc, f.relation, params.refDomains?.[name], name);
          else throw new UnresolvedData(`trường "${name}" của ${model} cần bản ghi ${f.relation ?? '?'}: kế hoạch dữ liệu chưa cung cấp`);
          continue;
        }
        if (f.type === 'one2many' || f.type === 'many2many') throw new UnresolvedData(`trường "${name}" của ${model} (${f.type}) bắt buộc: cần công thức/giá trị cụ thể từ test case`);
        const v = scalarValue(name, f, ctx.reference, ctx.seq);
        if (v === undefined) throw new UnresolvedData(`không có giá trị mặc định cho trường "${name}" (${f.type}) của ${model}`);
        vals[name] = v;
      }
      // Nhãn nhận diện framework: tham chiếu AUTOTEST và thẻ QA đủ bốn ID, nếu model có trường chữ phù hợp.
      if (r.adapter?.refField && !(params.vals && r.adapter.refField in params.vals)) vals[r.adapter.refField] = ctx.reference;
      if (r.adapter?.tagField && r.adapter.tagField !== r.adapter.refField && !(params.vals && r.adapter.tagField in params.vals)) vals[r.adapter.tagField] = ctx.tag;
      if (r.meta.name && !('name' in vals) && !(params.vals && 'name' in params.vals) && r.meta.name.required) vals.name = `${ctx.reference} ${ctx.seq}`;
      const id = await ctx.rpc.call<number>(model, 'create', [{ ...vals, ...(params.vals ?? {}) }]);
      return { id };
    },
    async finalize(ctx, rec, p) {
      for (const stepKey of p?.steps ?? []) {
        const t = r.adapter?.transitions?.[stepKey];
        if (!t) throw new UnresolvedData(`adapter của ${model} không khai báo bước "${stepKey}" (chưa có nút tương ứng trên form): không tự đoán`);
        if (t.from && r.adapter?.stateField) {
          const [cur] = await ctx.rpc.searchRead<Record<string, unknown>>(model, [['id', '=', rec.id]], [r.adapter.stateField]);
          if (!t.from.includes(String(cur?.[r.adapter.stateField]))) throw new Error(`${model}#${rec.id} đang ở trạng thái "${cur?.[r.adapter.stateField]}", bước "${stepKey}" chỉ chạy từ ${t.from.join('/')}`);
        }
        const result = await ctx.rpc.call<unknown>(model, t.method, [[rec.id]]);
        await resolveWizard(ctx.rpc, result);
        if (t.to && r.adapter?.stateField) {
          const [after] = await ctx.rpc.searchRead<Record<string, unknown>>(model, [['id', '=', rec.id]], [r.adapter.stateField]);
          if (after?.[r.adapter.stateField] !== t.to) throw new Error(`bước "${stepKey}" (${t.method}) không đưa ${model}#${rec.id} tới "${t.to}" (đang là "${after?.[r.adapter.stateField]}")`);
        }
      }
    },
    async children(ctx, rec, p) {
      const out: { model: string; id: number; reference: string }[] = [];
      for (const c of p?.children ?? []) {
        for (const row of await ctx.rpc.searchRead<{ id: number; name?: string }>(c.model, [[c.field, '=', rec.id]], ['name'])) {
          out.push({ model: c.model, id: row.id, reference: row.name ?? ctx.reference });
        }
      }
      return out;
    },
    async update(ctx, rec, vals) {
      await ctx.rpc.call(model, 'write', [[rec.id], vals]);
    },
  };
}

/** Phương thức wizard được thử (theo thứ tự) khi một nút trả về hành động mở wizard (ví dụ xác nhận phiếu kho). Chỉ những tên chuẩn của Odoo. */
export const WIZARD_METHODS = ['process', 'action_confirm', 'confirm', 'action_apply'];

/** Nút trả về hành động act_window có res_model ⇒ tạo wizard với context của hành động rồi gọi phương thức xử lý chuẩn. Không phải wizard ⇒ không làm gì. */
export async function resolveWizard(rpc: OdooRpc, result: unknown): Promise<void> {
  const a = result as { type?: string; res_model?: string; context?: Record<string, unknown>; res_id?: number } | undefined;
  if (!a || typeof a !== 'object' || a.type !== 'ir.actions.act_window' || !a.res_model) return;
  const id = a.res_id ?? (await rpc.call<number>(a.res_model, 'create', [{}], { context: a.context ?? {} }));
  let last: unknown;
  for (const m of WIZARD_METHODS) {
    try {
      await rpc.call(a.res_model, m, [[id]], { context: a.context ?? {} });
      return;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`wizard ${a.res_model} không xử lý được bằng ${WIZARD_METHODS.join('/')}: ${(last as Error)?.message ?? ''}`);
}

export interface GenericContext {
  rpc: OdooRpc;
  adapters: AdapterManifest[];
}

/** Nạp cấu trúc các model cần thiết (và quan hệ phụ thuộc) rồi trả về hàm resolveRecipe đồng bộ cho DataFactory. */
export async function prepareGeneric(g: GenericContext, models: string[]): Promise<{ resolveRecipe: (kind: string) => Recipe<OdooRpc> | undefined; metas: Map<string, ModelMeta> }> {
  const metas = new Map<string, ModelMeta>();
  const load = async (m: string, depth: number) => {
    if (metas.has(m) || depth > MAX_DEPTH || REFERENCE_MODELS.has(m)) return;
    const meta = await modelMeta(g.rpc, m);
    if (!meta) throw new UnresolvedData(`model ${m} không tồn tại hoặc không đọc được trên môi trường này (module chưa cài hoặc thiếu quyền)`);
    metas.set(m, meta);
    for (const [, f] of requiredFields(meta)) if (f.type === 'many2one' && f.relation) await load(f.relation, depth + 1);
  };
  for (const m of models) await load(m, 0);
  const adapterOf = (m: string) => g.adapters.flatMap((a) => a.models).find((x) => x.model === m);
  return {
    metas,
    resolveRecipe: (kind) => {
      if (!kind.startsWith(KIND_PREFIX)) return undefined;
      const model = kind.slice(KIND_PREFIX.length);
      const meta = metas.get(model);
      return meta ? (genericRecipe(model, { meta, adapter: adapterOf(model) }) as Recipe<OdooRpc>) : undefined;
    },
  };
}

/**
 * Kế hoạch dữ liệu cho một model: node chính + node phụ cho mọi quan hệ many2one bắt buộc không phải model cấu hình
 * (tạo mới, độ sâu tối đa 3). Quan hệ vòng hoặc quá sâu ⇒ UnresolvedData (BLOCKED), không tạo gì.
 */
export function planForModel(metas: Map<string, ModelMeta>, model: string, params: GenericParams = {}): DataPlan {
  const plan: DataPlan = {};
  const build = (m: string, key: string, path: string[], p: GenericParams): void => {
    const meta = metas.get(m);
    if (!meta) throw new UnresolvedData(`chưa nạp cấu trúc của ${m}`);
    if (path.includes(m)) throw new UnresolvedData(`quan hệ vòng giữa các model: ${[...path, m].join(' → ')}`);
    if (path.length > MAX_DEPTH) throw new UnresolvedData(`chuỗi quan hệ sâu hơn ${MAX_DEPTH} cấp tại ${m}`);
    const links: Record<string, string> = { ...(p.links ?? {}) };
    const requires: string[] = [];
    for (const [name, f] of requiredFields(meta)) {
      if (f.type !== 'many2one' || !f.relation || REFERENCE_MODELS.has(f.relation) || (p.vals && name in p.vals) || links[name]) continue;
      const sub = `${key}.${name}`;
      build(f.relation, sub, [...path, m], {});
      links[name] = sub;
      requires.push(sub);
    }
    plan[key] = { kind: modelKind(m), params: { ...p, links }, requires };
  };
  build(model, 'main', [], params);
  return plan;
}
