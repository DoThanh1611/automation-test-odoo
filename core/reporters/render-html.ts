import type { Requirement, TcStatus } from '../testcases/schema';
import { computeCoverage } from '../testcases/coverage';
import { VERIFICATION_LABEL, type Bug } from './bugs';
import type { FocusInfo } from './focus';
import { descriptionIsRedundant, plainTerms, presentActual, presentBugTrust, presentSteps } from './present';
import { filterOptions, formatDuration, runDurationMs, type RunMeta } from './render-extras';
import type { Summary, TcResult } from './types';

export type { Summary, TcResult } from './types';

/**
 * Báo cáo QA dạng trang HTML tĩnh, thiết kế theo bản thiết kế của người dùng (tiêu đề "Báo cáo kiểm thử <REQ-ID>: <tên requirement>"):
 * tiêu đề + nút thao tác, bảng Chỉ số thực thi (chỉ đọc, không bấm được), thanh tab (Tất cả/Pass/Fail/Block/Need Clarify/Not run/Ma trận truy vết/Lịch sử test),
 * từng test case dạng thẻ (Description, Steps, Actual, Expected, video/ảnh bằng chứng, ảnh bug có phóng to), ma trận truy vết REQ ↔ Test case, lịch sử chạy.
 * Các thuộc tính data-* (data-filter, data-focus, data-status) là hợp đồng để `report:verify` đối chiếu số liệu giữa JSON, HTML và QA Summary.
 */
export interface RenderInput {
  summary: Summary;
  results: TcResult[];
  glossary: Record<string, string>;
  requirements: Requirement[];
  /** Các lần chạy đã lưu (để hiển thị nguồn của kết quả). */
  runs?: RunMeta[];
  /** Bug tự sinh từ các test FAIL trong lịch sử các lần chạy. */
  bugs?: Bug[];
  /** Requirement đang xử lý: danh sách mặc định lọc theo requirement này. */
  focus?: FocusInfo;
  /** Người phê duyệt theo requirement (từ approvals/, có chữ ký). */
  approvers?: Record<string, { by: string; at: string }>;
  /** Môi trường của báo cáo (ví dụ STAGING_A). */
  environment?: string;
}

const STATUS: Record<TcStatus, { cls: string; vi: string; tab: string; hint: string; sub: string }> = {
  PASS: { cls: 'pass', vi: 'Đạt', tab: 'Pass', hint: 'Test đã chạy và mọi kiểm tra đều đúng như mong đợi', sub: 'Đạt tiêu chuẩn chất lượng' },
  FAIL: { cls: 'fail', vi: 'Lỗi', tab: 'Fail', hint: 'Test đã chạy nhưng kết quả KHÁC mong đợi (có thể là bug)', sub: 'Yêu cầu tạo bug fix' },
  BLOCKED: { cls: 'blocked', vi: 'Bị chặn', tab: 'Block', hint: 'Không chạy được vì thiếu điều kiện (tài khoản, dữ liệu, quyền...)', sub: 'Tắc nghẽn môi trường / API' },
  'NEEDS CLARIFICATION': { cls: 'clarify', vi: 'Cần làm rõ', tab: 'Need Clarify', hint: 'Requirement chưa đủ rõ để xác định kết quả mong đợi', sub: 'Cần BA/Claude làm rõ' },
  'NOT RUN': { cls: 'notrun', vi: 'Chưa chạy', tab: 'Not run', hint: 'Chưa được thực thi trong lần chạy này', sub: 'Chưa kích hoạt chạy' },
};
const ORDER: TcStatus[] = ['PASS', 'FAIL', 'BLOCKED', 'NEEDS CLARIFICATION', 'NOT RUN'];

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('vi-VN') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const pctText = (v: number | null) => (v === null ? 'N/A' : `${v}%`);

