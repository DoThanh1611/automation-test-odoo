import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { evaluate, readRecord, submit } from '../../core/approval/approval';
import { startReviewServer, type ReviewServer } from '../../core/approval/server';
import { approvePhrase, processDecision, type DecisionRequest, type HumanConfirm, type ReviewContext } from '../../core/approval/web';
import { resolveEnvironment } from '../../core/environment/config';
import { confirmationProblem } from '../../core/environment/state';
import { grantProblems } from '../../core/testdata/write-guard';
import type { Requirement, TestCaseDef } from '../../core/testcases/schema';
import { installFakeEnvironments } from './helpers/fake-env';
import { makeWorkspace, wsReq } from './helpers/workspace';

// Framework tests cho Approval Gate trên giao diện Web (WEB-*). Dữ liệu giả, thư mục tạm, máy chủ cục bộ 127.0.0.1.
// KHÔNG kết nối staging; hộp thoại hệ điều hành luôn được thay bằng HumanConfirm giả (CLI thật không cho phép tiêm).

const cleanups: (() => void)[] = [];
const prevKey = process.env.QA_APPROVAL_KEY_FILE;
test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (prevKey === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
  else process.env.QA_APPROVAL_KEY_FILE = prevKey;
});

/** Thư mục tạm đã trình duyệt (PENDING_APPROVAL). Khoá chữ ký của thư mục này được đặt cho tiến trình test. */
function pending() {
  const w = makeWorkspace('pending');
  cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
  process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
  const testcaseFile = path.join(w.ws, 'testcases', 'odoo-sales', `${wsReq.id}.testcases.json`);
  /** Đọc lại bối cảnh từ đĩa mỗi lần (như scripts/review.ts) để thấy test case bị sửa. */
  const ctx = (): ReviewContext => {
    const suite = JSON.parse(fs.readFileSync(testcaseFile, 'utf8')) as { testCases: TestCaseDef[] };
    const requirement = JSON.parse(fs.readFileSync(path.join(w.ws, 'requirements', 'odoo-sales', `${wsReq.id}.json`), 'utf8')) as Requirement;
    return { root: w.ws, requirement, defs: suite.testCases.map((d) => ({ ...d, requirementId: wsReq.id, application: 'odoo', module: 'sales' })) };
  };
  const mutate = (fn: (tc: TestCaseDef) => void) => {
    const suite = JSON.parse(fs.readFileSync(testcaseFile, 'utf8'));
    fn(suite.testCases[0]);
    fs.writeFileSync(testcaseFile, JSON.stringify(suite));
  };
  const req = (over: DecisionRequest = {}): DecisionRequest => ({ action: 'APPROVE', version: 1, hash: w.hash, by: 'Người duyệt', phrase: approvePhrase(wsReq.id, 1, w.hash), ...over });
  return { ...w, ctx, mutate, req, testcaseFile };
}
const yes: HumanConfirm = async () => true;
const calls = () => {
  const seen: unknown[] = [];
  return { seen, confirm: (async (i) => { seen.push(i); return true; }) as HumanConfirm };
};

