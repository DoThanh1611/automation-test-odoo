import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { listOdooModules, odooModules } from '../../applications/odoo/modules';
import { purchaseModule } from '../../applications/odoo/modules/purchase/module';
import { salesModule } from '../../applications/odoo/modules/sales/module';
import { aggregate } from '../../core/reporters/aggregate';
import { buildBugs, classifyError } from '../../core/reporters/bugs';
import { formatDuration, runDurationMs } from '../../core/reporters/render-extras';
import { acceptanceOf, renderHtml, stampVi } from '../../core/reporters/render-html';
import { sanitizeEntry } from '../../core/reporters/sanitize';
import type { RunFile, TcRunEntry } from '../../core/reporters/types';
import { computeCoverage } from '../../core/testcases/coverage';
import { defHash } from '../../core/testcases/hash';
import { loadRequirements, loadTestCases } from '../../core/testcases/loader';
import { findSimilarRequirements } from '../../core/testcases/duplicates';
import { shareDecision } from '../../core/security/scan';
import { parseRequirement } from '../../core/testcases/req-parser';
import type { Requirement, TestCaseDef } from '../../core/testcases/schema';
import { checkExecutionGate, confirmPhrase, planId, type PlanItem } from '../../core/testdata/cleanup';
import { grantProblems } from '../../core/testdata/write-guard';

// Framework tests cho kiến trúc đa module. KHÔNG kết nối Odoo, KHÔNG tạo dữ liệu.

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];

const mkDef = (id: string, over: Partial<TestCaseDef> = {}): TestCaseDef => ({
  id, title: `Tiêu đề ${id}`, requirementRefs: ['BR-01'], description: '', preconditions: [], testData: {}, steps: ['bước 1', 'bước 2'],
  expectedResult: 'kết quả mong đợi', verification: 'UI', automated: true, requirementId: 'REQ-A', application: 'odoo', module: 'sales', ...over,
});
const mkEntry = (def: TestCaseDef, status: TcRunEntry['status'], extra: Partial<TcRunEntry> = {}): TcRunEntry => ({
  tcId: def.id, defHash: defHash(def), status, actual: 'thực tế', durationMs: 1000, evidence: { screenshots: [] }, ...extra,
});
const mkRun = (runId: string, entries: TcRunEntry[], extra: Partial<RunFile> = {}): RunFile => ({ runId, startedAt: runId, finishedAt: `2026-11-03T00:00:0${runId.slice(-1)}Z`, entries, ...extra });

