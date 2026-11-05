import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Browser } from '@playwright/test';
import { odooConfig } from '../../applications/odoo/config';
import { evaluate } from '../../core/approval/approval';
import { aggregate } from '../../core/reporters/aggregate';
import { writeAggregate } from '../../core/reporters/qa-reporter';
import type { RunFile } from '../../core/reporters/types';
import { defHash } from '../../core/testcases/hash';
import { loadTestCases } from '../../core/testcases/loader';
import { installNavigationGuard } from '../../core/environment/active';
import {
  ambiguousTargets, listEnvironmentKeys, resolveAll, resolveEnvironment, validateEnvironmentsFile, type EnvironmentsFile,
} from '../../core/environment/config';
import { activeEnvKey, authFileFor, fixturesDirFor, registryPathFor, reportsDirFor } from '../../core/environment/paths';
import { establishSession, readMeta, sessionProblem, verificationProblems } from '../../core/environment/session';
import {
  clearSelection, confirmExecution, confirmPhrase, confirmationProblem, hostsInInput, readState, revokeConfirmation, selectEnvironment, stateFile, urlProblem,
} from '../../core/environment/state';
import { FixtureError, loadFixtures } from '../../core/testdata/fixtures';
import { loadRegistry, registerRecord } from '../../core/testdata/registry';
import { grantProblems, readGrant } from '../../core/testdata/write-guard';
import { installFakeEnvironments, type FakeEnvSpec } from './helpers/fake-env';
import { startMockOdoo, type MockServer } from './helpers/mock-odoo';
import { makeApprovedWorkspace, wsReq } from './helpers/workspace';

// Framework tests cho nhiều môi trường (ENV-*). CHỈ dùng môi trường GIẢ LẬP: máy chủ giả trên 127.0.0.1, example.com, thư mục tạm.
// KHÔNG kết nối staging thật, không ghi dữ liệu nghiệp vụ, không đụng reports/, .auth/, testdata/ thật.

const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const scripts = (n: string) => path.join(process.cwd(), 'scripts', n);
const acct = { user: 'ke.toan@example.com', pass: 'Mk#fake-A-111' };

let tmp: string;
const cleanups: (() => void)[] = [];
const OVERRIDES = ['QA_ENV', 'QA_APPROVAL_KEY_FILE', 'QA_AUTH_DIR', 'QA_REPORTS_DIR', 'QA_REGISTRY_FILE', 'QA_FIXTURES_DIR', 'QA_WRITE_GRANT'] as const;
const savedEnv = Object.fromEntries(OVERRIDES.map((k) => [k, process.env[k]]));
let currentFake: { restore(): void } | undefined;

