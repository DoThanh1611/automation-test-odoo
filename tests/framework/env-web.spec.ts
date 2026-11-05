import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { resolveEnvironment } from '../../core/environment/config';
import { startEnvServer, type EnvServer } from '../../core/environment/server';
import { confirmationProblem, readState, selectEnvironment } from '../../core/environment/state';
import { buildEnvCards, processEnvDecision, renderEnvPage, sessionStatus, stateJson, type EnvHumanConfirm, type EnvHumanConfirmInfo, type EnvWebContext } from '../../core/environment/web';
import { policyCheck } from '../../core/policy/policy';
import type { Requirement, TestCaseDef } from '../../core/testcases/schema';
import { installFakeEnvironments, type FakeEnvSpec } from './helpers/fake-env';
import { makeWorkspace, wsReq } from './helpers/workspace';

// Framework tests cho giao diện Web chọn môi trường + xác nhận chính sách ghi (ENVW-*). Dữ liệu giả, thư mục tạm, 127.0.0.1.
// KHÔNG kết nối staging. Hộp thoại hệ điều hành luôn được thay bằng EnvHumanConfirm giả (CLI thật không cho phép tiêm).

const SECRETS = ['Mk#fake-A-111', 'ke.toan@example.com', 'Mk#fake-B-222', 'token-bi-mat-123'];
const OVERRIDES = ['QA_ENV', 'QA_APPROVAL_KEY_FILE', 'QA_ENVIRONMENTS_DIR', 'QA_PRODUCTION_HOSTS', 'AUTO_CLEANUP', 'FAKE_ENV_A_URL'] as const;
const saved = Object.fromEntries(OVERRIDES.map((k) => [k, process.env[k]]));
const cleanups: (() => void)[] = [];

test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const k of OVERRIDES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const A: FakeEnvSpec = { url: 'https://a.example.com', version: '18.0', roles: { accountant: { user: 'ke.toan@example.com', pass: 'Mk#fake-A-111' }, noaccess: { user: 'khong.quyen@example.com', pass: 'token-bi-mat-123' } } };
const B: FakeEnvSpec = { url: 'https://b.example.com', version: '18.0', roles: { accountant: { user: 'b.ketoan@example.com', pass: 'Mk#fake-B-222' } } };
const PROD: FakeEnvSpec = { url: 'https://erp.example.com', version: '18.0', kind: 'production', roles: { accountant: { user: 'p@example.com', pass: 'Mk#fake-P' } } };
const READONLY: FakeEnvSpec = { url: 'https://uat.example.com', version: '18.0', kind: 'uat', roles: { accountant: { user: 'u@example.com', pass: 'Mk#fake-U' } } };
const NOURL: FakeEnvSpec = { version: '18.0', roles: { accountant: { user: 'n@example.com' } } };