/** Ngày giờ theo mẫu thiết kế: 05/11/2026 - 09:15:00 A.M. */
export function stampVi(iso?: string): string {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return 'Không có dữ liệu';
  const p = (n: number) => String(n).padStart(2, '0');
  const h = d.getHours();
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} - ${p(h % 12 === 0 ? 12 : h % 12)}:${p(d.getMinutes())}:${p(d.getSeconds())} ${h < 12 ? 'A.M.' : 'P.M.'}`;
}

/** Trạng thái nghiệm thu của một requirement từ trạng thái các test case của nó (xấu nhất thắng). */
export function acceptanceOf(statuses: TcStatus[]): { cls: string; label: string } {
  if (statuses.includes('FAIL')) return { cls: 'fail', label: 'Cần sửa' };
  if (statuses.includes('BLOCKED')) return { cls: 'blocked', label: 'Bị chặn' };
  if (statuses.includes('NEEDS CLARIFICATION')) return { cls: 'clarify', label: 'Cần làm rõ' };
  if (!statuses.length || statuses.includes('NOT RUN')) return { cls: 'notrun', label: 'Chưa chạy' };
  return { cls: 'pass', label: 'Đạt' };
}

const ICON = {
  chart: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 17v-5M12 17V8M16 17v-3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
  matrix: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="6" height="5"/><rect x="15" y="4" width="6" height="5"/><rect x="15" y="15" width="6" height="5"/><path d="M9 6.5h6M12 6.5v11h3"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4M12 8v5l3 2"/></svg>',
  clip: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11l-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.9-2.9l8.3-8.3"/></svg>',
  steps: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>',
  ok: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>',
  bug: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="8" height="11" rx="4"/><path d="M12 8V5M5 10l3 1M19 10l-3 1M5 17l3-1M19 17l-3-1M9 4l1.5 2M15 4l-1.5 2"/></svg>',
};

const SELF_TOKEN = '__QA_REPORT_SOURCE__';

export function renderHtml(input: RenderInput): string {
  const { summary: s, glossary, requirements, focus, approvers = {}, environment } = input;
  // Một requirement — một báo cáo: khi có requirement đang xử lý, MỌI thành phần (test case, bug, evidence, lịch sử, ma trận) chỉ gồm requirement đó.
  // Dữ liệu của requirement khác không có mặt trong HTML (kể cả ẩn); chúng vẫn nằm nguyên trong reports/runs/* và qa-results.json.
  const results = focus ? input.results.filter((r) => r.def.requirementId === focus.requirementId) : input.results;
  const bugs = focus ? (input.bugs ?? []).filter((b) => b.requirementId === focus.requirementId) : (input.bugs ?? []);
  const runs = focus ? (input.runs ?? []).filter((r) => Boolean(r.byRequirement?.[focus.requirementId])) : (input.runs ?? []);
  const generatedAt = s.generatedAt;
  const bugsByTc = new Map<string, Bug[]>();
  for (const b of bugs) bugsByTc.set(b.relatedTestCase, [...(bugsByTc.get(b.relatedTestCase) ?? []), b]);
  const reqText = new Map<string, string>();
  for (const r of requirements) for (const x of [...r.businessRules, ...r.acceptanceCriteria]) reqText.set(x.id, x.text);
  const reqTitle = new Map(requirements.map((r) => [r.id, r.title]));

  // ---- Phạm vi của dashboard: requirement đang xử lý nếu có, nếu không là toàn bộ ----
  const scope = focus ? focus.summary : s;
  const attr = focus ? 'data-focus' : 'data-metric';
  const count = (st: TcStatus) => (st === 'PASS' ? scope.passed : st === 'FAIL' ? scope.failed : st === 'BLOCKED' ? scope.blocked : st === 'NEEDS CLARIFICATION' ? scope.needsClarification : scope.notRun);
  const fullCount = (st: TcStatus) => (st === 'PASS' ? s.passed : st === 'FAIL' ? s.failed : st === 'BLOCKED' ? s.blocked : st === 'NEEDS CLARIFICATION' ? s.needsClarification : s.notRun);
  const rate = scope.executionPassRate;
  const barPct = rate === null ? 0 : Math.max(0, Math.min(100, rate));

  const tiles = [
    `<div class="mt total"><div class="mh"><span>Tổng Test Case</span><i class="ic">${ICON.list}</i></div><b ${attr}="TOTAL">${scope.total}</b><small>${focus ? `Phạm vi ${esc(focus.requirementId)}` : '100% phạm vi kiểm thử'}</small></div>`,
    ...ORDER.map((st) => `<div class="mt ${STATUS[st].cls}" title="${esc(STATUS[st].hint)}"><div class="mh"><span>${STATUS[st].tab}</span><i class="dot"></i></div><b ${attr}="${st}">${count(st)}</b><small>${esc(STATUS[st].sub)}</small></div>`),
    `<div class="mt rate" title="Execution Pass Rate = Passed ÷ (Passed + Failed). Chỉ tính các test đã chạy ra kết luận; không tính BLOCKED, NEEDS CLARIFICATION, NOT RUN."><div class="mh"><span>Tỉ lệ Pass (%)</span><i class="pc">%</i></div><b class="big" ${attr}="RATE">${pctText(rate)}</b><div class="pbar"><i style="width:${barPct}%"></i></div><small>Pass ÷ (Pass + Fail) · Coverage ${pctText(scope.overallPassCoverage)}</small></div>`,
  ].join('');

  // Số liệu TOÀN BỘ requirement (gồm lịch sử): hiện khi có requirement đang xử lý; luôn có trong HTML để report:verify đối chiếu.
  const allStrip = focus ? '' : `<div class="allstrip" id="allstrip" hidden>Toàn bộ requirement (gồm lịch sử): <span data-filter="ALL"><b>${s.total}</b> test case</span>${ORDER.map((st) => ` · <span data-filter="${st}"><b>${fullCount(st)}</b> ${st}</span>`).join('')} · <span class="kv"><b>${pctText(s.executionPassRate)}</b><span>Execution Pass Rate</span></span> · <span class="kv"><b>${pctText(s.overallPassCoverage)}</b><span>Overall Pass Coverage</span></span></div>`;
  const provenance = focus
    ? `<div class="prov" data-prov="${esc(focus.provenance.latestRunId ?? '')}">Kết quả của <b>${esc(focus.requirementId)}</b>: lần chạy gần nhất ${esc(focus.provenance.latestRunId ?? '(chưa chạy)')} → ${focus.provenance.fromLatestRun} test case · lần chạy trước của chính requirement này → ${focus.provenance.fromEarlierRuns} · chưa từng chạy → ${focus.provenance.neverRun} · Bug đang mở ${focus.bugs.open}${focus.bugs.total > focus.bugs.open ? ` (${focus.bugs.total - focus.bugs.open} bug đã được thay thế bởi lần chạy mới)` : ''}</div>`
    : '';

  const scoped = results;
  const tabCount = (st: TcStatus) => scoped.filter((r) => r.status === st).length;
  const tabs = [
    `<button type="button" class="tab active" data-tab="ALL"><i class="ic">${ICON.list}</i>Tất cả <span class="n">${scoped.length}</span></button>`,
    ...ORDER.map((st) => `<button type="button" class="tab" data-tab="${st}"><i class="dot ${STATUS[st].cls}"></i>${STATUS[st].tab} <span class="n ${STATUS[st].cls}">${tabCount(st)}</span></button>`),
    '<span class="sep"></span>',
    `<button type="button" class="tab" data-tab="RTM"><i class="ic">${ICON.matrix}</i>Ma trận truy vết REQ với Test case</button>`,
    `<button type="button" class="tab" data-tab="HISTORY"><i class="ic">${ICON.history}</i>Lịch sử test</button>`,
  ].join('');

  // ---- Thẻ test case ----
  const cards = results.map((r) => {
    const used = new Set<string>();
    const ann = (t: unknown) => {
      const p = plainTerms(String(t), glossary);
      p.used.forEach((k) => used.add(k));
      return esc(p.text);
    };
    const st = STATUS[r.status];
    const when = (iso?: string) => (iso ? stampVi(iso) : '');
    const tcBugs = bugsByTc.get(r.def.id) ?? [];
    const liveBug = tcBugs.find((b) => b.status === 'OPEN'); // chỉ bug đang mở mới hiện nhãn "Bug đang mở" ở chân thẻ

    const steps = presentSteps(r.def.steps).map((x, i) => `<li><b>Step ${i + 1}:</b> ${ann(x)}</li>`).join('');
    const shown = presentActual({ actual: r.actual, status: r.status, reason: r.reason, summary: r.summary, technical: r.technical, error: r.error, blockedKind: r.blockedKind, summarySource: r.summarySource, summaryBasis: r.summaryBasis });
    // Dữ liệu chạy + diễn giải thuật ngữ nằm trong mục "Chi tiết kỹ thuật" sẵn có (không tạo mục mới).
    if (r.data && Object.keys(r.data).length) shown.details.push({ title: 'Dữ liệu thực tế đã dùng khi chạy', text: Object.entries(r.data).map(([k, v]) => `${k}: ${fmt(v)}`).join('\n') });
    const expHtml = ann(r.def.expectedResult);
    const showDesc = !descriptionIsRedundant(r.def.description, [r.def.title, r.def.expectedResult, ...r.def.steps]);
    const descHtml = ann(r.def.description);
    if (used.size) shown.details.push({ title: 'Giải thích thuật ngữ trong Steps/Expected', text: [...used].map((k) => `${k}: ${glossary[k]}`).join('\n') });
    if (r.evidence.trace) shown.details.push({ title: 'Playwright Trace', text: `npx playwright show-trace ${r.evidence.trace}` });
    const techId = `tech-${r.def.id}`;
    const techHtml = shown.details.length
      ? `<details class="techdetail" id="${esc(techId)}"><summary>Chi tiết kỹ thuật</summary>${shown.details.map((d) => `<div class="tdi"><h6>${esc(d.title)}</h6><pre>${esc(d.text)}</pre></div>`).join('')}</details>`
      : '';
    const notes: string[] = [];
    if (r.readOnlySkip) notes.push(`<div class="note"><b>Lưu ý:</b> lần chạy chỉ đọc ${esc(r.readOnlySkip.runId)} (${esc(when(r.readOnlySkip.executedAt))}) không thực thi test ghi này (BLOCKED vì chưa cấp quyền ghi) nên kết quả hiển thị vẫn là của lần chạy trước có cùng định nghĩa test case.</div>`);
    if (r.stale) notes.push(`<div class="note stale"><b>Kết quả cũ không còn áp dụng:</b> lần chạy ${esc(r.stale.runId)} (${esc(when(r.stale.executedAt))}) cho kết quả <b>${esc(r.stale.status)}</b>, nhưng định nghĩa test case đã thay đổi sau đó. Cần chạy lại để có kết quả cho định nghĩa hiện tại.</div>`);
    if (r.status === 'BLOCKED' && r.reason) notes.push(`<div class="note blockednote"><b>Lý do bị chặn (BLOCKED):</b> ${esc(r.reason)}</div>`);
    if (r.status === 'NEEDS CLARIFICATION' && r.reason) notes.push(`<div class="note"><b>Phần chưa xác minh được (NEEDS CLARIFICATION):</b> ${esc(r.reason)}</div>`);
    if (r.def.needsClarification && r.def.needsClarification !== r.reason) notes.push(`<div class="note"><b>Ghi chú nghiệp vụ:</b> ${esc(r.def.needsClarification)}</div>`);

    // Bằng chứng: video toàn màn hình luôn đính kèm khi có; ảnh chụp màn hình (bug) kèm nút phóng to.
    const fileName = (p: string) => p.split('/').pop() ?? p;
    const video = r.evidence.video
      ? `<div class="vid"><div class="vh"><span><i class="rec"></i> Video quay toàn màn hình quá trình thực thi</span></div><video controls preload="metadata" src="${esc(r.evidence.video)}"></video><div class="vf">Screen-record: ${esc(fileName(r.evidence.video))}</div></div>`
      : '';
    // PASS: chỉ video. FAIL/BLOCKED: video + ảnh chụp màn hình. Trạng thái khác: chỉ video.
    const wantShots = r.status === 'FAIL' || r.status === 'BLOCKED';
    const shots = (wantShots ? r.evidence.screenshots : []).map((p, i) => `<div class="shot ${st.cls}"><div class="sh"><span>${ICON.bug} ${r.status === 'FAIL' ? 'Bug Screenshot' : 'Screenshot'}: ${esc(r.def.title)}${r.evidence.screenshots.length > 1 ? ` (${i + 1})` : ''}</span><button type="button" class="zoombtn" data-zoom="${esc(p)}">Nhấp để phóng to</button></div><img loading="lazy" src="${esc(p)}" alt="Ảnh chụp màn hình ${esc(r.def.id)}" data-zoom="${esc(p)}"></div>`).join('');
    const shotCount = wantShots ? r.evidence.screenshots.length : 0;
    const evCount = [video ? '1 video' : '', shotCount ? `${shotCount} ảnh` : ''].filter(Boolean).join(' · ');
    const evChips = `${video ? '<em>Video</em>' : ''}${shotCount ? '<em>Screenshot</em>' : ''}${r.evidence.trace ? `<a href="#${esc(techId)}" data-open="${esc(techId)}">Trace</a>` : ''}`;
    // Mặc định chỉ hiện tên mục và số lượng; mở ra mới tải khung video/ảnh hiện có. Lệnh Trace nằm trong "Chi tiết kỹ thuật".
    const evidence = video || shots
      ? `<details class="evbox"><summary><span class="evh">${ICON.clip}<b>Bằng chứng</b><span class="evn">${evCount}</span></span><span class="evc">${evChips}</span></summary><div class="evgrid${video && shots ? '' : ' one'}">${video}${shots}</div></details>`
      : '';

    const bugTable = (b: (typeof tcBugs)[number]) => {
      const env = b.environment;
      const trust = presentBugTrust(b, tcBugs);
      return `<table class="kvt" id="bug-${esc(b.bugId)}"><tr><td>Bug ID</td><td>${esc(b.bugId)} · ${b.status === 'OPEN' ? 'ĐANG MỞ' : `SUPERSEDED — đã có lần chạy mới hơn${r.runId && r.runId !== b.runId ? ` (${esc(r.runId)})` : ''} hoặc định nghĩa test case đã đổi; giữ làm lịch sử`}</td></tr>
