import fs from 'node:fs';
import path from 'node:path';
import { defHash } from '../core/testcases/hash';
import { loadTestCases } from '../core/testcases/loader';
import { writeAggregate } from '../core/reporters/qa-reporter';
import type { RunFile, TcRunEntry } from '../core/reporters/types';

// Chuyển báo cáo định dạng cũ (reports/qa-results.json + reports/artifacts) thành 1 lần chạy trong reports/runs/<runId>/.
// Chỉ DI CHUYỂN file, không xoá bằng chứng. Chạy lại an toàn (bỏ qua nếu đã chuyển). Không đụng tới Odoo.
const reports = path.resolve('reports');
const legacyFile = path.join(reports, 'qa-results.json');
if (!fs.existsSync(legacyFile)) {
  console.log('Không có báo cáo định dạng cũ để chuyển.');
  process.exit(0);
}
const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
if (legacy.runs) {
  console.log('Báo cáo đã ở định dạng mới (có danh sách lần chạy). Không cần chuyển.');
  process.exit(0);
}

const iso: string = legacy.summary.generatedAt;
const runId = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
const dest = path.join(reports, 'runs', runId);
if (fs.existsSync(path.join(dest, 'results.json'))) {
  console.log(`Lần chạy ${runId} đã tồn tại. Không chuyển lại.`);
  process.exit(0);
}
fs.mkdirSync(dest, { recursive: true });
for (const name of ['artifacts', 'playwright-html', 'playwright-results.json']) {
  const src = path.join(reports, name);
  if (fs.existsSync(src)) fs.renameSync(src, path.join(dest, name));
}

const defs = loadTestCases();
// Chỉ các test case THỰC SỰ có chạy: PASS/FAIL/BLOCKED. NEEDS CLARIFICATION/NOT RUN của báo cáo cũ là giá trị mặc định từ định nghĩa.
const entries: TcRunEntry[] = (legacy.testCases as any[])
  .filter((t) => ['PASS', 'FAIL', 'BLOCKED'].includes(t.status))
  .map((t) => ({
    tcId: t.def.id,
    defHash: defHash(defs.find((d) => d.id === t.def.id) ?? t.def),
    status: t.status,
    actual: t.actual,
    reason: t.status === 'BLOCKED' ? t.actual : undefined,
    durationMs: t.durationMs,
    data: t.data,
    error: t.error,
    evidence: t.evidence, // 'artifacts/...' vốn tương đối so với reports/, nay tương đối so với thư mục lần chạy: giữ nguyên
  }));
const run: RunFile = { runId, startedAt: iso, finishedAt: iso, baseURL: undefined, entries };
fs.writeFileSync(path.join(dest, 'results.json'), JSON.stringify(run, null, 2));
console.log(`Đã chuyển ${entries.length} kết quả vào reports/runs/${runId}/`);
writeAggregate(reports);
