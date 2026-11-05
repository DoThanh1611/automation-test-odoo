import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Adapter của một module ứng dụng: bản mô tả KHAI BÁO (JSON, không phải mã) về model, quy trình chuyển trạng thái và cách dọn dữ liệu,
 * được sinh từ việc khám phá môi trường thật rồi tái sử dụng cho các requirement sau. Lõi framework không biết model nghiệp vụ nào:
 * mọi hiểu biết riêng nằm ở đây. Adapter ghi rõ nó đã được kiểm chứng trên phiên bản/edition/module nào; khi môi trường khác đi,
 * adapter bị đánh dấu REVERIFY thay vì được tin mù quáng.
 */
export type Edition = 'community' | 'enterprise' | 'unknown';

export type CleanupKind =
  /** Đặt active=false, không xoá. */
  | 'archive'
  /** Gọi các bước (ví dụ action_cancel) khi chứng từ chưa ở trạng thái cuối. */
  | 'cancel'
  /** Xoá hẳn: chỉ cho bản ghi không phải chứng từ (ví dụ serial chưa dùng). */
  | 'unlink'
  /** Chưa có cách dọn an toàn đã xác minh: CLEANUP_BLOCKED, không đoán. */
  | 'unsupported';

export interface AdapterTransition {
  /** Phương thức ORM (nút trên giao diện) thực hiện bước, ví dụ action_confirm. */
  method: string;
  /** Trạng thái kỳ vọng sau bước. Bắt buộc kiểm tra: không đạt thì bước coi như lỗi. */
  to?: string;
  /** Trạng thái đầu hợp lệ. */
  from?: string[];
}

export interface AdapterModel {
  model: string;
  /** Trường chữ tự do để gắn nhãn AUTOTEST (ví dụ origin, ref, note). Không có ⇒ chỉ nhận diện qua registry. */
  refField?: string;
  /** Trường ghi thẻ QA đủ bốn ID (comment, note, description...). */
  tagField?: string;
  stateField?: string;
  /** Trạng thái cuối không thể dọn bằng huỷ (ví dụ done, posted). */
  finalStates?: string[];
  /** Trạng thái coi như đã dọn. */
  cleanStates?: string[];
  transitions?: Record<string, AdapterTransition>;
  cleanup: { kind: CleanupKind; steps?: string[]; reason?: string };
  /** Dấu vết cấu trúc đã kiểm chứng (băm tên:kiểu:bắt buộc của các trường). Đổi ⇒ cần kiểm chứng lại. */
  fieldsFingerprint: string;
}

export interface AdapterManifest {
  schema: 1;
  application: string;
  /** Tên module framework (khớp tests/<app>-<module>); không có danh sách cố định. */
  module: string;
  /** Module kỹ thuật của ứng dụng phải được cài (Odoo: sale, stock, x_custom...). Thiếu ⇒ UNAVAILABLE (thiếu điều kiện môi trường, không phải lỗi nghiệp vụ). */
  requiresModules: string[];
  verifiedOn: { version: string; edition: Edition; at: string };
  models: AdapterModel[];
  /** 'derived' = sinh tự động từ khám phá; 'curated' = đã được người/Claude chỉnh sau khi kiểm chứng. */
  origin: 'derived' | 'curated';
  note?: string;
}

export interface EnvProfile {
  version: string;
  edition: Edition;
  installedModules: string[];
  /** false = tài khoản không đọc được danh sách module đã cài (ir.module.module bị từ chối): không suy ra được module nào thiếu. */
  modulesKnown?: boolean;
}

export type ReuseStatus = 'REUSE' | 'REVERIFY' | 'UNAVAILABLE';

export interface ReuseDecision {
  status: ReuseStatus;
  reasons: string[];
}

export const ADAPTERS_DIR = 'adapters';
const major = (v: string) => v.split('.')[0].replace(/^saas~/, '');

