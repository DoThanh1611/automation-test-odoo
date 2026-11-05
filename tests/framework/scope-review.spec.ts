import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';
import { approve, evaluate, evaluateAndSync, readRecord, revise, submit } from '../../core/approval/approval';
import { aggregate } from '../../core/reporters/aggregate';
import { buildBugs } from '../../core/reporters/bugs';
import { buildFocus, resolveFocusId } from '../../core/reporters/focus';
import { runMeta, writeAggregate } from '../../core/reporters/qa-reporter';
import { APPROVAL_BLOCK_PREFIX } from '../../core/approval/approval';
import { WRITE_NOT_GRANTED_PREFIX } from '../../core/testdata/write-guard';
import { descriptionIsRedundant, failFromError, plainTerms, presentActual, presentBugTrust, presentSteps } from '../../core/reporters/present';
import { historicalSummaryFor, loadSummaries, type SummaryFile } from '../../core/reporters/summaries';
import { renderHtml } from '../../core/reporters/render-html';
import type { RunFile, TcRunEntry } from '../../core/reporters/types';
import { defHash } from '../../core/testcases/hash';
import { loadTestCases } from '../../core/testcases/loader';
import type { Requirement, TestCaseDef } from '../../core/testcases/schema';
import { cleanupScope, runCleanup } from '../../core/testdata/cleanup-engine';
import { odooFactoryCleanupHandlers } from '../../applications/odoo/factory-cleanup';
import type { TestDataRecord } from '../../core/testdata/registry';
import { formatReview, reviewInfo } from '../../core/workflow/review';
import { decideNext, markWorkflow, nextStep, type WorkflowFacts } from '../../core/workflow/next';
import { makeWorkspace, wsDefs, wsReq } from './helpers/workspace';

// Framework tests (SCR-*): báo cáo lọc theo requirement, liên kết review mỗi lần gọi /qa-requirement, cleanup đúng phạm vi.
// Dữ liệu giả, thư mục tạm; không kết nối staging.

const req = (id: string, title: string): Requirement => ({ id, title, application: 'odoo', module: 'inventory', businessRequirement: 'b', businessRules: [{ id: 'BR-01', text: 'a' }], acceptanceCriteria: [{ id: 'AC-01', text: 'c' }] });
const REQ_A = req('REQ-A', 'Yêu cầu A');
const REQ_B = req('REQ-B', 'Yêu cầu B');
const def = (id: string, requirementId: string): TestCaseDef => ({
  id, title: `Tiêu đề ${id}`, requirementRefs: ['BR-01', 'AC-01'], description: '', preconditions: [], testData: {}, steps: ['b1'], expectedResult: 'kq', verification: 'UI', automated: true,
  requirementId, application: 'odoo', module: 'inventory',
});
const A1 = def('TC-A1', 'REQ-A');
const A2 = def('TC-A2', 'REQ-A');
const B1 = def('TC-B1', 'REQ-B');
const entry = (d: TestCaseDef, status: TcRunEntry['status'], extra: Partial<TcRunEntry> = {}): TcRunEntry => ({ tcId: d.id, defHash: defHash(d), status, actual: 'thực tế', durationMs: 10, evidence: { screenshots: [] }, ...extra });
const run = (runId: string, entries: TcRunEntry[]): RunFile => ({ runId, startedAt: `2026-11-05T0${runId.slice(-1)}:00:00Z`, finishedAt: `2026-11-05T0${runId.slice(-1)}:05:00Z`, entries, environment: 'ENV_A', writesEnabled: true });

// run1: chỉ REQ-A (1 PASS, 1 FAIL) · run2: chỉ REQ-B · run3: cả hai
const runs = [
  run('20261105-000001', [entry(A1, 'PASS'), entry(A2, 'FAIL', { error: { message: 'x' } })]),
  run('20261105-000002', [entry(B1, 'PASS')]),
  run('20261105-000003', [entry(A1, 'PASS'), entry(B1, 'FAIL', { error: { message: 'y' } })]),
];
const defs = [A1, A2, B1];

function html(focusId?: string, over: { runs?: RunFile[] } = {}) {
  const rs = over.runs ?? runs;
  const { results, summary } = aggregate(defs, rs);
  const bugs = buildBugs(defs, rs);
  const focus = focusId ? buildFocus(focusId, [REQ_A, REQ_B], results, bugs, summary.generatedAt) : undefined;
  return renderHtml({ summary, results, glossary: {}, requirements: [REQ_A, REQ_B], runs: rs.map((r) => runMeta(r, defs)), bugs, focus, environment: 'ENV_A' });
}
const rows = (h: string, panel: string) => {
  const p = h.slice(h.indexOf(`id="${panel}"`), h.indexOf('</section>', h.indexOf(`id="${panel}"`)));
  return p.split('<tr').slice(1);
};

test.describe('SCR-1 Ma trận truy vết theo requirement đang xử lý', () => {
  test('mặc định chỉ requirement hiện tại; requirement khác chỉ có khi chuyển phạm vi; giữ 5 cột', () => {
    const h = html('REQ-A');
    const body = rows(h, 'panel-rtm').slice(1);
    expect(body).toHaveLength(1); // chỉ requirement hiện tại; không có dòng requirement cũ/khác (kể cả ẩn)
    expect(body[0]).toContain('data-rtm="REQ-A"');
    expect(body[0]).toContain('data-tc="TC-A1"');
    expect(body[0]).not.toContain('TC-B1'); // không trộn test case của requirement khác
    expect(h).not.toContain('data-rtm="REQ-B"');
    expect(rows(h, 'panel-rtm')[0].match(/<th/g)).toHaveLength(5);
    const panel = h.slice(h.indexOf('id="panel-rtm"'), h.indexOf('</section>', h.indexOf('id="panel-rtm"')));
    expect(panel).not.toContain('data-scope-toggle'); // ma trận không có nút xem requirement cũ
  });

  test('độ phủ và trạng thái nghiệm thu tính theo test case của requirement hiện tại', () => {
    const h = html('REQ-A');
    const a = rows(h, 'panel-rtm').find((r) => r.includes('data-rtm="REQ-A"'))!;
    expect(a).toMatch(/class="acc fail"/); // REQ-A có 1 FAIL ⇒ không đạt
    const hb = html('REQ-B');
    expect(rows(hb, 'panel-rtm').slice(1)).toHaveLength(1);
    expect(rows(hb, 'panel-rtm').find((r) => r.includes('data-rtm="REQ-B"'))).toMatch(/class="acc fail"/);
    expect(hb).not.toContain('data-rtm="REQ-A"');
    expect(h).toContain('Độ phủ REQ-A: 100%');
  });

  test('chuyển sang requirement mới: báo cáo hiển thị đúng requirement mới; không có focus thì hiển thị tất cả, không có nút chuyển phạm vi', () => {
    expect(html('REQ-B')).toContain('data-focus="TOTAL">1<');
    const all = html();
    expect(all).not.toContain('data-out="1"');
    expect(all).not.toMatch(/<button[^>]*data-scope-toggle/);
    expect(all).toContain('Độ phủ trung bình');
  });
});