<tr><td>Run ID · thời gian phát hiện</td><td>${esc(b.runId)} · ${esc(when(b.detectedAt))}</td></tr>
<tr><td>Phân loại sơ bộ</td><td>${trust.category ? esc(trust.category) : `${esc(b.categoryLabel)} (${b.category === 'SUSPECTED_INFRASTRUCTURE' ? 'nghi hạ tầng' : 'nghi sản phẩm'})${b.category === 'SUSPECTED_PRODUCT' && !b.hasEvidence ? ' · <b class="warn">thiếu bằng chứng đính kèm</b>' : ''}`}</td></tr>
<tr><td>Kiểm chứng lại</td><td>${esc(trust.verification ?? VERIFICATION_LABEL[b.verification])}</td></tr>
<tr><td>Bước lỗi</td><td>${esc(b.failedStep ?? '—')}</td></tr>
<tr><td>Log lỗi</td><td><pre class="log">${esc(b.errorMessage)}</pre></td></tr>
<tr><td>Môi trường</td><td>${env.key ? `<b>${esc(env.key)}</b> · ` : ''}Máy chủ: ${esc(env.host ?? 'không rõ')} · ${esc(env.application ?? '-')}/${esc(env.module ?? '-')} · Role: ${esc(env.role?.role ?? 'không rõ')}</td></tr></table>`;
    };
    // Một mục thu gọn duy nhất: bug đang mở trước, bug đã bị thay thế sau (vẫn giữ nguyên dữ liệu, Bug ID đầy đủ nằm ở đây).
    const oldBugs = tcBugs.filter((b) => b.status !== 'OPEN');
    const defect = tcBugs.length
      ? `<details class="bugdetail"><summary>Lịch sử bug (${tcBugs.length})</summary>${tcBugs.filter((b) => b.status === 'OPEN').map(bugTable).join('')}${oldBugs.length ? `<h5>Bug cũ đã được thay thế (SUPERSEDED)</h5>${oldBugs.map(bugTable).join('')}` : ''}</details>`
      : '';
    const liveLink = liveBug ? `<a class="defect" href="#bug-${esc(liveBug.bugId)}" data-bug="${esc(liveBug.bugId)}">Bug đang mở</a>` : '';
    const footer = liveLink || techHtml || defect ? `<div class="tf">${liveLink}${techHtml}${defect}</div>` : '';

    const search = [r.def.id, r.def.title, r.def.description, r.def.requirementRefs.join(' ')].join(' ').toLowerCase();
    const actualCls = r.status === 'FAIL' ? 'fail' : r.status === 'PASS' ? 'pass' : r.status === 'NOT RUN' ? 'plain' : st.cls;

    return `<article class="tc ${st.cls}" id="tc-${esc(r.def.id)}" data-status="${r.status}" data-ver="${r.def.verification}" data-app="${esc(r.def.application ?? '')}" data-module="${esc(r.def.module ?? '')}" data-req="${esc(r.def.requirementId ?? '')}" data-search="${esc(search)}">