/** Băm cấu trúc trường của một model (ổn định theo thứ tự). */
export function fieldsFingerprint(fields: Record<string, { type?: string; required?: boolean }>): string {
  const canon = Object.keys(fields).sort().map((k) => `${k}:${fields[k].type ?? ''}:${fields[k].required ? 1 : 0}`).join('|');
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

/**
 * Adapter đã có dùng lại được trên môi trường này không? Thuần hàm.
 *  - UNAVAILABLE: môi trường không cài module cần thiết (phân biệt với lỗi nghiệp vụ ⇒ test BLOCKED vì thiếu điều kiện môi trường).
 *  - REVERIFY: khác phiên bản chính/edition hoặc cấu trúc trường đã đổi ⇒ phải khám phá/kiểm chứng lại trước khi tin.
 */
export function reuseDecision(m: AdapterManifest, env: EnvProfile, currentFingerprints: Record<string, string> = {}): ReuseDecision {
  const reasons: string[] = [];
  if (env.modulesKnown === false) reasons.push('không đọc được danh sách module đã cài: chưa xác minh được môi trường có đủ module');
  else {
    const missing = m.requiresModules.filter((x) => !env.installedModules.includes(x));
    if (missing.length) return { status: 'UNAVAILABLE', reasons: [`môi trường chưa cài module: ${missing.join(', ')}`] };
  }
  if (major(m.verifiedOn.version) !== major(env.version)) reasons.push(`kiểm chứng trên Odoo ${m.verifiedOn.version}, môi trường là ${env.version}`);
  if (m.verifiedOn.edition !== 'unknown' && env.edition !== 'unknown' && m.verifiedOn.edition !== env.edition) reasons.push(`kiểm chứng trên edition ${m.verifiedOn.edition}, môi trường là ${env.edition}`);
  for (const am of m.models) {
    const cur = currentFingerprints[am.model];
    if (cur && cur !== am.fieldsFingerprint) reasons.push(`cấu trúc trường của ${am.model} đã đổi`);
  }
  return reasons.length ? { status: 'REVERIFY', reasons } : { status: 'REUSE', reasons: [] };
}

/** Kiểm tra cấu trúc manifest. Trả về lỗi (rỗng = hợp lệ). */
export function manifestProblems(m: Partial<AdapterManifest> | undefined): string[] {
  const p: string[] = [];
  if (!m || typeof m !== 'object') return ['không phải đối tượng'];
  if (m.schema !== 1) p.push('schema phải là 1');
  for (const k of ['application', 'module'] as const) if (!m[k] || typeof m[k] !== 'string') p.push(`thiếu ${k}`);
  if (!Array.isArray(m.requiresModules)) p.push('thiếu requiresModules');
  if (!m.verifiedOn?.version) p.push('thiếu verifiedOn.version');
  if (!Array.isArray(m.models) || !m.models.length) p.push('adapter phải có ít nhất một model');
  for (const am of m.models ?? []) {
    if (!am.model) p.push('có model không tên');
    if (!am.fieldsFingerprint) p.push(`${am.model}: thiếu fieldsFingerprint`);
    if (!am.cleanup || !['archive', 'cancel', 'unlink', 'unsupported'].includes(am.cleanup.kind)) p.push(`${am.model}: cleanup.kind không hợp lệ`);
    else if (am.cleanup.kind === 'cancel' && !am.cleanup.steps?.length) p.push(`${am.model}: cleanup cancel phải có steps`);
    else if (am.cleanup.kind === 'unsupported' && !am.cleanup.reason) p.push(`${am.model}: cleanup unsupported phải có reason`);
  }
  return p;
}

export const adapterFile = (root: string, application: string, module: string) => path.join(root, ADAPTERS_DIR, application, `${module}.adapter.json`);

/** Đọc mọi adapter của một ứng dụng. File hỏng được trả về trong problems (không ném lỗi, không bị tin). */
export function loadAdapters(root: string, application: string): { adapters: AdapterManifest[]; problems: string[] } {
  const dir = path.join(root, ADAPTERS_DIR, application);
  const adapters: AdapterManifest[] = [];
  const problems: string[] = [];
  if (!fs.existsSync(dir)) return { adapters, problems };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.adapter.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as AdapterManifest;
      const bad = manifestProblems(j);
      if (bad.length) problems.push(`${f}: ${bad.join('; ')}`);
      else adapters.push(j);
    } catch (e) {
      problems.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { adapters, problems };
}

export function saveAdapter(root: string, m: AdapterManifest): string {
  const bad = manifestProblems(m);
  if (bad.length) throw new Error(`Adapter không hợp lệ: ${bad.join('; ')}`);
  const file = adapterFile(root, m.application, m.module);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  return file;
}