test.describe('Kiến trúc đa module (FW-10)', () => {
  test('lõi dùng chung (core/) không nhắc tới model hay logic của bất kỳ module nghiệp vụ nào', () => {
    const forbidden = /sale\.order|purchase\.order|stock\.picking|account\.payment|account\.move|moveo_|client_order_ref|partner_ref/;
    for (const f of walk('core').filter((x) => x.endsWith('.ts'))) {
      expect(fs.readFileSync(f, 'utf8'), `${f} chứa logic riêng của module`).not.toMatch(forbidden);
    }
    // client RPC dùng chung của Odoo cũng không được biết model cụ thể (trừ dữ liệu thuần tuý của framework: ir.*)
    const client = fs.readFileSync(path.join('applications', 'odoo', 'client.ts'), 'utf8');
    expect(client).not.toMatch(/sale\.order|purchase\.order|account\.payment|moveo_/);
  });

  test('mỗi thư mục trong applications/odoo/modules đều được đăng ký và khai báo đủ', () => {
    const dirs = fs.readdirSync(path.join('applications', 'odoo', 'modules'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs.sort()).toEqual(listOdooModules().map((m) => m.module).sort());
    for (const m of listOdooModules()) {
      expect(m.key).toBe(`odoo-${m.module}`);
      expect(odooModules[m.key]).toBe(m);
      for (const f of ['module.ts', 'api.ts', 'fixtures.ts']) expect(fs.existsSync(path.join('applications', 'odoo', 'modules', m.module, f)), `${m.key} thiếu ${f}`).toBe(true);
      if (!fs.existsSync(path.join('tests', m.key))) continue; // bộ cài đặt dùng chung không kèm requirement/test case/fixture nghiệp vụ
      for (const d of [path.join('requirements', m.key), path.join('testcases', m.key), path.join('tests', m.key)]) expect(fs.existsSync(d), `${m.key} thiếu thư mục ${d}`).toBe(true);
      // Fixture thật bị .gitignore (chứa host và chứng từ thật): máy mới chưa có thì kiểm mẫu *.example.json thay thế.
      const real = path.join('testdata', 'fixtures', `${m.fixturesKey}.json`);
      const file = fs.existsSync(real) ? real : path.join('testdata', 'fixtures', `${m.fixturesKey}.example.json`);
      if (!fs.existsSync(file)) continue;
      const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(typeof fx.environment, `${m.key}: fixture thiếu environment`).toBe('string');
    }
  });

  test('mọi model có quyền ghi (ownership) đều có handler cleanup khai báo; không module nào dùng chung model cleanup với module khác', () => {
    const claimed = new Map<string, string>();
    for (const m of listOdooModules()) {
      for (const rule of m.ownership) {
        expect(m.cleanup.some((h) => h.models.includes(rule.model)), `${m.key}: model ${rule.model} được ghi nhưng chưa khai báo cleanup (kể cả "chưa hỗ trợ")`).toBe(true);
        expect(rule.refField && rule.creatorField).toBeTruthy();
      }
      for (const h of m.cleanup) {
        if (!h.supported) expect(h.unsupportedReason, `${m.key}/${h.id}: chưa hỗ trợ thì phải nêu lý do`).toBeTruthy();
        for (const model of h.models) {
          expect(claimed.get(model), `${model} bị hai module cùng khai báo cleanup (${claimed.get(model)} và ${m.key})`).toBeUndefined();
          claimed.set(model, m.key);
        }
      }
    }
  });

  test('Purchase: chưa có handler cleanup nào được hỗ trợ và KHÔNG mượn quy trình huỷ của Sales', async () => {
    expect(purchaseModule.cleanup.length).toBeGreaterThan(0);
    for (const h of purchaseModule.cleanup) expect(h.supported, `${h.id} không được hỗ trợ khi chưa xác minh`).toBe(false);
    expect(purchaseModule.cleanup.flatMap((h) => h.models)).toEqual(expect.arrayContaining(['purchase.order', 'stock.move', 'account.move']));
    expect(purchaseModule.cleanup.flatMap((h) => h.models)).not.toContain('stock.picking'); // phiếu kho thuộc Inventory
    const rec = { runId: 'r', testCaseId: 'TC-X', application: 'odoo', module: 'purchase', model: 'purchase.order', recordId: 5, reference: 'AUTOTEST r TC-X', createdAt: '', cleanupStatus: 'PENDING' as const, origin: 'AUTOMATION' as const };
    const items = await purchaseModule.cleanup[0].plan({ client: undefined as never, records: [rec] });
    expect(items).toHaveLength(1);
    expect(items[0].eligible).toBe(false);
    expect(items[0].steps).toEqual([]);
    expect(items[0].blockers.join(' ')).toMatch(/CHƯA HỖ TRỢ/);
    expect(purchaseModule.ownership.map((r) => r.model)).not.toContain('sale.order');
    expect(JSON.stringify(purchaseModule)).not.toMatch(/action_unlock|sale\.order|account\.payment/);
  });

  test('Sales giữ nguyên khai báo cũ: ghi sale.order, cleanup SO + phiếu thu', () => {
    expect(salesModule.ownership).toEqual([{ model: 'sale.order', refField: 'client_order_ref', creatorField: 'create_uid' }]);
    expect(salesModule.cleanup.flatMap((h) => h.models).sort()).toEqual(['account.payment', 'sale.order']);
    expect(salesModule.cleanup.every((h) => h.supported && !h.execute)).toBe(true); // chưa triển khai thực thi
  });

  test('test case nạp từ Sales mang đủ application/module/requirement để lọc báo cáo', () => {
    const tcs = loadTestCases();
    test.skip(tcs.length === 0, 'Chưa có test case nào (bộ cài đặt dùng chung không kèm test case nghiệp vụ)');
    for (const t of tcs) {
      expect(t.application, t.id).toBeTruthy();
      expect(t.module, t.id).toBeTruthy();
      expect(t.requirementId, t.id).toBeTruthy();
    }
  });
});

test.describe('Giấy phép ghi theo môi trường/module/lần chạy (FW-11)', () => {
  const base = { allowWrite: true, grant: { host: 'a.example.com', module: 'odoo-sales', runId: '20261103-000001' }, host: 'a.example.com', module: 'odoo-sales', runId: '20261103-000001' };
  test('chỉ qua khi cả ba (môi trường, module, lần chạy) khớp và ALLOW_WRITE_TESTS bật', () => {
    expect(grantProblems(base)).toEqual([]);
    expect(grantProblems({ ...base, allowWrite: false })).toHaveLength(1);
    expect(grantProblems({ ...base, grant: undefined })).toHaveLength(1); // trả sớm: không có giấy phép thì không cần so tiếp
    expect(grantProblems({ ...base, grant: undefined, allowWrite: false })).toHaveLength(2);
    expect(grantProblems({ ...base, host: 'b.example.com' })).toHaveLength(1);
    expect(grantProblems({ ...base, module: 'odoo-purchase' })).toHaveLength(1);
    expect(grantProblems({ ...base, runId: '20261103-000002' })).toHaveLength(1);
  });
});

test.describe('Cleanup có cổng xác nhận (FW-12)', () => {
  const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ model: 'm', id, reference: 'r', label: 'l', eligible: true, alreadyClean: false, blockers: [], steps: [{ op: 'm.cancel', why: 'x' }], ...over });
  test('planId ổn định, không phụ thuộc thứ tự, và đổi khi kế hoạch đổi', () => {
    expect(planId([item(1), item(2)])).toBe(planId([item(2), item(1)]));
    expect(planId([item(1)])).not.toBe(planId([item(1), item(2)]));
    expect(planId([item(1)])).not.toBe(planId([item(1, { steps: [{ op: 'm.other', why: 'x' }] })]));
    expect(planId([item(1)])).not.toBe(planId([item(1, { eligible: false })]));
  });

  test('cổng thực thi: thiếu bất kỳ điều kiện nào cũng bị chặn; chỉ qua khi đủ tất cả', () => {
    const ok = { moduleKey: 'odoo-sales', host: 'h.example.com', currentPlanId: 'abc123', executableCount: 3, givenPlanId: 'abc123', givenPhrase: confirmPhrase('odoo-sales', 'h.example.com', 3), allowCleanupEnv: true };
    expect(checkExecutionGate(ok)).toEqual([]);
    expect(checkExecutionGate({ ...ok, moduleKey: undefined, givenPhrase: undefined })).not.toEqual([]); // không chỉ định module
    expect(checkExecutionGate({ ...ok, allowCleanupEnv: false })).toHaveLength(1);
    expect(checkExecutionGate({ ...ok, givenPlanId: 'khac' })).toHaveLength(1);
    expect(checkExecutionGate({ ...ok, givenPlanId: undefined })).toHaveLength(1);
    expect(checkExecutionGate({ ...ok, givenPhrase: 'xac nhan' })).toHaveLength(1);
    expect(checkExecutionGate({ ...ok, givenPhrase: confirmPhrase('odoo-sales', 'h.example.com', 99) })).toHaveLength(1); // sai số lượng
    expect(checkExecutionGate({ ...ok, executableCount: 0, givenPhrase: confirmPhrase('odoo-sales', 'h.example.com', 0) })).toHaveLength(1);
  });

  test('script cleanup không gọi hàm ghi và có cổng xác nhận; chưa có handler nào triển khai execute', () => {
    const script = fs.readFileSync(path.join('scripts', 'cleanup-autotest.ts'), 'utf8');
    expect(script).toContain('checkExecutionGate');
    expect(script).toContain('ALLOW_CLEANUP');
    const writeRpc = /\.(call|tryCall)\(\s*['"][^'"]+['"]\s*,\s*['"](write|create|unlink|copy|action_\w+|button_\w+)['"]/;
    for (const f of ['scripts/cleanup-autotest.ts', 'scripts/registry-backfill.ts', 'scripts/snapshot-fields.ts', ...walk(path.join('applications', 'odoo', 'modules')).filter((x) => /cleanup\.ts$|backfill\.ts$/.test(x))]) {
      expect(writeRpc.test(fs.readFileSync(f, 'utf8')), `${f} gọi RPC ghi`).toBe(false);
    }
  });
});

test.describe('Nhận requirement (FW-13)', () => {
  const toMarkdown = (r: Requirement) =>
    [`**[NEW REQUIREMENT] ${r.title}**`, `Path: ${r.path}`, '**Business Requirement**', r.businessRequirement, '**Expected Solution**', r.expectedSolution ?? 'Giải pháp mẫu.',
      '**Business Rules**', ...r.businessRules.map((b) => `- ${b.id}: ${b.text}`), '**Acceptance Criteria**', ...r.acceptanceCriteria.map((a) => `- ${a.id}: ${a.text}`)].join('\n');

  test('requirement Sales thật: phân tích rồi so lại, BR/AC giữ nguyên từng ký tự (không diễn giải)', () => {
    for (const r of loadRequirements()) {
      const p = parseRequirement(toMarkdown(r));
      expect(p.problems, r.id).toEqual([]);
      expect(p.businessRules).toEqual(r.businessRules);
      expect(p.acceptanceCriteria).toEqual(r.acceptanceCriteria);
      expect(p.businessRequirement).toBe(r.businessRequirement.trim());
      expect(p.path).toBe(r.path);
    }
  });

  test('chấp nhận tiêu đề tiếng Việt, đánh dấu in đậm/markdown, và dòng BR/AC nhiều dòng', () => {
    const md = ['# Tên', '**Đường dẫn:** Mua hàng → Đơn mua', '## Yêu cầu nghiệp vụ', 'Cho phép A.', '## Giải pháp mong đợi', 'Thêm nút B.', '### Quy tắc nghiệp vụ',
      '- BR-01: Nút B chỉ hiện khi `state = \'purchase\'`', '  và đã xác nhận.', '- BR-02: Quy tắc hai.', '### Tiêu chí nghiệm thu', '- AC-01: Thấy nút B.'].join('\n');
    const p = parseRequirement(md);
    expect(p.problems).toEqual([]);
    expect(p.path).toBe('Mua hàng → Đơn mua');
    expect(p.businessRules[0].text).toBe("Nút B chỉ hiện khi `state = 'purchase'` và đã xác nhận.");
    expect(p.businessRules).toHaveLength(2);
    expect(p.acceptanceCriteria).toEqual([{ id: 'AC-01', text: 'Thấy nút B.' }]);
  });

  test('requirement thiếu/sai cấu trúc bị báo lỗi, không tự đoán', () => {
    const missing = parseRequirement('**Path:** x\n**Business Requirement**\ny\n**Business Rules**\n- BR-01: a');
    expect(missing.problems.join('|')).toMatch(/Expected Solution/);
    expect(missing.problems.join('|')).toMatch(/Acceptance Criteria/);
    const dup = parseRequirement('Path: x\nBusiness Requirement\ny\nExpected Solution\nz\nBusiness Rules\n- BR-01: a\n- BR-01: b\nAcceptance Criteria\n- AC-01: c');
    expect(dup.problems.join('|')).toMatch(/Trùng mã BR-01/);
    const wrong = parseRequirement('Path: x\nBusiness Requirement\ny\nExpected Solution\nz\nBusiness Rules\n- AC-01: nằm nhầm chỗ\nAcceptance Criteria\n- AC-02: c');
    expect(wrong.problems.join('|')).toMatch(/AC-01 nằm trong mục "Business Rules"/);
  });

  test('đọc được định dạng dán thô: tiêu đề có số thứ tự, "(*)", "Path / Đường dẫn màn hình"; giữ nguyên chữ, kể cả lỗi chính tả', () => {
    const raw = [
      '[NEW REQUIREMENT] Tiêu đề', 'Path / Đường dẫn màn hình (*)', '', 'Menu A → B.', 'Menu C → D.',
      '1. Business Requirement (*)', 'Yêu cầu x.', '2. Expected Solution (*)', 'Tạo hóa đQơn (%).',
      '3. Business Rules (*)', 'BR-01: Có khoảng trắng thừa trước dấu chấm .', 'BR-02: b',
      '4. Acceptance Criteria (*)', 'AC-01: c',
    ].join('\n');
    const p = parseRequirement(raw);
    expect(p.problems).toEqual([]);
    expect(p.path).toBe('Menu A → B. Menu C → D.');
    expect(p.expectedSolution).toBe('Tạo hóa đQơn (%).');
    expect(p.businessRules[0].text).toBe('Có khoảng trắng thừa trước dấu chấm .');
    expect(p.businessRules).toHaveLength(2);
    expect(p.acceptanceCriteria).toHaveLength(1);
  });

  test('độ phủ tính THEO TỪNG requirement: BR-01 của requirement này không che BR-01 của requirement khác', () => {
    const reqs: Requirement[] = ['REQ-A', 'REQ-B'].map((id) => ({ id, title: id, application: 'odoo', module: 'x', businessRequirement: '', businessRules: [{ id: 'BR-01', text: 'a' }, { id: 'BR-02', text: 'b' }], acceptanceCriteria: [{ id: 'AC-01', text: 'c' }] }));
    const tcs = [mkDef('TC-1', { requirementId: 'REQ-A', requirementRefs: ['BR-01', 'AC-01'] }), mkDef('TC-2', { requirementId: 'REQ-B', requirementRefs: ['BR-02'] })];
    const cov = computeCoverage(reqs, tcs);
    expect(cov.find((c) => c.requirementId === 'REQ-A')!.uncovered).toEqual(['BR-02']);
    expect(cov.find((c) => c.requirementId === 'REQ-B')!.uncovered).toEqual(['BR-01', 'AC-01']);
    const bad = computeCoverage(reqs, [mkDef('TC-3', { requirementId: 'REQ-A', requirementRefs: ['BR-09'] }), mkDef('TC-3', { requirementId: 'REQ-Z', requirementRefs: ['BR-01'] })]);
    expect(bad.flatMap((c) => c.errors).join('|')).toMatch(/BR-09 không tồn tại trong REQ-A/);
    expect(bad.flatMap((c) => c.errors).join('|')).toMatch(/Trùng ID test case TC-3/);
    expect(bad.flatMap((c) => c.errors).join('|')).toMatch(/requirement "REQ-Z" không tồn tại/);
  });
});

test.describe('Bug Report và báo cáo (FW-14)', () => {
  const defA = mkDef('TC-A');
  const defB = mkDef('TC-B', { requirementRefs: ['AC-01'] });
  const aggregateInput = () => ({ ...aggregate([defA, defB], runs), glossary: {}, requirements: [] as Requirement[] });
  const runs = [
    mkRun('20261103-000001', [mkEntry(defA, 'FAIL', { error: { message: 'Error: apiRequestContext.post: read ECONNRESET', failedStep: 'Gọi RPC' } })], { baseURL: 'https://h.example.com', writesEnabled: false }),
    mkRun('20261103-000002', [mkEntry(defA, 'PASS'), mkEntry(defB, 'FAIL', { error: { message: 'expect(locator).toBeVisible() failed', failedStep: 'Nút hiển thị' }, role: { role: 'accountant', privileged: true }, evidence: { video: 'artifacts/b/video.webm', screenshots: ['artifacts/b/s.png'], trace: 'artifacts/b/trace.zip' } })], { baseURL: 'https://h.example.com', writesEnabled: true }),
  ];

  test('classifyError tách lỗi hạ tầng khỏi lỗi sản phẩm', () => {
    expect(classifyError('read ECONNRESET')).toBe('SUSPECTED_INFRASTRUCTURE');
    expect(classifyError('net::ERR_CONNECTION_REFUSED at https://x')).toBe('SUSPECTED_INFRASTRUCTURE');
    expect(classifyError('expect(locator).toBeVisible() failed')).toBe('SUSPECTED_PRODUCT');
    expect(classifyError('Expected: 10000000 Received: 0')).toBe('SUSPECTED_PRODUCT');
  });

  test('buildBugs: đủ trường theo mẫu, ID ổn định, trạng thái OPEN/SUPERSEDED, môi trường, evidence trỏ đúng lần chạy', () => {
    const bugs = buildBugs([defA, defB], runs);
    expect(bugs.map((b) => b.bugId)).toEqual(['BUG-20261103-000001-TC-A', 'BUG-20261103-000002-TC-B']);
    const [infra, prod] = bugs;
    expect(infra.status).toBe('SUPERSEDED'); // TC-A đã PASS ở lần chạy sau
    expect(infra.category).toBe('SUSPECTED_INFRASTRUCTURE');
    expect(prod.status).toBe('OPEN');
    expect(prod.category).toBe('SUSPECTED_PRODUCT');
    expect(prod).toMatchObject({ relatedTestCase: 'TC-B', stepsToReproduce: ['bước 1', 'bước 2'], expectedResult: 'kết quả mong đợi', failedStep: 'Nút hiển thị' });
    expect(prod.environment).toMatchObject({ host: 'h.example.com', application: 'odoo', module: 'sales', writesEnabled: true, runId: '20261103-000002' });
    expect(prod.environment.role?.role).toBe('accountant');
    expect(prod.evidence.video).toBe('runs/20261103-000002/artifacts/b/video.webm');
    expect(prod.evidence.screenshots).toEqual(['runs/20261103-000002/artifacts/b/s.png']);
  });

  test('bằng chứng theo trạng thái: PASS chỉ video; FAIL/BLOCKED video + ảnh; không có bằng chứng thì không có vùng bằng chứng; tab rỗng bị ẩn', () => {
    const ev = { video: 'artifacts/x/video.webm', screenshots: ['artifacts/x/s.png'] };
    const defs = ['TC-P', 'TC-F', 'TC-B', 'TC-N'].map((id) => mkDef(id));
    const run = mkRun('20261103-000020', [
      mkEntry(defs[0], 'PASS', { evidence: ev }),
      mkEntry(defs[1], 'FAIL', { evidence: ev, error: { message: 'x', failedStep: 's' } }),
      mkEntry(defs[2], 'BLOCKED', { evidence: ev, reason: 'chặn' }),
    ]);
    const { summary, results } = aggregate(defs, [run]);
    const html = renderHtml({ summary, results, glossary: {}, requirements: [], bugs: [] });
    const card = (id: string) => html.split('<article class="tc').find((c) => c.includes(`id="tc-${id}"`)) ?? '';
    expect(card('TC-P')).toContain('<video');
    expect(card('TC-P')).not.toContain('class="shot');
    for (const id of ['TC-F', 'TC-B']) {
      expect(card(id)).toContain('<video');
      expect(card(id)).toContain('class="shot');
      expect(card(id)).toContain('data-zoom=');
    }
    expect(card('TC-N')).not.toContain('class="evbox"');
    expect(card('TC-N')).not.toContain('<video');
    expect(html).not.toMatch(/data-tab="[A-Z ]+" hidden/); // mọi tab trạng thái luôn hiển thị trên menu
  });

  test('lần chạy CHỈ ĐỌC không đè kết quả thật của test ghi; BLOCKED vì lý do khác thì vẫn được hiển thị', () => {
    const writeDef = mkDef('TC-W');
    const real = mkRun('20261103-000010', [mkEntry(writeDef, 'PASS')]);
    const ro = mkRun('20261103-000011', [mkEntry(writeDef, 'BLOCKED', { reason: 'Chưa có quyền ghi dữ liệu: ALLOW_WRITE_TESTS != true' })]);
    const kept = aggregate([writeDef], [real, ro]).results[0];
    expect(kept.status).toBe('PASS');
    expect(kept.runId).toBe('20261103-000010');
    expect(kept.readOnlySkip?.runId).toBe('20261103-000011');
    // chưa từng có kết luận thật: hiển thị BLOCKED như thường
    expect(aggregate([writeDef], [ro]).results[0].status).toBe('BLOCKED');
    // BLOCKED vì thiếu tài khoản (lý do khác) là kết quả mới, không bị bỏ qua
    const noAcc = mkRun('20261103-000012', [mkEntry(writeDef, 'BLOCKED', { reason: 'Chưa có tài khoản cho role "x"' })]);
    expect(aggregate([writeDef], [real, noAcc]).results[0].status).toBe('BLOCKED');
    // định nghĩa đã đổi: kết quả cũ không còn áp dụng, không được dùng để che BLOCKED
    expect(aggregate([{ ...writeDef, expectedResult: 'khác' }], [real, ro]).results[0].status).not.toBe('PASS');
  });

  test('Bug Report: Run ID, thời gian phát hiện, có bằng chứng, và kiểm chứng lại (không kết luận khi chưa chạy lại)', () => {
    const [infra, prod] = buildBugs([defA, defB], runs);
    expect(prod).toMatchObject({ runId: '20261103-000002', hasEvidence: true, verification: 'UNVERIFIED' });
    expect(prod.detectedAt).toBe(runs[1].finishedAt);
    expect(infra.verification).toBe('NOT_REPRODUCED'); // lần chạy sau PASS, không tái hiện
    // lỗi ở 2 lần chạy với cùng định nghĩa => đã kiểm chứng lại
    const again = [...runs, mkRun('20261103-000003', [mkEntry(defB, 'FAIL', { error: { message: 'expect(locator).toBeVisible() failed' } })])];
    const b = buildBugs([defA, defB], again).filter((x) => x.relatedTestCase === 'TC-B');
    expect(b.map((x) => x.verification)).toEqual(['REPRODUCED', 'REPRODUCED']);
    expect(b.find((x) => x.runId === '20261103-000003')!.hasEvidence).toBe(false);
    const html = renderHtml({ summary: aggregateInput().summary, results: aggregateInput().results, glossary: {}, requirements: [], bugs: buildBugs([defA, defB], runs) });
    for (const need of ['Run ID · thời gian phát hiện', 'Kiểm chứng lại', 'Phân loại sơ bộ', 'Lịch sử bug', 'Bug đang mở', 'BUG-20261103-000002-TC-B']) expect(html, need).toContain(need);
  });

  test('báo cáo HTML có bộ lọc Application/Module/Requirement, truy vết BR/AC (đánh dấu BR/AC chưa phủ), Bug và ô framework test riêng', () => {
    const req: Requirement = { id: 'REQ-A', title: 'Yêu cầu A', application: 'odoo', module: 'sales', businessRequirement: 'x', businessRules: [{ id: 'BR-01', text: 'Quy tắc một' }, { id: 'BR-02', text: 'Quy tắc hai' }], acceptanceCriteria: [{ id: 'AC-01', text: 'Tiêu chí một' }] };
    const { results, summary } = aggregate([defA, defB], runs);
    const html = renderHtml({ summary, results, glossary: {}, requirements: [req], runs: [], bugs: buildBugs([defA, defB], runs) });
    for (const needle of ['id="app"', 'id="mod"', 'id="req"', 'BUG-20261103-000002-TC-B', 'nghi hạ tầng', 'Execution Pass Rate', 'Overall Pass Coverage', 'Ma trận truy vết yêu cầu']) {
      expect(html, `thiếu "${needle}"`).toContain(needle);
    }
    expect(html).toContain('data-app="odoo"');
    expect(html).toContain('data-module="sales"');
    expect(html).toContain('data-req="REQ-A"');
    expect(summary.executionPassRate).toBe(50); // 1 PASS / (1 PASS + 1 FAIL)
    expect(summary.overallPassCoverage).toBe(50);
  });

  test('báo cáo không thể chứa cookie/mật khẩu dù test vô tình ghi vào Actual hay lỗi', () => {
    const cookie = `ck-${randomBytes(15).toString('base64url')}`; // sinh lúc chạy: mã nguồn không chứa chuỗi giống mật khẩu
    const dirty = mkEntry(defA, 'FAIL', { actual: `Lỗi, cookie session_id=${cookie}`, reason: `Authorization: Bearer ${cookie}`, error: { message: `Cookie: session_id=${cookie}` }, data: { k: `session_id=${cookie}` }, evidence: { screenshots: [], video: 'artifacts/a/video.webm' } });
    const clean = sanitizeEntry(dirty, [{ label: 'x', value: 'Zx9#kLm2!' }]);
    expect(JSON.stringify(clean)).not.toContain(cookie);
    expect(clean.evidence.video).toBe('artifacts/a/video.webm'); // đường dẫn evidence không bị đổi
    expect(clean.actual).toContain('session_id=[REDACTED]');
  });

// Giao diện dashboard của báo cáo (chỉ kiểm tra cấu trúc HTML do renderHtml sinh ra; hành vi click được kiểm tra thủ công trên báo cáo thật).
test.describe('Báo cáo dạng dashboard', () => {
  const defs = [defA, defB];
  const req: Requirement = { id: 'REQ-A', title: 'Yêu cầu A', application: 'odoo', module: 'sales', businessRequirement: 'x', businessRules: [{ id: 'BR-01', text: 'Quy tắc một' }], acceptanceCriteria: [{ id: 'AC-01', text: 'Tiêu chí một' }] };
  const build = (extra: Partial<Parameters<typeof renderHtml>[0]> = {}) => {
    const { results, summary } = aggregate(defs, runs);
    return { summary, results, html: renderHtml({ summary, results, glossary: {}, requirements: [req], bugs: buildBugs(defs, runs), ...extra }) };
  };

  test('thiết kế mới: 7 ô chỉ số CHỈ ĐỌC, thanh tab đủ 8 mục, tiêu đề báo cáo, ba nút thao tác', () => {
    const { html, summary } = build();
    // Dashboard chỉ để đọc: các ô là div, không phải nút/liên kết bấm được.
    const dash = html.slice(html.indexOf('id="dash"'), html.indexOf('id="tabs"'));
    expect(dash.match(/class="mt /g)).toHaveLength(7); // Tổng + 5 trạng thái + Tỉ lệ Pass
    expect(dash).not.toMatch(/<button|<a /);
    for (const label of ['Tổng Test Case', 'Pass', 'Fail', 'Block', 'Need Clarify', 'Not run', 'Tỉ lệ Pass (%)']) expect(dash, label).toContain(label);
    expect(dash).toContain(`data-metric="PASS">${summary.passed}<`);
    // Thanh tab ngang: Tất cả | Pass | Fail | Block | Need Clarify | Not run | Ma trận truy vết | Lịch sử test
    for (const t of ['ALL', 'PASS', 'FAIL', 'BLOCKED', 'NEEDS CLARIFICATION', 'NOT RUN', 'RTM', 'HISTORY']) expect(html).toContain(`data-tab="${t}"`);
    expect(html).toContain('Ma trận truy vết REQ với Test case');
    expect(html).toContain('Lịch sử test');
    expect(html).toContain('<h1>Báo cáo kiểm thử: Tất cả requirement</h1>');
    for (const id of ['b-refresh', 'b-pdf', 'b-export']) expect(html).toContain(`id="${id}"`);
    for (const label of ['Làm mới', 'Xuất PDF', 'Xuất báo cáo']) expect(html).toContain(label);
    expect(html).toContain('Báo cáo tạo lúc:');
    expect(html).toContain('Người phê duyệt:');
    expect(html).toContain('<b>' + (summary.executionPassRate === null ? 'N/A' : summary.executionPassRate + '%') + '</b><span>Execution Pass Rate</span>');
  });

  test('thẻ test case: Description, Steps, Actual, Expected, bằng chứng (video luôn kèm; ảnh bug có nút phóng to); khối Defect', () => {
    const { html } = build();
    for (const needle of ['Các bước thực hiện (Steps)', 'Kết quả thực tế (Actual)', 'Kết quả mong đợi (Expected)', 'Bằng chứng', 'Step 1:']) expect(html, needle).toContain(needle);
    expect(html).toContain('<article class="tc');
    expect(html).not.toMatch(/<details class="tc/);
    expect(html).toContain('Video quay toàn màn hình quá trình thực thi'); // video luôn đính kèm khi có
    expect(html).toContain('Screen-record:');
    expect(html).toContain('Bug Screenshot'); // test FAIL có ảnh chụp màn hình
    expect(html).toContain('Nhấp để phóng to');
    expect(html).toContain('data-zoom=');
    expect(html).toContain('id="lb"'); // lớp phóng to ảnh
    expect(html).toContain('href="#bug-BUG-20261103-000002-TC-B"');
  });

  test('ma trận truy vết và lịch sử chạy nằm trong tab riêng (ẩn mặc định); các khu vực không còn là details thu gọn cũ', () => {
    const { html } = build({ runs: [{ runId: '20261103-000002', startedAt: '2026-11-03T00:00:00Z', finishedAt: '2026-11-03T00:02:15Z', testCases: 1, counts: { PASS: 1 }, scopes: ['odoo/sales'] }] });
    expect(html).toMatch(/<section class="panel" id="panel-rtm" hidden>/);
    expect(html).toMatch(/<section class="panel" id="panel-history" hidden>/);
    expect(html).toContain('Độ phủ trung bình:');
    for (const col of ['Mã Requirement', 'Tên yêu cầu nghiệp vụ Claude quy định', 'Các test case liên kết', 'Độ phủ kiểm thử', 'Trạng thái nghiệm thu']) expect(html, col).toContain(col);
    for (const col of ['Lần chạy (#Run ID)', 'Ngày giờ hoàn tất', 'Đo thời gian chạy', 'Số lượng token', 'Ghi chú phiên bản prompt / engine', 'Trạng thái run']) expect(html, col).toContain(col);
    expect(html).toContain('#RUN-20261103-000002');
    // Hai tab thay hoàn toàn khu vực thu gọn cũ: không còn khối truy vết BR/AC hay chi tiết từng lần chạy dạng details.
    for (const old of ['id="runsec"', 'Truy vết BR/AC (', 'Lịch sử chạy test (']) expect(html, old).not.toContain(old);
    for (const gone of ['Framework/unit test', 'fwbox', 'Cách đọc báo cáo', 'thuật ngữ chung']) expect(html, `không được có "${gone}"`).not.toContain(gone);
  });

  test('trạng thái nghiệm thu của requirement: xấu nhất thắng (FAIL → Cần sửa, BLOCKED → Bị chặn, NEEDS CLARIFICATION → Cần làm rõ, NOT RUN → Chưa chạy, toàn PASS → Đạt)', () => {
    expect(acceptanceOf(['PASS', 'FAIL', 'BLOCKED'])).toEqual({ cls: 'fail', label: 'Cần sửa' });
    expect(acceptanceOf(['PASS', 'BLOCKED', 'NEEDS CLARIFICATION'])).toEqual({ cls: 'blocked', label: 'Bị chặn' });
    expect(acceptanceOf(['PASS', 'NEEDS CLARIFICATION'])).toEqual({ cls: 'clarify', label: 'Cần làm rõ' });
    expect(acceptanceOf(['PASS', 'NOT RUN'])).toEqual({ cls: 'notrun', label: 'Chưa chạy' });
    expect(acceptanceOf([])).toEqual({ cls: 'notrun', label: 'Chưa chạy' });
    expect(acceptanceOf(['PASS', 'PASS'])).toEqual({ cls: 'pass', label: 'Đạt' });
    expect(stampVi('2026-11-05T09:15:00')).toBe('05/11/2026 - 09:15:00 A.M.');
    expect(stampVi('2026-11-04T16:30:22')).toBe('04/11/2026 - 04:30:22 P.M.');
  });

  test('lịch sử chạy: thời lượng chỉ hiển thị khi có dữ liệu hợp lệ, không suy đoán', () => {
    expect(runDurationMs('2026-11-03T00:00:00Z', '2026-11-03T00:02:15Z')).toBe(135000);
    expect(formatDuration(135000)).toBe('2 phút 15 giây');
    expect(formatDuration(8000)).toBe('8 giây');
    for (const [a, b] of [['2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z'], ['', '2026-11-03T00:00:00Z'], ['x', 'y']]) expect(runDurationMs(a, b)).toBeNull();
    expect(formatDuration(null)).toBe('Không có dữ liệu');
    const { html } = build({ runs: [{ runId: '20261102-000000', startedAt: '2026-11-02T00:00:00Z', finishedAt: '2026-11-02T00:00:00Z', testCases: 2, counts: { PASS: 1, BLOCKED: 1 }, scopes: ['odoo/sales'] }] });
    expect(html).toContain('Không có dữ liệu'); // thời lượng không suy đoán khi thiếu mốc hợp lệ
    expect(html).toContain('1 PASS');
    expect(html).toContain('1 BLOCKED');
    expect(html).toContain('odoo/sales');
  });

  test('bằng chứng nằm trong chi tiết test case (video + ảnh khi FAIL); tab lịch sử chỉ có bảng tổng hợp', () => {
    const { html } = build({ runs: [{ runId: 'r', startedAt: '2026-11-03T00:00:00Z', finishedAt: '2026-11-03T00:01:00Z', testCases: 1, counts: { FAIL: 1 }, scopes: ['odoo/sales'] }] });
    expect(html).toContain('runs/20261103-000002/artifacts/b/video.webm'); // evidence trong chi tiết test case
    expect(html).toContain('runs/20261103-000002/artifacts/b/s.png');
  });

  test('ô filter hỗ trợ nhiều application/module cùng lúc', () => {
    const { html } = build();
    expect(html).toContain('<option value="odoo">odoo</option>');
    expect(html).toContain('<option value="sales">sales</option>');
  });
});
});

test.describe('Trải nghiệm người dùng mới: /qa-requirement (FW-15)', () => {
  const cmd = fs.readFileSync(path.join('.claude', 'commands', 'qa-requirement.md'), 'utf8');

  test('lệnh /qa-requirement có đủ các bước và luật bắt buộc', () => {
    for (const need of ['req:import', 'req:check', 'Playwright MCP', '.mcp.json', 'nhiều module', 'trùng', 'requirements/_inbox', 'READ-ONLY'.replace('READ-ONLY', 'CHỈ ĐỌC'), 'NEEDS CLARIFICATION', 'BLOCKED', 'không bao giờ tự đổi', 'qa-report.html', 'test:write', 'KHÔNG đoán locator', 'KHÔNG sửa nội dung']) {
      expect(cmd.toLowerCase(), `thiếu "${need}" trong qa-requirement.md`).toContain(need.toLowerCase());
    }
    expect(fs.readFileSync('.mcp.json', 'utf8')).toContain('@playwright/mcp');
  });

  test('requirement mẫu hợp lệ theo mẫu 5 mục và không chứa dữ liệu thật', () => {
    const text = fs.readFileSync(path.join('example', 'requirements', 'SAMPLE-REQUIREMENT.md'), 'utf8');
    const p = parseRequirement(text);
    expect(p.problems).toEqual([]);
    expect(p.businessRules.map((x) => x.id)).toEqual(['BR-01', 'BR-02']);
    expect(p.acceptanceCriteria.map((x) => x.id)).toEqual(['AC-01', 'AC-02', 'AC-03']);
    expect(text).not.toMatch(/https?:\/\/|@[a-z0-9-]+\.[a-z]{2,}|vinfast|moveo/i);
  });

  test('phát hiện requirement trùng: cùng mã, cùng tiêu đề hoặc phần lớn BR/AC giống nhau; khác nhau thì không báo', () => {
    const base: Requirement = { id: 'REQ-A', title: 'Nút Duyệt', application: 'odoo', module: 'sales', businessRequirement: 'x', businessRules: [{ id: 'BR-01', text: 'Nút chỉ hiện khi chờ duyệt.' }], acceptanceCriteria: [{ id: 'AC-01', text: 'Thấy nút Duyệt' }] };
    const cand = (over: Partial<Parameters<typeof findSimilarRequirements>[0]>) => ({ id: 'REQ-NEW', title: 'Khác hẳn', businessRules: [{ text: 'Quy tắc hoàn toàn khác' }], acceptanceCriteria: [{ text: 'Tiêu chí khác' }], ...over });
    expect(findSimilarRequirements(cand({}), [base])).toEqual([]);
    expect(findSimilarRequirements(cand({ id: 'REQ-A' }), [base])[0].reason).toMatch(/mã/);
    expect(findSimilarRequirements(cand({ title: 'nút  duyệt!' }), [base])[0].reason).toMatch(/tiêu đề/);
    expect(findSimilarRequirements(cand({ businessRules: [{ text: 'Nút chỉ hiện khi chờ duyệt' }], acceptanceCriteria: [{ text: 'Tiêu chí khác' }] }), [base])[0].reason).toMatch(/1\/2/);
  });

  test('trùng MÃ requirement là lỗi cứng (không vượt qua được) và bị báo ở kiểm tra phủ khi có hai requirement cùng mã', () => {
    const r = (module: string): Requirement => ({ id: 'REQ-DUP', title: 'Y ' + module, application: 'odoo', module, businessRequirement: 'x', businessRules: [{ id: 'BR-01', text: 'a' + module }], acceptanceCriteria: [] });
    const hit = findSimilarRequirements({ id: 'REQ-DUP', title: 'khác', businessRules: [{ text: 'zzz' }], acceptanceCriteria: [] }, [r('sales')]);
    expect(hit).toMatchObject([{ id: 'REQ-DUP', hard: true }]);
    const errs = computeCoverage([r('sales'), r('purchase')], []).flatMap((c) => c.errors);
    expect(errs.join('|')).toMatch(/Trùng ID requirement REQ-DUP/);
    expect(fs.readFileSync(path.join('.claude', 'commands', 'qa-requirement.md'), 'utf8')).toContain('KHÔNG BAO GIỜ tự thêm');
  });

  test('bộ cài đặt (package:template) mang theo lệnh, mẫu và cấu hình MCP; không mang requirement người dùng dán', () => {
    for (const p of ['.claude/commands/qa-requirement.md', 'example/requirements/SAMPLE-REQUIREMENT.md', 'example/requirements/TEMPLATE.md', 'example/testcases/TEMPLATE.md', '.mcp.json', 'INSTALL.md', '.env.example']) {
      expect(shareDecision(p, { template: true }).include, p).toBe(true);
    }
    for (const p of ['requirements/_inbox/x.md', '.claude/settings.local.json', 'requirements/odoo-sales/REQ-1.json']) {
      expect(shareDecision(p, { template: true }).include, p).toBe(false);
    }
    expect(shareDecision('requirements/_inbox/x.md').include).toBe(false);
  });

  test('.gitignore chặn requirement dán vào và cấu hình Claude cục bộ nhưng không chặn lệnh dùng chung', () => {
    const ig = fs.readFileSync('.gitignore', 'utf8');
    expect(ig).toContain('requirements/_inbox/');
    expect(ig).toContain('.claude/settings.local.json');
    expect(ig).not.toMatch(/^\.claude\/?$/m);
    expect(ig).not.toMatch(/^\.mcp\.json$/m);
  });
});
