import { computeCoverage } from '../testcases/coverage';
import type { Requirement, TcStatus } from '../testcases/schema';
import type { FocusInfo } from './focus';
import type { Summary, TcResult } from './types';

export const STATUS_ORDER: TcStatus[] = ['PASS', 'FAIL', 'BLOCKED', 'NEEDS CLARIFICATION', 'NOT RUN'];

export const statusCount = (s: Summary, st: TcStatus): number =>
  ({ PASS: s.passed, FAIL: s.failed, BLOCKED: s.blocked, 'NEEDS CLARIFICATION': s.needsClarification, 'NOT RUN': s.notRun })[st];

const pctText = (v: number | null) => (v === null ? 'N/A' : `${v}%`);

/**
 * Bản tổng kết bằng chữ (reports/qa-summary.md), sinh TỪ CÙNG `summary` và `results` với qa-results.json và qa-report.html.
 * Claude/người dùng sao chép số liệu từ file này, không tự đếm. `npm run report:verify` đối chiếu ba nơi với nhau.
 * Các dòng bảng trạng thái có dạng cố định "| TRẠNG THÁI | số |" để công cụ kiểm tra đọc lại.
 */
export interface ApprovalLine { id: string; state: string; reason: string; version?: number }

export function buildSummaryMarkdown(summary: Summary, results: TcResult[], requirements: Requirement[], approvals: ApprovalLine[] = [], environment?: string, focus?: FocusInfo): string {
  const L: string[] = [];
  L.push('# Tổng kết QA (sinh tự động từ reports/qa-results.json — không sửa tay)', '');
  L.push(`Sinh lúc: ${summary.generatedAt}`, '');
  if (environment) L.push(`Môi trường: **${environment}** (số liệu chỉ của môi trường này; không cộng gộp với môi trường khác)`, '');
  if (focus) {
    const f = focus.summary;
    L.push(`## Requirement đang xử lý: ${focus.requirementId} — ${focus.title}`, '', 'Đây là kết quả HIỆN TẠI của requirement đang xử lý. Mọi requirement khác và các lần chạy trước là lịch sử; bảng "Số liệu" bên dưới là của TOÀN BỘ requirement.', '', '| Chỉ số (requirement đang xử lý) | Giá trị |', '|---|---|');
    L.push(`| Tổng test case [focus] | ${f.total} |`);
    for (const st of STATUS_ORDER) L.push(`| ${st} [focus] | ${statusCount(f, st)} |`);
    L.push(`| Execution Pass Rate [focus] | ${pctText(f.executionPassRate)} |`, `| Overall Pass Coverage [focus] | ${pctText(f.overallPassCoverage)} |`, `| Bug [focus] (mở/tổng) | ${focus.bugs.open}/${focus.bugs.total} |`, '');
    const pv = focus.provenance;
    L.push(`Nguồn kết quả của ${focus.requirementId}: lần chạy gần nhất ${pv.latestRunId ?? '(chưa chạy)'} → ${pv.fromLatestRun} test case; các lần chạy trước (LỊCH SỬ) → ${pv.fromEarlierRuns}; chưa từng chạy → ${pv.neverRun}.`, '');
  }
  L.push(focus ? '## Số liệu toàn bộ requirement (gồm lịch sử)' : '## Số liệu', '', '| Chỉ số | Giá trị |', '|---|---|');
  L.push(`| Tổng test case | ${summary.total} |`);
  for (const st of STATUS_ORDER) L.push(`| ${st} | ${statusCount(summary, st)} |`);
  L.push(`| Đã chạy ra kết luận (PASS + FAIL) | ${summary.executed} |`);
  L.push(`| Execution Pass Rate | ${pctText(summary.executionPassRate)} |`);
  L.push(`| Overall Pass Coverage | ${pctText(summary.overallPassCoverage)} |`, '');
  L.push('Execution Pass Rate = Passed / (Passed + Failed). Overall Pass Coverage = Passed / Tổng test case.', '');

  const cov = computeCoverage(requirements, results.map((r) => r.def));
  L.push('## Theo requirement', '');
  for (const c of cov.filter((x) => x.requirementId !== '(toàn cục)')) {
    const mine = results.filter((r) => r.def.requirementId === c.requirementId);
    const by = STATUS_ORDER.map((st) => `${st} ${mine.filter((r) => r.status === st).length}`).join(', ');
    const modules = [...new Set(mine.map((r) => `${r.def.application ?? '-'}/${r.def.module ?? '-'}`))].sort();
    L.push(`### ${c.requirementId} — ${c.title}`);
    L.push(`- Test case: ${c.testCaseCount} (${by})`);
    if (modules.length) L.push(`- Module: ${modules.map((m) => `${m} ${mine.filter((r) => `${r.def.application ?? '-'}/${r.def.module ?? '-'}` === m).length}`).join('; ')}`);
    L.push(`- Phủ BR/AC: ${c.items.length - c.uncovered.length}/${c.items.length}${c.uncovered.length ? ` (chưa phủ: ${c.uncovered.join(', ')})` : ''}`);
    for (const e of c.errors) L.push(`- LỖI truy vết: ${e}`);
    L.push('');
  }

  if (approvals.length) {
    L.push('## Phê duyệt bộ test case (Approval Gate)', '');
    for (const a of approvals) L.push(`- ${a.id}: ${a.state}${a.version ? ` (v${a.version})` : ''} — ${a.reason}`);
    L.push('');
  }

  const listed = (st: TcStatus) => results.filter((r) => r.status === st);
  for (const st of ['FAIL', 'BLOCKED', 'NEEDS CLARIFICATION'] as TcStatus[]) {
    const rows = listed(st);
    if (!rows.length) continue;
    L.push(`## ${st} (${rows.length})`, '');
    for (const r of rows) L.push(`- ${r.def.id} — ${r.def.title}${r.reason ? `: ${r.reason}` : ''}`);
    L.push('');
  }
  return L.join('\n') + '\n';
}
