import fs from 'node:fs';
import path from 'node:path';
import { evaluate, signText, verifyText } from '../approval/approval';
import { markerFile, type ExecutionMarker } from '../approval/gate';
import type { Requirement, TestCaseDef } from '../testcases/schema';
import { productionReason } from '../policy/policy';
import { environmentsDir, loadEnvironmentsFile, resolveEnvironment, type ResolvedEnvironment } from './config';

/**
 * Trạng thái chọn/xác nhận môi trường của phiên làm việc (.qa-state/environment.json, không chia sẻ).
 *
 *  - CHỌN môi trường: con trỏ "đang làm việc với môi trường nào" (Giai đoạn 2, trước khi kết nối Playwright MCP).
 *  - XÁC NHẬN thực thi: do NGƯỜI DÙNG gõ lại đúng "EXECUTE <ENV> <host>" trong terminal; riêng cho từng (môi trường, requirement),
 *    gắn với hash phê duyệt hiện tại và host hiện tại, có chữ ký (khoá ngoài dự án). APPROVE test case dùng chung được cho nhiều
 *    môi trường vì nội dung không đổi, nhưng xác nhận này KHÔNG dùng chung: mỗi môi trường phải xác nhận riêng.
 *  - Quyền GHI dữ liệu là một xác nhận thứ ba, riêng nữa (npm run test:write), không suy ra từ hai thứ trên.
 */
export interface EnvConfirmation {
  environment: string;
  application: string;
  host: string;
  requirementId: string;
  approvalHash: string;
  by: string;
  at: string;
  signature: string;
}

export interface EnvState {
  selected?: { environment: string; application: string; at: string };
  confirmations: Record<string, EnvConfirmation>;
}

export const stateFile = (root: string) => path.join(root, '.qa-state', 'environment.json');
const MAX_AGE_MS = 24 * 3600 * 1000;
const ckey = (env: string, req: string) => `${env}|${req}`;

/** Chế độ "APPROVE là xác nhận duy nhất" của một ứng dụng (khai báo trong environments/<app>.json). */
export function approvalMode(app: string): { defaultEnvironment: string } | undefined {
  try {
    const f = loadEnvironmentsFile(app);
    return f?.confirmation === 'approval' && f.defaultEnvironment && f.environments?.[f.defaultEnvironment] ? { defaultEnvironment: f.defaultEnvironment } : undefined;
  } catch {
    return undefined;
  }
}

/** Môi trường mặc định (chưa ai chọn) của ứng dụng đầu tiên có chế độ approval. Không ghi gì ra đĩa. */
function defaultSelection(): EnvState['selected'] {
  try {
    for (const name of fs.readdirSync(environmentsDir())) {
      if (!name.endsWith('.json')) continue;
      const app = name.slice(0, -5);
      const m = approvalMode(app);
      if (m) return { environment: m.defaultEnvironment, application: app, at: 'mặc định theo cấu hình' };
    }
  } catch { /* không có thư mục cấu hình */ }
  return undefined;
}

export function readState(root: string): EnvState {
  const f = stateFile(root);
  let state: EnvState = { confirmations: {} };
  if (fs.existsSync(f)) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8')) as EnvState;
      state = { selected: s.selected, confirmations: s.confirmations ?? {} };
    } catch { /* hỏng: coi như trống */ }
  }
  return state.selected ? state : { ...state, selected: defaultSelection() };
}

function writeState(root: string, s: EnvState) {
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify(s, null, 2) + '\n');
}

/** Chọn môi trường làm việc. Không xác nhận gì và không kết nối gì. */
export function selectEnvironment(root: string, app: string, key: string, source: NodeJS.ProcessEnv = process.env) {
  const r = resolveEnvironment(app, key, source);
  if (!r.ok) throw new Error(`Không chọn được môi trường ${key}: ${r.problems.join('; ')}`);
  const state = readState(root);
  const previous = state.selected?.environment;
  state.selected = { environment: key, application: app, at: new Date().toISOString() };
  writeState(root, state);
  return { env: r.env, previous, changed: previous !== undefined && previous !== key };
}

