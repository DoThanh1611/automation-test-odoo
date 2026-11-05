import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from '../approval/approval';
import { markerFile, type ExecutionMarker } from '../approval/gate';
import type { ResolvedEnvironment } from '../environment/config';
import type { Requirement, TestCaseDef } from '../testcases/schema';
import { policyCheck, productionReason } from './policy';

/**
 * Chính sách ghi áp dụng cả cho thao tác qua Playwright MCP (không chỉ npm scripts).
 * Hook không thể BIẾT chắc một cú click có ghi dữ liệu hay không, nên phân loại THEO Ý ĐỊNH (bảo thủ, thiên về chặn):
 *  - Công cụ chỉ đọc (navigate, snapshot, screenshot, hover, wait...) luôn qua.
 *  - Click/gõ/chọn có nhãn thuộc động từ ghi (Lưu, Save, Xác nhận, Tạo hóa đơn, Hủy, Xóa, Validate, Thanh toán, Import...),
 *    phím tắt lưu, và mã tự do (run_code_unsafe/evaluate) có thao tác ghi => "ý định ghi".
 *  - Mã tự do gọi call_kw: chỉ các phương thức đọc (search_read, read, fields_get...) được coi là đọc.
 * Ý định ghi cần: môi trường không phải production VÀ chính sách ghi đã được người dùng xác nhận cho phiên. Mỗi lần được cho qua đều ghi nhật ký.
 * Giới hạn: đây là phân loại theo heuristic, không chứng minh được bản ghi bị tác động là dữ liệu framework; quy tắc của /qa-requirement
 * yêu cầu Claude chỉ ghi lên bản ghi trong registry.
 */
const READ_TOOLS = new Set(['navigate', 'navigate_back', 'snapshot', 'take_screenshot', 'console_messages', 'network_requests', 'network_request', 'wait_for', 'tabs', 'resize', 'hover', 'find', 'close', 'emulate_media']);
const READ_RPC = new Set(['search_read', 'read', 'search', 'search_count', 'fields_get', 'name_search', 'name_get', 'check_access_rights', 'check_access_rule', 'read_group', 'web_search_read', 'web_read', 'web_read_group', 'default_get', 'onchange']);
const WRITE_WORDS = /(lưu|save|xác nhận|confirm|tạo hóa đơn|tạo hoá đơn|create invoice|\btạo\b|\bcreate\b|xóa|xoá|delete|hủy|huỷ|cancel|validate|xác thực|\bpost\b|vào sổ|thanh toán|payment|thu tiền|\bduyệt\b|approve|gửi|\bsend\b|import|submit|áp dụng|apply|unlock|mở khóa|mở khoá|reset|ghi nhận)/i;
const SAVE_KEYS = /(control|ctrl|meta|cmd)\+s\b/i;
const CODE_UI_WRITE = /\.(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles|dragTo|tap)\s*\(|\.keyboard\.|\.mouse\./;

const labelOf = (input: unknown): string => {
  const o = (input ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(o.fields) ? (o.fields as Record<string, unknown>[]).map((f) => `${f.name ?? ''} ${f.element ?? ''}`).join(' ') : '';
  return [o.element, o.description, o.text, o.name, fields].filter(Boolean).join(' ');
};

/** Lý do thao tác này có Ý ĐỊNH GHI (undefined = chỉ đọc). Thuần hàm. */
export function mcpWriteIntent(tool: string, input: unknown): string | undefined {
  const t = tool.replace(/^mcp__playwright__browser_/, '');
  if (READ_TOOLS.has(t)) return undefined;
  const o = (input ?? {}) as Record<string, unknown>;
  if (t === 'run_code_unsafe' || t === 'evaluate') {
    const code = String(o.code ?? o.function ?? '');
    const rpc = [...code.matchAll(/call_kw\/[\w.]+\/(\w+)/g)].map((m) => m[1]);
    const bad = rpc.filter((m) => !READ_RPC.has(m));
    if (bad.length) return `mã tự do gọi RPC không phải đọc (${[...new Set(bad)].join(', ')})`;
    if (/call_button|\/web\/dataset\/call(?!_kw)/.test(code)) return 'mã tự do gọi nút/hành động của Odoo';
    if (/method\s*:\s*['"`]?(unlink|write|create|action_\w+|button_\w+)/.test(code)) return 'mã tự do gọi phương thức ghi';
    if (CODE_UI_WRITE.test(code)) return 'mã tự do thao tác giao diện (click/gõ/phím) có thể lưu dữ liệu';
    return undefined;
  }
  if (t === 'press_key') return SAVE_KEYS.test(String(o.key ?? '')) ? 'phím tắt Lưu' : undefined;
  if (t === 'file_upload' || t === 'drop' || t === 'drag') return 'tải tệp/kéo thả có thể ghi dữ liệu';
  if (t === 'handle_dialog') return o.accept === false ? undefined : 'chấp nhận hộp thoại xác nhận có thể ghi dữ liệu';
  if (['click', 'type', 'fill_form', 'select_option'].includes(t)) {
    if (t === 'type' && o.submit === true) return 'gõ kèm gửi (submit)';
    const label = labelOf(input);
    return WRITE_WORDS.test(label) ? `thao tác "${label.slice(0, 60)}" có nhãn của hành động ghi` : undefined;
  }
  return undefined; // công cụ không biết: không coi là ghi (hook chính vẫn chặn khi chưa có phê duyệt/môi trường)
}

export interface McpWriteCheck {
  ok: boolean;
  problem?: string;
  requirementId?: string;
  sessionId?: string;
}

/** Ý định ghi qua MCP được phép không? Cần: không production, phiên thực thi, và chính sách ghi hợp lệ cho requirement của phiên. */
export function mcpWriteProblem(root: string, env: ResolvedEnvironment, requirements: Requirement[], defs: TestCaseDef[], now = Date.now()): McpWriteCheck {
  const prod = productionReason(env);
  if (prod) return { ok: false, problem: `môi trường ${env.key} bị coi là production (${prod}): không có quyền ghi qua Playwright MCP.` };
  let marker: ExecutionMarker;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile(root), 'utf8')) as ExecutionMarker;
  } catch {
    return { ok: false, problem: 'chưa có phiên thực thi hợp lệ.' };
  }
  const req = requirements.find((r) => r.id === marker.requirementId);
  const hash = req ? evaluate(root, req, defs.filter((d) => d.requirementId === req.id)).record?.approval?.hash : undefined;
  if (!req || !hash) return { ok: false, problem: `requirement ${marker.requirementId} chưa có phê duyệt hợp lệ.` };
  const c = policyCheck(root, env, req.id, hash, now);
  return c.ok ? { ok: true, requirementId: req.id, sessionId: c.confirmation?.sessionId } : { ok: false, problem: c.problem, requirementId: req.id };
}

/** Nhật ký các thao tác ghi qua MCP được cho qua (chỉ ghi thêm). */
export function auditMcpWrite(root: string, entry: Record<string, unknown>) {
  try {
    const f = path.join(root, '.qa-state', 'mcp-writes.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* nhật ký phụ không được làm hỏng hook */ }
}