<header class="th"><span class="tid ${st.cls}">${esc(r.def.id)}</span><h3>${esc(r.def.title)}</h3><span class="pill ${st.cls}"><i class="dot"></i>${st.tab}</span></header>
<div class="tb">
<div class="metaline"><em>${esc(r.def.application ?? '-')}/${esc(r.def.module ?? '-')}</em><em>${esc(r.def.requirementId ?? '-')}</em>${r.def.requirementRefs.map((x) => `<em>${esc(x)}</em>`).join('')}<em>${r.def.verification === 'UI' ? 'Kiểm tra qua giao diện' : 'Kiểm tra backend'}</em></div>
${showDesc ? `<h4 class="lbl">Description</h4><p class="desc">${descHtml}</p>` : ''}
<div class="cols">
<section class="col steps"><h4>${ICON.steps} Các bước thực hiện (Steps)</h4><ol class="st">${steps || '<li><i>(không có)</i></li>'}</ol></section>
<section class="col actual ${actualCls}"><h4>${ICON.warn} Kết quả thực tế (Actual)</h4><p>${esc(shown.main)}</p></section>
<section class="col expected"><h4>${ICON.ok} Kết quả mong đợi (Expected)</h4><p>${expHtml}</p></section>
</div>
${notes.join('')}
${evidence}
${footer}
</div></article>`;
  }).join('\n');

  // ---- Ma trận truy vết REQ ↔ Test case ----
  const statusOf = new Map(results.map((r) => [r.def.id, r.status]));
  const cov = computeCoverage(requirements, results.map((r) => r.def)).filter((c) => c.requirementId !== '(toàn cục)');
  const rtmRows = cov.map((c) => {
    const ids = [...new Set(c.items.flatMap((i) => i.testCases))].sort();
    const sts = ids.map((id) => statusOf.get(id) ?? 'NOT RUN') as TcStatus[];
    const covered = c.items.length - c.uncovered.length;
    const pct = c.items.length ? Math.round((covered / c.items.length) * 100) : 0;
    const acc = acceptanceOf(sts);
    const chips = ids.map((id) => `<a class="tcchip ${STATUS[(statusOf.get(id) ?? 'NOT RUN') as TcStatus].cls}" href="#tc-${esc(id)}" data-tc="${esc(id)}" title="${esc(statusOf.get(id) ?? 'NOT RUN')}">${esc(id)}</a>`).join('');
    // results đã lọc theo requirement đang xử lý: ma trận không có dòng nào của requirement khác.
    const inScope = !focus || c.requirementId === focus.requirementId;
    return { pct, inScope, html: `<tr data-rtm="${esc(c.requirementId)}"><td class="rid">${esc(c.requirementId)}</td><td>${esc(reqTitle.get(c.requirementId) ?? c.title)}</td><td class="chips">${chips || '<b class="warn">CHƯA CÓ TEST CASE</b>'}</td><td class="c"><span class="cov ${pct === 100 ? 'full' : 'part'}">${pct}%</span></td><td class="c"><span class="acc ${acc.cls}"><i class="dot"></i>${acc.label}</span></td></tr>` };
  });
  const avgOf = (rows: { pct: number }[]) => (rows.length ? Math.round(rows.reduce((n, r) => n + r.pct, 0) / rows.length) : 0);
  // Ma trận chỉ gồm requirement đang xử lý (không có dòng của requirement khác, không có nút chuyển phạm vi).
  const shownRtm = rtmRows.filter((r) => r.inScope);
  const avgCov = avgOf(shownRtm);
  const rtmBadge = `<span class="badge2 ok">${focus ? `Độ phủ ${esc(focus.requirementId)}` : "Độ phủ trung bình"}: ${avgCov}%</span>`;
  const rtmPanel = `<section class="panel" id="panel-rtm" hidden><div class="ph"><div><h2><i class="ic">${ICON.matrix}</i> Ma trận truy vết yêu cầu (Requirement Traceability Matrix - RTM)</h2><p>Bảng ma trận đối chiếu mức độ bao phủ giữa các Requirement nghiệp vụ Claude quy định và danh sách Test Case kiểm thử.${focus ? ` Chỉ hiển thị <b>${esc(focus.requirementId)}</b>.` : ''}</p></div><div class="phr">${rtmBadge}</div></div>
