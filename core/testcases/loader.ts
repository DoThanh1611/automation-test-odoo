import fs from 'node:fs';
import path from 'node:path';
import { computeCoverage } from './coverage';
import type { Requirement, TestCaseDef, TestCaseSuite } from './schema';

const root = process.cwd();

function readJsonFiles<T>(dir: string): T[] {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out: T[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...readJsonFiles<T>(path.join(dir, entry.name)));
    else if (entry.name.endsWith('.json')) out.push(JSON.parse(fs.readFileSync(p, 'utf8')) as T);
  }
  return out;
}

export const loadRequirements = () => readJsonFiles<Requirement>('requirements');

/** Test case kèm requirementId/application/module lấy từ requirement của bộ test case (phục vụ lọc và truy vết trong báo cáo). */
export function loadTestCases(): TestCaseDef[] {
  const reqs = new Map(loadRequirements().map((r) => [r.id, r]));
  return readJsonFiles<TestCaseSuite>('testcases').flatMap((s) =>
    s.testCases.map((tc) => ({
      ...tc,
      requirementId: s.requirementId,
      application: s.application ?? reqs.get(s.requirementId)?.application,
      module: s.module ?? reqs.get(s.requirementId)?.module,
    })),
  );
}

export const loadGlossary = (): Record<string, string> =>
  Object.assign({}, ...readJsonFiles<TestCaseSuite>('testcases').map((s) => s.glossary ?? {}));

export function getTestCase(id: string): TestCaseDef {
  const tc = loadTestCases().find((t) => t.id === id);
  if (!tc) throw new Error(`Test case ${id} không có trong testcases/*.json`);
  return tc;
}

/** Kiểm tra truy vết THEO TỪNG requirement: lỗi tham chiếu/trùng ID, và danh sách BR/AC chưa có test case (dạng "REQ-ID:BR-01"). */
export function validateTraceability() {
  const cov = computeCoverage(loadRequirements(), loadTestCases());
  return {
    errors: cov.flatMap((c) => c.errors),
    uncovered: cov.flatMap((c) => c.uncovered.map((id) => `${c.requirementId}:${id}`)),
  };
}
