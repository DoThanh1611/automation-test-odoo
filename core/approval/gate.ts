import fs from 'node:fs';
import path from 'node:path';
import { evaluate, evaluateAndSync, type Evaluation } from './approval';
import type { Requirement, TestCaseDef } from '../testcases/schema';

/** Requirement có test case thuộc các project (<app>-<module>) được chọn; không chọn project nào = mọi module. */
export function requirementsInScope(requirements: Requirement[], defs: TestCaseDef[], projects?: string[], requirementIds?: string[]): Requirement[] {
  const wanted = projects?.length ? new Set(projects) : undefined;
  const ids = new Set(defs.filter((d) => !wanted || wanted.has(`${d.application}-${d.module}`)).map((d) => d.requirementId));
  const only = requirementIds ? new Set(requirementIds) : undefined;
  return requirements.filter((r) => ids.has(r.id) && (!only || only.has(r.id)));
}

export interface GateResult {
  ok: boolean;
  problems: string[];
  evaluations: { requirementId: string; evaluation: Evaluation }[];
}

/**
 * Cổng chạy test: MỌI requirement trong phạm vi phải có phê duyệt hợp lệ khớp hash bộ test case hiện tại.
 * Gọi trước khi mở bất kỳ kết nối nào tới staging (kể cả đăng nhập setup).
 */
export function gateForRun(root: string, requirements: Requirement[], defs: TestCaseDef[], projects?: string[], sync = true, requirementIds?: string[]): GateResult {
  const scope = requirementsInScope(requirements, defs, projects, requirementIds);
  const evaluations = scope.map((r) => ({
    requirementId: r.id,
    evaluation: (sync ? evaluateAndSync : evaluate)(root, r, defs.filter((d) => d.requirementId === r.id)),
  }));
  const problems = evaluations.filter((e) => !e.evaluation.ok).map((e) => `${e.requirementId}: ${e.evaluation.state} — ${e.evaluation.reason}`);
  for (const id of requirementIds ?? []) if (!scope.some((r) => r.id === id)) problems.push(`${id}: không có requirement/test case này trong phạm vi chạy.`);
  if (!scope.length && defs.length) problems.push('Có test case nhưng không tìm thấy requirement tương ứng trong phạm vi chạy.');
  return { ok: problems.length === 0, problems, evaluations };
}

/** Kiểm tra từng test case lúc chạy (phòng thủ chiều sâu: không tin biến môi trường của lệnh chạy). */
export function tcApprovalProblem(tcId: string, root: string, requirements: Requirement[], defs: TestCaseDef[]): string | undefined {
  const def = defs.find((d) => d.id === tcId);
  if (!def) return undefined; // test kỹ thuật/không thuộc bảng test case
  const req = requirements.find((r) => r.id === def.requirementId);
  if (!req) return `test case ${tcId} thuộc requirement "${def.requirementId}" không tồn tại`;
  const ev = evaluate(root, req, defs.filter((d) => d.requirementId === req.id));
  return ev.ok ? undefined : `${req.id}: ${ev.state} — ${ev.reason}`;
}

// ---- Phiên thực thi (dùng cho hook chặn Playwright MCP) ----
export interface ExecutionMarker { requirementId: string; version: number; hash: string; startedAt: string }
export const markerFile = (root: string) => path.join(root, '.qa-state', 'execution.json');
const MAX_AGE_MS = 24 * 3600 * 1000;

export function beginExecution(root: string, requirement: Requirement, defs: TestCaseDef[]): ExecutionMarker {
  const ev = evaluateAndSync(root, requirement, defs);
  if (!ev.ok) throw new Error(`Không được bắt đầu thực thi ${requirement.id}: ${ev.state} — ${ev.reason}`);
  const marker: ExecutionMarker = { requirementId: requirement.id, version: ev.record!.approval!.version, hash: ev.record!.approval!.hash, startedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(markerFile(root)), { recursive: true });
  fs.writeFileSync(markerFile(root), JSON.stringify(marker, null, 2) + '\n');
  return marker;
}

export function endExecution(root: string) {
  fs.rmSync(markerFile(root), { force: true });
}

/** undefined = được phép dùng Playwright MCP/kết nối staging; chuỗi = lý do chặn. Luôn kiểm tra lại hash hiện tại. */
export function executionProblem(root: string, requirements: Requirement[], defs: TestCaseDef[], now = Date.now()): string | undefined {
  const f = markerFile(root);
  if (!fs.existsSync(f)) return 'Chưa có phiên thực thi được phê duyệt. Cần: trình duyệt test case (submit), người dùng APPROVE, rồi `npm run qa:approval -- begin --requirement=<REQ-ID>`.';
  let marker: ExecutionMarker;
  try {
    marker = JSON.parse(fs.readFileSync(f, 'utf8')) as ExecutionMarker;
  } catch {
    return 'File phiên thực thi hỏng; chạy lại `npm run qa:approval -- begin`.';
  }
  if (now - Date.parse(marker.startedAt) > MAX_AGE_MS) return 'Phiên thực thi đã quá 24 giờ; chạy lại `npm run qa:approval -- begin`.';
  const req = requirements.find((r) => r.id === marker.requirementId);
  if (!req) return `Requirement ${marker.requirementId} của phiên thực thi không còn tồn tại.`;
  const ev = evaluate(root, req, defs.filter((d) => d.requirementId === req.id));
  if (!ev.ok) return `${req.id}: ${ev.state} — ${ev.reason}`;
  if (ev.record?.approval?.hash !== marker.hash) return `Phê duyệt của ${req.id} đã đổi so với lúc bắt đầu phiên thực thi.`;
  return undefined;
}