<div class="tw"><table class="grid"><thead><tr><th>Mã Requirement</th><th>Tên yêu cầu nghiệp vụ Claude quy định</th><th>Các test case liên kết</th><th class="c">Độ phủ kiểm thử</th><th class="c">Trạng thái nghiệm thu</th></tr></thead><tbody>${shownRtm.map((r) => r.html).join('') || '<tr><td colspan="5"><i>Chưa có requirement</i></td></tr>'}</tbody></table></div></section>`;

  // ---- Lịch sử chạy ----
  // Có requirement đang xử lý: `runs` đã được lọc ở đầu hàm (chỉ lần chạy có test case của nó); mỗi dòng chỉ đếm test case của requirement này.
  const sortedRuns = [...runs].sort((x, y) => y.runId.localeCompare(x.runId));
  const countsNote = (n: number, c: Record<string, number>) => `${n} test · ${c.PASS ?? 0} PASS · ${c.FAIL ?? 0} FAIL · ${c.BLOCKED ?? 0} BLOCKED · ${c['NEEDS CLARIFICATION'] ?? 0} NEEDS CLARIFICATION · ${c['NOT RUN'] ?? 0} NOT RUN`;
  const histRows = sortedRuns.map((r, i) => {
    const dur = r.durationMs === undefined ? runDurationMs(r.startedAt, r.finishedAt) : r.durationMs;
    const mode = r.writesEnabled ? ' · có quyền ghi' : r.writesEnabled === false ? ' · chỉ đọc' : '';
    const mine = focus ? r.byRequirement?.[focus.requirementId] : undefined;
    const note = mine
      ? `${focus!.requirementId} · ${countsNote(mine.testCases, mine.counts)}${mode}`
      : `${r.scopes?.length ? r.scopes.join(', ') : 'Không có dữ liệu'} · ${countsNote(r.testCases, r.counts ?? {})}${mode}`;
    return `<tr><td class="rid"><i class="dot ${i === 0 ? 'pass' : 'notrun'}"></i>#RUN-${esc(r.runId)}</td><td>${esc(stampVi(r.finishedAt))}</td><td class="mono">${esc(formatDuration(dur))}</td><td class="mono r" title="Framework không đo token tiêu thụ của AI testing engine">Không ghi nhận</td><td>${esc(note)}</td><td class="c"><span class="acc pass">Hoàn tất</span></td></tr>`;
  }).join('');
  const histBadge = `<span class="badge2 info">${focus ? `${esc(focus.requirementId)}: ` : 'Tổng cộng: '}${runs.length} lần chạy hoàn tất</span>`;
  const histEmptyRow = focus ? `<tr><td colspan="6"><i>${esc(focus.requirementId)} chưa có lần chạy nào.</i></td></tr>` : '<tr><td colspan="6"><i>Chưa có lần chạy nào</i></td></tr>';
  const histPanel = `<section class="panel" id="panel-history" hidden><div class="ph"><div><h2><i class="ic">${ICON.history}</i> Lịch sử các lần chạy kiểm thử (Execution Run History)</h2><p>Nhật ký thống kê thời gian chạy toàn bộ test case và tài nguyên token tiêu thụ của AI testing engine.${focus ? ` Chỉ gồm các lần chạy của <b>${esc(focus.requirementId)}</b>, mới nhất trước.` : ''}</p></div><div class="phr">${histBadge}</div></div>
<div class="tw"><table class="grid"><thead><tr><th>Lần chạy (#Run ID)</th><th>Ngày giờ hoàn tất</th><th>Đo thời gian chạy</th><th class="r">Số lượng token</th><th>Ghi chú phiên bản prompt / engine</th><th class="c">Trạng thái run</th></tr></thead><tbody>${histRows || histEmptyRow}</tbody></table></div></section>`;

  // ---- Tiêu đề ----
  const reqLabel = focus ? `${focus.requirementId} — ${focus.title}` : 'TẤT CẢ REQUIREMENT';
  const approverIds = focus ? [focus.requirementId] : Object.keys(approvers);
  const names = [...new Set(approverIds.map((id) => approvers[id]?.by).filter(Boolean))];
  const approverText = names.length ? names.join(', ') : 'Chưa có phê duyệt hợp lệ';

  const page = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Báo cáo kiểm thử${focus ? ` ${esc(focus.requirementId)}` : ''}</title><style>
