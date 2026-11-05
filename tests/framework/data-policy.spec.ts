import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { odooRecipes, salesPlan } from '../../applications/odoo/factory';
import { odooFactoryCleanupHandlers } from '../../applications/odoo/factory-cleanup';
import type { OdooClient } from '../../applications/odoo/client';
import { odooConfig } from '../../applications/odoo/config';
import { getRunId } from '../../core/config/run';
import { resolveEnvironment, validateEnvironmentsFile, type EnvironmentsFile, type ResolvedEnvironment } from '../../core/environment/config';
import { confirmExecution, confirmPhrase, selectEnvironment } from '../../core/environment/state';
import { confirmPolicy, effectivePolicy, policyCheck, policyFile, policyPhrase, productionReason, revokePolicy } from '../../core/policy/policy';
import { collectSecrets, redactHosts, scanTextFile, shareDecision } from '../../core/security/scan';
import { redactText } from '../../core/security/scrub-trace';
import { DataFactory, FactoryError, planOrder, type FactoryScope } from '../../core/testdata/factory';
import { evidenceProblems, failedTestCases, runCleanup, writeCleanupReport } from '../../core/testdata/cleanup-engine';
import { loadRegistry, registerRecord, type TestDataRecord } from '../../core/testdata/registry';
import { grantProblems } from '../../core/testdata/write-guard';
import { installFakeEnvironments, type FakeEnvSpec } from './helpers/fake-env';
import { FakeOrm } from './helpers/fake-orm';
import { makeApprovedWorkspace, wsReq } from './helpers/workspace';

// Framework tests cho chính sách quyền thao tác, Test Data Factory, registry và cleanup (POL-*).
// Toàn bộ chạy trên ORM Odoo GIẢ trong bộ nhớ + thư mục tạm; không kết nối staging, không chạm dữ liệu/registry/báo cáo thật.

const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = (n: string) => path.join(process.cwd(), 'scripts', n);
const acct = { user: 'ke.toan@example.com', pass: 'Mk#fake-A-111' };
const OVERRIDES = ['QA_ENV', 'QA_REGISTRY_FILE', 'QA_APPROVAL_KEY_FILE', 'QA_REPORTS_DIR', 'QA_POLICY', 'AUTO_CLEANUP', 'QA_PRODUCTION_HOSTS', 'QA_ENVIRONMENTS_DIR'] as const;
const saved = Object.fromEntries(OVERRIDES.map((k) => [k, process.env[k]]));
const cleanups: (() => void)[] = [];
let tmp: string;

test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-pol-'));
  for (const k of OVERRIDES) delete process.env[k];
  process.env.QA_REGISTRY_FILE = path.join(tmp, 'registry.jsonl');
  process.env.QA_APPROVAL_KEY_FILE = path.join(tmp, 'k.key');
  process.env.QA_ENV = 'ENV_A';
  // Mặc định không có cấu hình môi trường thật (chế độ explicit): test nào cần cấu hình tự dựng bằng fakeEnv.
  process.env.QA_ENVIRONMENTS_DIR = path.join(tmp, 'no-environments');
});
test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const k of OVERRIDES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const envOf = (over: Partial<ResolvedEnvironment> = {}): ResolvedEnvironment => ({
  application: 'odoo', key: 'ENV_A', label: 'Staging A', kind: 'staging', baseUrl: 'https://a.example.com', origin: 'https://a.example.com', host: 'a.example.com', roles: {},
  policy: { write: 'framework-data', autoCleanup: true, failureRetentionHours: 48, maxRecordsPerRun: 200 }, ...over,
});
const fakeEnv = (specs: Record<string, FakeEnvSpec>) => {
  const f = installFakeEnvironments(tmp, specs);
  cleanups.push(f.restore);
  return f;
};
/** Ghi cấu hình môi trường giả kèm chính sách ghi (cho cả tiến trình này lẫn tiến trình con chạy trong thư mục làm việc). */
function usePolicyConfig(ws: string, f: ReturnType<typeof installFakeEnvironments>) {
  const cfg = structuredClone(f.config);
  for (const k of Object.keys(cfg.environments)) cfg.environments[k].policy = { write: 'framework-data', autoCleanup: true };
  const json = JSON.stringify(cfg);
  fs.writeFileSync(path.join(f.envDir, 'odoo.json'), json);
  fs.mkdirSync(path.join(ws, 'environments'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'environments', 'odoo.json'), json);
}
const resolved = (key: string, source?: NodeJS.ProcessEnv) => {
  const r = resolveEnvironment('odoo', key, source);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.env;
};