test.describe('WEB-1 Backend quyết định: phiên bản, hash, toàn vẹn, HMAC, audit', () => {
  test('APPROVE hợp lệ: ghi APPROVED có chữ ký HMAC, kênh web-review, lịch sử và nhật ký; vẫn KHÔNG có môi trường/quyền ghi', async () => {
    const p = pending();
    const c = calls();
    const r = await processDecision(p.ctx(), p.req(), c.confirm);
    expect(r).toMatchObject({ ok: true, status: 200, state: 'APPROVED' });
    expect(c.seen).toEqual([{ requirementId: wsReq.id, version: 1, hash: p.hash, by: 'Người duyệt' }]);
    const ctx = p.ctx();
    const ev = evaluate(p.ws, ctx.requirement, ctx.defs);
    expect(ev).toMatchObject({ state: 'APPROVED', ok: true }); // chữ ký HMAC xác minh được bằng khoá ngoài dự án
    const rec = readRecord(p.ws, wsReq.id)!;
    expect(rec.approval).toMatchObject({ version: 1, hash: p.hash, by: 'Người duyệt', channel: 'web-review' });
    expect(rec.approval!.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.history.map((h) => h.action)).toEqual(['SUBMIT', 'APPROVE']);
    const audit = fs.readFileSync(path.join(p.ws, 'approvals', wsReq.id, 'web-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ outcome: 'APPROVED', channel: 'web-review', version: 1 });
    // APPROVE không đồng nghĩa với xác nhận môi trường hay quyền ghi.
    const fake = installFakeEnvironments(p.ws, { E1: { url: 'https://e1.example.com', version: '18.0', roles: { accountant: { user: 'a@example.com', pass: 'p' } } } });
    cleanups.push(fake.restore);
    const e = resolveEnvironment('odoo', 'E1');
    if (!e.ok) throw new Error(e.problems.join());
    expect(confirmationProblem(p.ws, e.env, wsReq.id, p.hash)).toMatch(/chưa được xác nhận thực thi/);
    expect(grantProblems({ allowWrite: false, host: 'e1.example.com', environment: 'E1', module: 'odoo-sales', runId: '20261104-100000' }).join()).toMatch(/ALLOW_WRITE_TESTS|chưa có giấy phép ghi/);
  });

  test('APPROVE bị từ chối khi: người dùng không xác nhận trên hộp thoại, sai cụm, thiếu tên, sai hash, sai phiên bản (không đổi trạng thái)', async () => {
    const p = pending();
    const c = calls();
    const no: HumanConfirm = async () => false;
    const cases: [string, DecisionRequest, RegExp, HumanConfirm][] = [
      ['không bấm Yes', p.req(), /hộp thoại hệ điều hành/, no],
      ['sai cụm', p.req({ phrase: 'APPROVE' }), /Cụm xác nhận APPROVE không khớp/, c.confirm],
      ['thiếu tên', p.req({ by: '  ' }), /Phải nhập tên/, c.confirm],
      ['sai hash', p.req({ hash: 'f'.repeat(64) }), /Hash không khớp/, c.confirm],
      ['sai phiên bản', p.req({ version: 2 }), /không phải phiên bản đang chờ/, c.confirm],
      ['hành động lạ', p.req({ action: 'DELETE' }), /Hành động không hợp lệ/, c.confirm],
    ];
    for (const [name, body, msg, confirm] of cases) {
      const r = await processDecision(p.ctx(), body, confirm);
      expect(r.ok, name).toBe(false);
      expect(r.message, name).toMatch(msg);
    }
    expect(c.seen).toEqual([]); // hộp thoại chỉ hiện khi mọi kiểm tra khác đã đạt
    expect(readRecord(p.ws, wsReq.id)!.status).toBe('PENDING_APPROVAL');
    const audit = fs.readFileSync(path.join(p.ws, 'approvals', wsReq.id, 'web-audit.jsonl'), 'utf8').trim().split('\n');
    expect(audit).toHaveLength(cases.length); // mọi lần thử bị từ chối đều có nhật ký
  });

  test('REVISE/REJECT cần tên + nhận xét; ghi đúng trạng thái và giữ lịch sử; sau đó không quyết định thêm được', async () => {
    const p = pending();
    expect((await processDecision(p.ctx(), p.req({ action: 'REVISE', comment: '' }), yes)).message).toMatch(/REVISE phải kèm nhận xét/);
    const rv = await processDecision(p.ctx(), p.req({ action: 'REVISE', comment: 'Thiếu trường hợp AC-01' }), yes);
    expect(rv).toMatchObject({ ok: true, state: 'REVISION_REQUESTED' });
    expect(readRecord(p.ws, wsReq.id)!.history.at(-1)).toMatchObject({ action: 'REVISE', comment: 'Thiếu trường hợp AC-01', channel: 'web-review', by: 'Người duyệt' });
    expect(await processDecision(p.ctx(), p.req(), yes)).toMatchObject({ ok: false, status: 409 }); // đã REVISION_REQUESTED

    const q = pending();
    expect((await processDecision(q.ctx(), q.req({ action: 'REJECT' }), yes)).message).toMatch(/REJECT phải kèm/);
    expect(await processDecision(q.ctx(), q.req({ action: 'REJECT', comment: 'Sai phạm vi' }), yes)).toMatchObject({ ok: true, state: 'REJECTED' });
    expect(evaluate(q.ws, q.ctx().requirement, q.ctx().defs)).toMatchObject({ state: 'REJECTED', ok: false });
    expect((await processDecision(q.ctx(), q.req(), yes)).ok).toBe(false);
  });

  test('test case đổi trước khi duyệt: hash lệch, không APPROVE được; đổi SAU khi duyệt: tự INVALIDATED (có dòng lịch sử), mọi quyết định bị từ chối', async () => {
    const p = pending();
    p.mutate((tc) => { tc.expectedResult = 'bị sửa khi đang chờ duyệt'; });
    const stale = await processDecision(p.ctx(), p.req(), yes);
    expect(stale).toMatchObject({ ok: false, status: 409, state: 'PENDING_STALE' });
    expect(readRecord(p.ws, wsReq.id)!.status).toBe('PENDING_APPROVAL');

    const q = pending();
    expect((await processDecision(q.ctx(), q.req(), yes)).ok).toBe(true);
    q.mutate((tc) => { tc.steps = [...tc.steps, 'bước thêm sau khi duyệt']; });
    const after = await processDecision(q.ctx(), q.req({ action: 'REJECT', comment: 'x' }), yes);
    expect(after).toMatchObject({ ok: false, status: 409, state: 'INVALIDATED' });
    const rec = readRecord(q.ws, wsReq.id)!;
    expect(rec.status).toBe('INVALIDATED');
    expect(rec.history.map((h) => h.action)).toEqual(['SUBMIT', 'APPROVE', 'INVALIDATE']);
    expect(evaluate(q.ws, q.ctx().requirement, q.ctx().defs).ok).toBe(false);
  });

  test('chữ ký APPROVE không giả được: sửa tay bản ghi hoặc xoá khoá => không còn hợp lệ', async () => {
    const p = pending();
    await processDecision(p.ctx(), p.req(), yes);
    const file = path.join(p.ws, 'approvals', `${wsReq.id}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.approval.by = 'Kẻ giả mạo';
    fs.writeFileSync(file, JSON.stringify(rec));
    expect(evaluate(p.ws, p.ctx().requirement, p.ctx().defs)).toMatchObject({ state: 'SIGNATURE_INVALID', ok: false });
    fs.writeFileSync(file, JSON.stringify({ ...rec, approval: { ...rec.approval, by: 'Người duyệt' } }));
    fs.rmSync(p.keyFile);
    expect(evaluate(p.ws, p.ctx().requirement, p.ctx().defs).ok).toBe(false);
  });

  test('toàn vẹn: requirement bị sửa so với bản khoá thì APPROVE bị từ chối (422) dù mọi thứ khác đúng', async () => {
    const p = pending();
    const f = path.join(p.ws, 'requirements', 'odoo-sales', `${wsReq.id}.json`);
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    r.businessRules[0].text = 'nội dung BR bị sửa sau khi khoá';
    fs.writeFileSync(f, JSON.stringify(r));
    const res = await processDecision(p.ctx(), p.req(), yes);
    expect(res.ok).toBe(false);
    // hash của bộ test case gồm cả hash requirement nên bị bắt ở bước hash hoặc toàn vẹn; cả hai đều từ chối.
    expect([409, 422]).toContain(res.status);
    expect(readRecord(p.ws, wsReq.id)!.status).toBe('PENDING_APPROVAL');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('WEB-2 Máy chủ cục bộ: Claude/tiến trình ngoài không vượt được cổng', () => {
  const servers: ReviewServer[] = [];
  test.afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  const serve = async (p: ReturnType<typeof pending>, confirm: HumanConfirm = yes) => {
    const s = await startReviewServer({ root: p.ws, requirementId: wsReq.id, getContext: p.ctx, confirm });
    servers.push(s);
    return s;
  };
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
  const post = (s: ReviewServer, body: object, headers: Record<string, string> = {}) =>
    raw(`${s.url}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const nonceOf = async (s: ReviewServer) => /data-nonce="([0-9a-f]+)"/.exec((await raw(s.url)).body)![1];

  test('chỉ nghe 127.0.0.1; sai mã phiên, sai Host, sai Origin, sai Content-Type, thiếu/sai/dùng lại nonce đều bị từ chối', async () => {
    const p = pending();
    const s = await serve(p);
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/review\/[0-9a-f]{48}$/);
    expect((await raw(s.url.replace(/[0-9a-f]{48}$/, 'a'.repeat(48)))).status).toBe(404);
    expect((await raw(s.url, { headers: { host: 'evil.example.com' } })).status).toBe(403);
    expect((await post(s, p.req(), { origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await raw(`${s.url}/decision`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post(s, p.req())).status).toBe(403); // thiếu nonce
    expect((await post(s, { ...p.req(), nonce: 'f'.repeat(32) })).status).toBe(403); // nonce không do trang cấp
    const nonce = await nonceOf(s);
    expect((await post(s, { ...p.req({ phrase: 'sai' }), nonce })).status).toBe(400); // bị từ chối: nonce còn dùng được để sửa và gửi lại
    expect(readRecord(p.ws, wsReq.id)!.status).toBe('PENDING_APPROVAL');
    expect((await post(s, { ...p.req(), nonce })).status).toBe(200);
    expect((await post(s, { ...p.req(), nonce })).status).toBe(403); // thành công rồi thì nonce đã tiêu hao (không phát lại được)
  });

  test('Claude cào trang để lấy nonce rồi gọi API vẫn KHÔNG APPROVE được vì không bấm được hộp thoại hệ điều hành', async () => {
    const p = pending();
    const asked: unknown[] = [];
    const s = await serve(p, async (i) => { asked.push(i); return false; }); // người dùng không bấm Yes
    const res = await post(s, { ...p.req(), nonce: await nonceOf(s) });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).message).toMatch(/hộp thoại hệ điều hành/);
    expect(asked).toHaveLength(1);
    expect(readRecord(p.ws, wsReq.id)!.status).toBe('PENDING_APPROVAL');
  });

  test('giới hạn số lần thử: sau 10 lần, mọi yêu cầu bị khoá (429) và có nhật ký', async () => {
    const p = pending();
    const s = await serve(p);
    for (let i = 0; i < 10; i++) await post(s, { ...p.req(), nonce: 'x' });
    const locked = await post(s, { ...p.req(), nonce: await nonceOf(s) });
    expect(locked.status).toBe(429);
    expect(fs.readFileSync(path.join(p.ws, 'approvals', wsReq.id, 'web-audit.jsonl'), 'utf8')).toContain('LOCKED');
  });

  test('GET /state phản ánh trạng thái thật; trang escape nội dung (không chèn được HTML)', async () => {
    const p = pending();
    p.mutate((tc) => { tc.title = '<img src=x onerror=alert(1)> tiêu đề'; });
    // Cập nhật hash đã trình duyệt để trang vẫn ở PENDING_APPROVAL với nội dung mới.
    const c = p.ctx();
    submit(p.ws, c.requirement, c.defs);
    const s = await serve(p);
    const html = (await raw(s.url)).body;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const st = JSON.parse((await raw(`${s.url}/state`)).body);
    expect(st).toMatchObject({ requirementId: wsReq.id, state: 'PENDING_APPROVAL', version: 2 });
  });

  test('hook Bash chặn lệnh gọi API review, import hàm duyệt, đặt biến vượt cổng; cho qua lệnh thường', () => {
    const run = (command: string) => spawnSync(process.execPath, [path.join('scripts', 'guard-bash.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
    const token = 'a'.repeat(48);
    for (const bad of [
      `curl -X POST http://127.0.0.1:5555/review/${token}/decision -d {}`,
      `Invoke-WebRequest http://localhost:5555/review/${token}`,
      `node -e "import('./core/approval/approval.ts').then(m=>m.approve(r,q,d,i))"`,
      'QA_APPROVAL_GATE=passed npx playwright test',
      'QA_ENV=STAGING_A npm test',
      'cat ~/.qa-framework/approval.key',
      'echo {} > .qa-state/environment.json',
    ]) expect(run(bad).status, bad).toBe(2);
    for (const ok of ['npm run typecheck', 'npm run qa:review -- --requirement=REQ-X-001', 'npm run qa:approval -- status', 'git status']) expect(run(ok).status, ok).toBe(0);
    expect(spawnSync(process.execPath, [path.join('scripts', 'guard-bash.mjs')], { input: '{không phải json', encoding: 'utf8' }).status).toBe(0);
    const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('guard-bash.mjs');
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('mcp__playwright__');
  });

  test('CLI qa:review chạy thật (không mở trình duyệt): in link, phục vụ trang, từ chối POST không nonce; thoát sớm khi không còn chờ duyệt', async () => {
    const p = pending();
    const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const child = spawn(process.execPath, [tsx, path.join(process.cwd(), 'scripts', 'review.ts'), `--requirement=${wsReq.id}`, '--no-open'], { cwd: p.ws, env: { ...process.env, CLAUDE_PROJECT_DIR: p.ws }, stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(() => child.kill());
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error(`không thấy link: ${out}`)), 60_000);
      child.stdout.on('data', (d) => {
        out += d;
        const m = /(http:\/\/127\.0\.0\.1:\d+\/review\/[0-9a-f]+)/.exec(out);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
    });
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(wsReq.id);
    expect(html).toContain(p.hash);
    const bad = await fetch(`${url}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'APPROVE', version: 1, hash: p.hash, by: 'x' }) });
    expect(bad.status).toBe(403);
    expect(readRecord(p.ws, wsReq.id)!.status).toBe('PENDING_APPROVAL');
    child.kill();
    // Đã APPROVED (qua backend) thì lần mở sau báo không cần duyệt và thoát ngay.
    await processDecision(p.ctx(), p.req(), yes);
    const again = spawnSync(process.execPath, [tsx, path.join(process.cwd(), 'scripts', 'review.ts'), `--requirement=${wsReq.id}`, '--no-open'], { cwd: p.ws, env: { ...process.env, CLAUDE_PROJECT_DIR: p.ws }, encoding: 'utf8' });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/đang ở trạng thái APPROVED/);
  });

  test('CLI qa:review không có tham số nào để tiêm xác nhận giả hoặc bỏ qua hộp thoại', () => {
    const src = fs.readFileSync(path.join('scripts', 'review.ts'), 'utf8');
    expect(src).toContain('nativeConfirm(');
    expect(src).not.toMatch(/process\.env\.QA_[A-Z_]*(CONFIRM|AUTO|APPROVE)/);
    expect(src).not.toMatch(/--(yes|auto|force)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('WEB-3 Giao diện Review & Approval trên trình duyệt thật (dữ liệu giả)', () => {
  const servers: ReviewServer[] = [];
  test.afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });
  const serve = async (p: ReturnType<typeof pending>, confirm: HumanConfirm) => {
    const s = await startReviewServer({ root: p.ws, requirementId: wsReq.id, getContext: p.ctx, confirm });
    servers.push(s);
    return s;
  };

  test('hiển thị Requirement ID, version, hash, test case theo module, phủ BR/AC, trạng thái; APPROVE qua giao diện', async ({ page }, info) => {
    const p = pending();
    const asked: unknown[] = [];
    const s = await serve(p, async (i) => { asked.push(i); return true; });
    await page.goto(s.url);
    await expect(page.locator('h1')).toContainText(wsReq.id);
    await expect(page.locator('#version')).toHaveText('v1');
    await expect(page.locator('#hash')).toHaveText(p.hash);
    await expect(page.locator('#state')).toHaveText('PENDING_APPROVAL');
    await expect(page.locator('section.mod')).toHaveCount(1);
    await expect(page.locator('section.mod h3')).toContainText('odoo-sales');
    await expect(page.locator('details.tc')).toHaveCount(2);
    await page.locator('details.tc').first().locator('summary').click();
    await expect(page.locator('details.tc').first()).toContainText('kết quả TC-E-001');
    await expect(page.locator('#coverage tr')).toHaveCount(3); // tiêu đề + BR-01 + AC-01
    await expect(page.locator('#coverage')).toContainText('TC-E-001, TC-E-002');
    await expect(page.locator('#history')).toContainText('SUBMIT');
    await info.attach('review-pending.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    // Chưa nhập tên/cụm: giao diện báo lỗi từ backend, không đổi trạng thái.
    await page.locator('#approve').click();
    await expect(page.locator('#msg')).toContainText('Phải nhập tên');
    await page.locator('#by').fill('Chị Thanh');
    await page.locator('#phrase').fill('APPROVE sai');
    await page.locator('#approve').click();
    await expect(page.locator('#msg')).toContainText('Cụm xác nhận APPROVE không khớp');
    expect(asked).toHaveLength(0);
    expect(readRecord(p.ws, wsReq.id)!.status).toBe('PENDING_APPROVAL');

    await page.locator('#phrase').fill(approvePhrase(wsReq.id, 1, p.hash));
    await page.locator('#approve').click();
    await expect(page.locator('#state')).toHaveText('APPROVED', { timeout: 10_000 }); // trang tự tải lại sau khi duyệt
    await expect(page.locator('.locked')).toContainText('Đã duyệt');
    await expect(page.locator('#history')).toContainText('web-review');
    await info.attach('review-approved.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(asked).toHaveLength(1);
    const ctx = p.ctx();
    expect(evaluate(p.ws, ctx.requirement, ctx.defs)).toMatchObject({ state: 'APPROVED', ok: true });
  });

  test('REVISE và REJECT qua giao diện cần nhận xét; trang báo trạng thái mới', async ({ page }) => {
    const p = pending();
    const s = await serve(p, async () => { throw new Error('REVISE/REJECT không được gọi hộp thoại'); });
    await page.goto(s.url);
    await page.locator('#by').fill('Người duyệt');
    await page.locator('#revise').click();
    await expect(page.locator('#msg')).toContainText('REVISE phải kèm nhận xét');
    await page.locator('#comment').fill('Cần thêm test case cho AC-01');
    await page.locator('#revise').click();
    await expect(page.locator('#state')).toHaveText('REVISION_REQUESTED', { timeout: 10_000 });
    expect(readRecord(p.ws, wsReq.id)!.history.at(-1)).toMatchObject({ action: 'REVISE', comment: 'Cần thêm test case cho AC-01' });

    const q = pending();
    const s2 = await serve(q, yes);
    await page.goto(s2.url);
    await page.locator('#by').fill('Người duyệt');
    await page.locator('#comment').fill('Sai phạm vi');
    await page.locator('#reject').click();
    await expect(page.locator('#state')).toHaveText('REJECTED', { timeout: 10_000 });
    await expect(page.locator('#decision')).toHaveCount(0); // hết nút quyết định
  });

  test('test case bị sửa khi trang đang mở: trang cảnh báo trạng thái đổi và nút duyệt cũ bị backend từ chối', async ({ page }) => {
    const p = pending();
    const s = await serve(p, yes);
    await page.goto(s.url);
    await expect(page.locator('#stale')).not.toHaveClass(/show/);
    p.mutate((tc) => { tc.expectedResult = 'sửa khi người dùng đang xem'; });
    await expect(page.locator('#stale')).toHaveClass(/show/, { timeout: 10_000 });
    await page.locator('#by').fill('Người duyệt');
    await page.locator('#phrase').fill(approvePhrase(wsReq.id, 1, p.hash));
    await page.locator('#approve').click();
    await expect(page.locator('#msg')).toContainText('PENDING_STALE');
    expect(readRecord(p.ws, wsReq.id)!.status).toBe('PENDING_APPROVAL');
  });
});