:root{color-scheme:light;--bg:#f6f8fc;--card:#fff;--line:#e3e8f0;--txt:#0f172a;--mut:#64748b;--blue:#1d5fe6;--pass:#0f8a5f;--passbg:#dcf8ea;--passbd:#9fe3c2;--fail:#c4163f;--failbg:#fde3e8;--failbd:#f6b1bf;--blocked:#b45309;--blockedbg:#fdf1c8;--blockedbd:#f3d77c;--clarify:#7e22ce;--clarifybg:#f4e8ff;--clarifybd:#d9b8fb;--notrun:#52627a;--notrunbg:#eef1f6;--notrunbd:#cbd5e1}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.55 Inter,'Segoe UI',system-ui,-apple-system,Roboto,sans-serif}
.top{display:flex;gap:16px;flex-wrap:wrap;align-items:center;justify-content:space-between;padding:14px 22px;background:var(--card);border-bottom:1px solid var(--line)}
.top h1{margin:0;font-size:28px;letter-spacing:.2px;text-transform:uppercase;font-weight:800;line-height:1.15}.top p{margin:4px 0 0;color:var(--mut)}
.acts{display:flex;gap:10px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--txt);font:inherit;font-weight:600;cursor:pointer}.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}
.top{padding-inline:max(22px,calc((100% - 1180px)/2))}.wrap{max-width:1180px;margin:0 auto;padding:22px 22px 60px}
.box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 24px;margin-bottom:20px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.box h2{margin:0 0 14px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:20px;display:flex;gap:10px;align-items:center}.ic{display:inline-flex;color:var(--blue)}
.metrics{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:14px}@media(max-width:1100px){.metrics{grid-template-columns:repeat(4,1fr)}}@media(max-width:620px){.metrics{grid-template-columns:repeat(2,1fr)}}
.mt{border:1px solid var(--line);border-radius:10px;padding:16px 18px;background:#f8fafc;cursor:default;user-select:text}.mh{display:flex;justify-content:space-between;align-items:center;color:var(--mut);font-weight:500}.mt b{display:block;font-size:34px;line-height:1.2;margin:8px 0 4px}.mt small{color:var(--mut);display:block}
.mt.pass{background:var(--passbg);border-color:var(--passbd)}.mt.pass b,.mt.pass .mh{color:var(--pass)}.mt.fail{background:var(--failbg);border-color:var(--failbd)}.mt.fail b,.mt.fail .mh{color:var(--fail)}
.mt.blocked{background:var(--blockedbg);border-color:var(--blockedbd)}.mt.blocked b,.mt.blocked .mh{color:var(--blocked)}.mt.clarify{background:var(--clarifybg);border-color:var(--clarifybd)}.mt.clarify b,.mt.clarify .mh{color:var(--clarify)}
.mt.notrun{background:var(--notrunbg);border-color:var(--notrunbd)}.mt.notrun b{color:var(--notrun)}.mt.rate{background:#eef5ff;border-color:#bcd3fb}.mt.rate b,.mt.rate .mh{color:var(--blue)}
.mt .dot{width:10px;height:10px;border-radius:50%;background:currentColor;display:inline-block}.pc{font-style:normal;font-weight:800}.pbar{height:8px;border-radius:6px;background:#dbe5f5;overflow:hidden;margin:2px 0 6px}.pbar i{display:block;height:100%;background:#12b886}
.allstrip{margin-top:14px;color:var(--mut);font-size:13px}.allstrip b{color:var(--txt)}.allstrip .kv span{margin-left:4px}.prov{margin-top:8px;color:var(--mut);font-size:13px}.linkbtn{background:none;border:0;color:var(--blue);font:inherit;cursor:pointer;text-decoration:underline;padding:0 4px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin-bottom:18px}
.tab{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border:0;border-radius:8px;background:transparent;color:#334155;font:inherit;font-weight:600;cursor:pointer}.tab:hover{background:#f1f5f9}.tab.active{background:var(--blue);color:#fff}.tab.active .ic{color:#fff}
.tab .n{display:inline-block;min-width:26px;text-align:center;padding:1px 8px;border-radius:99px;background:#e8edf5;color:#334155;font-size:13px}.tab.active .n{background:rgba(255,255,255,.25);color:#fff}
.tab .n.pass{background:var(--passbg);color:var(--pass)}.tab .n.fail{background:var(--failbg);color:var(--fail)}.tab .n.blocked{background:var(--blockedbg);color:var(--blocked)}.tab .n.clarify{background:var(--clarifybg);color:var(--clarify)}.tab .n.notrun{background:var(--notrunbg);color:var(--notrun)}
.tab .dot{width:10px;height:10px;border-radius:50%;display:inline-block}.dot.pass{background:#10b981}.dot.fail{background:#e11d48}.dot.blocked{background:#f59e0b}.dot.clarify{background:#a855f7}.dot.notrun{background:#94a3b8}
.sep{width:1px;align-self:stretch;background:var(--line);margin:0 6px}
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}.filters input,.filters select,.filters button{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--txt);font:inherit}.filters input{flex:1;min-width:220px}.count{color:var(--mut);font-size:13px;margin:0 2px 10px}
article.tc{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 18px;overflow:hidden}article.tc.fail{border-color:var(--failbd)}
.th{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:16px 22px;border-bottom:1px solid var(--line);cursor:pointer}article.tc.fail .th{background:#fdeef1}article.tc.pass .th{background:#f1fbf6}article.tc.blocked .th{background:#fff9e6}article.tc.clarify .th{background:#faf3ff}
.th h3{margin:0;font-size:20px;flex:1;min-width:240px}.tid{font:600 14px ui-monospace,Consolas,monospace;padding:6px 12px;border:1px solid var(--notrunbd);border-radius:6px;background:#fff;color:var(--notrun)}
.tid.fail{border-color:var(--failbd);color:var(--fail)}.tid.pass{border-color:var(--passbd);color:var(--pass)}.tid.blocked{border-color:var(--blockedbd);color:var(--blocked)}.tid.clarify{border-color:var(--clarifybd);color:var(--clarify)}
.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 16px;border-radius:99px;font-weight:600;border:1px solid}.pill .dot{width:10px;height:10px;border-radius:50%;background:currentColor}
.pill.pass{background:var(--passbg);border-color:var(--passbd);color:var(--pass)}.pill.fail{background:var(--failbg);border-color:var(--failbd);color:var(--fail)}.pill.blocked{background:var(--blockedbg);border-color:var(--blockedbd);color:var(--blocked)}.pill.clarify{background:var(--clarifybg);border-color:var(--clarifybd);color:var(--clarify)}.pill.notrun{background:var(--notrunbg);border-color:var(--notrunbd);color:var(--notrun)}
.defect{padding:6px 14px;border:1px solid var(--failbd);border-radius:6px;background:#fff;color:var(--fail);font-weight:600;text-decoration:none}
.tb{padding:18px 24px 22px}article.tc.collapsed .tb{display:none}.metaline{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}.metaline em{font-style:normal;font-size:12px;background:#f1f5f9;border:1px solid var(--line);border-radius:6px;padding:1px 8px;color:var(--mut)}
.lbl{margin:14px 0 6px;font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}.desc{margin:0 0 14px;font-size:16.5px}
.cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}@media(max-width:980px){.cols{grid-template-columns:1fr}}
.col{border:1px solid var(--line);border-radius:8px;padding:12px 16px}.col h4{margin:0 0 10px;display:flex;gap:8px;align-items:center;font-size:15px;text-transform:uppercase}.col p{margin:0;font-size:16px;line-height:1.7}
.col.steps{background:#f8fafc}.rundata{margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)}.rundata h5{margin:0 0 6px}.rundata dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 12px;margin:0;font-size:14px}.rundata dt{color:var(--mut)}.rundata dd{margin:0;font-family:ui-monospace,Consolas,monospace;word-break:break-word}ol.st{list-style:none;margin:0;padding:0}ol.st li{margin:6px 0;font-size:16px}
.col.actual.fail{background:#fdeef1;border-color:var(--failbd);color:#8d1030}.col.actual.fail h4{color:var(--fail)}.col.actual.pass{background:#f1fbf6;border-color:var(--passbd)}.col.actual.pass h4{color:var(--pass)}.col.actual.blocked{background:#fff9e6;border-color:var(--blockedbd)}.col.actual.blocked h4{color:var(--blocked)}.col.actual.clarify{background:#faf3ff;border-color:var(--clarifybd)}.col.actual.clarify h4{color:var(--clarify)}.col.actual.plain{background:#f8fafc}
.col.expected{background:#effcf5;border-color:var(--passbd);color:#0b5d41}.col.expected h4{color:var(--pass)}
.evgrid.one{grid-template-columns:minmax(0,640px)}.evgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}@media(max-width:980px){.evgrid{grid-template-columns:1fr}}
.vid{background:#0f1a33;border-radius:10px;overflow:hidden;color:#e8eefc}.vh{padding:8px 14px;font-weight:500;font-size:14px}.rec{display:inline-block;width:12px;height:12px;border:2px solid #fb7185;border-radius:50%;margin-right:8px;vertical-align:-1px}.vid video{display:block;width:100%;max-height:420px;background:#000}.vf{padding:6px 14px;font:13px ui-monospace,Consolas,monospace;background:#0b1328}
.shot{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}.shot.fail{border-color:var(--failbd);background:#fff7f8}.sh{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 14px;font-weight:600;font-size:14px}.sh svg{vertical-align:-4px}.shot.fail .sh{color:var(--fail)}
.zoombtn{white-space:nowrap;padding:4px 12px;border:0;border-radius:6px;background:#fbd5dc;color:var(--fail);font:inherit;font-weight:600;cursor:pointer}.shot img{display:block;width:100%;max-height:420px;object-fit:contain;background:#f1f5f9;cursor:zoom-in}
.note{background:var(--clarifybg);border:1px solid var(--clarifybd);border-radius:8px;padding:8px 12px;margin-top:12px}.note.stale,.note.blockednote{background:var(--blockedbg);border-color:var(--blockedbd)}.src{color:var(--mut);font-size:13px;margin-top:8px}.warn{color:var(--blocked)}.mut{color:var(--mut)}
details.ref,details.bugdetail{margin-top:14px;border:1px dashed var(--line);border-radius:8px;padding:8px 14px}details summary{cursor:pointer;color:var(--mut);font-weight:600}h5{margin:12px 0 4px;font-size:13px;text-transform:uppercase;color:var(--mut)}
table.kvt{border-collapse:collapse;width:100%}table.kvt td{border-top:1px solid var(--line);padding:5px 8px;vertical-align:top}table.kvt td:first-child{width:28%;color:var(--mut)}pre{white-space:pre-wrap;background:#f1f5f9;padding:8px;border-radius:6px;max-height:240px;overflow:auto;margin:0}code{background:#f1f5f9;padding:0 4px;border-radius:4px;font-size:13px}.term i{color:var(--mut);font-style:normal}
.panel .ph{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-start;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--line)}.panel h2{margin:0;font-size:21px;display:flex;gap:10px;align-items:center;border:0;padding:0}.panel .ph p{margin:4px 0 0;color:var(--mut)}.phr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.scopebtn{font-size:13px}
pre.log{max-height:110px}.evbox{margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:12px 16px}.evbox>summary{list-style:none;display:flex;flex-direction:column;gap:10px}.evbox>summary::-webkit-details-marker{display:none}.evh{display:flex;align-items:center;gap:8px;color:var(--txt)}.evn{margin-left:auto;font-weight:400;color:var(--mut)}.evc{display:flex;flex-wrap:wrap;gap:8px}.evc em,.evc a{padding:3px 12px;border:1px solid var(--line);border-radius:999px;background:#f8fafc;color:inherit;font-style:normal;font-size:13px;text-decoration:none}.evbox[open]>.evgrid{margin-top:12px}.tf{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:14px}.tf details{margin:0;padding:0;border:0;font-size:14px;color:var(--mut)}.tf details[open]{flex-basis:100%}.tf summary{list-style:none;color:var(--mut);font-weight:500}.tf summary::-webkit-details-marker{display:none}.tf summary:hover{text-decoration:underline}@media(min-width:520px){.tf details:not([open])+details:not([open])>summary::before{content:"· ";margin-right:6px}}.tf details[open]>summary{color:var(--blue);margin-bottom:6px}.tf .defect{padding:3px 12px;border-radius:999px;background:#fdeef1;font-size:14px}.techdetail{font-size:13px;color:var(--mut)}.techdetail pre{white-space:pre-wrap;word-break:break-word;background:var(--bg,#f6f8fb);border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:4px 0 8px;font-size:12px;max-height:240px;overflow:auto}.techdetail h6{margin:8px 0 0;font-size:12px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-bottom:20px}.badge2{padding:6px 16px;border-radius:99px;border:1px solid;font-weight:600;white-space:nowrap}.badge2.ok{background:var(--passbg);border-color:var(--passbd);color:var(--pass)}.badge2.info{background:#eaf2ff;border-color:#bcd3fb;color:var(--blue)}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:10px}table.grid{border-collapse:collapse;width:100%}table.grid th{background:#f8fafc;text-align:left;padding:14px 18px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#334155}table.grid td{padding:14px 18px;border-top:1px solid var(--line);vertical-align:middle}
.acc{white-space:nowrap}.c{text-align:center}.r{text-align:right}.mono{font-family:ui-monospace,Consolas,monospace;white-space:nowrap}td.r{white-space:nowrap}td.rid{font:600 15px ui-monospace,Consolas,monospace;color:var(--blue)}td.rid .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}td.chips{line-height:2.2}td.chips .tcchip{margin:0 6px 0 0}
.tcchip{display:inline-block;padding:3px 10px;border-radius:5px;font:600 14px ui-monospace,Consolas,monospace;text-decoration:none;color:var(--notrun);background:var(--notrunbg)}.tcchip.pass{background:var(--passbg);color:var(--pass)}.tcchip.fail{background:var(--failbg);color:var(--fail)}.tcchip.blocked{background:var(--blockedbg);color:var(--blocked)}.tcchip.clarify{background:var(--clarifybg);color:var(--clarify)}
.cov{display:inline-block;padding:4px 16px;border-radius:99px;border:1px solid var(--passbd);background:#effcf5;color:var(--pass);font-weight:600}.cov.part{background:var(--blockedbg);border-color:var(--blockedbd);color:var(--blocked)}
.acc{display:inline-flex;align-items:center;gap:8px;padding:4px 14px;border-radius:99px;font-weight:600;border:1px solid}.acc .dot{width:9px;height:9px;border-radius:50%;background:currentColor}.acc.pass{background:var(--passbg);border-color:var(--passbd);color:var(--pass)}.acc.fail{background:var(--failbg);border-color:var(--failbd);color:var(--fail)}.acc.blocked{background:var(--blockedbg);border-color:var(--blockedbd);color:var(--blocked)}.acc.clarify{background:var(--clarifybg);border-color:var(--clarifybd);color:var(--clarify)}.acc.notrun{background:var(--notrunbg);border-color:var(--notrunbd);color:var(--notrun)}
details.sect{margin-top:14px;border:1px dashed var(--line);border-radius:10px;padding:10px 14px}details.sect>summary{cursor:pointer;font-weight:600}details.legend.trace{margin:8px 0}table.tr{border-collapse:collapse;width:100%}table.tr th{text-align:left;font-size:12px;text-transform:uppercase;color:var(--mut);padding:4px 8px}table.tr td{border-top:1px solid var(--line);padding:5px 8px;vertical-align:top}details.run{border-top:1px solid var(--line);margin-top:8px;padding-top:6px}
.empty{display:none;text-align:center;color:var(--mut);padding:30px}#lb{position:fixed;inset:0;background:rgba(15,23,42,.86);display:none;align-items:center;justify-content:center;z-index:50;padding:24px}#lb.show{display:flex}#lb img{max-width:96vw;max-height:92vh;border-radius:8px;background:#fff}
@media print{.acts,.tabs,.filters,.zoombtn{display:none!important}.panel[hidden]{display:none}body{background:#fff}article.tc.collapsed .tb{display:block}}
</style></head><body>
<header class="top"><div><h1>${focus ? `Báo cáo kiểm thử ${esc(focus.requirementId)}: ${esc(focus.title.replace(/^\s*\[[^\]]*\]\s*/, ''))}` : 'Báo cáo kiểm thử: Tất cả requirement'}</h1><p>Báo cáo tạo lúc: ${esc(stampVi(generatedAt))} | Người phê duyệt: ${esc(approverText)}${focus ? ` | Requirement: ${esc(focus.requirementId)}` : ''}${environment ? ` | Môi trường: ${esc(environment)}` : ''}</p></div>
<div class="acts"><button type="button" class="btn" id="b-refresh">${ICON.refresh} Làm mới</button><button type="button" class="btn" id="b-pdf">${ICON.pdf} Xuất PDF</button><button type="button" class="btn primary" id="b-export">${ICON.download} Xuất báo cáo</button></div></header>
<div class="wrap">
<section class="box" id="dash"><h2><i class="ic">${ICON.chart}</i> Dashboard Thống kê kết quả kiểm thử</h2><div class="metrics">${tiles}</div>${provenance}${allStrip}</section>
<nav class="tabs" id="tabs" role="tablist">${tabs}</nav>
<section id="panel-tests">
<div class="filters" hidden><input type="search" id="q" placeholder="Tìm theo mã, tên, BR/AC... (ví dụ TC-SO-010, AC-06)"><select id="app">${filterOptions(results.map((r) => r.def.application), 'Mọi ứng dụng')}</select><select id="mod">${filterOptions(results.map((r) => r.def.module), 'Mọi module')}</select><select id="req">${filterOptions(results.map((r) => r.def.requirementId), 'Mọi requirement')}</select><select id="ver"><option value="">Mọi loại kiểm tra</option><option value="UI">Giao diện (UI)</option><option value="BACKEND">Backend</option></select><button type="button" id="open">Mở tất cả</button><button type="button" id="close">Thu gọn</button><button type="button" id="reset">Bỏ lọc</button></div>
<div class="count" id="count"></div><div id="list">${cards}</div><div class="empty" id="empty"></div></section>
${rtmPanel}
${histPanel}
</div><div id="lb" role="dialog" aria-label="Xem ảnh lớn"><img alt=""></div>
<script>
(()=>{const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],cards=$$('article.tc'),tabs=$$('.tab'),VI={PASS:'Đạt',FAIL:'Lỗi',BLOCKED:'Bị chặn','NEEDS CLARIFICATION':'Cần làm rõ','NOT RUN':'Chưa chạy'};
let tab='ALL';
function apply(){const q=$('#q').value.trim().toLowerCase(),ver=$('#ver').value,fa=$('#app').value,fm=$('#mod').value,fr=$('#req').value;let n=0;
 cards.forEach(d=>{const ok=(tab==='ALL'||tab==='RTM'||tab==='HISTORY'||d.dataset.status===tab)&&(!ver||d.dataset.ver===ver)&&(!fa||d.dataset.app===fa)&&(!fm||d.dataset.module===fm)&&(!fr||d.dataset.req===fr)&&(!q||d.dataset.search.includes(q));d.style.display=ok?'':'none';if(ok)n++});
 $('#count').textContent=n?'Hiển thị '+n+' / '+cards.length+' test case':'';
 const f=[];if(tab!=='ALL'&&VI[tab])f.push('trạng thái = '+tab);if(fr)f.push('requirement = '+fr);if(q)f.push('từ khóa "'+q+'"');
 $('#empty').style.display='none';$('#empty').textContent=''}
function show(t){tab=t;tabs.forEach(b=>b.classList.toggle('active',b.dataset.tab===t));
 $('#panel-tests').hidden=(t==='RTM'||t==='HISTORY');$('#panel-rtm').hidden=t!=='RTM';$('#panel-history').hidden=t!=='HISTORY';apply()}
tabs.forEach(b=>b.onclick=()=>show(b.dataset.tab));
['#ver','#app','#mod','#req'].forEach(s=>$(s).onchange=apply);$('#q').oninput=apply;
$('#reset').onclick=()=>{['#q','#ver','#app','#mod'].forEach(s=>$(s).value='');$('#req').value='';show('ALL')};
$('#open').onclick=()=>cards.forEach(d=>d.classList.remove('collapsed'));$('#close').onclick=()=>cards.forEach(d=>d.classList.add('collapsed'));
cards.forEach(d=>d.querySelector('.th').addEventListener('click',e=>{if(e.target.closest('a'))return;d.classList.toggle('collapsed')}));
const lb=$('#lb');document.addEventListener('click',e=>{const z=e.target.closest('[data-zoom]');if(z){lb.querySelector('img').src=z.dataset.zoom;lb.classList.add('show');return}
 if(e.target.closest('#lb')){lb.classList.remove('show');return}
 const t=e.target.closest('a[data-tc]');if(t){e.preventDefault();show('ALL');const d=document.getElementById('tc-'+t.dataset.tc);if(d){d.classList.remove('collapsed');d.scrollIntoView({block:'start'})}return}
 const bg=e.target.closest('a[data-bug],a[data-open]');if(bg){e.preventDefault();const el=document.getElementById(bg.dataset.open||'bug-'+bg.dataset.bug);if(el){const det=el.closest('details');if(det)det.open=true;el.scrollIntoView({block:'center'})}}});
document.addEventListener('keydown',e=>{if(e.key==='Escape')lb.classList.remove('show')});
$('#b-refresh').onclick=()=>location.reload();$('#b-pdf').onclick=()=>window.print();
const SRC='${SELF_TOKEN}',MARK='${SELF_TOKEN}';
$('#b-export').onclick=()=>{const html=new TextDecoder().decode(Uint8Array.from(atob(SRC),c=>c.charCodeAt(0))).replace(MARK,()=>SRC).replace('<head>',()=>'<head><base href="'+new URL('.',document.baseURI).href+'">'),blob=new Blob([html],{type:'text/html'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='qa-report.html';document.body.appendChild(a);a.click();a.remove()};
const FOCUS=${focus ? JSON.stringify(focus.requirementId) : "''"};if(FOCUS){$('#req').value=FOCUS}
apply()})();
</script></body></html>`;
  // "Xuất báo cáo" tải đúng HTML gốc này (nhúng base64), không chụp DOM đang xem: không mang theo trạng thái người dùng hay nội dung extension chèn vào.
  return page.replace(SELF_TOKEN, () => Buffer.from(page, 'utf8').toString('base64'));
}