test.describe('SCR-2 Lịch sử test theo requirement', () => {
  test('chỉ các Run ID có test case của requirement hiện tại; giữ 6 cột; không token/engine giả; lần chạy cũ của chính nó còn nguyên', () => {
    const h = html('REQ-A');
    const all = rows(h, 'panel-history');
    expect(all[0].match(/<th/g)).toHaveLength(6);
    const body = all.slice(1);
    const idOf = (r: string) => /#RUN-(\d{8}-\d{6})/.exec(r)![1];
    expect(body.map(idOf)).toEqual(['20261105-000003', '20261105-000001']); // mới nhất trước; run2 (chỉ REQ-B) không có mặt, kể cả dạng ẩn
    expect(h).not.toContain('20261105-000002');
    // lần chạy chứa nhiều requirement: chỉ đếm test case của requirement hiện tại
    const r3 = body.find((r) => idOf(r) === '20261105-000003')!;
    expect(r3).toContain('REQ-A · 1 test · 1 PASS');
    expect(r3).not.toContain('2 test');
    expect(r3).not.toContain('1 FAIL'); // FAIL của REQ-B trong cùng lần chạy không lẫn vào
    expect(h).not.toContain('data-scope-toggle'); // không có nút chuyển sang requirement khác
    // không bịa token/engine
    for (const r of body) expect(r).toContain('Không ghi nhận');
    expect(h).not.toMatch(/claude-|gpt|tokens?:\s*\d/i);
  });

  test('requirement chưa có lần chạy nào: trạng thái rỗng phù hợp; không lẫn lịch sử requirement khác', () => {
    const h = html('REQ-A', { runs: [runs[1]] });
    expect(rows(h, 'panel-history').slice(1).join('')).toContain('REQ-A chưa có lần chạy nào');
    expect(h).not.toContain('20261105-000002');
    expect(h).toContain('REQ-A: 0 lần chạy hoàn tất');
  });

  test('metadata mỗi lần chạy có requirementIds và số liệu theo requirement (nguồn của bộ lọc)', () => {
    const m = runMeta(runs[2], defs);
    expect(m.requirementIds).toEqual(['REQ-A', 'REQ-B']);
    expect(m.byRequirement).toEqual({ 'REQ-A': { testCases: 1, counts: { PASS: 1 } }, 'REQ-B': { testCases: 1, counts: { FAIL: 1 } } });
    expect(runMeta(runs[0], defs).requirementIds).toEqual(['REQ-A']);
  });
});

