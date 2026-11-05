import { gateForRun, requirementsInScope } from './gate';
import type { Requirement, TestCaseDef } from '../testcases/schema';

/**
 * Phạm vi một lần chạy test: những requirement nào phải qua Approval/Environment/Write Policy và test case nào được phép chạy.
 *  - Có `requirement`: CHỈ test case của requirement đó (không kéo theo requirement khác cùng module).
 *  - Không có: chạy theo project (module) như trước; MỌI requirement có test case trong các project đó đều phải được duyệt.
 * Phạm vi do scripts/run-tests.ts tính và truyền qua QA_GATE_SCOPE, nhưng KHÔNG được tin: playwright.config.ts và từng test
 * tính lại phê duyệt từ file, và test nằm ngoài phạm vi bị bỏ qua trước khi kết nối bất kỳ hệ thống nào.
 */
export interface RunScope {
  requirement?: string;
  requirementIds: string[];
  projects: string[];
}

export const SCOPE_ENV = 'QA_GATE_SCOPE';
export const OUT_OF_SCOPE_PREFIX = 'OUT OF SCOPE';

export function resolveRunScope(requirements: Requirement[], defs: TestCaseDef[], o: { projects?: string[]; requirement?: string }): { scope?: RunScope; problems: string[] } {
  const projects = o.projects ?? [];
  if (!o.requirement) {
    return { scope: { requirementIds: requirementsInScope(requirements, defs, projects).map((r) => r.id), projects }, problems: [] };
  }
  const id = o.requirement;
  if (!requirements.some((r) => r.id === id)) return { problems: [`Requirement "${id}" không tồn tại.`] };
  const mine = defs.filter((d) => d.requirementId === id);
  if (!mine.length) return { problems: [`Requirement "${id}" chưa có test case nào.`] };
  const own = [...new Set(mine.map((d) => `${d.application}-${d.module}`))];
  const foreign = projects.filter((p) => !own.includes(p));
  if (foreign.length) return { problems: [`Project ${foreign.join(', ')} không chứa test case của ${id} (các project của requirement này: ${own.join(', ')}).`] };
  return { scope: { requirement: id, requirementIds: [id], projects: projects.length ? projects : own }, problems: [] };
}

export function scopeFromEnv(env: NodeJS.ProcessEnv = process.env): RunScope | undefined {
  const raw = env[SCOPE_ENV];
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw) as RunScope;
    const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string');
    if (!strings(s.requirementIds) || !strings(s.projects) || (s.requirement !== undefined && typeof s.requirement !== 'string')) return undefined;
    return { requirement: s.requirement, requirementIds: s.requirementIds, projects: s.projects };
  } catch {
    return undefined;
  }
}

/** Tính lại từ file: mọi requirement trong phạm vi phải có phê duyệt hợp lệ. Rỗng = hợp lệ. Không ghi gì xuống đĩa. */
export function scopeGateProblems(root: string, requirements: Requirement[], defs: TestCaseDef[], scope: RunScope): string[] {
  if (!scope.requirementIds.length) return ['Phạm vi chạy không có requirement nào.'];
  if (scope.requirement && (scope.requirementIds.length !== 1 || scope.requirementIds[0] !== scope.requirement)) return ['Phạm vi theo requirement không nhất quán.'];
  return gateForRun(root, requirements, defs, scope.projects, false, scope.requirementIds).problems;
}

/** undefined = test case này được chạy trong phạm vi; chuỗi = lý do ngoài phạm vi. Dựa trên metadata test case (annotation tc), không dựa trên chuỗi tiêu đề. */
export function tcScopeProblem(tcId: string, defs: TestCaseDef[], scope: RunScope): string | undefined {
  const def = defs.find((d) => d.id === tcId);
  if (!def) return scope.requirement ? `test không gắn test case nào của ${scope.requirement}` : undefined;
  if (!scope.requirementIds.includes(def.requirementId ?? '')) return `${tcId} thuộc ${def.requirementId}, ngoài phạm vi lần chạy (${scope.requirementIds.join(', ')})`;
  return undefined;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Bộ lọc tiêu đề cho Playwright, dựng từ đúng danh sách ID test case của requirement (có biên để TC-SO-1 không khớp TC-SO-10).
 * Chỉ để KHÔNG LIỆT KÊ test ngoài phạm vi; ranh giới an toàn thật là tcScopeProblem theo annotation (kiểm tra lại trong từng test).
 */
export function scopeGrep(defs: TestCaseDef[], scope: RunScope): RegExp | undefined {
  if (!scope.requirement) return undefined;
  const ids = defs.filter((d) => d.requirementId === scope.requirement).map((d) => esc(d.id)).sort((a, b) => b.length - a.length);
  return ids.length ? new RegExp(`(?<![\\w-])(?:${ids.join('|')})(?![\\w-])`) : /(?!)/;
}