/** Thư mục làm việc tạm đã APPROVE + môi trường giả (ENV_A, ENV_B có chính sách ghi; PROD là production; UAT_RO không khai báo ghi; ENV_X thiếu URL). */
function setup(extra: Record<string, FakeEnvSpec> = {}) {
  const w = makeWorkspace('approved');
  cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
  process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
  const f = installFakeEnvironments(w.ws, { ENV_A: A, ENV_B: B, PROD, UAT_RO: READONLY, ENV_X: NOURL, ...extra });
  cleanups.push(f.restore);
  const cfg = structuredClone(f.config);
  for (const k of ['ENV_A', 'ENV_B', 'PROD']) cfg.environments[k].policy = { write: 'framework-data', autoCleanup: true };
  fs.writeFileSync(path.join(f.envDir, 'odoo.json'), JSON.stringify(cfg));
  const ctx = (over: Partial<EnvWebContext> = {}): EnvWebContext => ({
    root: w.ws,
    app: 'odoo',
    requirement: JSON.parse(fs.readFileSync(path.join(w.ws, 'requirements', 'odoo-sales', `${wsReq.id}.json`), 'utf8')) as Requirement,
    defs: w.defs as TestCaseDef[],
    roleDescription: (r) => (r === 'accountant' ? 'Kế toán' : r === 'noaccess' ? 'Không có quyền' : undefined),
    ...over,
  });
  return { ...w, f, ctx };
}
const recorder = (answer = true) => {
  const seen: EnvHumanConfirmInfo[] = [];
  const confirm: EnvHumanConfirm = async (i) => {
    seen.push(i);
    return answer;
  };
  return { seen, confirm };
};
const auditOf = (ws: string) => {
  const f = path.join(ws, 'approvals', wsReq.id, 'web-audit.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};
const resolved = (key: string) => {
  const r = resolveEnvironment('odoo', key);
  if (!r.ok) throw new Error(r.problems.join('; '));
  return r.env;
};
const confirmedBoth = async (s: ReturnType<typeof setup>, env = 'ENV_A') => {
  const ok = recorder();
  await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: env, by: 'Người dùng' }, ok.confirm);
  await processEnvDecision(s.ctx(), { action: 'CONFIRM_POLICY', environment: env, by: 'Người dùng' }, ok.confirm);
};

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENVW-1 Danh sách môi trường: đủ thông tin, không lộ bí mật', () => {
  test('mỗi môi trường hiện tên, loại, ứng dụng, host, vai trò; môi trường mới thêm vào environments/ tự xuất hiện', () => {
    const s = setup({ ENV_NEW: { url: 'https://new.example.com', version: '18.0', roles: { accountant: { user: 'x@example.com', pass: 'y' } } } });
    const cards = buildEnvCards(s.ctx());
    expect(cards.map((c) => c.key)).toEqual(['ENV_A', 'ENV_B', 'PROD', 'UAT_RO', 'ENV_X', 'ENV_NEW']);
    const a = cards.find((c) => c.key === 'ENV_A')!;
    expect(a).toMatchObject({ kind: 'staging', application: 'odoo', host: 'a.example.com', usable: true, selected: false });
    expect(a.roles).toEqual([{ role: 'accountant', description: 'Kế toán', configured: true, missingVars: [] }, { role: 'noaccess', description: 'Không có quyền', configured: true, missingVars: [] }]);
    expect(cards.find((c) => c.key === 'PROD')).toMatchObject({ kind: 'production', write: { eligible: false } });
    expect(cards.find((c) => c.key === 'UAT_RO')!.write.eligible).toBe(false);
    expect(cards.find((c) => c.key === 'ENV_A')!.write.eligible).toBe(true);
  });

  test('môi trường thiếu cấu hình: không chọn được, chỉ nêu TÊN biến còn thiếu; vai trò thiếu mật khẩu báo chưa cấu hình', () => {
    const s = setup();
    const x = buildEnvCards(s.ctx()).find((c) => c.key === 'ENV_X')!;
    expect(x.usable).toBe(false);
    expect(x.problems.join(' ')).toMatch(/FAKE_ENV_X_URL/);
    expect(x.roles[0].configured).toBe(false);
    expect(x.write.eligible).toBe(false);
    const html = renderEnvPage({ nonce: 'n', ctx: s.ctx() });
    expect(html).toMatch(/data-env="ENV_X"[\s\S]*?type="radio"[^>]*disabled/);
  });

  test('trang HTML và JSON trạng thái KHÔNG chứa mật khẩu, tên đăng nhập, token hay giá trị biến .env', () => {
    const s = setup();
    const html = renderEnvPage({ nonce: 'abc', ctx: s.ctx() });
    const state = JSON.stringify(stateJson(s.ctx()));
    for (const secret of SECRETS) {
      expect(html, secret).not.toContain(secret);
      expect(state, secret).not.toContain(secret);
    }
    for (const needle of ['Xác nhận môi trường', 'Xác nhận chính sách ghi dữ liệu', 'a.example.com', 'ENV_A', 'accountant']) expect(html).toContain(needle);
    expect(html.match(/id="confirm-env"/g)).toHaveLength(1);
    expect(html.match(/id="confirm-policy"/g)).toHaveLength(1);
  });

  test('chưa APPROVE: các nút bị khóa và trang báo lý do', () => {
    const w = makeWorkspace('pending');
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    const f = installFakeEnvironments(w.ws, { ENV_A: A });
    cleanups.push(f.restore);
    const ctx: EnvWebContext = { root: w.ws, app: 'odoo', requirement: wsReq, defs: w.defs as TestCaseDef[] };
    const html = renderEnvPage({ nonce: 'n', ctx });
    expect(html).toMatch(/Chưa thể xác nhận môi trường[\s\S]*PENDING_APPROVAL/);
    expect(html).toMatch(/id="confirm-env"[^>]*disabled/);
    expect(html).toMatch(/type="radio"[^>]*disabled/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENVW-2 Backend: dùng lại đúng cơ chế terminal, hai xác nhận độc lập', () => {
  test('CONFIRM_ENV: người dùng đồng ý ⇒ chọn + xác nhận có chữ ký (cùng hàm với terminal); KHÔNG tạo chính sách ghi', async () => {
    const s = setup();
    const r = recorder();
    const res = await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_A', by: ' Thanh ' }, r.confirm);
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(r.seen).toEqual([expect.objectContaining({ kind: 'ENV', environment: 'ENV_A', host: 'a.example.com', envKind: 'staging', by: 'Thanh', roles: ['accountant', 'noaccess'] })]);
    const st = readState(s.ws);
    expect(st.selected).toMatchObject({ environment: 'ENV_A', application: 'odoo' });
    const conf = st.confirmations[`ENV_A|${wsReq.id}`];
    expect(conf).toMatchObject({ by: 'Thanh', host: 'a.example.com', approvalHash: s.hash });
    expect(conf.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(confirmationProblem(s.ws, resolved('ENV_A'), wsReq.id, s.hash)).toBeUndefined();
    expect(policyCheck(s.ws, resolved('ENV_A'), wsReq.id, s.hash).ok).toBe(false); // xác nhận môi trường KHÔNG suy ra quyền ghi
    expect(auditOf(s.ws).at(-1)).toMatchObject({ channel: 'web-env', action: 'CONFIRM_ENV', outcome: 'ENV_CONFIRMED', environment: 'ENV_A', by: 'Thanh' });
  });

  test('người dùng không bấm Yes (từ chối / hết thời gian / không hỗ trợ): không chọn, không xác nhận, ghi nhật ký REFUSED', async () => {
    const s = setup();
    const r = recorder(false);
    const res = await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh' }, r.confirm);
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(res.message).toMatch(/hộp thoại hệ điều hành/);
    expect(readState(s.ws)).toEqual({ confirmations: {}, selected: undefined });
    expect(auditOf(s.ws).at(-1)).toMatchObject({ outcome: 'REFUSED', environment: 'ENV_A' });
  });

  test('từ chối: hành động lạ, môi trường không có, môi trường thiếu cấu hình, thiếu tên; không gọi hộp thoại và không ghi gì', async () => {
    const s = setup();
    const r = recorder();
    const go = (req: object) => processEnvDecision(s.ctx(), req, r.confirm);
    expect(await go({ action: 'APPROVE', environment: 'ENV_A', by: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(await go({ action: 'CONFIRM_ENV', environment: 'ENV_KHONG_CO', by: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(await go({ action: 'CONFIRM_ENV', environment: 'ENV_X', by: 'x' })).toMatchObject({ ok: false, status: 422 });
    expect(await go({ action: 'CONFIRM_ENV', environment: 'ENV_A', by: '  ' })).toMatchObject({ ok: false, status: 400 });
    expect(await go({ action: 'CONFIRM_ENV', by: 'x' })).toMatchObject({ ok: false });
    expect(r.seen).toHaveLength(0);
    expect(readState(s.ws).selected).toBeUndefined();
    expect(auditOf(s.ws).filter((e) => e.outcome === 'REFUSED')).toHaveLength(5);
  });

  test('chưa APPROVE hoặc test case đổi sau khi duyệt: không xác nhận được', async () => {
    const s = setup();
    const ctx = s.ctx();
    const changed = { ...ctx, defs: ctx.defs.map((d, i) => (i === 0 ? { ...d, expectedResult: 'đã sửa sau khi duyệt' } : d)) };
    const r = recorder();
    const res = await processEnvDecision(changed, { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'x' }, r.confirm);
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(res.message).toMatch(/chưa có phê duyệt hợp lệ/);
    expect(r.seen).toHaveLength(0);
  });

  test('CONFIRM_POLICY: nút riêng, hộp thoại riêng; cần môi trường đã chọn; ghi đúng chính sách (cùng hàm với terminal), hiệu lực 8 giờ', async () => {
    const s = setup();
    const r = recorder();
    const early = await processEnvDecision(s.ctx(), { action: 'CONFIRM_POLICY', environment: 'ENV_A', by: 'Thanh' }, r.confirm);
    expect(early).toMatchObject({ ok: false, status: 409 });
    expect(r.seen).toHaveLength(0);
    await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh' }, r.confirm);
    const res = await processEnvDecision(s.ctx(), { action: 'CONFIRM_POLICY', environment: 'ENV_A', by: 'Thanh' }, r.confirm);
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(r.seen.map((i) => i.kind)).toEqual(['ENV', 'POLICY']); // hai hộp thoại riêng
    expect(r.seen[1].policyLines.join(' ')).toMatch(/DO FRAMEWORK TẠO/);
    const chk = policyCheck(s.ws, resolved('ENV_A'), wsReq.id, s.hash);
    expect(chk.ok).toBe(true);
    expect(Date.parse(chk.confirmation!.expiresAt) - Date.parse(chk.confirmation!.at)).toBe(8 * 3600 * 1000);
    expect(auditOf(s.ws).map((e) => e.outcome)).toEqual(['REFUSED', 'ENV_CONFIRMED', 'POLICY_CONFIRMED']); // lần thử sớm bị từ chối cũng được ghi
  });

  test('hai xác nhận độc lập: xác nhận chính sách không xác nhận môi trường; từ chối hộp thoại chính sách giữ nguyên xác nhận môi trường', async () => {
    const s = setup();
    selectEnvironment(s.ws, 'odoo', 'ENV_A'); // chỉ CHỌN, chưa xác nhận thực thi
    const yes = recorder();
    expect(await processEnvDecision(s.ctx(), { action: 'CONFIRM_POLICY', environment: 'ENV_A', by: 'Thanh' }, yes.confirm)).toMatchObject({ ok: true });
    expect(policyCheck(s.ws, resolved('ENV_A'), wsReq.id, s.hash).ok).toBe(true);
    expect(confirmationProblem(s.ws, resolved('ENV_A'), wsReq.id, s.hash)).toMatch(/chưa được xác nhận thực thi/); // vẫn chưa được thực thi
    const s2 = setup();
    await processEnvDecision(s2.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh' }, recorder().confirm);
    const no = recorder(false);
    expect(await processEnvDecision(s2.ctx(), { action: 'CONFIRM_POLICY', environment: 'ENV_A', by: 'Thanh' }, no.confirm)).toMatchObject({ ok: false, status: 403 });
    expect(confirmationProblem(s2.ws, resolved('ENV_A'), wsReq.id, s2.hash)).toBeUndefined();
    expect(policyCheck(s2.ws, resolved('ENV_A'), wsReq.id, s2.hash).ok).toBe(false);
  });

  test('chỉ môi trường có chính sách phù hợp mới ghi được: production, môi trường chỉ đọc, môi trường khác với môi trường đang chọn đều bị từ chối', async () => {
    const s = setup();
    const r = recorder();
    for (const key of ['PROD', 'UAT_RO']) {
      await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: key, by: 'Thanh' }, r.confirm); // chọn + xác nhận thực thi (chỉ đọc) vẫn được
      const res = await processEnvDecision(s.ctx(), { action: 'CONFIRM_POLICY', environment: key, by: 'Thanh' }, r.confirm);
      expect(res, key).toMatchObject({ ok: false, status: 403 });
      expect(policyCheck(s.ws, resolved(key), wsReq.id, s.hash).ok, key).toBe(false);
    }
    expect(r.seen.filter((i) => i.kind === 'POLICY')).toHaveLength(0); // không hiện hộp thoại ghi cho môi trường không được ghi
    await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh' }, r.confirm);
    const other = await processEnvDecision(s.ctx(), { action: 'CONFIRM_POLICY', environment: 'ENV_B', by: 'Thanh' }, r.confirm);
    expect(other).toMatchObject({ ok: false, status: 409 });
    expect(policyCheck(s.ws, resolved('ENV_B'), wsReq.id, s.hash).ok).toBe(false);
  });

  test('production được khai báo ghi nhầm vẫn bị chặn (host/tên có dấu hiệu production)', async () => {
    const s = setup({ ENV_LIVE: { url: 'https://live.example.com', version: '18.0', kind: 'staging', roles: { accountant: { user: 'l@example.com', pass: 'x' } } } });
    const cfg = JSON.parse(fs.readFileSync(path.join(s.f.envDir, 'odoo.json'), 'utf8'));
    cfg.environments.ENV_LIVE.policy = { write: 'framework-data', autoCleanup: true };
    fs.writeFileSync(path.join(s.f.envDir, 'odoo.json'), JSON.stringify(cfg));
    expect(buildEnvCards(s.ctx()).find((c) => c.key === 'ENV_LIVE')!.write.eligible).toBe(false);
    const r = recorder();
    await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_LIVE', by: 'Thanh' }, r.confirm);
    expect(await processEnvDecision(s.ctx(), { action: 'CONFIRM_POLICY', environment: 'ENV_LIVE', by: 'Thanh' }, r.confirm)).toMatchObject({ ok: false, status: 403 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENVW-3 Dùng lại xác nhận còn hiệu lực; hết hạn hoặc đổi cấu hình thì hỏi lại', () => {
  test('đã xác nhận hợp lệ ⇒ satisfied (không hỏi lại); cần ghi mà môi trường chỉ đọc vẫn satisfied', async () => {
    const s = setup();
    expect(sessionStatus(s.ctx(), false)).toMatchObject({ approvalOk: true, envValid: false, satisfied: false });
    await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh' }, recorder().confirm);
    expect(sessionStatus(s.ctx(), false)).toMatchObject({ selected: 'ENV_A', envValid: true, satisfied: true });
    expect(sessionStatus(s.ctx(), true)).toMatchObject({ envValid: true, policyEligible: true, policyValid: false, satisfied: false });
    await processEnvDecision(s.ctx(), { action: 'CONFIRM_POLICY', environment: 'ENV_A', by: 'Thanh' }, recorder().confirm);
    expect(sessionStatus(s.ctx(), true)).toMatchObject({ envValid: true, policyValid: true, satisfied: true });
    const ro = setup();
    await processEnvDecision(ro.ctx(), { action: 'CONFIRM_ENV', environment: 'UAT_RO', by: 'Thanh' }, recorder().confirm);
    expect(sessionStatus(ro.ctx(), true)).toMatchObject({ envValid: true, policyEligible: false, satisfied: true });
  });

  test('hết hạn: xác nhận môi trường sau 24 giờ và chính sách sau 8 giờ không còn hợp lệ', async () => {
    const s = setup();
    await confirmedBoth(s);
    const at = (h: number) => s.ctx({ now: () => Date.now() + h * 3600 * 1000 });
    expect(sessionStatus(at(7), true).satisfied).toBe(true);
    const nine = sessionStatus(at(9), true);
    expect(nine).toMatchObject({ envValid: true, policyValid: false, satisfied: false });
    expect(sessionStatus(at(9), false).satisfied).toBe(true); // chỉ đọc thì vẫn dùng lại được
    const day = sessionStatus(at(25), false);
    expect(day).toMatchObject({ envValid: false, satisfied: false });
    expect(day.envDetail).toMatch(/Cần xác nhận lại/);
  });

  test('đổi cấu hình: host trong .env đổi, hoặc phê duyệt/test case đổi ⇒ phải xác nhận lại', async () => {
    const s = setup();
    await confirmedBoth(s);
    expect(sessionStatus(s.ctx(), true).satisfied).toBe(true);
    process.env.FAKE_ENV_A_URL = 'https://a-moi.example.com';
    const moved = sessionStatus(s.ctx(), true);
    expect(moved).toMatchObject({ envValid: false, satisfied: false });
    expect(buildEnvCards(s.ctx()).find((c) => c.key === 'ENV_A')).toMatchObject({ host: 'a-moi.example.com', exec: { valid: false }, write: { valid: false } });
    process.env.FAKE_ENV_A_URL = 'https://a.example.com';
    expect(sessionStatus(s.ctx(), true).satisfied).toBe(true);
    const c = s.ctx();
    const changed = { ...c, defs: c.defs.map((d, i) => (i === 0 ? { ...d, expectedResult: 'đã sửa' } : d)) };
    expect(sessionStatus(changed, true)).toMatchObject({ approvalOk: false, satisfied: false });
  });

  test('đổi chính sách khai báo ⇒ xác nhận ghi cũ mất hiệu lực nhưng xác nhận môi trường còn', async () => {
    const s = setup();
    await confirmedBoth(s);
    const f = path.join(s.f.envDir, 'odoo.json');
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    cfg.environments.ENV_A.policy.maxRecordsPerRun = 5;
    fs.writeFileSync(f, JSON.stringify(cfg));
    expect(sessionStatus(s.ctx(), true)).toMatchObject({ envValid: true, policyValid: false, satisfied: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENVW-4 Máy chủ cục bộ: chống giả mạo như Approval Gate', () => {
  const raw = (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: o.method ?? 'GET', headers: o.headers }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.end(o.body);
    });
  async function serve(s: ReturnType<typeof setup>, confirm: EnvHumanConfirm = recorder().confirm) {
    const server = await startEnvServer({ getContext: () => s.ctx(), confirm });
    cleanups.push(() => void server.close());
    return server;
  }
  const post = (s: EnvServer, body: object, headers: Record<string, string> = {}) => raw(`${s.url}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const nonceOf = async (s: EnvServer) => /data-nonce="([0-9a-f]+)"/.exec((await raw(s.url)).body)![1];

  test('chỉ nghe 127.0.0.1; sai mã phiên, Host, Origin, Content-Type, thiếu/sai/dùng lại nonce đều bị từ chối và ghi nhật ký', async () => {
    const s = setup();
    const server = await serve(s);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/env\/[0-9a-f]{48}$/);
    expect((await raw(server.url.replace(/[0-9a-f]{48}$/, 'a'.repeat(48)))).status).toBe(404);
    expect((await raw(server.url, { headers: { host: 'evil.example.com' } })).status).toBe(403);
    const body = { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh' };
    expect((await post(server, body, { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await raw(`${server.url}/decision`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post(server, body)).status).toBe(403); // thiếu nonce
    expect((await post(server, { ...body, nonce: 'f'.repeat(32) })).status).toBe(403); // nonce không do trang cấp
    expect(readState(s.ws).selected).toBeUndefined();
    const nonce = await nonceOf(server);
    expect((await post(server, { ...body, nonce })).status).toBe(200);
    expect((await post(server, { ...body, nonce })).status).toBe(403); // nonce chỉ dùng được một lần khi thành công
    expect(auditOf(s.ws).filter((e) => e.outcome === 'REFUSED').length).toBeGreaterThanOrEqual(2);
  });

  test('nonce còn dùng được sau khi bị từ chối (người dùng sửa lại), nhưng số lần thử bị giới hạn', async () => {
    const s = setup();
    const server = await serve(s);
    const nonce = await nonceOf(server);
    expect((await post(server, { action: 'CONFIRM_ENV', environment: 'ENV_X', by: 'x', nonce })).status).toBe(422);
    expect((await post(server, { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'x', nonce })).status).toBe(200);
    const s2 = setup();
    const server2 = await serve(s2);
    const n2 = await nonceOf(server2);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await post(server2, { action: 'CONFIRM_ENV', environment: 'ENV_X', by: 'x', nonce: n2 })).status;
    expect(last).toBe(429);
    expect(auditOf(s2.ws).some((e) => e.outcome === 'LOCKED')).toBe(true);
  });

  test('GET /state không chứa bí mật; luồng đầy đủ qua HTTP: môi trường rồi chính sách (hai lần POST, hai nonce)', async () => {
    const s = setup();
    const r = recorder();
    const server = await serve(s, r.confirm);
    const st = await raw(`${server.url}/state`);
    for (const secret of SECRETS) expect(st.body).not.toContain(secret);
    const n1 = await nonceOf(server);
    expect((await post(server, { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh', nonce: n1 })).status).toBe(200);
    expect((await post(server, { action: 'CONFIRM_POLICY', environment: 'ENV_A', by: 'Thanh', nonce: n1 })).status).toBe(403); // nonce cũ đã dùng
    const n2 = await nonceOf(server);
    expect((await post(server, { action: 'CONFIRM_POLICY', environment: 'ENV_A', by: 'Thanh', nonce: n2 })).status).toBe(200);
    expect(r.seen.map((i) => i.kind)).toEqual(['ENV', 'POLICY']);
    expect(sessionStatus(s.ctx(), true).satisfied).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENVW-5 Script qa:env-web, hook chặn, phương án dự phòng', () => {
  const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(process.cwd(), 'scripts', 'env-review.ts');
  const run = (s: ReturnType<typeof setup>, ...args: string[]) =>
    spawnSync(process.execPath, [tsx, script, `--requirement=${wsReq.id}`, ...args], { cwd: s.ws, env: { ...process.env, ...s.f.vars, QA_ENVIRONMENTS_DIR: s.f.envDir, QA_APPROVAL_KEY_FILE: s.keyFile }, encoding: 'utf8', timeout: 60_000 });

  test('--check: chưa xác nhận ⇒ thoát 1; đã xác nhận hợp lệ ⇒ thoát 0 và DÙNG LẠI (không mở giao diện, không hỏi lại)', async () => {
    const s = setup();
    fs.cpSync(path.join(process.cwd(), 'applications'), path.join(s.ws, 'applications'), { recursive: true });
    const no = run(s, '--check');
    expect(no.status, no.stderr).toBe(1);
    expect(no.stdout).toMatch(/chưa chọn môi trường|Chưa chọn/i);
    await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh' }, recorder().confirm);
    const yes = run(s, '--check');
    expect(yes.status, yes.stderr).toBe(0);
    expect(yes.stdout).toMatch(/ENV_A — ĐÃ XÁC NHẬN, còn hiệu lực/);
    const reuse = run(s, '--no-open');
    expect(reuse.status, reuse.stderr).toBe(0);
    expect(reuse.stdout).toMatch(/DÙNG LẠI xác nhận hợp lệ[\s\S]*không hỏi lại/);
    expect(reuse.stdout).not.toMatch(/GIAO DIỆN CHỌN MÔI TRƯỜNG/);
    const needW = run(s, '--check', '--need-write');
    expect(needW.status).toBe(1);
    expect(needW.stdout).toMatch(/Chính sách ghi: chưa xác nhận/);
  });

  test('chưa APPROVE: script từ chối, không mở giao diện', () => {
    const w = makeWorkspace('pending');
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    const f = installFakeEnvironments(w.ws, { ENV_A: A });
    cleanups.push(f.restore);
    fs.cpSync(path.join(process.cwd(), 'applications'), path.join(w.ws, 'applications'), { recursive: true });
    const r = spawnSync(process.execPath, [tsx, script, `--requirement=${wsReq.id}`, '--no-open'], { cwd: w.ws, env: { ...process.env, ...f.vars, QA_ENVIRONMENTS_DIR: f.envDir, QA_APPROVAL_KEY_FILE: w.keyFile }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/chưa có phê duyệt hợp lệ/);
    expect(r.stdout).not.toMatch(/GIAO DIỆN CHỌN MÔI TRƯỜNG/);
  });

  test('script KHÔNG có đường nào tự chọn/tự xác nhận: mọi ghi trạng thái nằm sau hộp thoại hệ điều hành trong backend', () => {
    const src = fs.readFileSync(script, 'utf8');
    for (const forbidden of ['confirmExecution', 'confirmPolicy', 'selectEnvironment', 'processEnvDecision', 'signText']) expect(src, forbidden).not.toContain(forbidden);
    const web = fs.readFileSync(path.join('core', 'environment', 'web.ts'), 'utf8');
    // Trong processEnvDecision, mọi lần ghi (select/confirm) xuất hiện SAU lời gọi confirm(...) của người thật.
    const body = web.slice(web.indexOf('export async function processEnvDecision'));
    for (const [writer, human] of [['selectEnvironment(', "kind: 'ENV'"], ['confirmPolicy(', "kind: 'POLICY'"]] as const) expect(body.indexOf(human), writer).toBeLessThan(body.indexOf(writer));
    expect(body.match(/await confirm\(/g)).toHaveLength(2);
  });

  test('script chạy ngoài Playwright (qa:env-web, hook Playwright MCP) phải nạp .env, nếu không môi trường thật sẽ báo "thiếu biến" (lỗi gặp trên STAGING_A)', () => {
    for (const f of ['env-review.ts', 'approval.ts']) expect(fs.readFileSync(path.join('scripts', f), 'utf8'), f).toMatch(/import '\.\.\/core\/config\/env'/);
  });

  test('hook Bash chặn gọi thẳng API giao diện chọn môi trường và import hàm xác nhận; lệnh thường và qa:env-web vẫn chạy được', () => {
    const guard = (command: string) => spawnSync(process.execPath, [path.join('scripts', 'guard-bash.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
    const token = 'b'.repeat(48);
    for (const bad of [
      `curl -X POST http://127.0.0.1:5555/env/${token}/decision -d {}`,
      `Invoke-WebRequest http://localhost:5555/env/${token}/state`,
      'curl http://127.0.0.1:5555/env/abcdef',
      `node -e "import('./core/environment/state.ts').then(m=>m.confirmExecution(r,i))"`,
      `node -e "require('./core/policy/policy').confirmPolicy(r,i)"`,
    ]) expect(guard(bad).status, bad).toBe(2);
    for (const ok of ['npm run qa:env-web -- --requirement=REQ-X-001', 'npm run qa:env-web -- --requirement=REQ-X-001 --check', 'npm run qa:env -- list', 'npm run typecheck']) expect(guard(ok).status, ok).toBe(0);
  });

  test('lệnh terminal cũ vẫn là phương án dự phòng (qa:env, qa:policy) và dùng chung trạng thái đã ký', async () => {
    const s = setup();
    await processEnvDecision(s.ctx(), { action: 'CONFIRM_ENV', environment: 'ENV_A', by: 'Thanh' }, recorder().confirm);
    const out = spawnSync(process.execPath, [tsx, path.join(process.cwd(), 'scripts', 'environment.ts'), 'status'], { cwd: s.ws, env: { ...process.env, ...s.f.vars, QA_ENVIRONMENTS_DIR: s.f.envDir, QA_APPROVAL_KEY_FILE: s.keyFile }, encoding: 'utf8' });
    expect(out.stdout).toMatch(/Môi trường đang chọn: ENV_A/);
    expect(out.stdout).toMatch(new RegExp(`ENV_A / ${wsReq.id} — xác nhận bởi Thanh .* HỢP LỆ`));
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
    expect(pkg['qa:env']).toBeDefined();
    expect(pkg['qa:policy']).toBeDefined();
    expect(pkg['qa:env-web']).toBe('tsx scripts/env-review.ts');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('ENVW-6 Giao diện trên trình duyệt thật (dữ liệu giả)', () => {
  test('chọn môi trường ⇒ Xác nhận môi trường ⇒ (nút riêng) Xác nhận chính sách ghi; production và chỉ đọc không cho ghi', async ({ page }, info) => {
    const s = setup();
    const r = recorder();
    const server = await startEnvServer({ getContext: () => s.ctx(), confirm: r.confirm });
    cleanups.push(() => void server.close());
    await page.goto(server.url);
    await expect(page.locator('.card')).toHaveCount(5);
    await expect(page.locator('[data-env="ENV_A"]')).toContainText('a.example.com');
    await expect(page.locator('[data-env="ENV_A"]')).toContainText('Kế toán');
    await expect(page.locator('[data-env="PROD"] .kind')).toHaveText('production');
    await expect(page.locator('[data-env="ENV_X"] input')).toBeDisabled();
    for (const secret of SECRETS) await expect(page.locator('body')).not.toContainText(secret);
    await expect(page.locator('#confirm-env')).toBeDisabled(); // chưa chọn môi trường
    await expect(page.locator('#confirm-policy')).toBeDisabled();

    await page.locator('[data-env="ENV_A"] input').check();
    await page.locator('#by').fill('Thanh');
    await expect(page.locator('#confirm-env')).toBeEnabled();
    await expect(page.locator('#confirm-policy')).toBeDisabled(); // chưa xác nhận môi trường ⇒ chưa xác nhận ghi được
    await info.attach('env-web-1-chon.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.locator('#confirm-env').click();
    await expect(page.locator('#msg-env')).toContainText('Đã chọn và xác nhận môi trường ENV_A');
    await expect(page.locator('[data-env="ENV_A"] [data-exec]')).toHaveAttribute('data-exec', 'valid'); // sau khi tải lại
    expect(policyCheck(s.ws, resolved('ENV_A'), wsReq.id, s.hash).ok).toBe(false);

    await page.locator('#by').fill('Thanh');
    await expect(page.locator('#confirm-policy')).toBeEnabled();
    await page.locator('#confirm-policy').click();
    await expect(page.locator('#msg-policy')).toContainText('Đã xác nhận chính sách ghi của ENV_A');
    await expect(page.locator('[data-env="ENV_A"] [data-write]')).toHaveAttribute('data-write', 'valid');
    await expect(page.locator('#policy-lines')).toContainText('Đã xác nhận');
    await info.attach('env-web-2-da-xac-nhan.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(r.seen.map((i) => i.kind)).toEqual(['ENV', 'POLICY']);

    await page.locator('[data-env="PROD"] input').check();
    await expect(page.locator('#confirm-policy')).toBeDisabled();
    await expect(page.locator('#policy-lines')).toContainText('chỉ đọc');
    await page.locator('[data-env="UAT_RO"] input').check();
    await expect(page.locator('#confirm-policy')).toBeDisabled();
  });
});