test.describe('SCR-3 Focus còn sau khi phiên thực thi đóng', () => {
  test('requirement đang xử lý lấy từ phiên /qa-requirement (workflow.json) khi không còn phiên thực thi; không có ⇒ không focus', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-focus-'));
    try {
      const prevEnv = process.env.QA_FOCUS_REQ;
      delete process.env.QA_FOCUS_REQ;
      expect(resolveFocusId([REQ_A, REQ_B], undefined, root)).toBeUndefined();
      markWorkflow(root, 'REQ-B');
      expect(resolveFocusId([REQ_A, REQ_B], undefined, root)).toBe('REQ-B');
      expect(resolveFocusId([REQ_A, REQ_B], 'REQ-A', root)).toBe('REQ-A'); // đối số ưu tiên
      markWorkflow(root, 'REQ-KHONG-CO');
      expect(resolveFocusId([REQ_A, REQ_B], undefined, root)).toBeUndefined();
      if (prevEnv !== undefined) process.env.QA_FOCUS_REQ = prevEnv;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-4 Review gate: mỗi lần gọi /qa-requirement đều có trạng thái + liên kết', () => {
  const cleanups: (() => void)[] = [];
  test.afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });
  const ws = (stage: 'pending' | 'approved') => {
    const w = makeWorkspace(stage);
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    const prev = process.env.QA_APPROVAL_KEY_FILE;
    cleanups.push(() => {
      if (prev === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
    });
    return w;
  };
  const input = (w: ReturnType<typeof ws>, defsOverride?: TestCaseDef[]) => ({ root: w.ws, requirements: [wsReq] as Requirement[], defs: defsOverride ?? (w.defs as TestCaseDef[]), roles: () => ['accountant'], requirementId: wsReq.id });

  test('chưa APPROVE: hiển thị ID, version, PENDING_APPROVAL và liên kết mở được tới REVIEW.md + file test case; không sang giai đoạn 2', () => {
    const w = ws('pending');
    const step = nextStep(input(w));
    expect(step.stage).toBe('AWAITING_APPROVAL');
    const r = step.review!;
    expect(r).toMatchObject({ requirementId: wsReq.id, state: 'PENDING_APPROVAL', version: 1, outdated: false });
    expect(r.files.map((f) => path.basename(f.abs))).toEqual(expect.arrayContaining(['REVIEW.md', 'odoo-sales.testcases.md', 'testcases.snapshot.json']));
    for (const f of r.files) {
      expect(fs.existsSync(f.abs), f.abs).toBe(true); // liên kết mở được
      expect(f.rel).toMatch(/^approvals\/REQ-E-001\/v1\//);
    }
    const text = formatReview(r);
    expect(text).toContain('REQ-E-001');
    expect(text).toContain('PENDING_APPROVAL');
    expect(text).toMatch(/\]\(approvals\/REQ-E-001\/v1\/REVIEW\.md\)/);
    expect(text).toMatch(/APPROVE \/ REVISE \/ REJECT/);
  });

  test('đã APPROVE hợp lệ: vẫn hiển thị liên kết xem lại, version, APPROVED; không bắt duyệt lại; không nhập lại requirement', () => {
    const w = ws('approved');
    const r = reviewInfo(w.ws, wsReq, w.defs as TestCaseDef[]);
    expect(r).toMatchObject({ state: 'APPROVED', version: 1 });
    expect(r.files.length).toBeGreaterThanOrEqual(3);
    expect(formatReview(r)).toMatch(/Đã APPROVE hợp lệ: không cần duyệt lại/);
    const step = nextStep(input(w));
    expect(step.stage).not.toBe('AWAITING_APPROVAL');
    expect(step.stage).not.toBe('NO_REQUIREMENT');
    expect(step.review?.state).toBe('APPROVED');
    // gọi lại không tạo phiên bản/ requirement mới
    expect(fs.readdirSync(path.join(w.ws, 'approvals', wsReq.id)).filter((n) => /^v\d+$/.test(n))).toEqual(['v1']);
    expect(submit(w.ws, wsReq, w.defs as TestCaseDef[]).created).toBe(false);
  });

  test('test case thay đổi ⇒ INVALIDATED, tài liệu cũ đánh dấu cũ; submit tạo v2, giữ v1, link mới, vẫn chờ APPROVE', () => {
    const w = ws('approved');
    const changed = (w.defs as TestCaseDef[]).map((d, i) => (i === 0 ? { ...d, expectedResult: 'đã sửa' } : d));
    const ev = evaluateAndSync(w.ws, wsReq, changed);
    expect(ev.state).toBe('INVALIDATED');
    const stale = nextStep(input(w, changed));
    expect(stale.stage).toBe('NEEDS_REVISION');
    expect(stale.review).toMatchObject({ state: 'INVALIDATED', outdated: true, version: 1 });
    expect(formatReview(stale.review!)).toMatch(/phiên bản CŨ/);
    const s = submit(w.ws, wsReq, changed);
    expect(s).toMatchObject({ created: true });
    const after = nextStep(input(w, changed));
    expect(after.stage).toBe('AWAITING_APPROVAL'); // Approval Gate không bị bỏ qua
    expect(after.review).toMatchObject({ state: 'PENDING_APPROVAL', version: 2, outdated: false, versions: [1, 2] });
    expect(after.review!.files.every((f) => f.rel.startsWith('approvals/REQ-E-001/v2/'))).toBe(true);
    expect(fs.existsSync(path.join(w.ws, 'approvals', wsReq.id, 'v1', 'REVIEW.md'))).toBe(true);
    expect(evaluate(w.ws, wsReq, changed).ok).toBe(false);
  });

  test('REVISE bằng chat (kênh chat): ghi nhận nhận xét, giữ lịch sử, sửa rồi trình v2 và chờ duyệt lại', () => {
    const w = ws('pending');
    revise(w.ws, wsReq.id, 'Thanh', 'TC-E-002 thêm bước kiểm tra lại sau khi lưu', 'chat');
    const rec = readRecord(w.ws, wsReq.id)!;
    expect(rec.status).toBe('REVISION_REQUESTED');
    expect(rec.history.at(-1)).toMatchObject({ action: 'REVISE', channel: 'chat', comment: expect.stringContaining('TC-E-002') });
    const step = nextStep(input(w));
    expect(step).toMatchObject({ stage: 'NEEDS_REVISION', owner: 'claude' });
    expect(step.review?.state).toBe('REVISION_REQUESTED');
    const edited = (w.defs as TestCaseDef[]).map((d) => (d.id === 'TC-E-002' ? { ...d, steps: [...d.steps, 'bước kiểm tra lại'] } : d));
    submit(w.ws, wsReq, edited);
    const after = nextStep(input(w, edited));
    expect(after.stage).toBe('AWAITING_APPROVAL');
    expect(after.review).toMatchObject({ version: 2, versions: [1, 2] });
    // người dùng không phải gõ lệnh: bước kế tiếp là của Claude/giao diện review, không yêu cầu lệnh terminal từ người dùng
    expect(after.userActions.join(' ')).not.toMatch(/npm|qa:approval/);
  });

  test('gọi lại khi đang dở: nhận diện requirement từ phiên làm việc, không cần nhập lại; chưa có test case thì không có khối review', () => {
    const w = ws('pending');
    markWorkflow(w.ws, wsReq.id);
    const { requirementId: _omit, ...noId } = input(w);
    const again = nextStep(noId);
    expect(again).toMatchObject({ requirementId: wsReq.id, stage: 'AWAITING_APPROVAL' });
    expect(again.review?.files.length).toBeGreaterThan(0);
    expect(nextStep({ ...input(w), defs: [] }).review).toBeUndefined();
    // không tạo requirement/test case trùng khi gọi lại
    expect(fs.readdirSync(path.join(w.ws, 'requirements', 'odoo-sales'))).toHaveLength(2); // .json + .lock
    expect(wsDefs()).toHaveLength(2);
  });

  test('chưa trình duyệt: có khối review nhưng không có liên kết, nói rõ sẽ trình duyệt; pure decideNext không đổi', () => {
    const w = ws('pending');
    fs.rmSync(path.join(w.ws, 'approvals'), { recursive: true });
    const r = reviewInfo(w.ws, wsReq, w.defs as TestCaseDef[]);
    expect(r).toMatchObject({ state: 'NOT_SUBMITTED', files: [], version: undefined });
    expect(formatReview(r)).toMatch(/Chưa trình duyệt/);
    const f: Partial<WorkflowFacts> = { approvalState: 'NOT_SUBMITTED' };
    expect(decideNext({ requirementId: 'R', requirementExists: true, inbox: [], testCaseCount: 1, integrity: [], needWrite: false, ...f }).stage).toBe('READY_TO_SUBMIT');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-5 Cleanup đúng phạm vi', () => {
  const rec = (model: string, id: number, runId: string, tc: string, environment = 'STAGING_A'): TestDataRecord => ({
    testCaseId: tc, application: 'odoo', model, recordId: id, reference: `AUTOTEST ${runId} ${tc}`, runId, environment, owner: 'FRAMEWORK', origin: 'AUTOMATION', requirementId: 'REQ-INV-001', cleanupStatus: 'PENDING',
  } as TestDataRecord);
  const reg = [
    rec('product.product', 2276, '20261105-102428', 'TC-EIN-001'), rec('stock.picking', 146, '20261105-102428', 'TC-EIN-001'),
    rec('stock.picking', 147, '20261105-102428', 'TC-EIN-002'), rec('stock.picking', 141, '20261105-101641', 'TC-EIN-004'),
    rec('stock.picking', 146, '20261105-102428', 'TC-EIN-001', 'UAT'),
  ];

  test('--only thu hẹp chính xác vào các bản ghi chỉ định trong đúng môi trường và Run ID', () => {
    const r = cleanupScope(reg, { environment: 'STAGING_A', runId: '20261105-102428', only: ['stock.picking:146', 'product.product:2276'] });
    expect(r.unknown).toEqual([]);
    expect(r.scope.map((x) => `${x.model}:${x.recordId}`).sort()).toEqual(['product.product:2276', 'stock.picking:146']);
    expect(r.scope.every((x) => x.environment === 'STAGING_A' && x.runId === '20261105-102428')).toBe(true); // bản ghi cùng ID ở môi trường khác không bị lẫn
  });

  test('bản ghi chỉ định nằm ngoài phạm vi (khác Run ID, khác môi trường, không có registry) ⇒ unknown ⇒ từ chối; không mở rộng sang bản ghi khác', () => {
    const r = cleanupScope(reg, { environment: 'STAGING_A', runId: '20261105-102428', only: ['stock.picking:141', 'stock.picking:999'] });
    expect(r.unknown.sort()).toEqual(['stock.picking:141', 'stock.picking:999']);
    expect(cleanupScope(reg, { environment: 'PROD', runId: '20261105-102428', only: ['stock.picking:146'] }).unknown).toEqual(['stock.picking:146']);
  });

  test('không có --only: cả Run ID của môi trường đó (hành vi cũ), không lấy lần chạy khác', () => {
    const r = cleanupScope(reg, { environment: 'STAGING_A', runId: '20261105-102428' });
    expect(r.scope.map((x) => x.recordId).sort()).toEqual([146, 147, 2276]);
  });
});

test.describe('SCR-6 Hai tab trên trình duyệt', () => {
  test('Ma trận và Lịch sử chỉ có requirement hiện tại, không có nút chuyển sang requirement khác', async ({ page }) => {
    await page.setContent(html('REQ-A'));
    await page.getByRole('button', { name: /Ma trận truy vết REQ với Test case/ }).click();
    await expect(page.locator('#panel-rtm tbody tr')).toHaveCount(1);
    await expect(page.locator('#panel-rtm tbody tr[data-rtm="REQ-A"]')).toBeVisible();
    await page.getByRole('button', { name: /Lịch sử test/ }).click();
    await expect(page.locator('#panel-history tbody tr')).toHaveCount(2);
    await expect(page.locator('button', { hasText: 'Xem mọi requirement' })).toHaveCount(0);
    expect(await page.content()).not.toContain('REQ-B');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-7 Bug và evidence không bị trộn giữa các requirement', () => {
  const ev = (n: string) => ({ video: `artifacts/${n}/video.webm`, screenshots: [`artifacts/${n}/shot.png`] });
  const rs = [
    run('20261105-000001', [entry(A1, 'FAIL', { error: { message: 'loi A1' }, evidence: ev('a-old') }), entry(B1, 'FAIL', { error: { message: 'loi B1' }, evidence: ev('b-only') })]),
    run('20261105-000002', [entry(A1, 'PASS', { evidence: ev('a-new') })]),
  ];

  test('chỉ bug và evidence của requirement đang xử lý; bug SUPERSEDED giữ trạng thái và nêu lần chạy mới', () => {
    const h = html('REQ-A', { runs: rs });
    expect(h).toContain('a-new/video.webm');
    expect(h).not.toContain('b-only'); // evidence của requirement khác không có mặt
    expect(h).not.toContain('loi B1');
    expect(h).toMatch(/SUPERSEDED — đã có lần chạy mới hơn \(20261105-000002\)/);
    expect(h).not.toContain('TC-B1'); // test case, bug, ma trận của REQ-B không xuất hiện
    expect(h).not.toContain('class="defect"'); // test đã PASS ở lần chạy mới: không còn nhãn Defect ở tiêu đề thẻ
    expect(h).toContain('Bug cũ đã được thay thế (SUPERSEDED)'); // nhưng bug cũ vẫn xem được trong chi tiết
    // trong dữ liệu lưu trữ, bug của REQ-B vẫn còn (không bị xóa)
    const all = buildBugs(defs, rs);
    expect(all.map((b) => b.relatedTestCase).sort()).toEqual(['TC-A1', 'TC-B1']);
    expect(all.find((b) => b.relatedTestCase === 'TC-A1')!.status).toBe('SUPERSEDED');
    expect(all.find((b) => b.relatedTestCase === 'TC-B1')!.status).toBe('OPEN');
  });

  test('requirement kia có bug đang mở thì báo cáo của nó hiện đúng bug của nó', () => {
    const h = html('REQ-B', { runs: rs });
    expect(h).toContain('b-only/video.webm');
    expect(h).not.toContain('a-new');
    expect(h).not.toContain('a-old');
    expect(h).toContain('ĐANG MỞ');
    expect(h).not.toContain('SUPERSEDED —');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-8 Steps, Expected, Actual dễ đọc và không mất dữ liệu kỹ thuật', () => {
  const D: TestCaseDef = { ...def('TC-S1', 'REQ-S'), title: 'Kiểm tra lưu', steps: ['1. Mở danh sách VIN; chọn VIN thứ hai', 'Nhập số máy đã dùng', 'Nhập số máy đã dùng', 'Nhấn Lưu'], expectedResult: 'Hệ thống từ chối lưu và hiển thị cảnh báo.' };
  const REQ_S = req('REQ-S', 'Yêu cầu S');
  const render = (e: TcRunEntry | undefined) => {
    const rr = e ? [run('20261105-000007', [e])] : [];
    const { results, summary } = aggregate([D], rr);
    const focus = buildFocus('REQ-S', [REQ_S], results, [], summary.generatedAt);
    return renderHtml({ summary, results, glossary: {}, requirements: [REQ_S], runs: rr.map((r) => runMeta(r, [D])), bugs: [], focus });
  };

  test('Steps đánh số theo đúng thứ tự, mỗi bước một hành động, không lặp; Expected và Actual đúng cột', () => {
    const h = render(entry(D, 'FAIL', { actual: 'Hệ thống vẫn lưu, không hiển thị cảnh báo.', error: { message: 'x' } }));
    const stepsBlock = h.slice(h.indexOf('Các bước thực hiện'), h.indexOf('Kết quả thực tế'));
    const order = ['Mở danh sách VIN', 'chọn VIN thứ hai', 'Nhập số máy đã dùng', 'Nhấn Lưu'].map((t) => stepsBlock.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // đúng thứ tự thao tác
    expect(stepsBlock.match(/<b>Step \d+:<\/b>/g)).toHaveLength(4); // tách theo dấu chấm phẩy, bỏ bước lặp, bỏ số thứ tự gốc
    expect(stepsBlock).not.toMatch(/Step 1:<\/b> 1\./);
    const actual = h.slice(h.indexOf('Kết quả thực tế (Actual)'), h.indexOf('Kết quả mong đợi (Expected)'));
    const expected = h.slice(h.indexOf('Kết quả mong đợi (Expected)'), h.indexOf('</section>', h.indexOf('Kết quả mong đợi (Expected)')));
    expect(h).toContain('Hệ thống vẫn lưu, không hiển thị cảnh báo.'); // bản gốc đầy đủ trong Chi tiết kỹ thuật ở chân thẻ
    expect(actual).not.toContain('từ chối lưu');
    expect(expected).toContain('Hệ thống từ chối lưu và hiển thị cảnh báo.');
    expect(expected).not.toContain('vẫn lưu');
  });

  test('tóm tắt nghiệp vụ ở phần chính; nội dung kỹ thuật gốc (selector, API, ORM, lỗi) còn nguyên trong "Chi tiết kỹ thuật"', () => {
    const full = 'Mở stock.move.line qua RPC engine_number=EIN202611051016412222 cho VIN AT202611051016414908; locator td[name="engine_number"] ghi nhận giá trị mới.';
    const h = render(entry(D, 'FAIL', { actual: full, summary: 'Hệ thống vẫn lưu số máy trùng, không hiển thị cảnh báo.', technical: ['response: {"ok":true}'], error: { message: 'expect(locator).toHaveText failed', failedStep: 'Hệ thống chặn lưu' } }));
    const actual = h.slice(h.indexOf('Kết quả thực tế (Actual)'), h.indexOf('Kết quả mong đợi (Expected)'));
    const main = actual.slice(actual.indexOf('<p>'), actual.indexOf('</p>'));
    expect(main).toContain('Hệ thống vẫn lưu số máy trùng, không hiển thị cảnh báo.');
    expect(main).not.toMatch(/stock\.move\.line|locator|RPC/);
    expect(actual).not.toContain('techdetail'); // nằm ở chân thẻ, không kéo dài cột Actual
    expect(h).toMatch(/<details class="techdetail" id="[^"]+"><summary>Chi tiết kỹ thuật<\/summary>/);
    const tech = h.slice(h.indexOf('class="techdetail"'));
    for (const must of ['stock.move.line', 'EIN202611051016412222', 'AT202611051016414908', 'response: {&quot;ok&quot;:true}', 'expect(locator).toHaveText failed', 'Hệ thống chặn lưu']) expect(tech, must).toContain(must);
  });

  test('presentActual/presentSteps: ưu tiên tóm tắt, rút gọn mã máy, BLOCKED phân loại và không gọi là lỗi nghiệp vụ, NEEDS CLARIFICATION nêu đúng nội dung cần làm rõ', () => {
    expect(presentActual({ actual: 'chi tiết dài', status: 'PASS', summary: 'Phiếu nhập được hoàn tất, số máy vẫn hiển thị đúng.' }).main).toBe('Phiếu nhập được hoàn tất, số máy vẫn hiển thị đúng.');
    const legacy = presentActual({ actual: 'Nhập số máy EIN202611051016412222 cho VIN AT202611051016414908: lưu thành công; gọi stock.move.line.write qua RPC', status: 'PASS' });
    expect(legacy.main).toBe('Nhập số máy EIN…2222 cho VIN AT…4908: lưu thành công');
    expect(legacy.details[0].text).toContain('stock.move.line.write'); // bản gốc còn nguyên
    // BLOCKED: phân loại theo metadata có cấu trúc, KHÔNG theo từ khóa trong lý do
    const b = (reason: string, blockedKind?: string) => presentActual({ actual: '', status: 'BLOCKED', reason, blockedKind });
    expect(b('bất kỳ lý do nào', 'ENVIRONMENT').blocked?.kind).toBe('ENVIRONMENT');
    expect(b('bất kỳ lý do nào', 'PERMISSION').blocked?.kind).toBe('PERMISSION');
    expect(b('bất kỳ lý do nào', 'DATA').blocked?.kind).toBe('DATA');
    expect(b('Từ chối: tài khoản không có quyền truy cập môi trường dữ liệu').blocked?.kind).toBe('UNKNOWN'); // có từ khóa nhưng không có metadata ⇒ không đoán
    expect(b('Từ chối: tài khoản không có quyền truy cập môi trường dữ liệu').main).toContain('Chưa xác định nguyên nhân');
    expect(b(`${WRITE_NOT_GRANTED_PREFIX}: chưa xác nhận`).blocked?.kind).toBe('PERMISSION'); // kết quả cũ: chỉ dùng tiền tố có cấu trúc của framework
    expect(b(`${APPROVAL_BLOCK_PREFIX}: chưa duyệt`).blocked?.kind).toBe('APPROVAL');
    expect(b('x', 'ENVIRONMENT').main).toMatch(/chưa có kết luận nghiệp vụ/);
    expect(presentActual({ actual: '', status: 'NEEDS CLARIFICATION', reason: 'AC-02 chưa nói rõ có áp dụng cho số máy đã lưu trữ không' }).main).toContain('AC-02 chưa nói rõ');
    expect(presentSteps(['Bước 1: Mở màn hình; nhấn Lưu', '2) Nhấn Lưu', ''])).toEqual(['Mở màn hình', 'nhấn Lưu']);
  });

  test('BLOCKED hiển thị là điều kiện thực thi, kèm nhãn loại; không gọi là lỗi nghiệp vụ', () => {
    const h = render(entry(D, 'BLOCKED', { actual: 'x', reason: 'Chưa có tài khoản cho role "approver" trên môi trường STAGING_A', blockedKind: 'PERMISSION' }));
    expect(h).toContain('Thiếu quyền hoặc tài khoản vai trò');
    expect(h).toContain('chưa có kết luận nghiệp vụ');
    expect(render(entry(D, 'BLOCKED', { actual: 'x', reason: 'lý do lạ' }))).toContain('Chưa xác định nguyên nhân');
  });

  test('báo cáo vẫn dựng đúng khi chưa có test nào chạy: NOT RUN, lịch sử trống, không PASS/FAIL/bug giả', () => {
    const h = render(undefined);
    expect(h).toContain('data-focus="NOT RUN">1<');
    expect(h).toContain('data-focus="PASS">0<');
    expect(h).toContain('REQ-S chưa có lần chạy nào');
    expect(h).not.toContain('Lịch sử bug');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-9 Dựng lại báo cáo của requirement cũ từ dữ liệu đã lưu', () => {
  test('mỗi lần dựng chỉ chứa một requirement; chuyển qua lại không làm mất lịch sử, bug hay evidence trong thư mục lưu trữ', () => {
    // writeAggregate đọc testcases/requirements THẬT trên đĩa (không nhận tham số workspace), nên test này cần ít nhất 2 requirement
    // có test case sẵn có để mượn — bộ cài đặt sạch (clone mới, không kèm requirement nghiệp vụ thật) sẽ không có: bỏ qua, không giả lập.
    const byReq = new Map<string, TestCaseDef>();
    for (const d of loadTestCases()) if (d.requirementId && !byReq.has(d.requirementId)) byReq.set(d.requirementId, d);
    test.skip(byReq.size < 2, 'cần ít nhất 2 requirement có test case trên đĩa (bộ cài đặt sạch không kèm requirement nghiệp vụ thật)');
    const [[reqA, dA], [reqB, dB]] = [...byReq.entries()];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rebuild-'));
    try {
      const mk = (id: string, d: TestCaseDef, status: TcRunEntry['status']) => {
        const f = path.join(dir, 'runs', id);
        fs.mkdirSync(f, { recursive: true });
        fs.writeFileSync(path.join(f, 'results.json'), JSON.stringify(run(id, [entry(d, status, status === 'FAIL' ? { error: { message: 'x' } } : {})])));
      };
      mk('20261105-000001', dA, 'FAIL');
      mk('20261105-000002', dB, 'PASS');
      mk('20261105-000003', dA, 'PASS');
      const before = fs.readdirSync(path.join(dir, 'runs')).map((n) => fs.readFileSync(path.join(dir, 'runs', n, 'results.json'), 'utf8'));
      writeAggregate(dir, reqB);
      let h = fs.readFileSync(path.join(dir, 'qa-report.html'), 'utf8');
      expect([...h.matchAll(/data-req="([^"]+)"/g)].map((m) => m[1]).every((r) => r === reqB)).toBe(true);
      expect(h).toContain('#RUN-20261105-000002');
      expect(h).not.toContain('#RUN-20261105-000001');
      expect(h).not.toContain(reqA);
      writeAggregate(dir, reqA); // quay lại requirement cũ
      h = fs.readFileSync(path.join(dir, 'qa-report.html'), 'utf8');
      expect([...h.matchAll(/#RUN-(\d{8}-\d{6})/g)].map((m) => m[1])).toEqual(['20261105-000003', '20261105-000001']); // cả hai lần chạy cũ của chính nó còn nguyên
      expect(h).not.toContain(reqB);
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'qa-results.json'), 'utf8'));
      expect(json.focus.requirementId).toBe(reqA);
      expect(json.runs.map((r: { runId: string }) => r.runId)).toEqual(['20261105-000001', '20261105-000002', '20261105-000003']); // lưu trữ vẫn đủ mọi lần chạy
      expect(fs.readdirSync(path.join(dir, 'runs')).map((n) => fs.readFileSync(path.join(dir, 'runs', n, 'results.json'), 'utf8'))).toEqual(before); // dữ liệu gốc không đổi
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-10 Tóm tắt Actual cho kết quả lịch sử chưa có recordSummary', () => {
  const D: TestCaseDef = { ...def('TC-H1', 'REQ-H'), title: 'Lưu số liệu', steps: ['Mở màn hình', 'Nhấn Lưu'], expectedResult: 'Hệ thống từ chối lưu.' };
  const REQ_H = req('REQ-H', 'Yêu cầu H');
  const verbose = 'Nhập giá trị G1 cho dòng R1: giá trị sau khi Lưu = G1 (trước: (trống)); thông báo hiển thị: (không có).';
  const old = entry(D, 'FAIL', { actual: verbose, error: { message: 'Error: giá trị phải giữ nguyên\n\nexpect(received).toBe(expected)\n\nExpected: false\nReceived: "EIN202611051024281552"', failedStep: 'Hệ thống chặn lưu' } });
  const rs = [run('20261105-000009', [old])];
  const file = (over: Partial<SummaryFile['entries'][string]> = {}): Record<string, SummaryFile> => ({
    '20261105-000009': { runId: '20261105-000009', authoredAt: 'x', authoredBy: 'test', entries: { 'TC-H1': { status: 'FAIL', defHash: defHash(D), summary: 'Hệ thống vẫn lưu giá trị, không hiển thị cảnh báo.', basis: ['results.json (actual): giá trị sau khi Lưu = G1', 'ảnh chụp: không có cảnh báo'], ...over } } },
  });
  const build = (sums: Record<string, SummaryFile>) => {
    const { results, summary } = aggregate([D], rs, sums);
    const focus = buildFocus('REQ-H', [REQ_H], results, [], summary.generatedAt);
    return { r: results[0], html: renderHtml({ summary, results, glossary: {}, requirements: [REQ_H], runs: rs.map((x) => runMeta(x, [D])), bugs: [], focus }) };
  };
  const mainOf = (html: string) => {
    const actual = html.slice(html.indexOf('Kết quả thực tế (Actual)'), html.indexOf('Kết quả mong đợi (Expected)'));
    return { actual, main: actual.slice(actual.indexOf('<p>'), actual.indexOf('</p>')) };
  };

  test('tóm tắt lịch sử có căn cứ được dùng làm Actual chính; bản gốc và căn cứ còn nguyên trong Chi tiết kỹ thuật; dữ liệu gốc không đổi', () => {
    const before = JSON.stringify(rs);
    const { r, html } = build(file());
    expect(r).toMatchObject({ summary: 'Hệ thống vẫn lưu giá trị, không hiển thị cảnh báo.', summarySource: 'HISTORICAL' });
    expect(r.actual).toBe(verbose); // dữ liệu thực thi gốc không bị thay
    const { main } = mainOf(html);
    expect(main).toContain('Hệ thống vẫn lưu giá trị, không hiển thị cảnh báo.');
    const tech = html.slice(html.indexOf('class="techdetail"'));
    expect(tech).toContain('Nguồn của câu tóm tắt');
    expect(tech).toContain('ảnh chụp: không có cảnh báo');
    expect(tech).toContain('giá trị sau khi Lưu = G1 (trước: (trống))'); // nội dung gốc đầy đủ
    expect(JSON.stringify(rs)).toBe(before);
  });

  test('không áp sai: trạng thái hoặc hash test case khác kết quả ⇒ bỏ qua và quay về nội dung gốc; tóm tắt do test tự ghi luôn thắng', () => {
    expect(build(file({ status: 'PASS' })).r.summary).toBeUndefined();
    expect(build(file({ defHash: 'sai' })).r.summary).toBeUndefined();
    expect(historicalSummaryFor(file(), '20261105-000008', 'TC-H1', 'FAIL', defHash(D))).toBeUndefined(); // sai lần chạy
    const own = [run('20261105-000009', [{ ...old, summary: 'Tóm tắt do test ghi.' }])];
    expect(aggregate([D], own, file()).results[0]).toMatchObject({ summary: 'Tóm tắt do test ghi.', summarySource: 'RUN' });
  });

  test('tệp tóm tắt thiếu căn cứ hoặc hỏng bị bỏ qua và báo; đọc đúng tệp hợp lệ', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sum-'));
    try {
      fs.mkdirSync(path.join(dir, 'summaries'));
      fs.writeFileSync(path.join(dir, 'summaries', 'a.json'), JSON.stringify(file()['20261105-000009']));
      fs.writeFileSync(path.join(dir, 'summaries', 'b.json'), JSON.stringify({ runId: 'r2', entries: { 'TC-H1': { status: 'FAIL', defHash: 'h', summary: 'x', basis: [] } } }));
      fs.writeFileSync(path.join(dir, 'summaries', 'c.json'), '{ hỏng');
      const r = loadSummaries(dir);
      expect(Object.keys(r.files)).toEqual(['20261105-000009']);
      expect(r.problems).toHaveLength(2);
      expect(r.problems.join(' ')).toMatch(/b\.json.*basis/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('không có tóm tắt nào (kết quả lịch sử thuần): FAIL dùng thông báo assertion + mong đợi/thực tế có cấu trúc; không bịa gì thêm', () => {
    const { r, html } = build({});
    expect(r.summary).toBeUndefined();
    const { main } = mainOf(html);
    expect(main).toContain('Không đạt: Giá trị phải giữ nguyên (mong đợi: (trống); thực tế: EIN…1552).');
    expect(html).toContain('giá trị sau khi Lưu = G1'); // bản gốc đầy đủ trong chi tiết
    expect(failFromError('Test timeout of 90000ms exceeded.')).toBeUndefined(); // lỗi kỹ thuật thì không diễn giải
    expect(failFromError('Error: expect(locator).toBeVisible() failed')).toBeUndefined();
    expect(failFromError(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-11 Thẻ test case gọn: thuật ngữ, Description, dữ liệu chạy, Defect', () => {
  const gl = { vin_a: 'VIN (serial) thứ nhất, do Test Data Factory tạo khi chạy', vin_b: 'VIN (serial) thứ hai, khác vin_a, do Test Data Factory tạo khi chạy', do_nhap: 'Phiếu nhập kho có dòng sản phẩm theo dõi serial, dùng cho vin_a' };

  test('plainTerms: thay tên biến bằng cách gọi ngắn, không lặp từ, bỏ tên biến khi diễn giải dài, trả về thuật ngữ đã gặp', () => {
    expect(plainTerms('Mở Hoạt động chi tiết của VIN (serial) vin_b', gl).text).toBe('Mở Hoạt động chi tiết của VIN (serial) thứ hai');
    expect(plainTerms('Nhập đúng số máy đã gắn với vin_a', gl).text).toBe('Nhập đúng số máy đã gắn với VIN (serial) thứ nhất');
    expect(plainTerms('Mở phiếu nhập kho do_nhap dùng vin_a', gl)).toEqual({ text: 'Mở phiếu nhập kho dùng VIN (serial) thứ nhất', used: ['do_nhap', 'vin_a'] });
    expect(plainTerms('Không có thuật ngữ', gl)).toEqual({ text: 'Không có thuật ngữ', used: [] });
    expect(plainTerms('abc vin_a', {}).text).toBe('abc vin_a');
  });

  test('descriptionIsRedundant: ẩn khi lặp tiêu đề/bước/Expected, giữ khi có thông tin bổ sung', () => {
    const others = ['Lưu số máy trùng bị chặn', 'Mở phiếu nhập kho', 'Hệ thống chặn lưu và thông báo trùng'];
    expect(descriptionIsRedundant('Hệ thống chặn lưu số máy trùng và thông báo', others)).toBe(true);
    expect(descriptionIsRedundant('Chỉ áp dụng cho kho trung tâm, ngoài giờ hành chính, với người dùng quyền quản lý', others)).toBe(false);
  });

  test('thẻ: Description lặp bị ẩn, dữ liệu chạy + thuật ngữ nằm trong Chi tiết kỹ thuật (đóng), bug cũ chỉ trong mục Lịch sử; dữ liệu gốc không đổi', () => {
    const D2: TestCaseDef = { ...def('TC-G1', 'REQ-G'), title: 'Lưu số máy trùng bị chặn', description: 'Hệ thống chặn lưu số máy trùng và thông báo', steps: ['Mở phiếu nhập kho do_nhap'], expectedResult: 'Hệ thống chặn lưu và thông báo trùng cho vin_b.' };
    const R = req('REQ-G', 'Yêu cầu G');
    const e = entry(D2, 'PASS', { actual: 'ok', data: { vin_b: 'VIN001' } });
    const rs2 = [run('20261105-000010', [e])];
    const { results, summary } = aggregate([D2], rs2, {});
    const focus = buildFocus('REQ-G', [R], results, [], summary.generatedAt);
    const html = renderHtml({ summary, results, glossary: gl, requirements: [R], runs: rs2.map((x) => runMeta(x, [D2])), bugs: [], focus });
    const card = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    expect(card).not.toContain('class="desc"');
    expect(card).toContain('<li><b>Step 1:</b> Mở phiếu nhập kho</li>');
    expect(card).toContain('thông báo trùng cho VIN (serial) thứ hai.');
    expect(card).not.toContain('Test Data Factory tạo khi chạy</i>');
    expect(card).not.toContain('class="rundata"');
    const tech = card.slice(card.indexOf('<details class="techdetail"'));
    expect(tech).toContain('Dữ liệu thực tế đã dùng khi chạy');
    expect(tech).toContain('vin_b: VIN001');
    expect(tech).toContain('Giải thích thuật ngữ');
    expect(card).not.toMatch(/<details[^>]*\sopen/);
    expect(results[0].def.steps).toEqual(['Mở phiếu nhập kho do_nhap']); // test case gốc không bị sửa
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-12 Chân thẻ gọn: Evidence, Trace, Defect, tiêu đề', () => {
  const D3: TestCaseDef = { ...def('TC-J1', 'REQ-J'), title: 'Chặn lưu trùng', steps: ['Lưu'], expectedResult: 'Hệ thống chặn lưu.' };
  const R3 = { ...req('REQ-J', 'Yêu cầu J'), title: '[NEW REQUIREMENT] Không cho trùng' };
  const timeout = entry(D3, 'FAIL', { actual: 'x', error: { message: 'Test timeout of 90000ms exceeded.' } });
  const business = entry(D3, 'FAIL', { actual: 'y', error: { message: 'Error: số máy phải giữ nguyên' }, evidence: { video: 'v.webm', screenshots: ['a.png', 'b.png'], trace: 'runs/r/trace.zip' } });
  const rs3 = [run('20261105-000011', [timeout]), run('20261105-000012', [business])];
  const build = () => {
    const bugs = buildBugs([D3], rs3);
    const { results, summary } = aggregate([D3], rs3, {});
    const focus = buildFocus('REQ-J', [R3], results, bugs, summary.generatedAt);
    const html = renderHtml({ summary, results, glossary: {}, requirements: [R3], runs: rs3.map((x) => runMeta(x, [D3])), bugs, focus });
    return { bugs, html, card: html.slice(html.indexOf('<article'), html.indexOf('</article>')) };
  };

  test('không mục thu gọn nào mở sẵn; Evidence mặc định chỉ có tên và số lượng; khung video/ảnh hiện có nằm trong mục thu gọn', () => {
    const { card } = build();
    expect(card).not.toMatch(/<details[^>]*\sopen/);
    const box = card.slice(card.indexOf('<details class="evbox">'));
    const summary = box.slice(0, box.indexOf('</summary>'));
    expect(summary).toContain('Bằng chứng');
    expect(summary).toContain('1 video · 2 ảnh');
    expect(summary).not.toContain('<video');
    expect(summary).not.toContain('<img');
    const body = box.slice(box.indexOf('</summary>'));
    expect(body).toContain('<video controls');
    expect(body).toMatch(/data-zoom="[^"]*a\.png"/);
  });

  test('Trace chỉ nằm trong Chi tiết kỹ thuật; ngoài thẻ không còn đường dẫn dài; nhãn Trace dẫn tới đúng mục', () => {
    const { card } = build();
    const tech = card.slice(card.indexOf('class="techdetail"'), card.indexOf('class="bugdetail"'));
    expect(tech).toMatch(/npx playwright show-trace \S*trace\.zip/);
    expect(card.split('show-trace')).toHaveLength(2);
    expect(card).toContain('data-open="tech-TC-J1"');
    expect(card).toContain('id="tech-TC-J1"');
  });

  test('Defect: tiêu đề thẻ không chứa Bug ID; nhãn ngắn Bug đang mở; bug OPEN và SUPERSEDED tách rõ, một lớp thu gọn', () => {
    const { card, bugs } = build();
    const header = card.slice(0, card.indexOf('</header>'));
    expect(header).not.toContain('BUG-');
    expect(card).toContain('>Bug đang mở</a>');
    const open = bugs.find((b) => b.status === 'OPEN')!;
    const old = bugs.find((b) => b.status === 'SUPERSEDED')!;
    expect(card).toContain(`${open.bugId} · ĐANG MỞ`);
    expect(card.indexOf(`id="bug-${open.bugId}"`)).toBeLessThan(card.indexOf('Bug cũ đã được thay thế (SUPERSEDED)'));
    expect(card.indexOf('Bug cũ đã được thay thế (SUPERSEDED)')).toBeLessThan(card.indexOf(`id="bug-${old.bugId}"`));
    const defect = card.slice(card.indexOf('class="bugdetail"'));
    expect(defect.split('<details')).toHaveLength(1);
  });

  test('timeout automation không được tính là lỗi nghiệp vụ tái hiện; dữ liệu bug gốc không đổi', () => {
    const { card, bugs } = build();
    expect(bugs.map((b) => b.verification)).toEqual(['REPRODUCED', 'REPRODUCED']); // dữ liệu gốc giữ nguyên
    expect(card).not.toContain('lỗi tái hiện ở nhiều lần chạy');
    expect(card).toContain('Mới xác nhận ở 1 lần chạy có kết luận nghiệp vụ');
    expect(card).toContain('Chưa đủ căn cứ: lần chạy này dừng vì timeout/locator');
    expect(card).toContain('Chưa xác định: lần chạy dừng vì timeout/locator');
    const biz = { errorMessage: 'Error: sai', verification: 'REPRODUCED' as const, categoryLabel: 'x' };
    expect(presentBugTrust(biz, [biz, biz])).toEqual({ category: undefined, verification: undefined }); // 2 lần lỗi nghiệp vụ thật: giữ nguyên
  });

  test('tiêu đề báo cáo không còn ngoặc lồng; tên requirement gốc giữ nguyên', () => {
    const { html } = build();
    expect(html).toContain('<h1>Báo cáo kiểm thử REQ-J: Không cho trùng</h1>');
    expect(html).not.toContain('REPORT BUG REQ');
    expect(R3.title).toBe('[NEW REQUIREMENT] Không cho trùng');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-13 Xuất báo cáo sau khi người dùng đã tương tác', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const D4: TestCaseDef = { ...def('TC-K1', 'REQ-K'), title: 'Xuất', steps: ['Lưu'], expectedResult: 'Hệ thống chặn lưu.' };
  const R4 = req('REQ-K', 'Yêu cầu K');

  test('file xuất là HTML gốc: mục thu gọn đóng, tab mặc định, không có mã extension, ảnh vẫn tải từ thư mục khác; trang đang xem không đổi', async ({ page, browser }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-exp-'));
    try {
      const rs4 = [run('20261105-000013', [entry(D4, 'FAIL', { actual: 'x', error: { message: 'Error: sai' }, evidence: { screenshots: ['a.png'], trace: 't.zip' } })])];
      const bugs = buildBugs([D4], rs4);
      const { results, summary } = aggregate([D4], rs4, {});
      const focus = buildFocus('REQ-K', [R4], results, bugs, summary.generatedAt);
      const html = renderHtml({ summary, results, glossary: {}, requirements: [R4], runs: rs4.map((x) => runMeta(x, [D4])), bugs, focus });
      const shot = html.match(/data-zoom="([^"]+)"/)![1];
      const report = path.join(dir, 'report');
      fs.mkdirSync(path.dirname(path.join(report, shot)), { recursive: true });
      fs.writeFileSync(path.join(report, shot), PNG);
      fs.writeFileSync(path.join(report, 'qa-report.html'), html);

      await page.goto(pathToFileURL(path.join(report, 'qa-report.html')).href);
      await page.evaluate(() => { const s = document.createElement('style'); s.id = 'mttstyle'; document.head.appendChild(s); });
      await page.locator('details.evbox > summary .evh').click();
      await page.locator('details.techdetail > summary').click();
      await page.locator('.tab[data-tab="RTM"]').click();
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#b-export').click()]);
      const out = path.join(dir, 'downloads', 'qa-report.html');
      await download.saveAs(out);

      // Trang đang xem giữ nguyên trạng thái của người dùng.
      await expect(page.locator('details[open]')).toHaveCount(2);
      await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', 'RTM');

      // Đúng từng byte HTML gốc, chỉ thêm <base> để đường dẫn evidence tương đối vẫn trỏ về thư mục báo cáo.
      const exported = fs.readFileSync(out, 'utf8');
      const base = `<base href="${pathToFileURL(report).href}/">`;
      expect(exported).toContain(base);
      expect(exported.replace(base, '')).toBe(html);
      expect(exported).not.toContain('mttstyle');

      const fresh = await browser.newContext();
      const p2 = await fresh.newPage();
      await p2.goto(pathToFileURL(out).href);
      await expect(p2.locator('details[open]')).toHaveCount(0);
      await expect(p2.locator('.tab.active')).toHaveAttribute('data-tab', 'ALL');
      await expect(p2.locator('#panel-tests')).toBeVisible();
      await expect(p2.locator('#panel-rtm')).toBeHidden();
      await expect(p2.locator('article.tc')).toHaveCount(1);
      await p2.locator('details.evbox > summary .evh').click();
      await expect.poll(() => p2.locator('.shot img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
      await p2.locator('.shot img').click();
      await expect(p2.locator('#lb')).toHaveClass(/show/);
      await p2.keyboard.press('Escape');

      // Xuất lại từ chính file đã xuất: vẫn trỏ về đúng thư mục báo cáo.
      const [again] = await Promise.all([p2.waitForEvent('download'), p2.locator('#b-export').click()]);
      const out2 = path.join(dir, 'downloads2', 'qa-report.html');
      await again.saveAs(out2);
      expect(fs.readFileSync(out2, 'utf8')).toBe(exported);
      await fresh.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bản nhúng không làm đếm trùng dữ liệu báo cáo', () => {
    const rs4 = [run('20261105-000014', [entry(D4, 'PASS', { actual: 'x' })])];
    const { results, summary } = aggregate([D4], rs4, {});
    const html = renderHtml({ summary, results, glossary: {}, requirements: [R4], runs: rs4.map((x) => runMeta(x, [D4])), bugs: [], focus: buildFocus('REQ-K', [R4], results, [], summary.generatedAt) });
    expect(html.split('<article')).toHaveLength(2);
    expect(html.split('__QA_REPORT_SOURCE__')).toHaveLength(2); // chỉ còn dấu MARK; SRC đã thay bằng bản gốc
    expect(html).not.toContain('outerHTML');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('SCR-14 Cleanup chỉ dọn bản ghi có bằng chứng sở hữu và chưa phát sinh nghiệp vụ', () => {
  const handler = (model: string) => odooFactoryCleanupHandlers.find((h) => h.supported && h.models.includes(model) && h.id.startsWith('factory-'))!;
  const rec = (model: string, recordId: number, extra: Partial<TestDataRecord> = {}) => ({ model, recordId, reference: 'AUTOTEST x', ...extra }) as TestDataRecord;
  const client = (rows: Record<string, any[]>, used = 0) => ({
    currentUserId: async () => 10,
    searchRead: async (model: string) => rows[model] ?? [],
    count: async () => used,
  }) as never;
  const me = [10, 'automation'];

  test('phiếu kho: không có nhãn AUTOTEST hay liên kết SO test thì không được hủy, kể cả có trong registry', async () => {
    const rows = { 'stock.picking': [{ id: 67, name: 'WH/IN/00039', state: 'assigned', origin: 'P00003', create_uid: me }] };
    const [it] = await handler('stock.picking').plan({ client: client(rows), records: [rec('stock.picking', 67)] });
    expect(it.eligible).toBe(false);
    expect(it.steps).toEqual([]);
    expect(it.blockers.join(' ')).toContain('P00003');
  });

  test('phiếu kho: nhãn AUTOTEST hoặc phiếu do SO test sinh ra thì được hủy; người khác tạo hoặc đã hoàn tất thì chặn', async () => {
    const run = async (row: any, extra = {}) => (await handler('stock.picking').plan({ client: client({ 'stock.picking': [{ id: 1, name: 'P', state: 'assigned', create_uid: me, ...row }], 'sale.order': [{ id: 5, name: 'S00092' }] }), records: [rec('stock.picking', 1, extra)] }))[0];
    expect((await run({ origin: 'AUTOTEST 1 TC-1' })).steps.map((s) => s.op)).toEqual(['stock.picking.action_cancel']);
    expect((await run({ origin: 'S00092' }, { dependsOn: ['sale.order:5'] })).eligible).toBe(true);
    expect((await run({ origin: 'S00099' }, { dependsOn: ['sale.order:5'] })).eligible).toBe(false);
    expect((await run({ origin: 'AUTOTEST 1 TC-1', create_uid: [7, 'Người khác'] })).eligible).toBe(false);
    expect((await run({ origin: 'AUTOTEST 1 TC-1', state: 'done' })).eligible).toBe(false);
  });

  test('sản phẩm và liên hệ đã phát sinh nghiệp vụ thì không archive, dù tên mang nhãn AUTOTEST', async () => {
    const rows = { 'product.product': [{ id: 2, name: 'AUTOTEST sp', active: true, create_uid: me }], 'res.partner': [{ id: 3, name: 'AUTOTEST kh', active: true, create_uid: me }] };
    const records = [rec('product.product', 2), rec('res.partner', 3)];
    const blocked = await handler('product.product').plan({ client: client(rows, 1), records });
    expect(blocked.map((i) => i.eligible)).toEqual([false, false]);
    expect(blocked.map((i) => i.blockers.join(' ')).join(' ')).toMatch(/dịch chuyển kho hoàn tất.*chứng từ kế toán đã ghi sổ|chứng từ kế toán đã ghi sổ.*dịch chuyển kho hoàn tất/);
    const free = await handler('product.product').plan({ client: client(rows, 0), records });
    expect(free.map((i) => i.eligible)).toEqual([true, true]);
  });

  test('BACKFILL hoặc thiếu owner không bao giờ được chọn để dọn', async () => {
    const r = (origin: string, owner?: 'FRAMEWORK') => ({ ...rec('product.product', 9), origin, owner, environment: 'E', runId: 'r', testCaseId: 't', cleanupStatus: 'PENDING' }) as TestDataRecord;
    for (const x of [r('BACKFILL', 'FRAMEWORK'), r('AUTOMATION')]) {
      const res = await runCleanup({ client: client({}), handlers: odooFactoryCleanupHandlers as never, records: [x], environment: 'E', policy: { failureRetentionHours: 0 } as never, dryRun: true });
      expect(res.outcomes).toEqual([]);
    }
  });
});