export function clearSelection(root: string) {
  const s = readState(root);
  delete s.selected;
  writeState(root, s);
}

export const confirmPhrase = (env: Pick<ResolvedEnvironment, 'key' | 'host'>) => `EXECUTE ${env.key} ${env.host}`;
const payload = (c: Omit<EnvConfirmation, 'signature'>) => [c.environment, c.application, c.host, c.requirementId, c.approvalHash, c.by, c.at].join('|');

export interface ConfirmInput {
  env: ResolvedEnvironment;
  requirementId: string;
  approvalHash: string;
  by: string;
  /** Cụm người dùng đã gõ; phải đúng `EXECUTE <ENV> <host>`. */
  typed: string;
}

/** Ghi xác nhận thực thi cho ĐÚNG môi trường này. Từ chối nếu cụm xác nhận không khớp. */
export function confirmExecution(root: string, i: ConfirmInput): EnvConfirmation {
  if (i.typed !== confirmPhrase(i.env)) throw new Error('Cụm xác nhận không khớp.');
  if (!i.by.trim()) throw new Error('Phải ghi tên người xác nhận.');
  const base = { environment: i.env.key, application: i.env.application, host: i.env.host, requirementId: i.requirementId, approvalHash: i.approvalHash, by: i.by.trim(), at: new Date().toISOString() };
  const signature = signText(payload(base), true)!;
  const conf: EnvConfirmation = { ...base, signature };
  const state = readState(root);
  state.confirmations[ckey(i.env.key, i.requirementId)] = conf;
  writeState(root, state);
  return conf;
}

export function revokeConfirmation(root: string, envKey: string, requirementId?: string) {
  const state = readState(root);
  for (const k of Object.keys(state.confirmations)) {
    const c = state.confirmations[k];
    if (c.environment === envKey && (!requirementId || c.requirementId === requirementId)) delete state.confirmations[k];
  }
  writeState(root, state);
}

/** undefined = môi trường này đã được xác nhận hợp lệ cho requirement (đúng host, đúng hash phê duyệt hiện tại). */
export function confirmationProblem(root: string, env: ResolvedEnvironment, requirementId: string, approvalHash: string, now = Date.now()): string | undefined {
  // Chế độ approval: phê duyệt hợp lệ (đã được người dùng APPROVE) là xác nhận thực thi. Production không bao giờ được suy ra.
  if (approvalHash && approvalMode(env.application) && !productionReason(env)) return undefined;
  const c = readState(root).confirmations[ckey(env.key, requirementId)];
  const how = `npm run qa:env -- confirm --env=${env.key} --requirement=${requirementId}`;
  if (!c) return `Môi trường ${env.key} chưa được xác nhận thực thi cho ${requirementId}. Người dùng cần chạy trong terminal của mình: ${how}`;
  if (c.environment !== env.key || c.application !== env.application) return `Xác nhận không thuộc môi trường ${env.key}.`;
  if (!verifyText(payload(c), c.signature)) return `Xác nhận thực thi của ${env.key} không xác minh được chữ ký (bị sửa tay hoặc thiếu khoá). Cần xác nhận lại: ${how}`;
  if (c.host !== env.host) return `Xác nhận của ${env.key} cho host "${c.host}" nhưng .env hiện trỏ tới "${env.host}". Cần xác nhận lại: ${how}`;
  if (c.approvalHash !== approvalHash) return `Phê duyệt của ${requirementId} đã đổi so với lúc xác nhận môi trường ${env.key}. Cần xác nhận lại: ${how}`;
  if (now - Date.parse(c.at) > MAX_AGE_MS) return `Xác nhận thực thi của ${env.key} đã quá 24 giờ. Cần xác nhận lại: ${how}`;
  return undefined;
}

export type SelectedEnv = { env: ResolvedEnvironment; problem?: undefined } | { env?: undefined; problem: string };

