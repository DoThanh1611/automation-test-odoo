import { computeCoverage } from '../testcases/coverage';
import type { Requirement } from '../testcases/schema';
import type { TcResult } from './types';

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('vi-VN') : '');
const CLS: Record<string, string> = { PASS: 'pass', FAIL: 'fail', BLOCKED: 'blocked', 'NEEDS CLARIFICATION': 'clarify', 'NOT RUN': 'notrun' };

/** Một test case trong 1 lần chạy (đường dẫn evidence đã tính tương đối so với thư mục reports/). */
export interface RunEntryView {
  tcId: string;
  title: string;
  status: string;
  actual: string;
  reason?: string;
  video?: string;
  screenshots: string[];
  trace?: string;
}

/** Tóm tắt 1 lần chạy cho phần Lịch sử chạy test. */
export interface RunMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  testCases: number;
  writesEnabled?: boolean;
  /** "application/module" của các test case đã chạy. */
  scopes?: string[];
  counts?: Record<string, number>;
  /** Requirement mà lần chạy này có test case (để tab Lịch sử lọc theo requirement). */
  requirementIds?: string[];
  /** Số test case và kết quả theo từng requirement trong lần chạy này. */
  byRequirement?: Record<string, { testCases: number; counts: Record<string, number> }>;
  /** null = không có dữ liệu thời lượng đáng tin (không suy đoán). */
  durationMs?: number | null;
  entries?: RunEntryView[];
}

/** Thời lượng chỉ tính khi có đủ hai mốc hợp lệ và kết thúc sau bắt đầu; ngược lại null. */
export function runDurationMs(startedAt?: string, finishedAt?: string): number | null {
  const a = Date.parse(startedAt ?? '');
  const b = Date.parse(finishedAt ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : null;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'Không có dữ liệu';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  return `${m} phút ${s % 60} giây`;
}

const shortWhen = (iso?: string) => {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return 'Không có dữ liệu';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Lịch sử chạy: mỗi lần chạy một dòng ngắn; bấm vào để xem kết quả và bằng chứng riêng của lần chạy đó. */
export function renderRuns(runs: RunMeta[]): string {
  if (!runs.length) return '';
  const sorted = [...runs].sort((a, b) => b.runId.localeCompare(a.runId));
  const items = sorted.map((r) => {
    const c = r.counts ?? {};
    const dur = r.durationMs === undefined ? runDurationMs(r.startedAt, r.finishedAt) : r.durationMs;
    const scope = r.scopes?.length ? r.scopes.join(', ') : 'Không có dữ liệu';
    const line = `${esc(shortWhen(r.startedAt))} | ${esc(scope)} | ${r.testCases} test | ${c.PASS ?? 0} PASS | ${c.FAIL ?? 0} FAIL | ${c.BLOCKED ?? 0} BLOCKED | ${c['NEEDS CLARIFICATION'] ?? 0} NEEDS CLARIFICATION | ${c['NOT RUN'] ?? 0} NOT RUN | Thời lượng: ${esc(formatDuration(dur))}`;
    const rows = (r.entries ?? []).map((e) => {
      const ev = [fileLink('Video', e.video), ...e.screenshots.map((s) => fileLink('Screenshot', s)), e.trace ? `Trace: <code>${esc(e.trace)}</code>` : ''].filter(Boolean).join(' · ');
      return `<tr><td><a href="#tc-${esc(e.tcId)}" data-tc="${esc(e.tcId)}">${esc(e.tcId)}</a></td><td><span class="tcchip ${CLS[e.status] ?? 'notrun'}">${esc(e.status)}</span></td><td>${esc(e.title)}<br><small>${esc(e.actual)}${e.reason ? ` — Lý do: ${esc(e.reason)}` : ''}</small></td><td>${ev || '<i>không có</i>'}</td></tr>`;
    }).join('');
    return `<details class="run"><summary>${line}</summary>
      <p class="sub">Lần chạy <b>${esc(r.runId)}</b> · bắt đầu ${esc(when(r.startedAt))} · kết thúc ${esc(when(r.finishedAt))} · ${r.writesEnabled === undefined ? 'quyền ghi: không rõ (lần chạy cũ)' : r.writesEnabled ? 'ĐÃ BẬT quyền ghi dữ liệu' : 'chỉ đọc (quyền ghi tắt)'}</p>
      <table class="tr"><tr><th>Test case</th><th>Kết quả</th><th>Actual</th><th>Bằng chứng</th></tr>${rows}</table></details>`;
  }).join('');
  return `<details class="sect" id="runsec"><summary>Lịch sử chạy test (${runs.length} lần) <small>— bảng tổng hợp ở trên lấy kết quả mới nhất của từng test case</small></summary>${items}</details>`;
}

/** Truy vết BR/AC theo từng requirement: mỗi BR/AC kèm các test case và trạng thái hiện tại; BR/AC chưa phủ bị đánh dấu. */
export function renderTraceability(requirements: Requirement[], results: TcResult[]): string {
  const status = new Map(results.map((r) => [r.def.id, r.status]));
  const cov = computeCoverage(requirements, results.map((r) => r.def)).filter((c) => c.requirementId !== '(toàn cục)');
  if (!cov.length) return '';
  const blocks = cov.map((c) => {
    const covered = c.items.length - c.uncovered.length;
    const rows = c.items
      .map((i) => {
        const chips = i.testCases.length
          ? i.testCases.map((t) => `<a class="tcchip ${CLS[status.get(t) ?? 'NOT RUN']}" href="#tc-${esc(t)}" data-tc="${esc(t)}" title="${esc(status.get(t) ?? '')}">${esc(t)}</a>`).join(' ')
          : '<b class="warn">CHƯA CÓ TEST CASE</b>';
        return `<tr><td><b>${esc(i.id)}</b></td><td>${esc(i.text)}</td><td>${chips}</td></tr>`;
      })
      .join('');
    return `<details class="legend trace"><summary>${esc(c.requirementId)} — ${esc(c.title)} <small>[${esc(c.application)}/${esc(c.module)}]</small>: ${covered}/${c.items.length} BR/AC có test case${c.uncovered.length ? ` · <b class="warn">${c.uncovered.length} chưa phủ</b>` : ''} · ${c.testCaseCount} test case</summary>
      <table class="tr"><tr><th>BR/AC</th><th>Nội dung gốc (nguyên văn)</th><th>Test case</th></tr>${rows}</table></details>`;
  });
  return `<details class="sect"><summary>Truy vết BR/AC (${cov.length} requirement)</summary>${blocks.join('')}</details>`;
}

const fileLink = (label: string, p?: string) => (p ? `<a href="${esc(p)}" target="_blank">${label}</a>` : '');

/** Tuỳ chọn cho ô lọc: các giá trị phân biệt, đã sắp xếp. */
export function filterOptions(values: (string | undefined)[], label: string): string {
  const uniq = [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
  return `<option value="">${esc(label)}</option>${uniq.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
}
