import type { FieldMeta } from '../../../applications/odoo/introspect';
import type { OdooRpc } from '../../../applications/odoo/factory';

/**
 * Odoo GIẢ điều khiển bằng LƯỢC ĐỒ (không phải Odoo thật, không mạng): mô phỏng Community / Enterprise / module bên thứ ba / module tùy chỉnh
 * tuỳ lược đồ được truyền vào. Đủ để kiểm chứng LOGIC khám phá, sinh adapter, Factory tổng quát, chuyển trạng thái và cleanup.
 * Không chứng minh ngữ nghĩa Odoo thật.
 */
type Row = Record<string, any>;

export interface FakeModelDef {
  fields: Record<string, FieldMeta>;
  /** Tên nút hiện trên form view (type=object). */
  buttons?: string[];
  /** Phương thức → hành vi. from: trạng thái đầu hợp lệ; to: trạng thái sau; wizard: trả về hành động mở wizard model này. */
  actions?: Record<string, { from?: string[]; to?: string; wizard?: string }>;
  /** Mặc định do default_get trả về. */
  defaults?: Record<string, unknown>;
  /** Wizard: hiệu ứng khi process (đặt trạng thái cho bản ghi nguồn). */
  processes?: { model: string; to: string };
}

export interface FakeOdooOptions {
  version?: string;
  modules: string[];
  models: Record<string, FakeModelDef>;
  /** ir.module.module bị từ chối (tài khoản không phải admin). */
  denyModuleList?: boolean;
  uid?: number;
  start?: number;
}

export class FakeOdoo implements OdooRpc {
  readonly tables = new Map<string, Row[]>();
  readonly calls: { model: string; method: string; ids: number[] }[] = [];
  denied = new Set<string>();
  private seq: number;
  uid: number;

  constructor(readonly o: FakeOdooOptions) {
    this.seq = o.start ?? 1000;
    this.uid = o.uid ?? 7;
  }

  table(model: string): Row[] {
    if (!this.tables.has(model)) this.tables.set(model, []);
    return this.tables.get(model)!;
  }

  seed(model: string, row: Row): Row {
    const r = { id: ++this.seq, active: true, create_uid: [1, 'Người dùng khác'], ...row };
    this.table(model).push(r);
    return r;
  }

  find(model: string, id: number) {
    return this.table(model).find((r) => r.id === id);
  }

  private def(model: string): FakeModelDef {
    const d = this.o.models[model];
    if (!d) throw new Error(`Object ${model} doesn't exist`);
    return d;
  }

  private match(row: Row, domain: unknown[]) {
    return domain.every((c) => {
      const [f, op, v] = c as [string, string, any];
      const x = Array.isArray(row[f]) ? row[f][0] : row[f];
      if (op === '=') return x === v;
      if (op === '!=') return x !== v;
      if (op === 'in') return (v as unknown[]).includes(x);
      return false;
    });
  }

  async currentUserId() {
    return this.uid;
  }

  async count(model: string, domain: unknown[] = []) {
    return this.table(model).filter((r) => this.match(r, domain)).length;
  }

  async searchRead<T = any>(model: string, domain: unknown[], _f: string[], extra: Record<string, unknown> = {}): Promise<T[]> {
    if (model === 'ir.module.module') {
      if (this.o.denyModuleList) throw new Error('Odoo RPC ir.module.module.search_read: Xin lỗi, bạn không được phép truy cập');
      return this.o.modules.map((name) => ({ name })) as T[];
    }
    this.def(model);
    const ctx = (extra.context ?? {}) as { active_test?: boolean };
    let rows = this.table(model).filter((r) => this.match(r, domain) && (ctx.active_test === false || r.active !== false));
    if (typeof extra.limit === 'number') rows = rows.slice(0, extra.limit);
    return rows.map((r) => ({ ...r })) as T[];
  }

  async call<T = any>(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    const ids = method === 'create' || method === 'default_get' || method === 'fields_get' || method === 'get_views' ? [] : ((args[0] as number[]) ?? []);
    this.calls.push({ model, method, ids });
    const d = this.def(model);
    if (method === 'fields_get') return d.fields as T;
    if (method === 'check_access_rights') return !this.denied.has(`${model}.${args[0]}`) as T;
    if (method === 'get_views') return { views: { form: { arch: `<form>${(d.buttons ?? []).map((b) => `<button name="${b}" type="object"/>`).join('')}</form>` } } } as T;
    if (method === 'default_get') return Object.fromEntries(Object.entries(d.defaults ?? {}).filter(([k]) => (args[0] as string[]).includes(k))) as T;
    if (method === 'create') {
      const vals = args[0] as Row;
      for (const [n, f] of Object.entries(d.fields)) if (f.required && !f.readonly && vals[n] === undefined && (d.defaults ?? {})[n] === undefined) throw new Error(`Odoo RPC ${model}.create: Trường "${n}" là bắt buộc`);
      const state = d.fields.state?.selection?.[0]?.[0];
      const row: Row = { id: ++this.seq, active: true, create_uid: [this.uid, 'Tài khoản automation'], ...(state ? { state } : {}), ...(d.defaults ?? {}), ...vals };
      this.table(model).push(row);
      return row.id as T;
    }
    if (method === 'write') {
      for (const id of ids) Object.assign(this.find(model, id) ?? (() => { throw new Error(`${model}#${id} không tồn tại`); })(), args[1] as Row);
      return true as T;
    }
    if (method === 'unlink') {
      this.tables.set(model, this.table(model).filter((r) => !ids.includes(r.id)));
      return true as T;
    }
    const act = d.actions?.[method];
    if (!act && !d.processes) throw new Error(`${model}.${method} chưa được giả lập`);
    if (d.processes && method === 'process') {
      const src = (kwargs.context as { active_ids?: number[] } | undefined)?.active_ids ?? [];
      for (const sid of src) Object.assign(this.find(d.processes.model, sid) ?? {}, { state: d.processes.to });
      return true as T;
    }
    if (!act) throw new Error(`${model}.${method} chưa được giả lập`);
    for (const id of ids) {
      const r = this.find(model, id);
      if (!r) throw new Error(`${model}#${id} không tồn tại`);
      if (act.from && !act.from.includes(r.state)) throw new Error(`Odoo RPC ${model}.${method}: trạng thái "${r.state}" không hợp lệ`);
      if (act.wizard) return { type: 'ir.actions.act_window', res_model: act.wizard, context: { active_ids: ids, active_model: model } } as T;
      if (act.to) r.state = act.to;
    }
    return true as T;
  }
}

const sel = (...v: string[]): FieldMeta => ({ type: 'selection', selection: v.map((x) => [x, x]) as [string, string][] });
const char = (o: Partial<FieldMeta> = {}): FieldMeta => ({ type: 'char', ...o });
const m2o = (relation: string, o: Partial<FieldMeta> = {}): FieldMeta => ({ type: 'many2one', relation, ...o });

/** Mô hình tối thiểu dùng chung cho các bộ test: công ty, đối tác, sản phẩm cấu hình + chứng từ có quy trình. */
export const baseModels = (): Record<string, FakeModelDef> => ({
  'res.company': { fields: { name: char({ required: true }) } },
  'res.partner': { fields: { name: char({ required: true }), comment: { type: 'text' }, active: { type: 'boolean' } } },
});

export { sel, char, m2o };