test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-env-'));
  process.env.QA_APPROVAL_KEY_FILE = path.join(tmp, 'test.key');
  process.env.QA_AUTH_DIR = path.join(tmp, '.auth');
  // Các biến ghi đè của lần chạy hiện tại không được làm lệch kết quả test đường dẫn.
  for (const k of ['QA_ENV', 'QA_REPORTS_DIR', 'QA_REGISTRY_FILE', 'QA_FIXTURES_DIR', 'QA_WRITE_GRANT']) delete process.env[k];
});
test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  currentFake = undefined;
  for (const k of OVERRIDES) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fakeEnv = (specs: Record<string, FakeEnvSpec>) => {
  currentFake?.restore(); // mỗi lần gọi thay thế hoàn toàn môi trường giả trước đó (không để biến cũ còn sót)
  const f = installFakeEnvironments(tmp, specs);
  currentFake = f;
  cleanups.push(f.restore);
  return f;
};
const two = (): Record<string, FakeEnvSpec> => ({
  ENV_A: { url: 'https://a.example.com', version: '18.0', roles: { accountant: acct } },
  ENV_B: { url: 'https://b.example.com', version: '18.0', roles: { accountant: { user: 'ke.toan.b@example.com', pass: 'Mk#fake-B-222' } } },
});
const mustResolve = (key: string, source?: NodeJS.ProcessEnv) => {
  const r = resolveEnvironment('odoo', key, source);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.env;
};

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENV-1 Cấu hình nhiều môi trường, chỉ tham chiếu tên biến', () => {
  const file = (over: Partial<EnvironmentsFile['environments'][string]> = {}, key = 'STAGING_A'): EnvironmentsFile => ({
    application: 'odoo',
    environments: { [key]: { label: 'L', kind: 'staging', urlVar: 'A_URL', expectedVersionVar: 'A_VER', roles: { accountant: { userVar: 'A_USER', passVar: 'A_PASS' } }, ...over } },
  });

  test('environments/odoo.json thật hợp lệ, có STAGING_A/STAGING_B/UAT, và KHÔNG chứa URL/mật khẩu/email', () => {
    const real = JSON.parse(fs.readFileSync('environments/odoo.json', 'utf8')) as EnvironmentsFile;
    expect(validateEnvironmentsFile(real, Object.keys(odooConfig.roles))).toEqual([]);
    expect(Object.keys(real.environments)).toEqual(expect.arrayContaining(['STAGING_A', 'STAGING_B', 'UAT']));
    const raw = fs.readFileSync('environments/odoo.json', 'utf8');
    expect(raw).not.toMatch(/https?:\/\/|@/);
    for (const e of Object.values(real.environments)) expect(Object.keys(e.roles).sort()).toEqual(['accountant', 'noaccess']);
  });

  test('từ chối giá trị viết thẳng thay vì tên biến (URL, mật khẩu, email)', () => {
    const p = validateEnvironmentsFile(file({ urlVar: 'https://staging.example.com', roles: { accountant: { userVar: 'ke.toan@example.com', passVar: 'Matkhau123!' } } }));
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.join('|')).toMatch(/urlVar.*không phải tên biến/);
    expect(p.join('|')).not.toContain('Matkhau123!'); // không in lại giá trị
  });

  test('từ chối biến dùng chung giữa hai môi trường, tên môi trường sai, thiếu phiên bản kỳ vọng, vai trò lạ', () => {
    const shared: EnvironmentsFile = { application: 'odoo', environments: { ...file().environments, STAGING_B: file().environments.STAGING_A } };
    expect(validateEnvironmentsFile(shared).join('|')).toMatch(/A_URL bị dùng chung bởi STAGING_A và STAGING_B/);
    expect(validateEnvironmentsFile(file({}, 'staging-a')).join('|')).toMatch(/phải viết HOA/);
    expect(validateEnvironmentsFile(file({ expectedVersionVar: undefined as unknown as string })).join('|')).toMatch(/expectedVersionVar/);
    expect(validateEnvironmentsFile(file(), ['noaccess']).join('|')).toMatch(/vai trò "accountant" không có trong cấu hình ứng dụng/);
  });

  test('resolveEnvironment: đọc đúng giá trị từ .env, báo THIẾU theo tên biến (không lộ giá trị), kiểm tra URL', () => {
    const f = fakeEnv({ ...two(), ENV_C: { url: 'https://c.example.com', roles: { accountant: { user: 'c@example.com' } } } });
    const a = mustResolve('ENV_A');
    expect(a).toMatchObject({ key: 'ENV_A', host: 'a.example.com', origin: 'https://a.example.com', expectedVersion: '18.0', kind: 'staging' });
    expect(a.roles.accountant).toMatchObject({ user: acct.user, missing: [] });
    const c = mustResolve('ENV_C');
    expect(c.expectedVersion).toBeUndefined();
    expect(c.roles.accountant.missing).toEqual([f.config.environments.ENV_C.roles.accountant.passVar]); // chỉ tên biến

    const bad = (url: string, key = 'ENV_A') => {
      const r = resolveEnvironment('odoo', key, { ...process.env, FAKE_ENV_A_URL: url });
      return r.ok ? [] : r.problems;
    };
    expect(bad('')).toEqual([expect.stringContaining('thiếu biến FAKE_ENV_A_URL')]);
    expect(bad('khong-phai-url').join()).toMatch(/không phải URL/);
    expect(bad('http://staging.example.com').join()).toMatch(/phải là https/);
    expect(bad('https://u:p@a.example.com').join()).toMatch(/không được chứa tài khoản/);
    expect(bad('https://a.example.com/?db=x').join()).toMatch(/query/);
    expect(resolveEnvironment('odoo', 'KHONG_CO').ok).toBe(false);
    expect(resolveEnvironment('khongcoapp', 'ENV_A').ok).toBe(false);
  });

  test('hai môi trường trỏ cùng một đích bị báo; khác database thì hợp lệ', () => {
    fakeEnv({ ENV_A: { url: 'https://same.example.com', version: '18.0', roles: { accountant: acct } }, ENV_B: { url: 'https://same.example.com', version: '18.0', roles: { accountant: acct } } });
    const all = resolveAll('odoo');
    expect(all.ambiguous.join()).toMatch(/ENV_A và ENV_B cùng trỏ tới https:\/\/same\.example\.com/);
    const withDb = fakeEnv({ ENV_A: { url: 'https://same.example.com', db: 'a', version: '18.0', roles: { accountant: acct } }, ENV_B: { url: 'https://same.example.com', db: 'b', version: '18.0', roles: { accountant: acct } } });
    expect(withDb.config.environments.ENV_A.dbVar).toBeDefined();
    expect(resolveAll('odoo').ambiguous).toEqual([]);
    expect(listEnvironmentKeys('odoo')).toEqual(['ENV_A', 'ENV_B']);
    expect(ambiguousTargets([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENV-2 Chọn môi trường và xác nhận thực thi RIÊNG từng môi trường (phê duyệt dùng chung)', () => {
  /** Requirement đã APPROVE trong thư mục tạm (dùng chung cho mọi môi trường). */
  const approved = () => {
    const w = makeApprovedWorkspace();
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    return w;
  };
  const confirm = (root: string, key: string, hash: string, typed?: string) => {
    const env = mustResolve(key);
    return confirmExecution(root, { env, requirementId: wsReq.id, approvalHash: hash, by: 'Người xác nhận', typed: typed ?? confirmPhrase(env) });
  };

  test('select: lưu môi trường đang chọn, từ chối môi trường không hợp lệ, báo khi đổi môi trường', () => {
    fakeEnv({ ...two(), ENV_BAD: { roles: { accountant: acct } } });
    expect(readState(tmp).selected).toBeUndefined();
    const first = selectEnvironment(tmp, 'odoo', 'ENV_A');
    expect(first).toMatchObject({ changed: false, previous: undefined });
    expect(readState(tmp).selected).toMatchObject({ environment: 'ENV_A', application: 'odoo' });
    expect(selectEnvironment(tmp, 'odoo', 'ENV_B')).toMatchObject({ changed: true, previous: 'ENV_A' });
    expect(() => selectEnvironment(tmp, 'odoo', 'ENV_BAD')).toThrow(/thiếu biến FAKE_ENV_BAD_URL/);
    expect(() => selectEnvironment(tmp, 'odoo', 'KHONG_CO')).toThrow(/không có trong environments/);
    expect(readState(tmp).selected?.environment).toBe('ENV_B'); // lựa chọn lỗi không làm đổi trạng thái
    clearSelection(tmp);
    expect(readState(tmp).selected).toBeUndefined();
  });

  test('xác nhận chỉ ghi khi gõ đúng cụm EXECUTE <ENV> <host>; sai cụm bị từ chối', () => {
    fakeEnv(two());
    const w = approved();
    expect(() => confirm(w.ws, 'ENV_A', w.hash, 'EXECUTE ENV_A khac.example.com')).toThrow(/không khớp/);
    expect(() => confirm(w.ws, 'ENV_A', w.hash, 'EXECUTE ENV_B a.example.com')).toThrow(/không khớp/);
    expect(() => confirm(w.ws, 'ENV_A', w.hash, '')).toThrow(/không khớp/);
    expect(Object.keys(readState(w.ws).confirmations)).toEqual([]);
    expect(confirmPhrase(mustResolve('ENV_A'))).toBe('EXECUTE ENV_A a.example.com');
    expect(confirm(w.ws, 'ENV_A', w.hash)).toMatchObject({ environment: 'ENV_A', host: 'a.example.com', requirementId: wsReq.id });
  });

  test('cùng một phê duyệt: xác nhận của ENV_A KHÔNG dùng cho ENV_B; mỗi môi trường xác nhận riêng và thu hồi riêng', () => {
    fakeEnv(two());
    const w = approved();
    const a = mustResolve('ENV_A');
    const b = mustResolve('ENV_B');
    expect(confirmationProblem(w.ws, a, wsReq.id, w.hash)).toMatch(/chưa được xác nhận thực thi/);
    confirm(w.ws, 'ENV_A', w.hash);
    expect(confirmationProblem(w.ws, a, wsReq.id, w.hash)).toBeUndefined();
    expect(confirmationProblem(w.ws, b, wsReq.id, w.hash)).toMatch(/ENV_B chưa được xác nhận thực thi/);
    confirm(w.ws, 'ENV_B', w.hash);
    expect(confirmationProblem(w.ws, b, wsReq.id, w.hash)).toBeUndefined(); // cùng hash phê duyệt, không duyệt lại test case
    revokeConfirmation(w.ws, 'ENV_A');
    expect(confirmationProblem(w.ws, a, wsReq.id, w.hash)).toMatch(/chưa được xác nhận/);
    expect(confirmationProblem(w.ws, b, wsReq.id, w.hash)).toBeUndefined();
    // Xác nhận riêng theo requirement.
    expect(confirmationProblem(w.ws, b, 'REQ-KHAC-001', w.hash)).toMatch(/chưa được xác nhận/);
  });

  test('xác nhận mất hiệu lực khi: phê duyệt đổi, host trong .env đổi, file bị sửa tay, thiếu khoá, quá 24 giờ', () => {
    fakeEnv(two());
    const w = approved();
    const a = mustResolve('ENV_A');
    confirm(w.ws, 'ENV_A', w.hash);
    expect(confirmationProblem(w.ws, a, wsReq.id, 'hash-moi')).toMatch(/Phê duyệt của REQ-E-001 đã đổi/);
    const moved = mustResolve('ENV_A', { ...process.env, FAKE_ENV_A_URL: 'https://a2.example.com' });
    expect(confirmationProblem(w.ws, moved, wsReq.id, w.hash)).toMatch(/cho host "a\.example\.com" nhưng \.env hiện trỏ tới "a2\.example\.com"/);
    expect(confirmationProblem(w.ws, a, wsReq.id, w.hash, Date.now() + 25 * 3600 * 1000)).toMatch(/quá 24 giờ/);

    const state = JSON.parse(fs.readFileSync(stateFile(w.ws), 'utf8'));
    const key = `ENV_A|${wsReq.id}`;
    const original = JSON.stringify(state);
    state.confirmations[key].by = 'Người khác'; // sửa tay
    fs.writeFileSync(stateFile(w.ws), JSON.stringify(state));
    expect(confirmationProblem(w.ws, a, wsReq.id, w.hash)).toMatch(/không xác minh được chữ ký/);
    // Sao chép xác nhận của ENV_A thành của ENV_B cũng không qua được.
    const forged = JSON.parse(original);
    forged.confirmations[`ENV_B|${wsReq.id}`] = { ...forged.confirmations[key], environment: 'ENV_B' };
    fs.writeFileSync(stateFile(w.ws), JSON.stringify(forged));
    expect(confirmationProblem(w.ws, mustResolve('ENV_B'), wsReq.id, w.hash)).toMatch(/chữ ký|host/);

    fs.writeFileSync(stateFile(w.ws), original);
    expect(confirmationProblem(w.ws, a, wsReq.id, w.hash)).toBeUndefined();
    fs.rmSync(process.env.QA_APPROVAL_KEY_FILE!);
    expect(confirmationProblem(w.ws, a, wsReq.id, w.hash)).toMatch(/chữ ký/);
  });

  test('phê duyệt thật của framework không bị ảnh hưởng bởi môi trường (một bản phê duyệt, nhiều môi trường)', () => {
    const w = approved();
    const ev = evaluate(w.ws, w.req, w.defs);
    expect(ev.ok).toBe(true);
    expect(ev.record?.approval?.hash).toBe(w.hash);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENV-3 Chặn URL khác môi trường đã chọn', () => {
  test('hostsInInput/urlProblem: bắt URL trong tham số, kể cả trong đoạn mã; cho phép đúng host', () => {
    const env = { key: 'ENV_A', host: 'a.example.com' };
    expect(hostsInInput({ url: 'https://a.example.com/odoo?x=1' })).toEqual(['a.example.com']);
    expect(urlProblem({ url: 'https://a.example.com/odoo' }, env)).toBeUndefined();
    expect(urlProblem({ element: 'nút Lưu', ref: 'e12' }, env)).toBeUndefined();
    expect(urlProblem({ url: 'https://b.example.com/odoo' }, env)).toMatch(/b\.example\.com.*khác môi trường đã chọn ENV_A.*Không tự chuyển/);
    expect(urlProblem({ code: "await page.goto('https://b.example.com/x'); fetch('https://a.example.com')" }, env)).toMatch(/b\.example\.com/);
    expect(urlProblem({ url: 'https://a.example.com.evil.example.org/' }, env)).toMatch(/evil/); // không khớp theo tiền tố
    expect(urlProblem('chuỗi http://a.example.com:8443/x', env)).toMatch(/a\.example\.com:8443/); // khác cổng = khác môi trường
  });

  test('Playwright config: không có QA_ENV thì không có project nào chạm staging dù đã qua Approval Gate; có QA_ENV thì có', () => {
    const run = (extra: NodeJS.ProcessEnv) => spawnSync(process.execPath, [path.join('node_modules', '@playwright', 'test', 'cli.js'), 'test', '--list', '--project=odoo-sales', '--reporter=list'], {
      env: { ...process.env, QA_APPROVAL_GATE: 'passed', QA_REPORTS_DIR: path.join(tmp, 'rep'), QA_ENV: '', ...extra }, encoding: 'utf8',
    });
    const without = run({});
    expect(without.status).not.toBe(0);
    expect(`${without.stdout}${without.stderr}`).toMatch(/odoo-sales/); // báo "project not found"
    expect(`${without.stdout}`).not.toMatch(/collect-payment/);
    // Có QA_ENV nhưng thiếu phạm vi lần chạy (QA_GATE_SCOPE) vẫn không có project nào: không thể qua cổng chỉ bằng cách tự đặt biến.
    const noScope = run({ QA_ENV: 'STAGING_A' });
    expect(noScope.status).not.toBe(0);
    expect(noScope.stdout).not.toMatch(/collect-payment/);
    // Trường hợp phạm vi hợp lệ + môi trường => có project: kiểm ở requirement-scope.spec.ts (cần phê duyệt thật, ký bằng khóa thật).
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENV-4 Tách riêng kết quả, evidence, Run ID, Bug, sổ dữ liệu, fixture theo môi trường', () => {
  test('đường dẫn của hai môi trường không bao giờ trùng nhau', () => {
    const paths = (k: string) => [authFileFor(k, 'odoo', 'accountant'), reportsDirFor(k), registryPathFor(k), fixturesDirFor(k)];
    const [a, b] = [paths('ENV_A'), paths('ENV_B')];
    a.forEach((p, i) => expect(p).not.toBe(b[i]));
    expect(authFileFor('ENV_A', 'odoo', 'accountant')).not.toBe(authFileFor('ENV_A', 'odoo', 'noaccess'));
    expect(authFileFor('ENV_A', 'odoo', 'accountant')).toContain(`${path.sep}ENV_A${path.sep}`);
    expect(reportsDirFor('ENV_A')).toBe(path.resolve('reports', 'ENV_A'));
    expect(registryPathFor('ENV_A')).toBe(path.resolve('testdata', 'registry', 'ENV_A.jsonl'));
    process.env.QA_ENV = 'ENV_B';
    expect(activeEnvKey()).toBe('ENV_B');
    expect(reportsDirFor()).toBe(path.resolve('reports', 'ENV_B'));
  });

  test('cùng Run ID ở hai môi trường: kết quả, evidence và Bug ID nằm riêng, không đè nhau; trộn hai môi trường trong một thư mục bị từ chối', () => {
    const def = loadTestCases().find((d) => d.automated) ?? loadTestCases()[0];
    test.skip(!def, 'máy mới chưa có test case nghiệp vụ (bộ cài đặt dùng chung không kèm); phần tách môi trường đã được kiểm ở các test khác');
    const runId = '20261104-100000';
    const mk = (environment: string, status: 'PASS' | 'FAIL'): RunFile => ({
      runId, startedAt: '2026-11-04T10:00:00.000Z', finishedAt: '2026-11-04T10:01:00.000Z', baseURL: `https://${environment.toLowerCase()}.example.com`, environment, writesEnabled: false,
      entries: [{ tcId: def.id, defHash: defHash(def), status, actual: `kết quả ${environment}`, durationMs: 1, evidence: { screenshots: [], video: `artifacts/${environment}/video.webm` }, ...(status === 'FAIL' ? { error: { message: 'expect(locator).toBeVisible() failed', failedStep: 'bước' } } : {}) }],
    });
    const put = (dir: string, run: RunFile) => {
      fs.mkdirSync(path.join(dir, 'runs', run.runId), { recursive: true });
      fs.writeFileSync(path.join(dir, 'runs', run.runId, 'results.json'), JSON.stringify(run));
    };
    const dirA = path.join(tmp, 'reports', 'ENV_A');
    const dirB = path.join(tmp, 'reports', 'ENV_B');
    put(dirA, mk('ENV_A', 'FAIL'));
    put(dirB, mk('ENV_B', 'FAIL'));
    const ra = writeAggregate(dirA);
    const rb = writeAggregate(dirB);
    expect(ra.bugs.map((b) => b.bugId)).toEqual([`BUG-ENV_A-${runId}-${def.id}`]);
    expect(rb.bugs.map((b) => b.bugId)).toEqual([`BUG-ENV_B-${runId}-${def.id}`]);
    expect(ra.bugs[0].environment).toMatchObject({ key: 'ENV_A' });
    expect(ra.bugs[0].evidence.video).toContain('ENV_A');
    expect(JSON.parse(fs.readFileSync(path.join(dirA, 'qa-results.json'), 'utf8')).environment).toBe('ENV_A');
    expect(JSON.parse(fs.readFileSync(path.join(dirB, 'qa-results.json'), 'utf8')).environment).toBe('ENV_B');
    expect(fs.readFileSync(path.join(dirA, 'qa-summary.md'), 'utf8')).toMatch(/Môi trường: \*\*ENV_A\*\*/);
    expect(fs.readFileSync(path.join(dirA, 'qa-summary.md'), 'utf8')).not.toContain('ENV_B');
    expect(fs.readFileSync(path.join(dirA, 'bugs.json'), 'utf8')).not.toContain('ENV_B');
    // Kết quả ENV_B PASS không "cứu" lỗi của ENV_A: mỗi môi trường tính riêng.
    put(dirB, { ...mk('ENV_B', 'PASS'), runId: '20261104-100500' });
    expect(writeAggregate(dirB).summary.passed).toBe(1);
    expect(writeAggregate(dirA).summary).toMatchObject({ passed: 0, failed: 1 });
    // Trộn hai môi trường vào cùng thư mục: từ chối thay vì cộng gộp.
    put(dirA, { ...mk('ENV_B', 'PASS'), runId: '20261104-110000' });
    expect(() => writeAggregate(dirA)).toThrow(/nhiều môi trường \(ENV_A, ENV_B\)/);
    // Kết quả cũ không gắn môi trường vẫn đọc được như trước.
    const legacy = path.join(tmp, 'legacy');
    const { environment: _e, ...old } = mk('ENV_A', 'FAIL');
    put(legacy, old as RunFile);
    expect(aggregate(loadTestCases(), [old as RunFile]).summary.failed).toBe(1);
    expect(writeAggregate(legacy).bugs[0].bugId).toBe(`BUG-${runId}-${def.id}`);
  });

  test('sổ dữ liệu test: cùng model + ID ở hai môi trường là hai bản ghi khác nhau, mỗi môi trường một file', () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      delete process.env.QA_REGISTRY_FILE;
      const reg = (env: string, ref: string) => {
        process.env.QA_ENV = env;
        registerRecord({ testCaseId: 'TC-X-1', application: 'odoo', model: 'sale.order', recordId: 7, reference: ref, runId: '20261104-100000' });
      };
      reg('ENV_A', 'AUTOTEST 20261104-100000 A');
      reg('ENV_B', 'AUTOTEST 20261104-100000 B');
      expect(fs.existsSync(path.join(tmp, 'testdata', 'registry', 'ENV_A.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'testdata', 'registry', 'ENV_B.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'testdata', 'registry.jsonl'))).toBe(false); // sổ cũ không bị đụng tới
      process.env.QA_ENV = 'ENV_A';
      expect(loadRegistry().map((r) => r.reference)).toEqual(['AUTOTEST 20261104-100000 A']);
      process.env.QA_ENV = 'ENV_B';
      expect(loadRegistry().map((r) => r.reference)).toEqual(['AUTOTEST 20261104-100000 B']);
    } finally {
      process.chdir(cwd);
    }
  });

  test('fixture ghim: ưu tiên file riêng của môi trường; file cũ chỉ dùng khi đúng host và đúng environmentKey', () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      delete process.env.QA_FIXTURES_DIR;
      const fx = path.join(tmp, 'testdata', 'fixtures');
      fs.mkdirSync(path.join(fx, 'ENV_A'), { recursive: true });
      fs.writeFileSync(path.join(fx, 'ENV_A', 'odoo-sales.json'), JSON.stringify({ environment: 'a.example.com', id: 'riêng của A' }));
      process.env.QA_ENV = 'ENV_A';
      expect(loadFixtures('odoo-sales', 'https://a.example.com').id).toBe('riêng của A');
      process.env.QA_ENV = 'ENV_B';
      expect(() => loadFixtures('odoo-sales', 'https://b.example.com')).toThrow(FixtureError); // B chưa có fixture, không mượn của A
      fs.writeFileSync(path.join(fx, 'odoo-sales.json'), JSON.stringify({ environment: 'a.example.com', id: 'cũ' }));
      expect(() => loadFixtures('odoo-sales', 'https://b.example.com')).toThrow(/khai báo cho môi trường "a\.example\.com" nhưng đang chạy trên "b\.example\.com"/);
      fs.writeFileSync(path.join(fx, 'odoo-sales.json'), JSON.stringify({ environment: 'b.example.com', environmentKey: 'ENV_A', id: 'cũ' }));
      expect(() => loadFixtures('odoo-sales', 'https://b.example.com')).toThrow(/khai báo cho môi trường ENV_A nhưng đang chạy trên ENV_B/);
      fs.writeFileSync(path.join(fx, 'odoo-sales.json'), JSON.stringify({ environment: 'b.example.com', environmentKey: 'ENV_B', id: 'cũ-B' }));
      expect(loadFixtures('odoo-sales', 'https://b.example.com').id).toBe('cũ-B');
    } finally {
      process.chdir(cwd);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENV-5 Quyền ghi xác nhận riêng cho từng môi trường', () => {
  const ctx = { allowWrite: true, host: 'a.example.com', environment: 'ENV_A', module: 'odoo-sales', runId: '20261104-100000' };
  const grant = { host: 'a.example.com', environment: 'ENV_A', module: 'odoo-sales', runId: '20261104-100000' };

  test('giấy phép ghi của ENV_A không dùng được cho ENV_B, kể cả khi trùng host', () => {
    expect(grantProblems({ ...ctx, grant })).toEqual([]);
    expect(grantProblems({ ...ctx, environment: 'ENV_B', grant }).join()).toMatch(/giấy phép cho môi trường "ENV_A", đang chạy trên môi trường "ENV_B"/);
    expect(grantProblems({ ...ctx, grant: { ...grant, environment: undefined } }).join()).toMatch(/không ghi rõ/); // giấy phép cũ không có môi trường bị từ chối khi có môi trường
    expect(grantProblems({ ...ctx, environment: undefined, grant: { ...grant, environment: undefined } })).toEqual([]); // tương thích ngược
  });

  test('readGrant giữ khoá môi trường; runner từ chối ghi trên production và đưa môi trường vào giấy phép', () => {
    expect(readGrant(JSON.stringify(grant))).toEqual(grant);
    const runner = fs.readFileSync(path.join('scripts', 'run-tests.ts'), 'utf8');
    expect(runner).toContain('productionReason(target)'); // production (kể cả khai báo sai) bị từ chối ghi: xem data-policy.spec.ts
    expect(runner).toContain('environment: target.key');
    expect(runner).toContain('QA_ENV: target.key');
    expect(runner).toContain('ENVIRONMENT GATE');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENV-6 Xác minh tài khoản, phân quyền, phiên bản và tách phiên (máy chủ Odoo giả lập)', () => {
  const servers: MockServer[] = [];
  test.afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  const server = async (o: Parameters<typeof startMockOdoo>[0]) => {
    const s = await startMockOdoo(o);
    servers.push(s);
    return s;
  };

  /** Đăng nhập một vai trò của một môi trường trong context RIÊNG (trình duyệt/cookie không chia sẻ). */
  async function login(browser: Browser, envKey: string, role: string) {
    const env = mustResolve(envKey);
    const ctx = await browser.newContext({ baseURL: env.baseUrl });
    const page = await ctx.newPage();
    page.setDefaultTimeout(4000);
    try {
      return await establishSession({ page, app: odooConfig, env, role });
    } finally {
      await ctx.close();
    }
  }

  test('phiên tách riêng theo môi trường và vai trò: file riêng, cookie riêng, máy chủ này không bao giờ nhận cookie của môi trường kia', async ({ browser }) => {
    const a = await server({ version: '18.0+e', users: [{ login: 'a.ketoan@example.com', password: 'pw-a1' }, { login: 'a.khong@example.com', password: 'pw-a2' }] });
    const b = await server({ version: '18.0', users: [{ login: 'b.ketoan@example.com', password: 'pw-b1' }] });
    fakeEnv({
      ENV_A: { url: a.url, version: '18.0', roles: { accountant: { user: 'a.ketoan@example.com', pass: 'pw-a1' }, noaccess: { user: 'a.khong@example.com', pass: 'pw-a2' } } },
      ENV_B: { url: b.url, version: '18.0', roles: { accountant: { user: 'b.ketoan@example.com', pass: 'pw-b1' } } },
    });
    const results = {
      aAcc: await login(browser, 'ENV_A', 'accountant'),
      aNo: await login(browser, 'ENV_A', 'noaccess'),
      bAcc: await login(browser, 'ENV_B', 'accountant'),
    };
    for (const [k, m] of Object.entries(results)) expect(m.ok, `${k}: ${m.problems.join('; ')}`).toBe(true);
    expect(results.aAcc).toMatchObject({ environment: 'ENV_A', role: 'accountant', actualUser: 'a.ketoan@example.com', privileged: false, version: { expected: '18.0', actual: '18.0+e' } });
    expect(results.bAcc).toMatchObject({ environment: 'ENV_B', actualUser: 'b.ketoan@example.com' });

    const files = [authFileFor('ENV_A', 'odoo', 'accountant'), authFileFor('ENV_A', 'odoo', 'noaccess'), authFileFor('ENV_B', 'odoo', 'accountant')];
    for (const f of files) expect(fs.existsSync(f), f).toBe(true);
    const sid = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')).cookies.find((c: { name: string }) => c.name === 'session_id').value as string;
    const [sa, sn, sb] = files.map(sid);
    expect(new Set([sa, sn, sb]).size).toBe(3);
    expect(sa).toContain('aketoan');
    expect(sb).toContain('bketoan');
    // Cookie của B không có trong phiên của A và ngược lại; máy chủ A chưa từng thấy cookie của B.
    expect(fs.readFileSync(files[0], 'utf8')).not.toContain(sb);
    expect(fs.readFileSync(files[2], 'utf8')).not.toContain(sa);
    expect(a.hits.map((h) => h.cookie).filter(Boolean).some((c) => c === sb)).toBe(false);
    expect(b.hits.map((h) => h.cookie).filter(Boolean).some((c) => c === sa || c === sn)).toBe(false);
    // Meta không chứa mật khẩu/cookie.
    const metaText = fs.readFileSync(path.join(path.dirname(files[0]), 'odoo-accountant.meta.json'), 'utf8');
    expect(metaText).not.toContain('pw-a1');
    expect(metaText).not.toContain(sa);
    for (const key of ['ENV_A', 'ENV_B']) expect(sessionProblem(mustResolve(key), 'odoo', 'accountant')).toBeUndefined();
    expect(readMeta('ENV_A', 'odoo', 'accountant')?.ok).toBe(true);
  });

  test('đăng nhập lỗi KHÔNG tự chuyển sang môi trường khác: máy chủ ENV_B không nhận request nào', async ({ browser }) => {
    const crossPw = `pw-${randomBytes(9).toString('hex')}`; // sinh lúc chạy, không để chuỗi giống mật khẩu trong mã nguồn
    const a = await server({ version: '18.0', users: [{ login: 'a@example.com', password: 'dung' }] });
    const b = await server({ version: '18.0', users: [{ login: 'a@example.com', password: crossPw }] });
    fakeEnv({
      ENV_A: { url: a.url, version: '18.0', roles: { accountant: { user: 'a@example.com', pass: crossPw } } }, // mật khẩu hợp lệ ở B, sai ở A
      ENV_B: { url: b.url, version: '18.0', roles: { accountant: { user: 'a@example.com', pass: crossPw } } },
    });
    const m = await login(browser, 'ENV_A', 'accountant');
    expect(m.ok).toBe(false);
    expect(m.problems.join()).toMatch(/đăng nhập thất bại trên ENV_A\/accountant/);
    expect(m.problems.join()).toMatch(/Không tự chuyển sang môi trường hoặc tài khoản khác/);
    expect(m.problems.join()).not.toContain(crossPw); // không lộ mật khẩu trong lý do
    expect(b.hits).toHaveLength(0);
    expect(a.hits.length).toBeGreaterThan(0);
    expect(fs.existsSync(authFileFor('ENV_A', 'odoo', 'accountant'))).toBe(false); // không lưu phiên
    expect(fs.existsSync(authFileFor('ENV_B', 'odoo', 'accountant'))).toBe(false);
    expect(sessionProblem(mustResolve('ENV_A'), 'odoo', 'accountant')).toMatch(/chưa đạt xác minh.*đăng nhập thất bại/);
  });

  test('thiếu tài khoản của vai trò: không mở kết nối nào, ghi rõ tên biến còn thiếu', async ({ browser }) => {
    const a = await server({ version: '18.0', users: [] });
    fakeEnv({ ENV_A: { url: a.url, version: '18.0', roles: { accountant: { user: 'a@example.com' } } } });
    const m = await login(browser, 'ENV_A', 'accountant');
    expect(m.ok).toBe(false);
    expect(m.problems.join()).toMatch(/thiếu biến môi trường: FAKE_ENV_A_ACCOUNTANT_PASS/);
    expect(a.hits).toHaveLength(0);
  });

  test('phiên bản ứng dụng thực tế khác kỳ vọng, hoặc chưa khai báo kỳ vọng: không đạt và không lưu phiên', async ({ browser }) => {
    const old = await server({ version: '17.0', users: [{ login: 'a@example.com', password: 'p' }] });
    fakeEnv({ ENV_A: { url: old.url, version: '18.0', roles: { accountant: { user: 'a@example.com', pass: 'p' } } } });
    const m = await login(browser, 'ENV_A', 'accountant');
    expect(m.ok).toBe(false);
    expect(m.problems.join()).toMatch(/phiên bản ứng dụng 17\.0 không khớp phiên bản kỳ vọng 18\.0 của ENV_A/);
    expect(fs.existsSync(authFileFor('ENV_A', 'odoo', 'accountant'))).toBe(false);
    expect(readMeta('ENV_A', 'odoo', 'accountant')).toMatchObject({ ok: false, version: { expected: '18.0', actual: '17.0' } });

    const cur = await server({ version: '18.0', users: [{ login: 'a@example.com', password: 'p' }] });
    fakeEnv({ ENV_A: { url: cur.url, roles: { accountant: { user: 'a@example.com', pass: 'p' } } } }); // không khai báo phiên bản kỳ vọng
    const m2 = await login(browser, 'ENV_A', 'accountant');
    expect(m2.ok).toBe(false);
    expect(m2.problems.join()).toMatch(/chưa cấu hình phiên bản ứng dụng kỳ vọng/);

    const silent = await server({ users: [{ login: 'a@example.com', password: 'p' }] }); // máy chủ không báo phiên bản
    fakeEnv({ ENV_A: { url: silent.url, version: '18.0', roles: { accountant: { user: 'a@example.com', pass: 'p' } } } });
    expect((await login(browser, 'ENV_A', 'accountant')).problems.join()).toMatch(/không đọc được phiên bản/);
  });

  test('phân quyền: vai trò "noaccess" mà tài khoản là quản trị bị từ chối; tài khoản đăng nhập thực tế khác cấu hình bị từ chối', async ({ browser }) => {
    const s = await server({ version: '18.0', users: [{ login: 'admin@example.com', password: 'p', admin: true }, { login: 'u@example.com', password: 'p' }] });
    fakeEnv({ ENV_A: { url: s.url, version: '18.0', roles: { accountant: { user: 'admin@example.com', pass: 'p' }, noaccess: { user: 'admin@example.com', pass: 'p' } } } });
    const admin = await login(browser, 'ENV_A', 'noaccess');
    expect(admin.ok).toBe(false);
    expect(admin.problems.join()).toMatch(/phải là tài khoản KHÔNG có quyền quản trị/);
    expect(admin.privileged).toBe(true);
    expect((await login(browser, 'ENV_A', 'accountant')).ok).toBe(true); // vai trò accountant không bị buộc phải không-admin (báo cáo vẫn ghi nhận privileged)

    const mapped = await server({ version: '18.0', reportLoginAs: 'nguoi.khac@example.com', users: [{ login: 'u@example.com', password: 'p' }] });
    fakeEnv({ ENV_A: { url: mapped.url, version: '18.0', roles: { accountant: { user: 'u@example.com', pass: 'p' } } } });
    expect((await login(browser, 'ENV_A', 'accountant')).problems.join()).toMatch(/tài khoản đăng nhập thực tế khác tài khoản cấu hình/);
  });

  test('URL thực tế sau đăng nhập khác môi trường (redirect sang host khác): không đạt và không lưu phiên', async ({ browser }) => {
    const other = await server({ version: '18.0', users: [] });
    const a = await server({ version: '18.0', users: [{ login: 'a@example.com', password: 'p' }], redirectAfterLogin: `${other.url}/odoo/home` });
    fakeEnv({ ENV_A: { url: a.url, version: '18.0', roles: { accountant: { user: 'a@example.com', pass: 'p' } } } });
    const m = await login(browser, 'ENV_A', 'accountant');
    expect(m.ok).toBe(false);
    expect(m.problems.join()).toMatch(/URL thực tế sau đăng nhập \(127\.0\.0\.1:\d+\) khác môi trường ENV_A/);
    expect(fs.existsSync(authFileFor('ENV_A', 'odoo', 'accountant'))).toBe(false);
  });

  test('sessionProblem: phiên đã xác minh cho host cũ không dùng được khi .env đổi host; meta hỏng/không đạt bị chặn', async ({ browser }) => {
    const a = await server({ version: '18.0', users: [{ login: 'a@example.com', password: 'p' }] });
    const f = fakeEnv({ ENV_A: { url: a.url, version: '18.0', roles: { accountant: { user: 'a@example.com', pass: 'p' } } } });
    expect((await login(browser, 'ENV_A', 'accountant')).ok).toBe(true);
    expect(sessionProblem(mustResolve('ENV_A'), 'odoo', 'accountant')).toBeUndefined();
    const moved = mustResolve('ENV_A', { ...process.env, [f.config.environments.ENV_A.urlVar]: 'https://khac.example.com' });
    expect(sessionProblem(moved, 'odoo', 'accountant')).toMatch(/xác minh cho host ".*" nhưng môi trường hiện trỏ tới "khac\.example\.com"/);
    expect(sessionProblem(mustResolve('ENV_A'), 'odoo', 'noaccess')).toMatch(/Chưa có phiên đăng nhập đã xác minh cho ENV_A\/noaccess/);
  });

  test('verificationProblems (thuần hàm): "không biết" không bao giờ được coi là đạt', () => {
    fakeEnv(two());
    const env = mustResolve('ENV_A');
    const base = { env, role: 'accountant', configuredUser: acct.user };
    expect(verificationProblems({ ...base, facts: { finalUrl: 'https://a.example.com/odoo', info: { privileged: false, detail: 'd', login: acct.user.toUpperCase() }, version: '18.0.3', cookieDomains: ['a.example.com', '.example.com'] } })).toEqual([]);
    expect(verificationProblems({ ...base, facts: { info: { privileged: false, detail: 'd' }, version: '18.0' } }).join()).toMatch(/không cho biết tài khoản đang đăng nhập/);
    expect(verificationProblems({ ...base, facts: { version: '18.0' } }).join()).toMatch(/không xác định được tài khoản và quyền/);
    expect(verificationProblems({ ...base, mustBeUnprivileged: true, facts: { info: { privileged: true, detail: 'is_admin=true', login: acct.user }, version: '18.0' } }).join()).toMatch(/KHÔNG có quyền quản trị/);
    expect(verificationProblems({ ...base, facts: { info: { privileged: false, detail: 'd', login: acct.user }, version: '18.0', cookieDomains: ['b.example.com'] } }).join()).toMatch(/cookie của host khác/);
  });

  test('chặn điều hướng trang chính sang host khác môi trường; host đúng vẫn truy cập được', async ({ browser }) => {
    const a = await server({ users: [] });
    const b = await server({ users: [] });
    fakeEnv({ ENV_A: { url: a.url, version: '18.0', roles: { accountant: acct } } });
    const ctx = await browser.newContext();
    const guard = await installNavigationGuard(ctx, mustResolve('ENV_A'));
    const page = await ctx.newPage();
    await page.goto(`${a.url}/web/login`);
    expect(guard.violations).toEqual([]);
    await expect(page.goto(`${b.url}/web/login`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
    expect(guard.violations).toHaveLength(1);
    expect(guard.violations[0]).toContain(new URL(b.url).host);
    expect(b.hits).toHaveLength(0); // yêu cầu bị huỷ trước khi tới máy chủ khác
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENV-7 Cổng chạy bằng code: hook Playwright MCP, runner và CLI qa:env', () => {
  const hook = (ws: string, env: NodeJS.ProcessEnv, tool: string, toolInput: unknown = {}) =>
    spawnSync(process.execPath, [tsx, scripts('approval.ts'), 'hook'], { cwd: ws, env, input: JSON.stringify({ tool_name: tool, tool_input: toolInput }), encoding: 'utf8' });
  const cli = (script: string, ws: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync(process.execPath, [tsx, scripts(script), ...args], { cwd: ws, env: { ...env, APP: 'odoo' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  function workspace() {
    const w = makeApprovedWorkspace();
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    const f = fakeEnv(two());
    // environments/odoo.json phải nằm trong thư mục làm việc để tiến trình con (cwd = ws) đọc được.
    fs.mkdirSync(path.join(w.ws, 'environments'), { recursive: true });
    fs.writeFileSync(path.join(w.ws, 'environments', 'odoo.json'), JSON.stringify(f.config));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    const env = { ...w.env, ...f.vars, QA_ENVIRONMENTS_DIR: '' } as NodeJS.ProcessEnv;
    delete env.QA_ENVIRONMENTS_DIR;
    return { ...w, env };
  }
  const confirm = (root: string, key: string, hash: string) => {
    const e = mustResolve(key);
    confirmExecution(root, { env: e, requirementId: wsReq.id, approvalHash: hash, by: 'N', typed: confirmPhrase(e) });
  };

  test('hook: đã duyệt + có phiên thực thi nhưng CHƯA chọn/xác nhận môi trường vẫn bị chặn; xác nhận riêng từng môi trường', () => {
    const w = workspace();
    const nav = (url: string) => hook(w.ws, w.env, 'mcp__playwright__browser_navigate', { url });
    let r = nav('https://a.example.com/odoo');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ENVIRONMENT GATE: chặn mcp__playwright__browser_navigate\. Chưa chọn môi trường/);

    selectEnvironment(w.ws, 'odoo', 'ENV_A');
    r = nav('https://a.example.com/odoo');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ENV_A chưa được xác nhận thực thi/);

    confirm(w.ws, 'ENV_A', w.hash);
    expect(nav('https://a.example.com/odoo').status).toBe(0);
    expect(hook(w.ws, w.env, 'mcp__playwright__browser_snapshot').status).toBe(0);
    expect(hook(w.ws, w.env, 'Read').status).toBe(0);

    // Chuyển sang ENV_B: phê duyệt dùng chung nhưng chưa xác nhận ENV_B nên vẫn bị chặn; URL của ENV_A không còn hợp lệ.
    selectEnvironment(w.ws, 'odoo', 'ENV_B');
    r = nav('https://b.example.com/odoo');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ENV_B chưa được xác nhận thực thi/);
    confirm(w.ws, 'ENV_B', w.hash);
    expect(nav('https://b.example.com/odoo').status).toBe(0);
    r = nav('https://a.example.com/odoo');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/a\.example\.com\) khác môi trường đã chọn ENV_B \(b\.example\.com\)\. Không tự chuyển môi trường/);
  });

  test('hook: chặn URL khác môi trường trong mọi công cụ (navigate, mã tự do), cho qua công cụ không có URL', () => {
    const w = workspace();
    selectEnvironment(w.ws, 'odoo', 'ENV_A');
    confirm(w.ws, 'ENV_A', w.hash);
    const run = (tool: string, input: unknown) => hook(w.ws, w.env, tool, input);
    expect(run('mcp__playwright__browser_navigate', { url: 'https://b.example.com/odoo' }).status).toBe(2);
    expect(run('mcp__playwright__browser_navigate', { url: 'https://production.example.org' }).status).toBe(2);
    expect(run('mcp__playwright__browser_run_code_unsafe', { code: "async (page) => { await page.goto('https://b.example.com'); }" }).status).toBe(2);
    expect(run('mcp__playwright__browser_evaluate', { function: "() => fetch('https://x.example.net/api')" }).status).toBe(2);
    expect(run('mcp__playwright__browser_click', { element: 'Đăng nhập', ref: 'e5' }).status).toBe(0);
    expect(run('mcp__playwright__browser_run_code_unsafe', { code: "async (page) => { await page.goto('https://a.example.com/odoo'); }" }).status).toBe(0);
  });

  test('hook: xác nhận mất hiệu lực khi test case bị sửa (phê duyệt đổi) hoặc phiên thực thi đóng', () => {
    const w = workspace();
    selectEnvironment(w.ws, 'odoo', 'ENV_A');
    confirm(w.ws, 'ENV_A', w.hash);
    expect(hook(w.ws, w.env, 'mcp__playwright__browser_snapshot').status).toBe(0);
    fs.rmSync(path.join(w.ws, '.qa-state', 'execution.json'));
    const r = hook(w.ws, w.env, 'mcp__playwright__browser_snapshot');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/APPROVAL GATE/);
  });

  test('qa:env: list/check không lộ mật khẩu, check báo cấu hình sai; confirm bắt buộc bàn phím thật; select đặt môi trường', () => {
    const w = workspace();
    const list = cli('environment.ts', w.ws, w.env, 'list');
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/ENV_A.*a\.example\.com/);
    expect(list.stdout).toMatch(/ENV_B.*b\.example\.com/);
    expect(`${list.stdout}${list.stderr}`).not.toMatch(/Mk#fake/);
    expect(`${list.stdout}${list.stderr}`).not.toContain(acct.user);
    const check = cli('environment.ts', w.ws, w.env, 'check');
    expect(check.status, check.stdout + check.stderr).toBe(0);

    const nonTty = cli('environment.ts', w.ws, w.env, 'confirm', '--env=ENV_A', `--requirement=${wsReq.id}`, '--by=Tester');
    expect(nonTty.status).toBe(2);
    expect(nonTty.stderr).toMatch(/NGƯỜI DÙNG/);
    expect(Object.keys(readState(w.ws).confirmations)).toEqual([]);

    const sel = cli('environment.ts', w.ws, w.env, 'select', '--env=ENV_B');
    expect(sel.status, sel.stderr).toBe(0);
    expect(sel.stdout).toMatch(/Đã CHỌN môi trường ENV_B/);
    expect(sel.stdout).toMatch(/Chưa kết nối gì và chưa được phép thực thi/);
    expect(readState(w.ws).selected?.environment).toBe('ENV_B');
    expect(cli('environment.ts', w.ws, w.env, 'select', '--env=KHONG_CO').status).toBe(1);

    // Cấu hình sai (hai môi trường dùng chung biến) -> check thất bại.
    const broken = JSON.parse(fs.readFileSync(path.join(w.ws, 'environments', 'odoo.json'), 'utf8')) as EnvironmentsFile;
    broken.environments.ENV_B.urlVar = broken.environments.ENV_A.urlVar;
    fs.writeFileSync(path.join(w.ws, 'environments', 'odoo.json'), JSON.stringify(broken));
    const bad = cli('environment.ts', w.ws, w.env, 'check');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/bị dùng chung bởi ENV_A và ENV_B/);
  });

  test('runner (npm test): từ chối khi chưa chọn môi trường, khi môi trường chưa xác nhận, và khi --env khác môi trường đang chọn (không tự chuyển)', () => {
    const w = workspace();
    const run = (...args: string[]) => cli('run-tests.ts', w.ws, w.env, '--project=odoo-sales', ...args);
    let r = run();
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/ENVIRONMENT GATE: chưa chọn môi trường/);
    selectEnvironment(w.ws, 'odoo', 'ENV_B');
    r = run();
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/TỪ CHỐI chạy trên ENV_B.*chưa được xác nhận thực thi/s);
    r = run('--env=ENV_A');
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/yêu cầu --env=ENV_A nhưng môi trường đang chọn là ENV_B\. Không tự chuyển/);
    // Xác nhận ENV_A không "chảy" sang ENV_B.
    confirm(w.ws, 'ENV_A', w.hash);
    r = run();
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/ENV_B/);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Chế độ CHỈ ĐỌC/); // chưa tới bước chạy test
    // Ghi dữ liệu cũng không bỏ qua cổng môi trường.
    const w2 = spawnSync(process.execPath, [tsx, scripts('run-tests.ts'), '--write', '--module=odoo-sales', '--confirm-host=b.example.com'], { cwd: w.ws, env: { ...w.env, APP: 'odoo' }, encoding: 'utf8' });
    expect(w2.status).toBe(3);
    expect(w2.stderr).toMatch(/ENVIRONMENT GATE/);
  });
});
