import { fieldsFingerprint, type AdapterManifest, type AdapterModel, type AdapterTransition, type EnvProfile } from '../../core/adapters/manifest';
import type { OdooRpc } from './factory';

/**
 * Khám phá Odoo CHỈ ĐỌC (fields_get, get_views, search_read trên ir.module.module): phiên bản, edition, module đã cài, cấu trúc model,
 * nút thao tác trên form. Từ đó sinh adapter khai báo cho BẤT KỲ module nào (Community, Enterprise, bên thứ ba, tùy chỉnh) mà không
 * cần danh sách module cố định. Không tạo, không ghi, không gọi action_*.
 */
export interface FieldMeta {
  string?: string;
  type: string;
  required?: boolean;
  readonly?: boolean;
  store?: boolean;
  relation?: string;
  selection?: [string, string][];
}
export type ModelMeta = Record<string, FieldMeta>;

const FIELD_ATTRS = ['string', 'type', 'required', 'readonly', 'store', 'relation', 'selection'];

/** Cấu trúc model, hoặc undefined nếu model không tồn tại / không có quyền đọc (phân biệt "thiếu module" với lỗi khác ở bên gọi). */
export async function modelMeta(rpc: OdooRpc, model: string): Promise<ModelMeta | undefined> {
  try {
    return await rpc.call<ModelMeta>(model, 'fields_get', [], { attributes: FIELD_ATTRS });
  } catch {
    return undefined;
  }
}

/** Phiên bản, edition và module đã cài. Tài khoản không đọc được ir.module.module ⇒ edition 'unknown', modulesKnown=false (không bịa). */
export async function environmentProfile(rpc: OdooRpc, version: string): Promise<EnvProfile> {
  try {
    const rows = await rpc.searchRead<{ name: string }>('ir.module.module', [['state', '=', 'installed']], ['name']);
    const names = rows.map((r) => r.name);
    return { version, edition: names.includes('web_enterprise') ? 'enterprise' : 'community', installedModules: names, modulesKnown: true };
  } catch {
    return { version, edition: 'unknown', installedModules: [], modulesKnown: false };
  }
}

/** Tên các nút (type=object) trên form view của model; rỗng nếu không đọc được. */
export async function formButtons(rpc: OdooRpc, model: string): Promise<string[]> {
  try {
    const r = await rpc.call<{ views?: { form?: { arch?: string } } }>(model, 'get_views', [[[false, 'form']]], {});
    const arch = r?.views?.form?.arch ?? '';
    return [...new Set([...arch.matchAll(/<button\b[^>]*\bname="([A-Za-z_][\w]*)"[^>]*>/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
}

const REF_CANDIDATES = ['origin', 'client_order_ref', 'ref', 'reference', 'payment_reference', 'note', 'comment', 'description', 'narration'];
const TAG_CANDIDATES = ['comment', 'note', 'description', 'narration', 'internal_note'];
const writableText = (f?: FieldMeta) => Boolean(f && ['char', 'text'].includes(f.type) && !f.readonly && f.store !== false);

/** Tên phương thức → bước nghiệp vụ. Chỉ nhận khi nút đó THỰC SỰ có trên form của môi trường. */
const TRANSITION_NAMES: Record<string, string[]> = {
  confirm: ['action_confirm', 'button_confirm', 'action_validate'],
  validate: ['button_validate'],
  post: ['action_post'],
  cancel: ['action_cancel', 'button_cancel'],
  draft: ['action_draft', 'button_draft'],
  done: ['action_done', 'button_done'],
};

/** Sinh khai báo adapter cho MỘT model từ cấu trúc và nút trên form. Quy tắc dọn thận trọng: không chắc ⇒ unsupported. */
export function deriveModelAdapter(model: string, meta: ModelMeta, buttons: string[]): AdapterModel {
  const refField = REF_CANDIDATES.find((k) => writableText(meta[k]));
  const tagField = TAG_CANDIDATES.find((k) => writableText(meta[k]));
  const state = meta.state?.type === 'selection' ? meta.state : undefined;
  const states = (state?.selection ?? []).map(([v]) => v);
  const cleanStates = states.filter((s) => /^(cancel|cancelled|canceled)$/.test(s));
  const finalStates = states.filter((s) => /^(done|posted|closed)$/.test(s));

  const transitions: Record<string, AdapterTransition> = {};
  for (const [key, names] of Object.entries(TRANSITION_NAMES)) {
    const method = names.find((n) => buttons.includes(n));
    if (method) transitions[key] = { method, ...(key === 'cancel' && cleanStates[0] ? { to: cleanStates[0] } : {}), ...(key === 'draft' && states.includes('draft') ? { to: 'draft' } : {}) };
  }

  let cleanup: AdapterModel['cleanup'];
  const cancel = transitions.cancel;
  if (state && cancel && cleanStates.length) cleanup = { kind: 'cancel', steps: [cancel.method] };
  else if (meta.active) cleanup = { kind: 'archive' };
  else cleanup = { kind: 'unsupported', reason: `không có nút huỷ trên form và không có trường active của ${model}: cách dọn an toàn chưa được xác minh` };

  return {
    model, refField, tagField, stateField: state ? 'state' : undefined,
    finalStates: finalStates.length ? finalStates : undefined, cleanStates: cleanStates.length ? cleanStates : undefined,
    transitions: Object.keys(transitions).length ? transitions : undefined, cleanup, fieldsFingerprint: fieldsFingerprint(meta),
  };
}

/** Sinh adapter của một module từ danh sách model và module kỹ thuật cần có. Model không tồn tại ⇒ trả về trong `missing` (thiếu điều kiện môi trường). */
export async function deriveAdapter(rpc: OdooRpc, o: { module: string; models: string[]; requiresModules: string[]; profile: EnvProfile; now?: () => string }): Promise<{ adapter?: AdapterManifest; missing: string[] }> {
  const models: AdapterModel[] = [];
  const missing: string[] = [];
  for (const m of o.models) {
    const meta = await modelMeta(rpc, m);
    if (!meta) {
      missing.push(m);
      continue;
    }
    models.push(deriveModelAdapter(m, meta, await formButtons(rpc, m)));
  }
  if (missing.length || !models.length) return { missing };
  return {
    missing,
    adapter: {
      schema: 1, application: 'odoo', module: o.module, requiresModules: o.requiresModules,
      verifiedOn: { version: o.profile.version, edition: o.profile.edition, at: (o.now ?? (() => new Date().toISOString()))() },
      models, origin: 'derived',
    },
  };
}

/** Dấu vết cấu trúc hiện tại của các model (để so với adapter đã lưu). Model không đọc được bị bỏ qua. */
export async function currentFingerprints(rpc: OdooRpc, models: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of models) {
    const meta = await modelMeta(rpc, m);
    if (meta) out[m] = fieldsFingerprint(meta);
  }
  return out;
}