/** Môi trường đang chọn, đã giải biến từ .env. Chưa chọn / không còn hợp lệ => problem. */
export function selectedEnvironment(root: string, source: NodeJS.ProcessEnv = process.env): SelectedEnv {
  const sel = readState(root).selected;
  if (!sel) return { problem: 'Chưa chọn môi trường kiểm thử. Chạy: npm run qa:env -- select --env=<TÊN> (xem danh sách: npm run qa:env -- list).' };
  const r = resolveEnvironment(sel.application, sel.environment, source);
  return r.ok ? { env: r.env } : { problem: `Môi trường đã chọn ${sel.environment} không hợp lệ: ${r.problems.join('; ')}` };
}

/**
 * Cho hook Playwright MCP: ngoài phiên thực thi hợp lệ, phải có môi trường đã chọn VÀ xác nhận riêng cho môi trường đó.
 * Trả về môi trường (để hook so khớp URL) hoặc lý do chặn.
 */
export function mcpEnvironment(root: string, requirements: Requirement[], defs: TestCaseDef[], source: NodeJS.ProcessEnv = process.env): SelectedEnv {
  const sel = selectedEnvironment(root, source);
  if (!sel.env) return sel;
  let marker: ExecutionMarker;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile(root), 'utf8')) as ExecutionMarker;
  } catch {
    return { problem: 'Chưa có phiên thực thi hợp lệ.' };
  }
  const req = requirements.find((r) => r.id === marker.requirementId);
  if (!req) return { problem: `Requirement ${marker.requirementId} của phiên thực thi không còn tồn tại.` };
  const hash = evaluate(root, req, defs.filter((d) => d.requirementId === req.id)).record?.approval?.hash ?? marker.hash;
  const problem = confirmationProblem(root, sel.env, req.id, hash);
  return problem ? { problem } : sel;
}

/** Phòng thủ chiều sâu cho từng test case: môi trường của lần chạy (QA_ENV) phải được xác nhận cho requirement của test case. */
export function tcEnvironmentProblem(tcId: string, root: string, requirements: Requirement[], defs: TestCaseDef[], app: string, envKey: string | undefined, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const def = defs.find((d) => d.id === tcId);
  if (!def) return undefined; // test kỹ thuật/không thuộc bảng test case
  if (!envKey) return 'Chưa chọn môi trường (QA_ENV). Chạy qua npm test --env=<TÊN> sau khi xác nhận môi trường.';
  const r = resolveEnvironment(app, envKey, source);
  if (!r.ok) return `Môi trường ${envKey} không hợp lệ: ${r.problems.join('; ')}`;
  const req = requirements.find((q) => q.id === def.requirementId);
  if (!req) return `test case ${tcId} thuộc requirement "${def.requirementId}" không tồn tại`;
  const hash = evaluate(root, req, defs.filter((d) => d.requirementId === req.id)).record?.approval?.hash;
  if (!hash) return `${req.id} chưa có phê duyệt hợp lệ`;
  return confirmationProblem(root, r.env, req.id, hash);
}

// ---- Chặn URL thực tế khác môi trường đã chọn ----
const URL_IN_TEXT = /\bhttps?:\/\/[^\s'"`<>\\)]+/gi;

/** Host của mọi URL tuyệt đối xuất hiện trong tham số của một lần gọi công cụ (kể cả trong đoạn mã). */
export function hostsInInput(input: unknown): string[] {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  const out = new Set<string>();
  for (const m of text.match(URL_IN_TEXT) ?? []) {
    try {
      out.add(new URL(m).host);
    } catch {
      out.add(m); // URL hỏng: giữ nguyên để bị coi là khác môi trường
    }
  }
  return [...out];
}

/** undefined = mọi URL trong tham số đều thuộc môi trường đã chọn; chuỗi = lý do chặn. */
export function urlProblem(input: unknown, env: Pick<ResolvedEnvironment, 'key' | 'host'>): string | undefined {
  const foreign = hostsInInput(input).filter((h) => h !== env.host);
  return foreign.length ? `URL thực tế (${foreign.join(', ')}) khác môi trường đã chọn ${env.key} (${env.host}). Không tự chuyển môi trường.` : undefined;
}