// ---------------------------------------------------------------------------------------------------------------------
test.describe('POL-1 Chính sách quyền thao tác theo môi trường (production luôn bị chặn)', () => {
  test('khai báo hợp lệ: environments/odoo.json có policy cho staging, UAT mặc định chỉ đọc; policy sai bị báo', () => {
    const real = JSON.parse(fs.readFileSync('environments/odoo.json', 'utf8')) as EnvironmentsFile;
    expect(validateEnvironmentsFile(real, Object.keys(odooConfig.roles))).toEqual([]);
    expect(real.environments.STAGING_A.policy).toMatchObject({ write: 'framework-data', autoCleanup: true });
    expect(real.environments.UAT.policy).toBeUndefined();
    const bad = structuredClone(real);
    bad.environments.STAGING_A.policy = { write: 'everything' as never, failureRetentionHours: -1, maxRecordsPerRun: Number.NaN };
    const p = validateEnvironmentsFile(bad).join('|');
    expect(p).toMatch(/policy\.write phải là none hoặc framework-data/);
    expect(p).toMatch(/failureRetentionHours phải là số không âm/);
    expect(p).toMatch(/maxRecordsPerRun phải là số không âm/);
  });

  test('effectivePolicy: staging được ghi dữ liệu framework; mặc định chỉ đọc; AUTO_CLEANUP=false chỉ có thể TẮT', () => {
    const p = effectivePolicy(envOf());
    expect(p).toMatchObject({ write: 'framework-data', autoCleanup: true, failureRetentionHours: 48, maxRecordsPerRun: 200 });
    expect(effectivePolicy(envOf({ policy: undefined }))).toMatchObject({ write: 'none', autoCleanup: false });
    expect(effectivePolicy(envOf({ policy: { autoCleanup: true } }))).toMatchObject({ write: 'none', autoCleanup: false }); // không ghi thì không có cleanup tự động
    const off = effectivePolicy(envOf(), { AUTO_CLEANUP: 'false' } as NodeJS.ProcessEnv);
    expect(off.autoCleanup).toBe(false);
    expect(off.reasons.join()).toMatch(/AUTO_CLEANUP=false/);
    expect(effectivePolicy(envOf({ policy: { write: 'framework-data', autoCleanup: false } }), { AUTO_CLEANUP: 'true' } as NodeJS.ProcessEnv).autoCleanup).toBe(false);
    expect(effectivePolicy(envOf({ policy: { write: 'framework-data', maxRecordsPerRun: 5 } })).hash).not.toBe(p.hash);
  });

  test('production bị ép none ở mọi cách khai báo sai: kind, tên, host, nhãn, danh sách cấm; không có công tắc nào nới ra', () => {
    const wants = { write: 'framework-data' as const, autoCleanup: true };
    const cases: [string, Partial<ResolvedEnvironment>][] = [
      ['kind=production', { kind: 'production' }],
      ['khoá PROD', { key: 'ODOO_PROD' }],
      ['khoá LIVE', { key: 'LIVE' }],
      ['host prod', { host: 'erp.prod.example.com' }],
      ['host production', { host: 'production.example.com' }],
      ['nhãn production (kind gõ nhầm staging)', { kind: 'staging', label: 'Production chính' }],
    ];
    for (const [name, over] of cases) {
      const e = envOf({ policy: wants, ...over });
      expect(productionReason(e), name).toBeTruthy();
      expect(effectivePolicy(e), name).toMatchObject({ write: 'none', autoCleanup: false });
      expect(effectivePolicy(e).reasons.join(), name).toMatch(/Production không cho phép quyền ghi tự động/);
    }
    const denied = envOf({ host: 'erp.example.com', policy: wants });
    expect(effectivePolicy(denied).write).toBe('framework-data');
    expect(effectivePolicy(denied, { QA_PRODUCTION_HOSTS: 'x.example.com, ERP.example.com' } as NodeJS.ProcessEnv).write).toBe('none');
    expect(productionReason(envOf({ key: 'PRODUCT_TEST', host: 'products-test.example.com' }))).toBeUndefined(); // "product" không phải "prod"
    // Cổng ghi của giấy phép cũng từ chối, dù giấy phép hợp lệ.
    const ctx = { allowWrite: true, host: 'erp.prod.example.com', environment: 'ENV_A', environmentKind: 'staging', module: 'odoo-sales', runId: '20261105-100000' };
    expect(grantProblems({ ...ctx, grant: { host: ctx.host, environment: 'ENV_A', module: 'odoo-sales', runId: ctx.runId } }).join()).toMatch(/production không cho phép ghi/);
    expect(grantProblems({ ...ctx, host: 'erp.example.com', grant: { host: 'erp.example.com', environment: 'ENV_A', module: 'odoo-sales', runId: ctx.runId } })).toEqual([]);
  });

  test('xác nhận chính sách một lần: đúng cụm mới ghi; sai cụm, production, môi trường chỉ đọc đều bị từ chối', () => {
    const e = envOf();
    const p = effectivePolicy(e);
    expect(policyPhrase(e, p)).toMatch(/^ALLOW-WRITE ENV_A a\.example\.com [0-9a-f]{12}$/);
    const base = { env: e, requirementId: wsReq.id, approvalHash: 'h1', by: 'Chị Thanh' };
    expect(() => confirmPolicy(tmp, { ...base, typed: 'ALLOW-WRITE' })).toThrow(/không khớp/);
    expect(() => confirmPolicy(tmp, { ...base, by: ' ', typed: policyPhrase(e, p) })).toThrow(/tên/);
    expect(fs.existsSync(policyFile(tmp))).toBe(false);
    const prod = envOf({ kind: 'production' });
    expect(() => confirmPolicy(tmp, { ...base, env: prod, typed: policyPhrase(prod, effectivePolicy(prod)) })).toThrow(/không được cấp quyền ghi tự động.*Production/);
    const ro = envOf({ policy: undefined });
    expect(() => confirmPolicy(tmp, { ...base, env: ro, typed: 'x' })).toThrow(/không được cấp quyền ghi tự động/);
    const c = confirmPolicy(tmp, { ...base, typed: policyPhrase(e, p) });
    expect(c).toMatchObject({ environment: 'ENV_A', host: 'a.example.com', requirementId: wsReq.id, policyHash: p.hash });
    expect(Date.parse(c.expiresAt) - Date.parse(c.at)).toBe(8 * 3600 * 1000);
    expect(policyCheck(tmp, e, wsReq.id, 'h1')).toMatchObject({ ok: true });
  });

  test('xác nhận chỉ hợp lệ đúng môi trường/host/chính sách/phê duyệt/phiên; không dùng chéo, không giả được, thu hồi được', () => {
    const a = envOf();
    const b = envOf({ key: 'ENV_B', host: 'b.example.com' });
    const confirm = (e: ResolvedEnvironment) => confirmPolicy(tmp, { env: e, requirementId: wsReq.id, approvalHash: 'h1', by: 'N', typed: policyPhrase(e, effectivePolicy(e)) });
    expect(policyCheck(tmp, a, wsReq.id, 'h1').problem).toMatch(/chưa được xác nhận cho REQ-E-001.*npm run qa:policy -- confirm --env=ENV_A/);
    confirm(a);
    expect(policyCheck(tmp, a, wsReq.id, 'h1').ok).toBe(true);
    expect(policyCheck(tmp, b, wsReq.id, 'h1').problem).toMatch(/ENV_B chưa được xác nhận/); // không dùng chéo môi trường
    expect(policyCheck(tmp, a, 'REQ-KHAC', 'h1').ok).toBe(false);
    expect(policyCheck(tmp, a, wsReq.id, 'h2').problem).toMatch(/Phê duyệt của REQ-E-001 đã đổi/);
    expect(policyCheck(tmp, envOf({ host: 'a2.example.com' }), wsReq.id, 'h1').problem).toMatch(/host "a\.example\.com" nhưng \.env hiện trỏ tới "a2\.example\.com"/);
    expect(policyCheck(tmp, envOf({ policy: { write: 'framework-data', autoCleanup: false } }), wsReq.id, 'h1').problem).toMatch(/Chính sách của ENV_A đã đổi/);
    expect(policyCheck(tmp, a, wsReq.id, 'h1', Date.now() + 9 * 3600 * 1000).problem).toMatch(/đã hết hạn/);
    expect(policyCheck(tmp, envOf({ kind: 'production' }), wsReq.id, 'h1').ok).toBe(false); // production không bao giờ qua dù đã có xác nhận
    // Sửa tay / sao chép sang môi trường khác bị phát hiện bằng chữ ký.
    const original = fs.readFileSync(policyFile(tmp), 'utf8');
    const s = JSON.parse(original);
    s.confirmations[`ENV_A|${wsReq.id}`].by = 'Kẻ giả mạo';
    fs.writeFileSync(policyFile(tmp), JSON.stringify(s));
    expect(policyCheck(tmp, a, wsReq.id, 'h1').problem).toMatch(/không xác minh được chữ ký/);
    const forged = JSON.parse(original);
    forged.confirmations[`ENV_B|${wsReq.id}`] = { ...forged.confirmations[`ENV_A|${wsReq.id}`], environment: 'ENV_B', host: 'b.example.com' };
    fs.writeFileSync(policyFile(tmp), JSON.stringify(forged));
    expect(policyCheck(tmp, b, wsReq.id, 'h1').ok).toBe(false);
    fs.writeFileSync(policyFile(tmp), original);
    expect(policyCheck(tmp, a, wsReq.id, 'h1').ok).toBe(true);
    revokePolicy(tmp, 'ENV_A');
    expect(policyCheck(tmp, a, wsReq.id, 'h1').ok).toBe(false);
  });

  test('qa:policy CLI: confirm bắt buộc bàn phím thật; show cho production luôn là none; runner từ chối ghi trên production và gọi cleanup theo chính sách', () => {
    const w = makeApprovedWorkspace();
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    const f = fakeEnv({
      ENV_A: { url: 'https://a.example.com', version: '18.0', roles: { accountant: acct } },
      ENV_PROD: { url: 'https://erp.example.com', version: '18.0', kind: 'production', roles: { accountant: acct } },
    });
    usePolicyConfig(w.ws, f);
    const env = { ...w.env, ...f.vars, APP: 'odoo' } as NodeJS.ProcessEnv;
    delete env.QA_ENVIRONMENTS_DIR;
    delete env.QA_ENV;
    const run = (name: string, ...args: string[]) => spawnSync(process.execPath, [tsx, script(name), ...args], { cwd: w.ws, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    selectEnvironment(w.ws, 'odoo', 'ENV_A');
    const show = run('policy.ts', 'show');
    expect(show.status, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/write=framework-data, autoCleanup=true/);
    expect(show.stdout).toMatch(/KHÔNG đụng dữ liệu nghiệp vụ có sẵn/);
    const nonTty = run('policy.ts', 'confirm', `--requirement=${wsReq.id}`, '--by=Tester');
    expect(nonTty.status).toBe(2);
    expect(nonTty.stderr).toMatch(/NGƯỜI DÙNG/);
    expect(fs.existsSync(policyFile(w.ws))).toBe(false);

    selectEnvironment(w.ws, 'odoo', 'ENV_PROD');
    const prod = run('policy.ts', 'show');
    expect(prod.stdout).toMatch(/write=none, autoCleanup=false/);
    expect(prod.stdout).toMatch(/Production không cho phép quyền ghi tự động/);

    // Runner: môi trường production đã chọn + đã xác nhận thực thi vẫn bị từ chối ghi.
    fs.mkdirSync(path.join(w.ws, 'tests', 'odoo-sales'), { recursive: true });
    Object.assign(process.env, f.vars);
    const pe = resolved('ENV_PROD');
    confirmExecution(w.ws, { env: pe, requirementId: wsReq.id, approvalHash: w.hash, by: 'N', typed: confirmPhrase(pe) });
    const w1 = run('run-tests.ts', '--write', '--module=odoo-sales', '--confirm-host=erp.example.com');
    expect(w1.status).toBe(2);
    expect(w1.stderr).toMatch(/bị coi là PRODUCTION.*quyền ghi dữ liệu bị từ chối, không có ngoại lệ/);

    const src = fs.readFileSync(path.join('scripts', 'run-tests.ts'), 'utf8');
    expect(src).toContain('policyCheck(');
    expect(src).toContain('cleanup-run.ts');
    expect(src).toContain('QA_POLICY');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('POL-2 Test Data Factory: sinh dữ liệu, gắn ID, registry, phụ thuộc', () => {
  const scope = (over: Partial<FactoryScope> = {}): FactoryScope => ({ application: 'odoo', module: 'sales', environment: 'ENV_A', runId: '20261105-100000', requirementId: 'REQ-F-001', testCaseId: 'TC-F-001', ...over });
  const mk = (orm: FakeOrm, over: { scope?: Partial<FactoryScope>; problems?: () => string[]; max?: number } = {}) =>
    new DataFactory({ rpc: orm, recipes: odooRecipes, scope: scope(over.scope), writeProblems: over.problems ?? (() => []), maxRecordsPerRun: over.max ?? 200 });

  test('sinh trọn bộ khách hàng, sản phẩm, serial, SO, DO, thanh toán theo thứ tự phụ thuộc; mọi bản ghi mang đủ 4 ID trong registry và thẻ trong dữ liệu', async () => {
    const orm = new FakeOrm();
    const f = mk(orm);
    const h = await f.build(salesPlan({ amount: 5000, serial: true, delivery: true, payment: 2000 }));
    expect(Object.keys(h).sort()).toEqual(['delivery', 'partner', 'payment', 'product', 'serial', 'so']);
    expect(h.so.model).toBe('sale.order');
    expect(h.delivery.model).toBe('stock.picking');
    const creates = orm.calls.filter((c) => c.method === 'create').map((c) => c.model);
    expect(creates.indexOf('res.partner')).toBeLessThan(creates.indexOf('sale.order'));
    expect(creates.indexOf('product.product')).toBeLessThan(creates.indexOf('stock.lot'));
    expect(creates.indexOf('sale.order')).toBeLessThan(creates.indexOf('account.payment'));
    expect(orm.calls.some((c) => c.model === 'sale.order' && c.method === 'action_confirm')).toBe(true);
    expect(orm.calls.some((c) => c.model === 'account.payment' && c.method === 'action_post')).toBe(true);

    const reg = loadRegistry();
    expect(reg).toHaveLength(6);
    for (const r of reg) {
      expect(r, r.model).toMatchObject({ environment: 'ENV_A', runId: '20261105-100000', requirementId: 'REQ-F-001', testCaseId: 'TC-F-001', owner: 'FRAMEWORK', origin: 'AUTOMATION', cleanupStatus: 'PENDING', application: 'odoo' });
    }
    const dep = (m: string) => reg.find((r) => r.model === m)!.dependsOn;
    expect(dep('sale.order')).toEqual([h.partner.key, h.product.key]);
    expect(dep('stock.lot')).toEqual([h.product.key]);
    expect(dep('stock.picking')).toEqual([h.so.key]); // phiếu giao do SO tự sinh được đăng ký ngay khi xác nhận SO (phụ thuộc SO)
    expect(dep('account.payment')).toEqual([h.so.key, h.partner.key]);
    expect(reg.find((r) => r.model === 'account.payment')!.parent).toBe(h.so.key);
    // Thẻ nằm trong chính dữ liệu: tham chiếu AUTOTEST + env/run/req/tc.
    const so = orm.find('sale.order', h.so.id)!;
    expect(so.client_order_ref).toBe('AUTOTEST 20261105-100000 TC-F-001');
    for (const v of [so.origin, orm.find('res.partner', h.partner.id)!.comment, orm.find('product.product', h.product.id)!.description]) expect(v).toContain('env=ENV_A run=20261105-100000 req=REQ-F-001 tc=TC-F-001');
    expect(orm.find('res.partner', h.partner.id)!.name).toMatch(/^AUTOTEST /);
    expect(orm.find('stock.lot', h.serial.id)!.note).toContain('QA env=ENV_A');
  });

  test('cổng ghi: thiếu quyền thì KHÔNG gọi RPC nào; giới hạn bản ghi mỗi lần chạy; kế hoạch sai bị từ chối trước khi tạo', async () => {
    const orm = new FakeOrm();
    await expect(mk(orm, { problems: () => ['chưa xác nhận chính sách ghi'] }).create('partner')).rejects.toThrow(/Từ chối tạo\/sửa dữ liệu: chưa xác nhận chính sách ghi/);
    expect(orm.calls).toHaveLength(0);
    expect(loadRegistry()).toHaveLength(0);

    const limited = mk(orm, { max: 3 });
    await limited.build({ a: { kind: 'partner' }, b: { kind: 'partner' }, c: { kind: 'partner' } });
    await expect(limited.create('partner')).rejects.toThrow(/giới hạn 3 bản ghi/);
    expect(loadRegistry()).toHaveLength(3);

    const fresh = new FakeOrm();
    const g = mk(fresh, { scope: { runId: '20261105-110000' } });
    expect(() => planOrder({ a: { kind: 'x', requires: ['b'] }, b: { kind: 'x', requires: ['a'] } })).toThrow(/chu trình: a → b → a/);
    expect(() => planOrder({ a: { kind: 'x', requires: ['zzz'] } })).toThrow(/yêu cầu "zzz"/);
    await expect(g.build({ a: { kind: 'sale.order', requires: ['nope'] } })).rejects.toThrow(FactoryError);
    await expect(g.create('khong-co')).rejects.toThrow(/Chưa có công thức/);
    expect(fresh.calls).toHaveLength(0);
  });

  test('chỉ sửa dữ liệu do chính lần chạy này tạo; phụ thuộc/bản ghi của lần chạy hoặc môi trường khác bị từ chối', async () => {
    const orm = new FakeOrm();
    const f = mk(orm);
    const h = await f.build(salesPlan({ amount: 100 }));
    await f.update(h.so, { note: 'sửa bởi test' });
    expect(orm.find('sale.order', h.so.id)!.note).toBe('sửa bởi test');
    // Cùng bản ghi nhưng từ lần chạy khác / môi trường khác: không được sửa.
    await expect(mk(orm, { scope: { runId: '20261105-120000' } }).update(h.so, { note: 'x' })).rejects.toThrow(/Từ chối sửa sale\.order:\d+: không phải dữ liệu framework/);
    await expect(mk(orm, { scope: { environment: 'ENV_B' } }).update(h.so, { note: 'x' })).rejects.toThrow(/Từ chối sửa/);
    // Bản ghi nghiệp vụ có sẵn (không có trong registry) không bao giờ sửa được; không dùng làm phụ thuộc.
    const existing = orm.seed('sale.order', { name: 'S-CO-SAN', client_order_ref: 'KH-123', state: 'sale' });
    const foreign = { key: `sale.order:${existing.id}`, kind: 'sale.order', model: 'sale.order', id: existing.id, reference: 'KH-123', dependsOn: [] };
    await expect(f.update(foreign, { state: 'cancel' })).rejects.toThrow(/Từ chối sửa/);
    await expect(f.create('payment', { amount: 1 }, { partner: h.partner, so: foreign })).rejects.toThrow(/không phải dữ liệu do lần chạy này tạo/);
    expect(orm.find('sale.order', existing.id)).toMatchObject({ state: 'sale', client_order_ref: 'KH-123' });
  });

  test('bước sau khi tạo lỗi (xác nhận SO) vẫn để lại dấu vết trong registry để cleanup', async () => {
    const orm = new FakeOrm();
    orm.failOn = (m, method) => (m === 'sale.order' && method === 'action_confirm' ? 'không đủ tồn kho' : undefined);
    const f = mk(orm);
    await expect(f.build(salesPlan({ amount: 100 }))).rejects.toThrow(/không đủ tồn kho/);
    const reg = loadRegistry();
    expect(reg.map((r) => r.model).sort()).toEqual(['product.product', 'res.partner', 'sale.order']);
    expect(reg.every((r) => r.owner === 'FRAMEWORK' && r.environment === 'ENV_A')).toBe(true);
  });

  test('registry riêng theo môi trường: cùng model + ID ở hai môi trường không lẫn nhau; bản ghi cũ không có owner/environment', () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      delete process.env.QA_REGISTRY_FILE;
      const reg = (env: string) => {
        process.env.QA_ENV = env;
        registerRecord({ testCaseId: 'TC-F-001', application: 'odoo', model: 'sale.order', recordId: 5, reference: `AUTOTEST 20261105-100000 TC-F-001`, runId: '20261105-100000', requirementId: 'REQ-F-001', owner: 'FRAMEWORK' });
      };
      reg('ENV_A');
      reg('ENV_B');
      expect(fs.existsSync(path.join(tmp, 'testdata', 'registry', 'ENV_A.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'testdata', 'registry', 'ENV_B.jsonl'))).toBe(true);
      process.env.QA_ENV = 'ENV_A';
      expect(loadRegistry().map((r) => r.environment)).toEqual(['ENV_A']);
      process.env.QA_ENV = 'ENV_B';
      expect(loadRegistry().map((r) => r.environment)).toEqual(['ENV_B']);
      const raw = fs.readFileSync(path.join(tmp, 'testdata', 'registry', 'ENV_A.jsonl'), 'utf8');
      expect(raw).not.toMatch(/https?:|example\.com/); // sổ không chứa địa chỉ môi trường
    } finally {
      process.chdir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('POL-3 Cleanup: chỉ dữ liệu framework, theo phụ thuộc, giữ khi FAIL, CLEANUP_BLOCKED không đổi kết quả test', () => {
  const RUN = '20261105-100000';
  const policy = (over: Partial<ReturnType<typeof effectivePolicy>> = {}) => ({ ...effectivePolicy(envOf()), ...over });
  const clean = (orm: FakeOrm, o: Partial<Parameters<typeof runCleanup>[0]> = {}) =>
    runCleanup({ client: orm as unknown as OdooClient, handlers: odooFactoryCleanupHandlers, records: loadRegistry(), environment: 'ENV_A', policy: policy(), runId: RUN, ...o } as Parameters<typeof runCleanup>[0]);
  const build = async (orm: FakeOrm, plan = salesPlan({ amount: 5000, serial: true, delivery: true, payment: 2000 }), tc = 'TC-F-001') => {
    const f = new DataFactory({ rpc: orm, recipes: odooRecipes, scope: { application: 'odoo', module: 'sales', environment: 'ENV_A', runId: RUN, requirementId: 'REQ-F-001', testCaseId: tc }, writeProblems: () => [], maxRecordsPerRun: 200 });
    return f.build(plan);
  };
  const statusOf = (key: string) => loadRegistry().find((r) => `${r.model}:${r.recordId}` === key)!;
  const keyOf = (m: string, id: number) => `${m}:${id}`;

  test('cleanup trọn bộ: dọn con trước gốc sau (thanh toán → DO → SO → serial → sản phẩm → khách hàng), huỷ/lưu trữ chứ không xoá chứng từ', async () => {
    const orm = new FakeOrm();
    const h = await build(orm);
    const before = orm.calls.length;
    const res = await clean(orm);
    expect(res.counts).toMatchObject({ CLEANED: 6, CLEANUP_BLOCKED: 0 });
    const ops = orm.calls.slice(before).filter((c) => !['search_read', 'search_count'].includes(c.method)).map((c) => `${c.model}.${c.method}`);
    const at = (s: string) => ops.indexOf(s);
    // Con trước, gốc sau: thanh toán và phiếu giao trước SO; SO và serial trước sản phẩm; SO trước khách hàng.
    for (const child of ['account.payment.action_cancel', 'stock.picking.action_cancel']) expect(at(child), child).toBeGreaterThanOrEqual(0);
    expect(at('account.payment.action_cancel')).toBeLessThan(at('sale.order.action_cancel'));
    expect(at('stock.picking.action_cancel')).toBeLessThan(at('sale.order.action_cancel'));
    expect(at('sale.order.action_cancel')).toBeLessThan(at('product.product.write'));
    expect(at('stock.lot.unlink')).toBeLessThan(at('product.product.write'));
    expect(at('sale.order.action_cancel')).toBeLessThan(at('res.partner.write'));
    expect(ops).not.toContain('sale.order.unlink');
    expect(ops).not.toContain('account.payment.unlink');
    expect(orm.find('sale.order', h.so.id)!.state).toBe('cancel');
    expect(orm.find('account.payment', h.payment.id)!.state).toBe('canceled');
    expect(orm.find('stock.picking', h.delivery.id)!.state).toBe('cancel');
    expect(orm.find('product.product', h.product.id)!.active).toBe(false);
    expect(orm.find('res.partner', h.partner.id)!.active).toBe(false);
    expect(orm.find('stock.lot', h.serial.id)).toBeUndefined();
    for (const r of loadRegistry()) expect(r).toMatchObject({ cleanupStatus: 'CLEANED' });
    expect(statusOf(keyOf('sale.order', h.so.id)).cleanedAt).toBeTruthy();
    // Chạy lại: không còn gì để dọn.
    expect((await clean(orm)).outcomes).toHaveLength(0);
  });

  test('không đụng dữ liệu ngoài registry, dữ liệu chưa có chủ sở hữu (cũ), BACKFILL, hay của môi trường/lần chạy khác', async () => {
    const orm = new FakeOrm();
    const existing = orm.seed('sale.order', { name: 'S-CU', client_order_ref: 'AUTOTEST 20261102-175937 TC-SO-001', state: 'sale', create_uid: [7, 'Tài khoản automation'], invoice_ids: [], picking_ids: [] });
    const partner = orm.seed('res.partner', { name: 'Khách thật' });
    const before = JSON.stringify([orm.find('sale.order', existing.id), orm.find('res.partner', partner.id)]);
    // Bản ghi cũ: có AUTOMATION nhưng chưa có owner/environment (dữ liệu trước đây); BACKFILL; môi trường khác; lần chạy khác.
    const base = { testCaseId: 'TC-SO-001', application: 'odoo', model: 'sale.order', reference: 'AUTOTEST 20261102-175937 TC-SO-001', runId: RUN };
    registerRecord({ ...base, recordId: existing.id });
    registerRecord({ ...base, model: 'res.partner', recordId: partner.id, origin: 'BACKFILL', owner: 'FRAMEWORK', environment: 'ENV_A' });
    registerRecord({ ...base, recordId: 9001, owner: 'FRAMEWORK', environment: 'ENV_B' });
    registerRecord({ ...base, recordId: 9002, owner: 'FRAMEWORK', environment: 'ENV_A', runId: '20260101-000000' });
    const mine = await build(orm, salesPlan({ amount: 10 }));
    const res = await clean(orm);
    const pickKey = loadRegistry().find((r) => r.model === 'stock.picking')!;
    expect(res.outcomes.map((o) => o.key).sort()).toEqual([mine.partner.key, mine.product.key, mine.so.key, `stock.picking:${pickKey.recordId}`].sort()); // gồm phiếu giao SO tự sinh
    expect(JSON.stringify([orm.find('sale.order', existing.id), orm.find('res.partner', partner.id)])).toBe(before);
    expect(loadRegistry().filter((r) => r.cleanupStatus === 'PENDING').map((r) => r.recordId).sort((a, b) => a - b)).toEqual([existing.id, partner.id, 9001, 9002].sort((a, b) => a - b));
  });

  test('chứng từ bị ràng buộc kế toán/kho: CLEANUP_BLOCKED kèm nguyên nhân, không thao tác phá huỷ; bản ghi gốc không bị dọn khi còn bản ghi phụ thuộc', async () => {
    const orm = new FakeOrm();
    const h = await build(orm, salesPlan({ amount: 1000, delivery: true, payment: 500 }));
    orm.find('account.payment', h.payment.id)!.is_reconciled = true; // đã đối soát hoá đơn
    const before = orm.calls.length;
    const res = await clean(orm);
    const by = Object.fromEntries(res.outcomes.map((o) => [o.key, o]));
    expect(by[h.payment.key]).toMatchObject({ status: 'CLEANUP_BLOCKED' });
    expect(by[h.payment.key].reason).toMatch(/đã đối soát/);
    expect(by[h.so.key]).toMatchObject({ status: 'CLEANUP_BLOCKED' });
    expect(by[h.so.key].reason).toMatch(/phiếu thu .* chưa đủ điều kiện huỷ|còn bản ghi phụ thuộc chưa dọn/);
    expect(by[h.partner.key]).toMatchObject({ status: 'CLEANUP_BLOCKED' });
    expect(by[h.partner.key].reason).toMatch(/còn bản ghi phụ thuộc chưa dọn: .*sale\.order/);
    expect(orm.find('sale.order', h.so.id)!.state).toBe('sale');
    expect(orm.find('res.partner', h.partner.id)!.active).toBe(true);
    const destructive = orm.calls.slice(before).filter((c) => ['sale.order', 'res.partner', 'product.product'].includes(c.model) && !['search_read', 'search_count'].includes(c.method));
    expect(destructive).toEqual([]);
    expect(statusOf(h.payment.key)).toMatchObject({ cleanupStatus: 'CLEANUP_BLOCKED' });
    expect(statusOf(h.payment.key).note).toMatch(/đã đối soát/);

    // Phiếu giao đã hoàn tất (ảnh hưởng tồn kho/kế toán) cũng bị chặn, kéo theo SO.
    const orm2 = new FakeOrm(5000);
    const g = await build(orm2, salesPlan({ amount: 1000, delivery: true }), 'TC-F-002');
    await orm2.call('stock.picking', 'button_validate', [[g.delivery.id]]);
    const r2 = await clean(orm2, { records: loadRegistry().filter((r) => r.testCaseId === 'TC-F-002') });
    const b2 = Object.fromEntries(r2.outcomes.map((o) => [o.key, o]));
    expect(b2[g.delivery.key].reason).toMatch(/đã hoàn tất: ảnh hưởng tồn kho\/kế toán/);
    expect(b2[g.so.key].status).toBe('CLEANUP_BLOCKED');
    expect(orm2.find('sale.order', g.so.id)!.state).toBe('sale');
  });

  test('cleanup lỗi: ghi rõ bản ghi + nguyên nhân (đã che bí mật), CLEANUP_BLOCKED, không ném lỗi, KHÔNG đổi kết quả kiểm thử', async () => {
    const orm = new FakeOrm();
    const h = await build(orm, salesPlan({ amount: 1000 }));
    orm.failOn = (m, method) => (m === 'sale.order' && method === 'action_cancel' ? 'Access denied token=S3cretValue99' : undefined);
    // Kết quả kiểm thử đã có trước khi cleanup (không được thay đổi).
    const reports = path.join(tmp, 'reports', 'ENV_A');
    const results = path.join(reports, 'runs', RUN, 'results.json');
    fs.mkdirSync(path.dirname(results), { recursive: true });
    fs.writeFileSync(results, JSON.stringify({ runId: RUN, entries: [{ tcId: 'TC-F-001', status: 'PASS' }] }));
    const resultsBefore = fs.readFileSync(results);
    const res = await clean(orm, { redact: (s) => redactText(s, [{ label: 'T', value: 'S3cretValue99' }]).text });
    const so = res.outcomes.find((o) => o.key === h.so.key)!;
    expect(so).toMatchObject({ status: 'CLEANUP_BLOCKED', model: 'sale.order', id: h.so.id, requirementId: 'REQ-F-001', testCaseId: 'TC-F-001', environment: 'ENV_A' });
    expect(so.reason).toMatch(/bước sale\.order\.action_cancel lỗi: .*Access denied/);
    expect(so.reason).not.toContain('S3cretValue99');
    expect(statusOf(h.so.key)).toMatchObject({ cleanupStatus: 'CLEANUP_BLOCKED' });
    expect(statusOf(h.so.key).note).not.toContain('S3cretValue99');
    expect(res.outcomes.find((o) => o.key === h.partner.key)!.status).toBe('CLEANUP_BLOCKED'); // gốc không được dọn khi SO còn
    const mdFile = writeCleanupReport(reports, { environment: 'ENV_A', runId: RUN, dryRun: false }, res);
    const md = fs.readFileSync(mdFile, 'utf8');
    expect(md).toContain('CLEANUP_BLOCKED');
    expect(md).toContain(h.so.key);
    expect(md).not.toContain('S3cretValue99');
    expect(fs.readFileSync(results).equals(resultsBefore)).toBe(true); // kết quả test giữ nguyên từng byte
    expect(fs.readdirSync(path.join(reports, 'cleanup')).length).toBe(2);
    // Sửa nguyên nhân rồi thử lại: dọn được.
    orm.failOn = undefined;
    const retry = await clean(orm, { retryBlocked: true });
    expect(retry.counts.CLEANED).toBe(3);
    expect(statusOf(h.so.key).cleanupStatus).toBe('CLEANED');
  });

  test('test FAIL: giữ dữ liệu theo thời gian cấu hình (RETAINED, cả bản ghi gốc), hết hạn thì dọn; retention 0 dọn ngay', async () => {
    const orm = new FakeOrm();
    const h = await build(orm, salesPlan({ amount: 100 }), 'TC-F-009');
    const now = Date.parse('2026-11-05T10:00:00Z');
    const failed = new Set(['TC-F-009']);
    const first = await clean(orm, { now, failedTestCases: failed });
    expect(first.counts).toMatchObject({ RETAINED: 4, CLEANED: 0 }); // SO, khách hàng, sản phẩm và phiếu giao tự sinh
    const until = new Date(now + 48 * 3600 * 1000).toISOString();
    expect(first.outcomes[0]).toMatchObject({ status: 'RETAINED', retainUntil: until });
    expect(statusOf(h.so.key)).toMatchObject({ cleanupStatus: 'RETAINED', retainUntil: until });
    expect(orm.find('sale.order', h.so.id)!.state).toBe('sale'); // còn nguyên để điều tra
    // Chưa hết hạn: vẫn giữ. Hết hạn: dọn.
    expect((await clean(orm, { now: now + 47 * 3600_000, failedTestCases: failed })).counts.CLEANED).toBe(0);
    const later = await clean(orm, { now: now + 49 * 3600_000, failedTestCases: failed });
    expect(later.counts).toMatchObject({ CLEANED: 4, RETAINED: 0 });
    // Retention 0 giờ: dọn luôn kể cả test FAIL.
    const orm2 = new FakeOrm(7000);
    await build(orm2, salesPlan({ amount: 100 }), 'TC-F-010');
    const zero = await clean(orm2, { failedTestCases: new Set(['TC-F-010']), policy: policy({ failureRetentionHours: 0 }), records: loadRegistry().filter((r) => r.testCaseId === 'TC-F-010') });
    expect(zero.counts.CLEANED).toBe(4);
  });

  test('chỉ giữ dữ liệu của test FAIL: test PASS cùng lần chạy vẫn được dọn; phụ thuộc chung giữ lại cho tới khi hết hạn', async () => {
    const orm = new FakeOrm();
    const pass = await build(orm, salesPlan({ amount: 100 }), 'TC-F-001');
    const fail = await build(orm, { so: { kind: 'sale.order', requires: ['partner', 'product'], params: {} }, partner: { kind: 'partner' }, product: { kind: 'product' } }, 'TC-F-002');
    const res = await clean(orm, { failedTestCases: new Set(['TC-F-002']) });
    const by = Object.fromEntries(res.outcomes.map((o) => [o.key, o.status]));
    expect(by[pass.so.key]).toBe('CLEANED');
    expect(by[pass.partner.key]).toBe('CLEANED');
    expect(by[fail.so.key]).toBe('RETAINED');
    expect(orm.find('sale.order', fail.so.id)!.state).toBe('sale');
    expect(orm.find('sale.order', pass.so.id)!.state).toBe('cancel');
  });

  test('dry-run không thay đổi gì; môi trường khác không bao giờ bị dọn; chu trình phụ thuộc và loại chưa hỗ trợ bị chặn', async () => {
    const orm = new FakeOrm();
    const h = await build(orm, salesPlan({ amount: 100 }));
    const snap = orm.snapshot();
    const regBefore = fs.readFileSync(process.env.QA_REGISTRY_FILE!, 'utf8');
    const callsBefore = orm.calls.length;
    const dry = await clean(orm, { dryRun: true });
    expect(dry.counts).toMatchObject({ WOULD_CLEAN: 4, CLEANED: 0 });
    expect(orm.snapshot()).toBe(snap);
    expect(fs.readFileSync(process.env.QA_REGISTRY_FILE!, 'utf8')).toBe(regBefore);
    expect(orm.calls.slice(callsBefore).every((c) => ['search_read', 'search_count'].includes(c.method))).toBe(true);
    expect((await clean(orm, { environment: 'ENV_B' })).outcomes).toHaveLength(0); // đang dọn môi trường khác: không đụng bản ghi của ENV_A
    expect(orm.find('sale.order', h.so.id)!.state).toBe('sale');

    const cyc: TestDataRecord[] = ['a', 'b'].map((x, i) => ({
      runId: RUN, testCaseId: 'TC-F-001', application: 'odoo', model: 'res.partner', recordId: 800 + i, reference: 'AUTOTEST', createdAt: new Date().toISOString(), cleanupStatus: 'PENDING', origin: 'AUTOMATION',
      environment: 'ENV_A', owner: 'FRAMEWORK', dependsOn: [`res.partner:${800 + (1 - i)}`],
    }));
    const c = await clean(new FakeOrm(), { records: cyc, setStatus: () => undefined });
    expect(c.outcomes.map((o) => o.status)).toEqual(['CLEANUP_BLOCKED', 'CLEANUP_BLOCKED']);
    expect(c.outcomes[0].reason).toMatch(/chu trình/);
    const odd: TestDataRecord = { ...cyc[0], model: 'khac.model', recordId: 1, dependsOn: [] };
    const u = await clean(new FakeOrm(), { records: [odd], setStatus: () => undefined });
    expect(u.outcomes[0]).toMatchObject({ status: 'CLEANUP_BLOCKED' });
    expect(u.outcomes[0].reason).toMatch(/CHƯA HỖ TRỢ/);
  });

  test('QA Report + Bug Report + evidence phải có TRƯỚC cleanup: thiếu/cũ thì chặn; qa:finish xong mới qua; cleanup không đổi báo cáo', () => {
    const reports = path.join(tmp, 'reports', 'ENV_A');
    expect(evidenceProblems(reports, RUN).join()).toMatch(/chưa có kết quả của lần chạy/);
    const results = path.join(reports, 'runs', RUN, 'results.json');
    fs.mkdirSync(path.dirname(results), { recursive: true });
    fs.writeFileSync(results, JSON.stringify({ runId: RUN, entries: [{ tcId: 'TC-F-001', status: 'FAIL' }, { tcId: 'TC-F-002', status: 'PASS' }] }));
    expect(evidenceProblems(reports, RUN).join()).toMatch(/thiếu qa-report\.html.*thiếu bugs\.json/);
    expect([...failedTestCases(reports, RUN)]).toEqual(['TC-F-001']);
    const old = new Date(Date.now() - 60_000);
    for (const f of ['qa-report.html', 'qa-results.json', 'qa-summary.md', 'bugs.json']) {
      fs.writeFileSync(path.join(reports, f), 'x');
      fs.utimesSync(path.join(reports, f), old, old);
    }
    expect(evidenceProblems(reports, RUN).join()).toMatch(/qa-report\.html cũ hơn kết quả/);
    const now = new Date();
    for (const f of ['qa-report.html', 'qa-results.json', 'qa-summary.md', 'bugs.json']) fs.utimesSync(path.join(reports, f), now, now);
    expect(evidenceProblems(reports, RUN)).toEqual([]);
    const cr = fs.readFileSync(path.join('scripts', 'cleanup-run.ts'), 'utf8');
    expect(cr).toContain('evidenceProblems(');
    expect(cr.indexOf('evidenceProblems(')).toBeLessThan(cr.indexOf('runCleanup('));
    const rt = fs.readFileSync(path.join('scripts', 'run-tests.ts'), 'utf8');
    expect(rt.indexOf('qa-finish.ts')).toBeLessThan(rt.indexOf('cleanup-run.ts')); // báo cáo dựng xong rồi mới cleanup
  });

  test('qa:policy + cleanup:run CLI: từ chối khi chưa xác nhận chính sách, khi thiếu báo cáo, và trên môi trường nghi production (trước khi kết nối)', () => {
    const w = makeApprovedWorkspace();
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    const f = fakeEnv({ ENV_A: { url: 'https://a.example.com', version: '18.0', roles: { accountant: acct } }, PROD_X: { url: 'https://erp.example.com', version: '18.0', roles: { accountant: acct } } });
    usePolicyConfig(w.ws, f);
    const env = { ...w.env, ...f.vars, APP: 'odoo' } as NodeJS.ProcessEnv;
    delete env.QA_ENVIRONMENTS_DIR;
    delete env.QA_ENV;
    delete env.QA_REGISTRY_FILE;
    const reg = (envKey: string) => {
      const file = path.join(w.ws, 'testdata', 'registry', `${envKey}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const rec = { event: 'created', runId: RUN, testCaseId: 'TC-E-001', application: 'odoo', model: 'res.partner', recordId: 5, reference: 'AUTOTEST', createdAt: new Date().toISOString(), cleanupStatus: 'PENDING', origin: 'AUTOMATION', environment: envKey, owner: 'FRAMEWORK', requirementId: wsReq.id };
      fs.writeFileSync(file, JSON.stringify(rec) + '\n');
    };
    reg('ENV_A');
    reg('PROD_X');
    const run = (...args: string[]) => spawnSync(process.execPath, [tsx, script('cleanup-run.ts'), ...args], { cwd: w.ws, env, encoding: 'utf8' });
    expect(run(`--run=${RUN}`).status).toBe(3); // chưa chọn môi trường
    selectEnvironment(w.ws, 'odoo', 'ENV_A');
    Object.assign(process.env, f.vars);
    let r = run(`--run=${RUN}`);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/CLEANUP GATE: Chính sách ghi của ENV_A chưa được xác nhận/);
    const a = resolved('ENV_A');
    confirmPolicy(w.ws, { env: a, requirementId: wsReq.id, approvalHash: w.hash, by: 'N', typed: policyPhrase(a, effectivePolicy(a)) });
    r = run(`--run=${RUN}`);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/chưa đủ báo cáo\/evidence cho lần chạy .*chưa có kết quả/);
    expect(run().stderr).toMatch(/chỉ định --run/);
    selectEnvironment(w.ws, 'odoo', 'PROD_X');
    r = run(`--run=${RUN}`);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/PROD_X bị coi là production.*không cleanup tự động/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('POL-4 Bí mật và địa chỉ staging không lộ trong mã nguồn, báo cáo chia sẻ, ZIP, GitHub', () => {
  test('cấu hình môi trường/chính sách không chứa URL, email, mật khẩu; .gitignore chặn .env, .auth, .qa-state, reports, share', () => {
    const raw = fs.readFileSync('environments/odoo.json', 'utf8');
    expect(raw).not.toMatch(/https?:|@|password/i);
    const lines = fs.readFileSync('.gitignore', 'utf8').split(/\r?\n/).map((l) => l.trim());
    for (const need of ['.env', '.env.*', '!.env.example', '.auth/', '.qa-state/', 'reports/', 'share/', '*.zip']) expect(lines, need).toContain(need);
    const example = fs.readFileSync('.env.example', 'utf8');
    expect(example).not.toMatch(/staging\.vinfast|\.vn\b/);
  });

  test('trạng thái chính sách, nhật ký và báo cáo cleanup không chứa mật khẩu/URL/tài khoản; không vào gói chia sẻ', () => {
    const w = makeApprovedWorkspace();
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    const e = envOf();
    confirmPolicy(w.ws, { env: e, requirementId: wsReq.id, approvalHash: w.hash, by: 'Chị Thanh', typed: policyPhrase(e, effectivePolicy(e)) });
    const text = fs.readFileSync(policyFile(w.ws), 'utf8');
    for (const secret of [acct.pass, acct.user, 'https://', 'password']) expect(text).not.toContain(secret);
    const no = (p: string) => expect(shareDecision(p, { withReport: true }).include, `${p} không được vào ZIP`).toBe(false);
    ['.qa-state/policy.json', '.qa-state/environment.json', '.auth/ENV_A/odoo-accountant.json', 'reports/ENV_A/cleanup/cleanup-x.json', 'reports/ENV_A/cleanup/cleanup-x.md',
      'reports/ENV_A/readiness/REQ-1.json', 'reports/ENV_A/runs/r1/artifacts/a/video.webm', '.env', '.env.staging'].forEach(no);
    expect(shareDecision('environments/odoo.json').include).toBe(true);
    expect(shareDecision('reports/ENV_A/qa-report.html', { withReport: true }).include).toBe(true);
    expect(shareDecision('reports/ENV_A/runs/r1/results.json', { withReport: true }).include).toBe(true);
  });

  test('địa chỉ staging trong .env được coi là bí mật khi đóng gói: collectSecrets(urls) + redactHosts che trước khi chia sẻ; quét ZIP bắt rò rỉ', () => {
    fs.writeFileSync(path.join(tmp, '.env'), ['ODOO_STAGING_A_URL=https://staging-a.example.org', 'ODOO_STAGING_A_ACCOUNTANT_USER=ke.toan@example.org', 'ODOO_STAGING_A_ACCOUNTANT_PASS=Mk#fake-777'].join('\n'));
    const plain = collectSecrets(tmp).secrets;
    expect(plain.some((s) => s.kind === 'url')).toBe(false); // quét thường không coi URL là bí mật (tránh báo nhầm báo cáo nội bộ)
    const withUrls = collectSecrets(tmp, { urls: true }).secrets;
    expect(withUrls.filter((s) => s.kind === 'url').map((s) => s.value).sort()).toEqual(['https://staging-a.example.org', 'staging-a.example.org']);
    const report = JSON.stringify({ baseURL: 'https://staging-a.example.org', note: 'Máy chủ: staging-a.example.org · ENV_A' });
    const file = path.join(tmp, 'report.json');
    fs.writeFileSync(file, report);
    expect(scanTextFile(file, withUrls).length).toBeGreaterThan(0); // chưa che: bị bắt
    const safe = redactHosts(report, withUrls);
    expect(safe).not.toContain('staging-a.example.org');
    expect(safe).toContain('[ENV-URL]');
    expect(safe).toContain('ENV_A');
    fs.writeFileSync(file, safe);
    expect(scanTextFile(file, withUrls)).toEqual([]);
    const share = fs.readFileSync(path.join('scripts', 'package-share.ts'), 'utf8');
    expect(share).toContain('redactHosts(');
    expect(share).toContain('urls: true');
  });

  test('báo cáo/registry do factory sinh không chứa địa chỉ staging hay thông tin đăng nhập', async () => {
    const orm = new FakeOrm();
    const f = new DataFactory({ rpc: orm, recipes: odooRecipes, scope: { application: 'odoo', environment: 'ENV_A', runId: getRunId(), requirementId: 'REQ-F-001', testCaseId: 'TC-F-001' }, writeProblems: () => [], maxRecordsPerRun: 50 });
    await f.build(salesPlan({ amount: 1 }));
    const reg = fs.readFileSync(process.env.QA_REGISTRY_FILE!, 'utf8');
    expect(reg).not.toMatch(/https?:\/\/|example\.com|password|cookie|token/i);
    const summary = await runCleanup({ client: orm as unknown as OdooClient, handlers: odooFactoryCleanupHandlers, records: loadRegistry(), environment: 'ENV_A', policy: effectivePolicy(envOf()), runId: getRunId() });
    const md = fs.readFileSync(writeCleanupReport(path.join(tmp, 'rep'), { environment: 'ENV_A', runId: getRunId(), dryRun: false }, summary), 'utf8');
    expect(md).not.toMatch(/https?:\/\/|example\.com/i);
  });
});
