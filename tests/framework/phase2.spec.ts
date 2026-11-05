import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { analyzeSpec, buildReadiness, type ReadinessInput, type SpecTc } from '../../core/automation/readiness';
import { compareReport } from '../../core/reporters/verify';
import { computeSummary } from '../../core/reporters/aggregate';
import { confirmExecution, confirmPhrase, selectEnvironment } from '../../core/environment/state';
import { resolveEnvironment } from '../../core/environment/config';
import { defHash } from '../../core/testcases/hash';
import type { TestCaseDef } from '../../core/testcases/schema';
import { installFakeEnvironments, type FakeEnvSpec } from './helpers/fake-env';
import { makeApprovedWorkspace, wsDefs, wsReq } from './helpers/workspace';

// Framework tests cho tự động hóa Giai đoạn 2 và QA Report (PH-*). Dữ liệu giả, thư mục tạm, không kết nối staging.

const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = (n: string) => path.join(process.cwd(), 'scripts', n);
const acct = { user: 'ke.toan@example.com', pass: 'Mk#fake-A-111' };
const cleanups: (() => void)[] = [];
const prevKey = process.env.QA_APPROVAL_KEY_FILE;
test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (prevKey === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
  else process.env.QA_APPROVAL_KEY_FILE = prevKey;
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('PH-1 Kiểm tra sẵn sàng và phân loại test case (thuần hàm)', () => {
  const defs: TestCaseDef[] = [
    ...wsDefs(),
    { ...wsDefs()[0], id: 'TC-E-003', title: 'Cần làm rõ', needsClarification: 'AC-01 chưa nói rõ làm tròn' },
    { ...wsDefs()[0], id: 'TC-E-004', title: 'Test ghi' },
  ];
  const spec = (over: Partial<SpecTc> = {}): SpecTc => ({ file: 'tests/odoo-sales/x.spec.ts', writes: false, usesFixtures: false, ...over });
  const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
    requirementId: wsReq.id,
    defs,
    approval: { ok: true, reason: 'APPROVED' },
    environment: { key: 'ENV_A', label: 'A', kind: 'staging', host: 'a.example.com' },
    roleMissing: { accountant: [], noaccess: [] },
    defaultRole: 'accountant',
    specs: new Map([['TC-E-001', spec()], ['TC-E-002', spec({ role: 'noaccess' })], ['TC-E-004', spec({ writes: true })]]),
    fixtureModules: new Set(['odoo-sales']),
    ...over,
  });
  const byId = (r: ReturnType<typeof buildReadiness>) => Object.fromEntries(r.testCases.map((t) => [t.tcId, t]));

  test('quyền ghi theo metadata thực thi: có spec nhưng chưa khai báo hoặc khai báo WRITE ⇒ BLOCKED; READ hợp lệ ⇒ ELIGIBLE', () => {
    const rd = { access: 'READ', dataStrategy: 'EXISTING_READONLY', cleanup: 'NONE' } as const;
    const wr = { access: 'WRITE', dataStrategy: 'FACTORY', cleanup: 'REGISTRY' } as const;
    const auto = (tcs: Record<string, typeof rd | typeof wr>) => [{ requirementId: wsReq.id, testCases: tcs }];
    const r = byId(buildReadiness(input({ automation: auto({ 'TC-E-001': rd, 'TC-E-002': wr }) })));
    expect(r['TC-E-001'].classification).toBe('ELIGIBLE');
    expect(r['TC-E-002']).toMatchObject({ classification: 'BLOCKED' });
    expect(r['TC-E-002'].reason).toMatch(/^Test ghi dữ liệu/);
    // TC-E-001 chưa khai báo: mặc định GHI dù spec trông chỉ đọc.
    const u = byId(buildReadiness(input({ automation: auto({}) })));
    expect(u['TC-E-001'].classification).toBe('BLOCKED');
    expect(u['TC-E-001'].reason).toMatch(/mặc định coi là GHI/);
  });

  test('đủ điều kiện: ELIGIBLE cho test chỉ đọc có spec; ghi dữ liệu BLOCKED; chưa có spec NOT RUN hoặc NEEDS CLARIFICATION; không PASS/FAIL', () => {
    const r = buildReadiness(input());
    const t = byId(r);
    expect(t['TC-E-001'].classification).toBe('ELIGIBLE');
    expect(t['TC-E-002'].classification).toBe('ELIGIBLE');
    expect(t['TC-E-003']).toMatchObject({ classification: 'NEEDS CLARIFICATION' });
    expect(t['TC-E-003'].reason).toContain('AC-01 chưa nói rõ làm tròn');
    expect(t['TC-E-004']).toMatchObject({ classification: 'BLOCKED' });
    expect(t['TC-E-004'].reason).toMatch(/cần quyền ghi riêng \(npm run test:write\)/);
    expect(r.canConnect).toBe(true);
    expect(r.runnable).toBe(2);
    expect(Object.values(t).map((x) => x.classification)).not.toContain('PASS');
    expect(r.questions.join('\n')).toMatch(/TC-E-003.*AC-01 chưa nói rõ/); // chỉ hỏi điều thật sự mơ hồ + quyền ghi nếu muốn chạy
    expect(r.questions.join('\n')).toMatch(/Chính sách ghi cho TC-E-004.*qa:policy -- confirm/);
    expect(r.questions.some((q) => /^Môi trường:|^Điền vào \.env|^Phê duyệt/.test(q))).toBe(false); // không hỏi điều đã tự xác minh được
  });

  test('chưa phê duyệt: mọi test case NOT RUN và không được kết nối', () => {
    const r = buildReadiness(input({ approval: { ok: false, reason: 'PENDING_APPROVAL: đang chờ' } }));
    expect(r.testCases.every((t) => t.classification === 'NOT RUN')).toBe(true);
    expect(r.canConnect).toBe(false);
    expect(r.nextSteps.join()).toMatch(/KHÔNG kết nối Playwright MCP/);
    expect(r.questions[0]).toMatch(/Phê duyệt REQ-E-001 chưa hợp lệ/);
  });

  test('môi trường chưa chọn/chưa xác nhận: test có spec BLOCKED, không kết nối, câu hỏi nêu môi trường', () => {
    const r = buildReadiness(input({ environment: undefined, environmentProblem: 'Chưa chọn môi trường kiểm thử' }));
    expect(byId(r)['TC-E-001']).toMatchObject({ classification: 'BLOCKED' });
    expect(byId(r)['TC-E-001'].reason).toMatch(/Môi trường chưa sẵn sàng: Chưa chọn môi trường/);
    expect(r.canConnect).toBe(false);
    expect(r.questions.join()).toMatch(/Môi trường: Chưa chọn môi trường/);
    const unconfirmed = buildReadiness(input({ environmentProblem: 'Môi trường ENV_A chưa được xác nhận thực thi cho REQ-E-001' }));
    expect(unconfirmed.canConnect).toBe(false);
    expect(byId(unconfirmed)['TC-E-001'].classification).toBe('BLOCKED');
  });

  test('thiếu tài khoản của vai trò: chỉ test dùng vai trò đó BLOCKED, câu hỏi nêu TÊN biến (không giá trị)', () => {
    const r = buildReadiness(input({ roleMissing: { accountant: [], noaccess: ['ODOO_STAGING_A_NOACCESS_USER', 'ODOO_STAGING_A_NOACCESS_PASS'] } }));
    expect(byId(r)['TC-E-001'].classification).toBe('ELIGIBLE');
    expect(byId(r)['TC-E-002']).toMatchObject({ classification: 'BLOCKED' });
    expect(byId(r)['TC-E-002'].reason).toMatch(/Thiếu tài khoản vai trò "noaccess" trên ENV_A: ODOO_STAGING_A_NOACCESS_USER, ODOO_STAGING_A_NOACCESS_PASS/);
    expect(r.questions.join()).toMatch(/vai trò "noaccess".*ODOO_STAGING_A_NOACCESS_USER/);
    expect(r.checks.find((c) => c.name === 'Tài khoản vai trò noaccess')).toMatchObject({ ok: false });
  });

  test('thiếu fixture ghim: test cần bản ghi BLOCKED và câu hỏi gom về việc chọn bản ghi (Claude chỉ đề xuất, không tự dùng)', () => {
    const r = buildReadiness(input({ specs: new Map([['TC-E-001', spec({ usesFixtures: true })]]), fixtureModules: new Set() }));
    expect(byId(r)['TC-E-001']).toMatchObject({ classification: 'BLOCKED' });
    expect(byId(r)['TC-E-001'].reason).toMatch(/chưa có fixture cho odoo-sales \(testdata\/fixtures\/ENV_A\/\)/);
    expect(r.questions.join()).toMatch(/Chỉ định bản ghi cần ghim cho odoo-sales.*người dùng quyết định/);
  });

  test('không có test nào chạy được: không chạy Playwright nhưng vẫn phải chạy qa:finish', () => {
    const r = buildReadiness(input({
      specs: new Map([['TC-E-001', spec({ writes: true })], ['TC-E-002', spec({ writes: true })], ['TC-E-003', spec({ writes: true })], ['TC-E-004', spec({ writes: true })]]),
    }));
    expect(r.runnable).toBe(0);
    expect(r.counts).toMatchObject({ ELIGIBLE: 0, BLOCKED: 4, 'NOT RUN': 0 });
    expect(r.nextSteps.join()).toMatch(/Không có test nào chạy được: không chạy Playwright; vẫn chạy npm run qa:finish/);
  });

  test('chưa có spec: bước tiếp theo là khám phá giao diện chỉ đọc rồi viết spec', () => {
    const r = buildReadiness(input({ specs: new Map() }));
    expect(r.counts['NOT RUN']).toBe(3);
    expect(r.counts['NEEDS CLARIFICATION']).toBe(1);
    expect(r.nextSteps.join()).toMatch(/khám phá giao diện, viết Page Object \+ spec/);
  });

  test('analyzeSpec: nhận diện test case, vai trò gần nhất, test ghi và fixture trong mã nguồn spec', () => {
    const text = `
test.use({ role: 'accountant' });
test(a, tcMeta('TC-A-1'), async ({ api }) => { const so = await fixtureOrBlock(api, 'x'); });
test.describe('b', () => { test.use({ role: 'noaccess' });
  test(b, tcMeta('TC-A-2'), async () => { await expect(1).toBe(1); });
  test(c, tcMeta('TC-A-3'), async ({ writeGuard, api }) => { writeGuard(); await api.createConfirmedSaleOrder(1, 'x'); });
});`;
    const m = analyzeSpec('s.spec.ts', text);
    expect(m.get('TC-A-1')).toMatchObject({ role: 'accountant', writes: false, usesFixtures: true });
    expect(m.get('TC-A-2')).toMatchObject({ role: 'noaccess', writes: false, usesFixtures: false });
    expect(m.get('TC-A-3')).toMatchObject({ role: 'noaccess', writes: true });
  });

  test('spec thật của repo: test ghi dữ liệu được nhận diện là cần quyền ghi (không bị coi ELIGIBLE)', () => {
    test.skip(!fs.existsSync('tests/odoo-sales/collect-payment.spec.ts'), 'máy mới chưa có spec nghiệp vụ (bộ cài đặt dùng chung không kèm)');
    const real = analyzeSpec('collect-payment.spec.ts', fs.readFileSync('tests/odoo-sales/collect-payment.spec.ts', 'utf8'));
    expect(real.size).toBeGreaterThan(5);
    expect([...real.values()].some((s) => s.writes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('PH-2 CLI qa:ready và qa:finish trong thư mục làm việc giả (đã duyệt, môi trường giả)', () => {
  function workspace(specs: Record<string, FakeEnvSpec> = { ENV_A: { url: 'https://a.example.com', version: '18.0', roles: { accountant: acct } } }) {
    const w = makeApprovedWorkspace();
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    const f = installFakeEnvironments(w.ws, specs);
    cleanups.push(f.restore);
    const env = { ...w.env, ...f.vars, APP: 'odoo' } as NodeJS.ProcessEnv;
    delete env.QA_ENVIRONMENTS_DIR;
    delete env.QA_REPORTS_DIR;
    delete env.QA_ENV;
    return { ...w, env, vars: f.vars };
  }
  const run = (w: ReturnType<typeof workspace>, name: string, ...args: string[]) =>
    spawnSync(process.execPath, [tsx, script(name), ...args], { cwd: w.ws, env: w.env, encoding: 'utf8' });
  const select = (w: ReturnType<typeof workspace>, key: string, confirm: boolean) => {
    Object.assign(process.env, w.vars);
    const r = resolveEnvironment('odoo', key);
    if (!r.ok) throw new Error(r.problems.join());
    selectEnvironment(w.ws, 'odoo', key);
    if (confirm) confirmExecution(w.ws, { env: r.env, requirementId: wsReq.id, approvalHash: w.hash, by: 'N', typed: confirmPhrase(r.env) });
  };

  test('qa:ready: chưa chọn môi trường → không kết nối, gom câu hỏi; chọn chưa xác nhận → vẫn chặn; xác nhận + đủ tài khoản → được kết nối', () => {
    const w = workspace();
    let r = run(w, 'ready.ts', `--requirement=${wsReq.id}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[ĐẠT\] Phê duyệt test case/);
    expect(r.stdout).toMatch(/\[CHƯA\] Môi trường đã chọn và xác nhận: Chưa chọn môi trường/);
    expect(r.stdout).toMatch(/NOT RUN\s+TC-E-001.*Chưa có automation spec/);
    expect(r.stdout).toMatch(/CÂU HỎI CẦN NGƯỜI DÙNG \(gom một lần\)/);
    expect(r.stdout).toMatch(/KHÔNG kết nối Playwright MCP/);
    expect(fs.existsSync(path.join(w.ws, 'reports'))).toBe(false); // chưa có môi trường: không ghi gì

    select(w, 'ENV_A', false);
    r = run(w, 'ready.ts', `--requirement=${wsReq.id}`);
    expect(r.stdout).toMatch(/\[CHƯA\] Môi trường đã chọn và xác nhận: Môi trường ENV_A chưa được xác nhận thực thi/);
    expect(r.stdout).toMatch(/KHÔNG kết nối Playwright MCP/);

    select(w, 'ENV_A', true);
    r = run(w, 'ready.ts', `--requirement=${wsReq.id}`);
    expect(r.stdout).toMatch(/\[ĐẠT\] Môi trường đã chọn và xác nhận: ENV_A \(Giả lập ENV_A, staging\) — a\.example\.com/);
    expect(r.stdout).toMatch(/\[ĐẠT\] Tài khoản vai trò accountant/);
    expect(r.stdout).toMatch(/Kết nối Playwright MCP \(chỉ đọc\)/);
    expect(`${r.stdout}${r.stderr}`).not.toContain(acct.pass); // không bao giờ in giá trị bí mật
    const saved = fs.readdirSync(path.join(w.ws, 'reports', 'ENV_A', 'readiness'));
    expect(saved).toHaveLength(2); // mỗi lần chạy một file mới, không ghi đè
    expect(saved[0]).toMatch(new RegExp(`^${wsReq.id}-\\d{8}-\\d{6}-\\d{3}\\.json$`));
  });

  test('qa:ready: thiếu tài khoản trong .env thì câu hỏi nêu tên biến còn thiếu và vẫn cho phép khám phá chỉ đọc nếu môi trường đã xác nhận', () => {
    const w = workspace({ ENV_A: { url: 'https://a.example.com', version: '18.0', roles: { accountant: { user: acct.user } } } });
    select(w, 'ENV_A', true);
    const r = run(w, 'ready.ts', `--requirement=${wsReq.id}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[CHƯA\] Tài khoản vai trò accountant: thiếu biến: FAKE_ENV_A_ACCOUNTANT_PASS/);
    expect(r.stdout).toMatch(/Điền vào \.env tài khoản vai trò "accountant": FAKE_ENV_A_ACCOUNTANT_PASS/);
  });

  /** Seed: requirement khác (lịch sử) có một lần chạy PASS trong cùng môi trường. */
  function seedHistory(w: ReturnType<typeof workspace>) {
    const other = { id: 'REQ-OTHER-001', title: 'Requirement khác (lịch sử)', application: 'odoo', module: 'purchase', businessRequirement: 'b', businessRules: [{ id: 'BR-01', text: 'a' }], acceptanceCriteria: [{ id: 'AC-01', text: 'c' }] };
    fs.mkdirSync(path.join(w.ws, 'requirements', 'odoo-purchase'), { recursive: true });
    fs.mkdirSync(path.join(w.ws, 'testcases', 'odoo-purchase'), { recursive: true });
    fs.writeFileSync(path.join(w.ws, 'requirements', 'odoo-purchase', `${other.id}.json`), JSON.stringify(other));
    const tc = { id: 'TC-O-001', title: 'Test của requirement khác', requirementRefs: ['BR-01', 'AC-01'], description: 'd', preconditions: [], testData: {}, steps: ['s'], expectedResult: 'e', verification: 'UI', automated: true };
    fs.writeFileSync(path.join(w.ws, 'testcases', 'odoo-purchase', `${other.id}.testcases.json`), JSON.stringify({ requirementId: other.id, testCases: [tc] }));
    const def = { ...tc, requirementId: other.id, application: 'odoo', module: 'purchase' } as TestCaseDef;
    const runDir = path.join(w.ws, 'reports', 'ENV_A', 'runs', '20261104-090000');
    fs.mkdirSync(runDir, { recursive: true });
    const file = path.join(runDir, 'results.json');
    fs.writeFileSync(file, JSON.stringify({ runId: '20261104-090000', startedAt: '2026-11-04T09:00:00.000Z', finishedAt: '2026-11-04T09:01:00.000Z', baseURL: 'https://a.example.com', environment: 'ENV_A', writesEnabled: false, entries: [{ tcId: def.id, defHash: defHash(def), status: 'PASS', actual: 'đạt', durationMs: 1, evidence: { screenshots: [], video: 'artifacts/o/video.webm' } }] }));
    return { file, before: fs.readFileSync(file, 'utf8') };
  }

  test('qa:finish khi KHÔNG test nào chạy được: vẫn dựng + đối chiếu báo cáo theo môi trường, focus theo requirement, giữ nguyên lịch sử', async ({ page }, info) => {
    const w = workspace();
    select(w, 'ENV_A', true);
    const seed = seedHistory(w);
    const r = run(w, 'qa-finish.ts', '--no-open');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Báo cáo môi trường ENV_A: reports\/ENV_A\//);
    expect(r.stdout).toMatch(/Requirement đang xử lý REQ-E-001: 2 test case \| PASS 0, FAIL 0, BLOCKED 0, NEEDS CLARIFICATION 0, NOT RUN 2/);
    expect(r.stdout).toMatch(/Toàn bộ requirement \(gồm lịch sử\): 3 test case \| PASS 1/);
    expect(r.stdout).toMatch(/JSON, HTML, QA Summary và Bug Report khớp nhau/);
    expect(r.stdout).toContain(path.join(w.ws, 'reports', 'ENV_A', 'qa-report.html'));

    const dir = path.join(w.ws, 'reports', 'ENV_A');
    for (const f of ['qa-results.json', 'qa-report.html', 'qa-summary.md', 'bugs.json']) expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'qa-results.json'), 'utf8'));
    expect(json.environment).toBe('ENV_A');
    expect(json.summary).toMatchObject({ total: 3, passed: 1, notRun: 2 });
    expect(json.focus).toMatchObject({ requirementId: 'REQ-E-001', summary: { total: 2, passed: 0, notRun: 2 }, bugs: { total: 0, open: 0 } });
    const md = fs.readFileSync(path.join(dir, 'qa-summary.md'), 'utf8');
    expect(md).toContain('## Requirement đang xử lý: REQ-E-001');
    expect(md).toContain('| PASS [focus] | 0 |');
    expect(md).toContain('| NOT RUN [focus] | 2 |');
    expect(md).toContain('## Số liệu toàn bộ requirement (gồm lịch sử)');
    expect(md).toMatch(/^\| PASS \| 1 \|$/m);
    expect(fs.readFileSync(seed.file, 'utf8')).toBe(seed.before); // kết quả cũ không bị đụng tới
    expect(fs.existsSync(path.join(w.ws, 'reports', 'qa-report.html'))).toBe(false); // không ghi ra thư mục chung

    // Giao diện báo cáo thực tế: mặc định lọc theo requirement đang xử lý, phân biệt với lịch sử.
    await page.goto(pathToUrl(path.join(dir, 'qa-report.html')));
    await expect(page.locator('h1')).toContainText('Báo cáo kiểm thử');
    await expect(page.locator('h1')).toContainText('Requirement thử nhiều môi trường');
    await expect(page.locator('header.top')).toContainText('Người phê duyệt: A'); // người duyệt lấy từ approvals/ (có chữ ký)
    await expect(page.locator('#dash .prov')).toContainText('lần chạy trước của chính requirement này'); // dòng nguồn kết quả có trong HTML nhưng ẩn (không hiển thị cho người xem)
    await expect(page.locator('#dash .prov')).toBeVisible(); // nguồn kết quả của chính requirement này
    await expect(page.locator('#dash .prov button')).toHaveCount(0); // không có nút xem requirement khác
    await expect(page.locator('h2').first()).toContainText('Dashboard Thống kê kết quả kiểm thử');
    await expect(page.locator('.filters')).toBeHidden(); // hàng bộ lọc không hiển thị; mặc định vẫn lọc theo requirement đang xử lý
    await expect(page.locator('#req')).toHaveValue('REQ-E-001');
    await expect(page.locator('#count')).toHaveText('Hiển thị 2 / 2 test case');
    await expect(page.locator('[data-focus="NOT RUN"]')).toHaveText('2');
    await expect(page.locator('[data-focus="PASS"]')).toHaveText('0');
    await expect(page.locator('#allstrip')).toHaveCount(0); // báo cáo chỉ chứa requirement đang xử lý, không có số liệu requirement khác
    expect(await page.content()).not.toContain('REQ-OTHER-001');
    await expect(page.locator('.tab[data-tab="ALL"] .n')).toHaveText('2'); // tab theo requirement đang xử lý
    // Dashboard chỉ để đọc: bấm vào ô số liệu không đổi gì.
    await page.locator('#dash .mt.pass').click();
    await expect(page.locator('#count')).toHaveText('Hiển thị 2 / 2 test case');
    await info.attach('qa-report-focus.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.locator('.tab[data-tab="NOT RUN"]').click();
    await expect(page.locator('#count')).toHaveText('Hiển thị 2 / 2 test case');
    await page.locator('.tab[data-tab="PASS"]').click(); // tab không có test case: vẫn hiện trên menu, bấm vào thì trống, không chú thích
    await expect(page.locator('article.tc:visible')).toHaveCount(0);
    await expect(page.locator('#count')).toHaveText('');
    await expect(page.locator('#empty')).toBeHidden();
    await page.locator('.tab[data-tab="RTM"]').click();
    await expect(page.locator('#panel-rtm')).toBeVisible();
    await expect(page.locator('#panel-tests')).toBeHidden();
    await page.locator('.tab[data-tab="HISTORY"]').click();
    await expect(page.locator('#panel-history')).toBeVisible();

    // Đổi requirement đang xử lý: cùng dữ liệu, góc nhìn khác.
    const other = run(w, 'qa-finish.ts', '--no-open', '--requirement=REQ-OTHER-001');
    expect(other.stdout).toMatch(/Requirement đang xử lý REQ-OTHER-001: 1 test case \| PASS 1/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'qa-results.json'), 'utf8')).summary).toMatchObject({ total: 3, passed: 1 });
  });

  test('report:verify (qa:finish) phát hiện lệch focus giữa JSON, HTML và QA Summary; chạy lại dựng đúng', () => {
    const w = workspace();
    select(w, 'ENV_A', true);
    expect(run(w, 'qa-finish.ts', '--no-open').status).toBe(0);
    const dir = path.join(w.ws, 'reports', 'ENV_A');
    const htmlFile = path.join(dir, 'qa-report.html');
    const html = fs.readFileSync(htmlFile, 'utf8');
    fs.writeFileSync(htmlFile, html.replace('data-focus="NOT RUN">2<', 'data-focus="NOT RUN">7<'));
    let v = run(w, 'report-verify.ts');
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/LỆCH: HTML: NOT RUN của requirement đang xử lý = 7 nhưng JSON\.focus = 2/);
    fs.writeFileSync(htmlFile, html);
    const mdFile = path.join(dir, 'qa-summary.md');
    const md = fs.readFileSync(mdFile, 'utf8');
    fs.writeFileSync(mdFile, md.replace('| NOT RUN [focus] | 2 |', '| NOT RUN [focus] | 5 |'));
    v = run(w, 'report-verify.ts');
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/qa-summary\.md: NOT RUN \[focus\] = 5 nhưng JSON\.focus = 2/);
    fs.writeFileSync(mdFile, md);
    const jsonFile = path.join(dir, 'qa-results.json');
    const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    j.focus.summary.notRun = 0;
    fs.writeFileSync(jsonFile, JSON.stringify(j));
    expect(run(w, 'report-verify.ts').stdout).toMatch(/JSON\.focus\.notRun = 0 nhưng tính lại cho REQ-E-001 ra 2/);
    expect(run(w, 'qa-finish.ts', '--no-open').status).toBe(0); // dựng lại: khớp
    expect(run(w, 'report-verify.ts').status).toBe(0);
  });

  test('bug report thống nhất: bugs.json lệch số bug so với qa-results.json/lần chạy bị phát hiện', () => {
    const w = workspace();
    select(w, 'ENV_A', true);
    run(w, 'qa-finish.ts', '--no-open');
    const bugsFile = path.join(w.ws, 'reports', 'ENV_A', 'bugs.json');
    const b = JSON.parse(fs.readFileSync(bugsFile, 'utf8'));
    b.bugs.push({ bugId: 'BUG-GIA' });
    fs.writeFileSync(bugsFile, JSON.stringify(b));
    const v = run(w, 'report-verify.ts');
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/bugs\.json có 1 bug nhưng tính lại từ các lần chạy ra 0/);
    fs.rmSync(bugsFile);
    expect(run(w, 'report-verify.ts').stdout).toMatch(/Thiếu bugs\.json/);
  });

  test('compareReport tương thích ngược: báo cáo không có focus vẫn đối chiếu như cũ', () => {
    const s = computeSummary([]);
    const json = JSON.stringify({ summary: s, testCases: [] });
    const html = `<button data-filter="ALL"><b>0</b></button>${['PASS', 'FAIL', 'BLOCKED', 'NEEDS CLARIFICATION', 'NOT RUN'].map((st) => `<button data-filter="${st}"><b>0</b></button>`).join('')}<b>N/A</b><span>Execution Pass Rate</span><b>N/A</b><span>Overall Pass Coverage</span>`;
    const md = ['| Tổng test case | 0 |', ...['PASS', 'FAIL', 'BLOCKED', 'NEEDS CLARIFICATION', 'NOT RUN'].map((st) => `| ${st} | 0 |`), '| Execution Pass Rate | N/A |', '| Overall Pass Coverage | N/A |'].join('\n');
    expect(compareReport(s, [], json, html, md).errors).toEqual([]);
  });

  test('runner tự dựng + đối chiếu báo cáo sau mỗi lần chạy; qa:finish mở báo cáo; tài liệu lệnh nêu đủ các bước tự động', () => {
    const runner = fs.readFileSync(path.join('scripts', 'run-tests.ts'), 'utf8');
    expect(runner).toContain('qa-finish.ts');
    expect(runner).toContain("'--no-open'");
    expect(runner).toContain('QA_FOCUS_REQ');
    const finish = fs.readFileSync(path.join('scripts', 'qa-finish.ts'), 'utf8');
    expect(finish).toContain('openInBrowser');
    expect(finish).toContain('verifyReportConsistency');
    const cmd = fs.readFileSync(path.join('.claude', 'commands', 'qa-requirement.md'), 'utf8');
    for (const need of ['qa:review', 'qa:ready', 'qa:finish', 'report:rebuild', 'report:verify', 'AskUserQuestion', 'gom']) expect(cmd, `qa-requirement.md thiếu "${need}"`).toContain(need);
  });
});

const pathToUrl = (p: string) => `file:///${p.split(path.sep).join('/')}`;
