import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { PurchaseApi } from '../../applications/odoo/modules/purchase/api';
import { expectToConditions } from '../../applications/odoo/modules/sales/expect';
import { SalesApi } from '../../applications/odoo/modules/sales/api';
import { RegisterPaymentDialog } from '../../applications/odoo/modules/sales/pages/register-payment.dialog';
import { env } from '../../core/config/env';
import { getRunId, RUN_ID_PATTERN } from '../../core/config/run';
import { tcMeta } from '../../core/utils/tc';
import { redactText } from '../../core/security/scrub-trace';
import { shareDecision, suspectCredentialLines } from '../../core/security/scan';
import { FixtureError, checkConditions, loadFixtures } from '../../core/testdata/fixtures';
import { loadRegistry, registerRecord } from '../../core/testdata/registry';
import { installFakeEnvironments } from './helpers/fake-env';

// Framework tests về an toàn: KHÔNG kết nối Odoo, KHÔNG tạo dữ liệu.

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];

/** Mọi spec của các module test (bỏ framework và setup). */
const moduleSpecs = () =>
  fs.readdirSync('tests', { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.includes('-'))
    .flatMap((d) => walk(path.join('tests', d.name)).filter((f) => f.endsWith('.spec.ts')).map((f) => ({ module: d.name, f, text: fs.readFileSync(f, 'utf8') })));

test.describe('Fixture tường minh (FW-07)', () => {
  test('checkConditions: phát hiện từng loại điều kiện bị đổi (không biết model cụ thể)', () => {
    const rec = { state: 'sale', amount: 100, tag: 'a' };
    expect(checkConditions(rec, [{ field: 'state', op: 'eq', value: 'sale' }, { field: 'amount', op: 'gt', value: 0 }])).toEqual([]);
    expect(checkConditions(rec, [{ field: 'state', op: 'eq', value: 'draft' }])).toHaveLength(1);
    expect(checkConditions(rec, [{ field: 'state', op: 'ne', value: 'sale' }])).toHaveLength(1);
    expect(checkConditions(rec, [{ field: 'amount', op: 'lte', value: 50 }])).toHaveLength(1);
    expect(checkConditions(rec, [{ field: 'tag', op: 'in', value: ['a', 'b'] }])).toEqual([]);
    expect(checkConditions(rec, [{ field: 'tag', op: 'notIn', value: ['a'] }])).toHaveLength(1);
  });

  test('định dạng điều kiện riêng của Sales được dịch sang điều kiện chung', () => {
    const base = { state: 'sale', moveo_payment_status: 'partial', moveo_amount_due: 100 };
    const ok = expectToConditions({ state: 'sale', paymentStatusNot: 'paid', dueGt: 0 });
    expect(checkConditions(base, ok)).toEqual([]);
    expect(checkConditions({ ...base, state: 'draft' }, ok)).toHaveLength(1);
    expect(checkConditions({ ...base, moveo_payment_status: 'paid' }, ok)).toHaveLength(1);
    expect(checkConditions({ ...base, moveo_amount_due: -500 }, expectToConditions({ dueLte: 0 }))).toEqual([]);
  });

  test('loadFixtures: từ chối khi sai môi trường hoặc chưa cấu hình URL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
    fs.writeFileSync(path.join(dir, 'app-mod.json'), JSON.stringify({ environment: 'staging.example.com' }));
    process.env.QA_FIXTURES_DIR = dir;
    try {
      expect(() => loadFixtures('app-mod', 'https://khac.example.com')).toThrow(FixtureError);
      expect(() => loadFixtures('app-mod', undefined)).toThrow(FixtureError);
      expect(() => loadFixtures('khong-ton-tai', 'https://staging.example.com')).toThrow(FixtureError);
      expect(loadFixtures('app-mod', 'https://staging.example.com/').environment).toBe('staging.example.com');
    } finally {
      delete process.env.QA_FIXTURES_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mọi khoá fixture mà spec dùng được khai báo trong fixture của CHÍNH module đó; không còn chọn bản ghi theo "mới nhất"', () => {
    for (const { module, f, text } of moduleSpecs()) {
      // Fixture thật chứa host/chứng từ thật nên bị .gitignore: máy chưa có thì bỏ qua module này (đọc trực tiếp, không nhúng host vào mã nguồn).
      const fxFile = path.join('testdata', 'fixtures', `${module}.json`);
      if (!fs.existsSync(fxFile)) continue;
      const fx = JSON.parse(fs.readFileSync(fxFile, 'utf8')) as Record<string, unknown>;
      const keys = new Set(Object.values(fx).flatMap((v) => (v && typeof v === 'object' ? Object.keys(v as object) : [])));
      for (const m of text.matchAll(/fixtureOr(?:Block|Undefined)\(api,\s*'([a-z_]+)'\)/g)) expect(keys.has(m[1]), `${f}: fixture "${m[1]}" chưa khai báo`).toBe(true);
      expect(/findSaleOrder|id desc|order: 'id/.test(text), `${f} còn chọn bản ghi theo thứ tự`).toBe(false);
    }
    for (const f of walk(path.join('applications', 'odoo')).filter((x) => x.endsWith('.ts'))) {
      expect(fs.readFileSync(f, 'utf8'), `${f} chọn bản ghi theo thứ tự`).not.toMatch(/order: 'id desc'|order: 'id asc'/);
    }
  });
});

test.describe('Chặn ghi nhầm (FW-08)', () => {
  const runId = getRunId();
  const HOST = 'staging.example.com';
  let tmp: string;
  const saved = { allow: env.allowWriteTests, qaEnv: process.env.QA_ENV, grant: process.env.QA_WRITE_GRANT };
  let fake: ReturnType<typeof installFakeEnvironments>;

  test.beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
    process.env.QA_REGISTRY_FILE = path.join(tmp, 'registry.jsonl');
    // Fixture GIẢ (không đọc fixture thật): framework test không phụ thuộc dữ liệu nghiệp vụ hay máy chủ thật.
    fs.mkdirSync(path.join(tmp, 'fx'));
    fs.writeFileSync(path.join(tmp, 'fx', 'odoo-sales.json'), JSON.stringify({ environment: HOST, orderFactory: { partner: { id: 15, name: 'Khách hàng mẫu' }, product: { id: 6, name: 'Dịch vụ mẫu' } } }));
    process.env.QA_FIXTURES_DIR = path.join(tmp, 'fx');
    // Môi trường GIẢ (TEST_ENV) thay cho biến URL cũ: host và khoá môi trường của lần chạy lấy từ QA_ENV.
    fake = installFakeEnvironments(tmp, { TEST_ENV: { url: `https://${HOST}`, version: '18.0', roles: { accountant: { user: 'a@example.com', pass: 'x' } } } });
    process.env.QA_ENV = 'TEST_ENV';
    env.allowWriteTests = true;
    grant({});
  });
  test.afterEach(() => {
    delete process.env.QA_REGISTRY_FILE;
    delete process.env.QA_FIXTURES_DIR;
    env.allowWriteTests = saved.allow;
    fake.restore();
    if (saved.qaEnv === undefined) delete process.env.QA_ENV; else process.env.QA_ENV = saved.qaEnv;
    if (saved.grant === undefined) delete process.env.QA_WRITE_GRANT; else process.env.QA_WRITE_GRANT = saved.grant;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Đặt giấy phép ghi; mặc định cho (môi trường staging, module, lần chạy hiện tại). */
  const grant = (over: Partial<{ host: string; environment: string; module: string; runId: string }> & { none?: boolean }, module = 'odoo-sales') => {
    if (over.none) delete process.env.QA_WRITE_GRANT;
    else process.env.QA_WRITE_GRANT = JSON.stringify({ host: HOST, environment: 'TEST_ENV', module, runId, ...over });
  };

  /** Odoo giả: trả người tạo và tham chiếu cho bản ghi đang hỏi. Không kết nối mạng. */
  const fakeRequest = (record: { ref: string | false; creator: number }, sessionUid = 10) =>
    ({
      post: async (url: string) => ({
        json: async () => (url.includes('get_session_info') ? { result: { uid: sessionUid } } : { result: [{ partner_ref: record.ref, client_order_ref: record.ref, create_uid: [record.creator, 'Người tạo'] }] }),
      }),
    }) as unknown as APIRequestContext;
  const good = () => `AUTOTEST ${runId} TC-X-001`;
  const own = (api: object, model: string, id: number, over: { runId?: string; origin?: 'AUTOMATION' | 'BACKFILL' } = {}) => {
    registerRecord({ testCaseId: 'TC-X-001', application: 'odoo', model, recordId: id, reference: good(), runId: over.runId ?? runId, origin: over.origin });
    (api as { created: unknown[] }).created.push({ model, id, tcId: 'TC-X-001', reference: good() });
  };
  const sales = (rec = { ref: good() as string | false, creator: 10 }) => new SalesApi(fakeRequest(rec));
  const purchase = (rec = { ref: good() as string | false, creator: 10 }) => new PurchaseApi(fakeRequest(rec));

  test('CHO PHÉP (Sales): đủ giấy phép + bản ghi do chính lần chạy tạo + đúng tham chiếu + đúng người tạo', async () => {
    const api = sales(); own(api, 'sale.order', 1);
    await expect(api.assertSafeToWrite('sale.order', 1)).resolves.toMatchObject({ kind: 'SafeWriteToken', application: 'odoo', module: 'odoo-sales', model: 'sale.order', id: 1 });
  });

  test('CHO PHÉP (Purchase): cùng cơ chế dùng chung, quy tắc sở hữu riêng của module (purchase.order / partner_ref)', async () => {
    grant({}, 'odoo-purchase');
    const api = purchase(); own(api, 'purchase.order', 7);
    await expect(api.assertSafeToWrite('purchase.order', 7)).resolves.toMatchObject({ module: 'odoo-purchase', model: 'purchase.order', id: 7 });
  });

  test('TỪ CHỐI: giấy phép của module KHÁC (module Sales không dùng được để ghi Purchase và ngược lại)', async () => {
    const p = purchase(); own(p, 'purchase.order', 7); // giấy phép đang là của odoo-sales
    await expect(p.assertSafeToWrite('purchase.order', 7)).rejects.toThrow(/giấy phép cho module "odoo-sales"/);
    grant({}, 'odoo-purchase');
    const s = sales(); own(s, 'sale.order', 1);
    await expect(s.assertSafeToWrite('sale.order', 1)).rejects.toThrow(/giấy phép cho module "odoo-purchase"/);
  });

  test('TỪ CHỐI: thiếu giấy phép, sai môi trường, sai lần chạy, hoặc ALLOW_WRITE_TESTS tắt', async () => {
    const api = sales(); own(api, 'sale.order', 1);
    grant({ none: true });
    await expect(api.assertSafeToWrite('sale.order', 1)).rejects.toThrow(/chưa có giấy phép ghi/);
    grant({ host: 'khac.example.com' });
    await expect(api.assertSafeToWrite('sale.order', 1)).rejects.toThrow(/giấy phép cho môi trường/);
    grant({ runId: '20200101-000000' });
    await expect(api.assertSafeToWrite('sale.order', 1)).rejects.toThrow(/giấy phép cho lần chạy/);
    grant({});
    env.allowWriteTests = false;
    await expect(api.assertSafeToWrite('sale.order', 1)).rejects.toThrow(/ALLOW_WRITE_TESTS/);
  });

  test('TỪ CHỐI: bản ghi nghiệp vụ có sẵn / của người khác (không do lần chạy này tạo)', async () => {
    await expect(sales({ ref: false, creator: 99 }).assertSafeToWrite('sale.order', 58)).rejects.toThrow(/không do lần chạy này tạo/);
  });

  test('TỪ CHỐI: registry thuộc lần chạy khác hoặc chỉ là BACKFILL', async () => {
    const a = sales(); own(a, 'sale.order', 2, { runId: '20200101-000000' });
    await expect(a.assertSafeToWrite('sale.order', 2)).rejects.toThrow(/Test Data Registry/);
    const b = sales(); own(b, 'sale.order', 3, { origin: 'BACKFILL' });
    await expect(b.assertSafeToWrite('sale.order', 3)).rejects.toThrow(/Test Data Registry/);
  });

  test('TỪ CHỐI: tham chiếu trên hệ thống không đúng mẫu, hoặc người tạo khác tài khoản automation', async () => {
    const a = sales({ ref: 'S00058 thủ công', creator: 10 }); own(a, 'sale.order', 4);
    await expect(a.assertSafeToWrite('sale.order', 4)).rejects.toThrow(/tham chiếu/);
    const b = sales({ ref: good(), creator: 77 }); own(b, 'sale.order', 5);
    await expect(b.assertSafeToWrite('sale.order', 5)).rejects.toThrow(/người dùng khác/);
  });

  test('TỪ CHỐI: model module chưa khai báo quy tắc sở hữu (chéo module, hoặc model lạ)', async () => {
    await expect(sales().assertSafeToWrite('purchase.order', 1)).rejects.toThrow(/chưa khai báo quy tắc sở hữu/);
    await expect(sales().assertSafeToWrite('account.move', 1)).rejects.toThrow(/chưa khai báo quy tắc sở hữu/);
    grant({}, 'odoo-purchase'); // giấy phép đúng của Purchase: nhưng Purchase không khai báo sale.order
    await expect(purchase().assertSafeToWrite('sale.order', 1)).rejects.toThrow(/chưa khai báo quy tắc sở hữu/);
  });

  /** Odoo giả trong bộ nhớ, đủ để chạy luồng tạo SO của Sales mà không chạm hệ thống thật. Ghi lại mọi lệnh gọi. */
  const fakeOdoo = () => {
    const calls: string[] = [];
    let created: { ref: string; price: number } | undefined;
    const ok = (result: unknown) => ({ json: async () => ({ result }) });
    const request = {
      post: async (url: string, opts?: { data?: { params: { model: string; method: string; args: any[] } } }) => {
        if (url.includes('get_session_info')) return ok({ uid: 10 });
        const { model, method, args } = opts!.data!.params;
        calls.push(`${model}.${method}`);
        if (model === 'res.partner') return ok([{ name: 'Khách hàng mẫu' }]);
        if (model === 'product.product') return ok([{ name: 'Dịch vụ mẫu' }]);
        if (model === 'sale.order' && method === 'create') {
          created = { ref: args[0].client_order_ref, price: args[0].order_line[0][2].price_unit };
          return ok(900);
        }
        if (model === 'sale.order' && method === 'action_confirm') return ok(true);
        if (model === 'sale.order' && method === 'search_read') {
          return ok([{ id: 900, name: 'S00900', state: 'sale', moveo_payment_status: 'unpaid', moveo_amount_due: created!.price, moveo_amount_paid: 0, amount_total: created!.price, partner_id: [15, 'x'], company_id: [1, 'c'], currency_id: [23, 'VND'], client_order_ref: created!.ref, create_uid: [10, 'Tester'] }]);
        }
        if (model === 'account.payment' && method === 'search_read') return ok([{ id: 5000, name: 'PBNK/TEST/1' }]);
        throw new Error(`Odoo giả chưa hỗ trợ ${model}.${method}`);
      },
    } as unknown as APIRequestContext;
    return { request, calls };
  };

  test('luồng ghi của Sales (Odoo giả): tạo SO → đăng ký registry → cấp giấy phép → đăng ký phiếu thu phát sinh; không gọi hàm nguy hiểm', tcMeta('TC-X-001'), async () => {
    const { request, calls } = fakeOdoo();
    const api = new SalesApi(request);
    const so = await api.createConfirmedSaleOrder(10_000_000, 'TC-X-001');
    expect(so).toMatchObject({ id: 900, moveo_amount_due: 10_000_000, state: 'sale' });
    expect(calls).toEqual(expect.arrayContaining(['sale.order.create', 'sale.order.action_confirm']));
    expect(calls.filter((c) => /unlink|\.write$|action_cancel|action_draft|action_unlock/.test(c))).toEqual([]);
    const reg = loadRegistry();
    expect(reg.find((r) => r.model === 'sale.order' && r.recordId === 900)).toMatchObject({ application: 'odoo', module: 'sales', origin: 'AUTOMATION', runId, reference: `AUTOTEST ${runId} TC-X-001`, cleanupStatus: 'PENDING' });
    await expect(api.assertSafeToWrite('sale.order', 900)).resolves.toMatchObject({ module: 'odoo-sales', id: 900 });
    await api.trackCreatedChildren();
    expect(loadRegistry().find((r) => r.model === 'account.payment' && r.recordId === 5000)).toMatchObject({ parent: 'sale.order:900', module: 'sales', origin: 'AUTOMATION' });
  });

  test('hàm tạo dữ liệu tự chặn khi thiếu giấy phép: KHÔNG gọi lệnh tạo nào', async () => {
    for (const setup of [() => grant({ none: true }), () => grant({}, 'odoo-purchase'), () => { grant({}); env.allowWriteTests = false; }]) {
      grant({}); env.allowWriteTests = true;
      setup();
      const { request, calls } = fakeOdoo();
      await expect(new SalesApi(request).createConfirmedSaleOrder(1, 'TC-X-001')).rejects.toThrow(/Từ chối tạo dữ liệu/);
      expect(calls.filter((c) => c.endsWith('.create'))).toEqual([]);
    }
  });

  test('popup: bấm Xác nhận/Lưu bị chặn nếu giấy phép không thuộc SO đang mở', async ({ page }) => {
    await page.goto('about:blank');
    const dialog = new RegisterPaymentDialog(page);
    const wrong = { kind: 'SafeWriteToken', application: 'odoo', module: 'odoo-sales', model: 'sale.order', id: 123 } as const;
    await expect(dialog.confirm(wrong)).rejects.toThrow(/không thuộc SO đang mở/);
    await expect(dialog.save(wrong)).rejects.toThrow(/không thuộc SO đang mở/);
  });

  test('runId phải đúng định dạng để cleanup nhận diện dữ liệu', () => {
    expect(RUN_ID_PATTERN.test(getRunId())).toBe(true);
    const keep = process.env.QA_RUN_ID;
    try {
      process.env.QA_RUN_ID = 'release-1';
      expect(() => getRunId()).toThrow(/YYYYMMDD-HHmmss/);
    } finally {
      process.env.QA_RUN_ID = keep;
    }
  });

  test('spec của MỌI module: mọi thao tác ghi qua popup đều có giấy phép; không gọi trực tiếp hàm tạo hay nút ghi', () => {
    for (const { f, text } of moduleSpecs()) {
      expect(/api\.createConfirmedSaleOrder\(/.test(text), `${f} gọi trực tiếp hàm tạo SO (phải qua createTestOrder)`).toBe(false);
      expect(/confirmButton|saveButton/.test(text), `${f} chạm trực tiếp nút ghi`).toBe(false);
      const writes = (text.match(/dialog\.(confirm|save)\(/g) ?? []).length;
      const tokens = (text.match(/assertSafeToWrite\(/g) ?? []).length;
      expect(tokens, `${f}: ${writes} lần ghi nhưng chỉ ${tokens} giấy phép`).toBeGreaterThanOrEqual(writes > 0 ? 1 : 0);
    }
  });

  test('npm test luôn ép chế độ chỉ đọc; quyền ghi chỉ qua test:write theo module', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.test).toBe('tsx scripts/run-tests.ts');
    expect(pkg.scripts['test:write']).toContain('--write');
    const runner = fs.readFileSync(path.join('scripts', 'run-tests.ts'), 'utf8');
    expect(runner).toContain("ALLOW_WRITE_TESTS: wantWrite ? 'true' : 'false'");
    expect(runner).toContain('QA_WRITE_GRANT: grant');
    expect(runner).toContain('typed !== host');
    expect(fs.readFileSync('.env.example', 'utf8')).toMatch(/^ALLOW_WRITE_TESTS=false$/m);
  });
});

test.describe('Bảo vệ bí mật (FW-09)', () => {
  const cookie = `ck-${randomBytes(15).toString('base64url')}`; // sinh lúc chạy: mã nguồn không chứa chuỗi giống mật khẩu

  test('redactText che cookie phiên, Authorization và giá trị bí mật đã biết; giữ nguyên phần còn lại', () => {
    const trace = JSON.stringify({ headers: [{ name: 'Cookie', value: `tz=Asia/Saigon; session_id=${cookie}; cids=1` }, { name: 'Authorization', value: 'Bearer abc.def.ghi' }], body: 'mật khẩu bí mật Zx9#kLm2!' });
    const { text, count } = redactText(trace, [{ label: 'PASS', value: 'Zx9#kLm2!' }]);
    expect(text).not.toContain(cookie);
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('Zx9#kLm2!');
    expect(text).toContain('session_id=[REDACTED]');
    expect(text).toContain('tz=Asia/Saigon');
    expect(count).toBe(3);
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test('shareDecision: bí mật và dữ liệu khách hàng không bao giờ vào ZIP; chỉ file trong danh sách trắng mới vào', () => {
    const no = (p: string, o = {}) => expect(shareDecision(p, o).include, `${p} không được vào ZIP`).toBe(false);
    const yes = (p: string, o = {}) => expect(shareDecision(p, o).include, `${p} phải được vào ZIP`).toBe(true);
    ['.env', '.env.local', '.auth/odoo-accountant.json', 'node_modules/x/index.js', 'reports/runs/r1/artifacts/a/trace.zip',
      'reports/runs/r1/artifacts/a/video.webm', 'reports/runs/r1/artifacts/a/test-failed-1.png', 'reports/runs/r1/playwright-html/data/x.zip',
      'share/old.zip', 'test_results/a.md', '.playwright-mcp/page.yml', 'so-S00058.yml', 'Odoo_MISA_Contact_Sync_Playwright_QA.md',
      'ghi-chu-rieng.md', '.vscode/settings.json', 'khac/file.ts'].forEach((p) => no(p, { withReport: true }));
    ['core/config/env.ts', 'tests/framework/safety.spec.ts', 'testcases/odoo-sales/a.json', '.env.example', 'FRAMEWORK.md', 'package.json', 'testdata/fixtures/odoo-purchase.json', '.claude/commands/qa-requirement.md'].forEach((p) => yes(p));
    no('.claude/settings.local.json');
    no('reports/qa-report.html');
    yes('reports/qa-report.html', { withReport: true });
    yes('reports/bugs.json', { withReport: true });
    yes('reports/runs/20261103-055138/results.json', { withReport: true });
  });

  test('suspectCredentialLines: bắt dòng/bảng giống thông tin đăng nhập, không báo nhầm văn bản thường', () => {
    const doc = ['| Hệ thống | URL | Tài khoản | Password |', '|---|---|---|---|', '| App | https://x.example | a@b.c | [Fake#Pw9_zzzTEST#42] |', 'Mật khẩu: không đổi'].join('\n');
    expect(suspectCredentialLines(doc)).toEqual([3]);
    expect(suspectCredentialLines('Không ghi mật khẩu hoặc token vào evidence.\nSession được lưu trong .auth/.')).toEqual([]);
    const assignment = ['const pass', "word = 'Abc12345!xyz';"].join(''); // ghép chuỗi để dòng nguồn này không tự khớp quy tắc quét
    expect(suspectCredentialLines(assignment, { code: true })).toEqual([1]);
    expect(suspectCredentialLines('export interface SafeWriteToken { kind: string }', { code: true })).toEqual([]);
  });

  test('.gitignore chặn bí mật, kết quả chạy và gói chia sẻ', () => {
    const lines = fs.readFileSync('.gitignore', 'utf8').split(/\r?\n/).map((l) => l.trim());
    for (const need of ['.env', '.env.*', '!.env.example', '.auth/', 'reports/', 'share/', '*.zip', 'node_modules/', '.playwright-mcp/']) {
      expect(lines, `.gitignore thiếu "${need}"`).toContain(need);
    }
  });
});
