import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { approve, reject, revise } from '../../core/approval/approval';
import { processEnvDecision, type EnvHumanConfirm } from '../../core/environment/web';
import { decideNext, gatherFacts, markWorkflow, nextStep, readWorkflow, resolveActiveRequirement, workflowFile, type GatherInput, type WorkflowFacts } from '../../core/workflow/next';
import { REQUIRED_IGNORE, runSetup } from '../../core/workflow/setup';
import type { Requirement, TestCaseDef } from '../../core/testcases/schema';
import { odooRecipes, salesPlan } from '../../applications/odoo/factory';
import { odooFactoryCleanupHandlers } from '../../applications/odoo/factory-cleanup';
import type { OdooClient } from '../../applications/odoo/client';
import { beginExecution } from '../../core/approval/gate';
import { DataFactory } from '../../core/testdata/factory';
import { runCleanup } from '../../core/testdata/cleanup-engine';
import { loadRegistry } from '../../core/testdata/registry';
import { defHash } from '../../core/testcases/hash';
import { FakeOrm } from './helpers/fake-orm';
import { installFakeEnvironments, type FakeEnvSpec } from './helpers/fake-env';
import { makeWorkspace, wsReq } from './helpers/workspace';

// Framework tests cho quy trình end-to-end của /qa-requirement: điều phối theo trạng thái thật, khôi phục phiên dở, thiếu cấu hình,
// đăng nhập lỗi, cài đặt lần đầu và tài liệu. Dữ liệu giả, thư mục tạm, KHÔNG kết nối staging.

const OVERRIDES = ['QA_APPROVAL_KEY_FILE', 'QA_ENVIRONMENTS_DIR', 'QA_AUTH_DIR', 'QA_REPORTS_DIR', 'QA_ENV', 'FAKE_ENV_A_URL', 'FAKE_ENV_A_ACCOUNTANT_USER', 'FAKE_ENV_A_ACCOUNTANT_PASS'] as const;
const saved = Object.fromEntries(OVERRIDES.map((k) => [k, process.env[k]]));
const cleanups: (() => void)[] = [];
test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const k of OVERRIDES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const A: FakeEnvSpec = { url: 'https://a.example.com', version: '18.0', roles: { accountant: { user: 'ke.toan@example.com', pass: 'Mk#fake-A-111' }, noaccess: { user: 'khong.quyen@example.com', pass: 'Mk#fake-A-222' } } };
const NOURL: FakeEnvSpec = { version: '18.0', roles: { accountant: { user: 'n@example.com' } } };
const yes: EnvHumanConfirm = async () => true;

// ---------------------------------------------------------------------------------------------------------------------
const facts = (over: Partial<WorkflowFacts> = {}): WorkflowFacts => ({
  requirementId: 'REQ-W-001', requirementExists: true, inbox: [], testCaseCount: 3, integrity: [], approvalState: 'APPROVED', approvalReason: 'ok', needWrite: false,
  setup: { usableEnvironments: 1, problems: [] },
  env: { selected: 'ENV_A', envValid: true, envDetail: 'ok', policyEligible: true, policyValid: true },
  login: { missing: [], failed: [] },
  probe: { supported: false, done: false, failed: false },
  automation: { eligibleWithoutSpec: [], marked: false, withSpec: ['TC-1', 'TC-2'], ranWithSpec: ['TC-1', 'TC-2'] },
  ...over,
});
const at = (over: Partial<WorkflowFacts>) => decideNext(facts(over));

test.describe('WF-1 Điều phối: mỗi trạng thái có đúng một bước tiếp theo và đúng người làm', () => {
  test('giai đoạn 1: chưa có requirement, có requirement trong _inbox, thiếu test case, lỗi phủ BR/AC, sẵn sàng trình duyệt', () => {
    expect(at({ requirementId: undefined, requirementExists: false })).toMatchObject({ stage: 'NO_REQUIREMENT', owner: 'user' });
    const inbox = at({ requirementId: undefined, requirementExists: false, inbox: ['ban-hang.md'] });
    expect(inbox).toMatchObject({ stage: 'NO_REQUIREMENT', owner: 'claude' });
    expect(inbox.actions.join(' ')).toMatch(/req:import/);
    expect(at({ requirementExists: false })).toMatchObject({ stage: 'NO_REQUIREMENT' });
    expect(at({ testCaseCount: 0, approvalState: 'NOT_SUBMITTED' })).toMatchObject({ stage: 'NEEDS_TESTCASES', owner: 'claude' });
    const bad = at({ integrity: ['AC-02 chưa có test case'], approvalState: 'NOT_SUBMITTED' });
    expect(bad).toMatchObject({ stage: 'NEEDS_TESTCASES', owner: 'claude' });
    expect(bad.summary).toMatch(/AC-02/);
    const ready = at({ approvalState: 'NOT_SUBMITTED' });
    expect(ready).toMatchObject({ stage: 'READY_TO_SUBMIT', owner: 'claude' });
    expect(ready.actions.join(' ')).toMatch(/qa:approval -- submit[\s\S]*qa:review/);
  });

  test('phê duyệt: chờ duyệt ⇒ người dùng; REVISE/stale/invalidated ⇒ Claude sửa và trình lại; REJECT ⇒ dừng; chữ ký hỏng ⇒ người dùng duyệt lại', () => {
    const wait = at({ approvalState: 'PENDING_APPROVAL' });
    expect(wait).toMatchObject({ stage: 'AWAITING_APPROVAL', owner: 'user' });
    expect(wait.userActions.join(' ')).toMatch(/APPROVE/);
    for (const s of ['REVISION_REQUESTED', 'PENDING_STALE', 'INVALIDATED']) expect(at({ approvalState: s }), s).toMatchObject({ stage: 'NEEDS_REVISION', owner: 'claude' });
    expect(at({ approvalState: 'REJECTED' })).toMatchObject({ stage: 'REJECTED', owner: 'user', actions: [] });
    for (const s of ['SIGNATURE_INVALID', 'KEY_MISSING']) expect(at({ approvalState: s }), s).toMatchObject({ stage: 'APPROVAL_INVALID', owner: 'user' });
    // Chưa APPROVE thì tuyệt đối không sang giai đoạn 2 dù mọi thứ khác đã sẵn sàng.
    for (const s of ['NOT_SUBMITTED', 'PENDING_APPROVAL', 'REJECTED', 'INVALIDATED', 'SIGNATURE_INVALID']) expect(at({ approvalState: s }).stage, s).not.toMatch(/ENVIRONMENT|LOGIN|PROBE|AUTOMATION|RUN/);
  });

  test('sau APPROVE: thiếu cấu hình ⇒ người dùng điền .env một lần; chưa xác nhận môi trường ⇒ mở giao diện web; hết hạn cũng vậy', () => {
    const setup = at({ setup: { usableEnvironments: 0, problems: ['ENV_A: thiếu biến FAKE_ENV_A_URL (URL của ENV_A) trong .env'] } });
    expect(setup).toMatchObject({ stage: 'NEEDS_SETUP', owner: 'user' });
    expect(setup.summary).toMatch(/FAKE_ENV_A_URL/);
    expect(setup.actions.join(' ')).toMatch(/npm run setup/);
    expect(at({ setup: { usableEnvironments: 1, problems: [], defaultRoleMissing: 'accountant' } })).toMatchObject({ stage: 'NEEDS_SETUP' });
    const env = at({ env: { selected: undefined, envValid: false, envDetail: 'Chưa chọn môi trường', policyEligible: false, policyValid: false } });
    expect(env).toMatchObject({ stage: 'NEEDS_ENVIRONMENT', owner: 'user' });
    expect(env.actions.join(' ')).toMatch(/qa:env-web/);
    expect(env.userActions.join(' ')).not.toMatch(/qa:env|qa:policy|npm/); // người dùng chỉ bấm nút trên web, không gõ lệnh
    const expired = at({ env: { selected: 'ENV_A', envValid: false, envDetail: 'Cần xác nhận lại: quá 24 giờ', policyEligible: true, policyValid: false } });
    expect(expired).toMatchObject({ stage: 'NEEDS_ENVIRONMENT' });
    expect(expired.summary).toMatch(/24 giờ/);
  });

  test('chính sách ghi: chỉ đòi xác nhận khi có test cần ghi và môi trường được phép ghi; môi trường chỉ đọc không chặn quy trình', () => {
    const need = at({ needWrite: true, env: { selected: 'ENV_A', envValid: true, envDetail: 'ok', policyEligible: true, policyValid: false } });
    expect(need).toMatchObject({ stage: 'NEEDS_WRITE_POLICY', owner: 'user' });
    expect(need.actions.join(' ')).toMatch(/qa:env-web[\s\S]*--need-write/);
    expect(at({ needWrite: false, env: { selected: 'ENV_A', envValid: true, envDetail: 'ok', policyEligible: true, policyValid: false } }).stage).not.toBe('NEEDS_WRITE_POLICY');
    const ro = at({ needWrite: true, env: { selected: 'UAT', envValid: true, envDetail: 'ok', policyEligible: false, policyValid: false } });
    expect(ro.stage).not.toBe('NEEDS_WRITE_POLICY');
    expect(ro.checks.find((c) => c.name === 'Chính sách ghi')?.detail).toMatch(/BLOCKED/);
    expect(at({ needWrite: true }).stage).not.toBe('NEEDS_WRITE_POLICY'); // đã xác nhận ⇒ dùng lại, không hỏi lại
  });

  test('đăng nhập: chưa có phiên ⇒ Claude chạy bước đăng nhập chỉ đọc; xác minh lỗi ⇒ dừng cho người dùng, KHÔNG đổi môi trường/tài khoản', () => {
    expect(at({ login: { missing: ['accountant'], failed: [] } })).toMatchObject({ stage: 'NEEDS_LOGIN', owner: 'claude' });
    const failed = at({ login: { missing: [], failed: [{ role: 'accountant', problem: 'sai mật khẩu' }] } });
    expect(failed).toMatchObject({ stage: 'LOGIN_FAILED', owner: 'user', actions: [] });
    expect(failed.summary).toMatch(/Không tự đổi môi trường/);
    expect(failed.summary).not.toMatch(/Mk#|ke\.toan@/);
  });

  test('thăm dò, tự động hóa, chạy, hoàn tất: đúng thứ tự và mỗi bước chỉ xuất hiện khi các bước trước đã đạt', () => {
    expect(at({ probe: { supported: true, done: false, failed: false } })).toMatchObject({ stage: 'NEEDS_PROBE', owner: 'claude', actions: ['npm run odoo:probe'] });
    expect(at({ probe: { supported: true, done: true, failed: true } })).toMatchObject({ stage: 'PROBE_FAILED', owner: 'user' });
    expect(at({ probe: { supported: false, done: false, failed: false } }).stage).not.toBe('NEEDS_PROBE'); // ứng dụng không có thăm dò
    const auto = at({ automation: { eligibleWithoutSpec: ['TC-3'], marked: false, withSpec: ['TC-1'], ranWithSpec: [] } });
    expect(auto).toMatchObject({ stage: 'NEEDS_AUTOMATION', owner: 'claude' });
    expect(auto.actions.join(' ')).toMatch(/mcp__playwright__[\s\S]*--mark=automation-done/);
    const run = at({ automation: { eligibleWithoutSpec: ['TC-3'], marked: true, withSpec: ['TC-1', 'TC-3'], ranWithSpec: ['TC-1'] } });
    expect(run).toMatchObject({ stage: 'READY_TO_RUN', owner: 'claude' }); // đã đánh dấu tự động hóa xong: không lặp lại
    expect(run.summary).toMatch(/TC-3/);
    const done = at({});
    expect(done).toMatchObject({ stage: 'RUN_COMPLETE', owner: 'claude' });
    expect(done.actions.join(' ')).toMatch(/qa:finish/);
    expect(done.actions.join(' ')).toMatch(/cleanup/i);
  });

  test('đường dẫn lệnh khi cần ghi: dùng test:write theo requirement (cleanup theo chính sách); chỉ đọc: dùng npm test theo requirement', () => {
    const w = at({ needWrite: true, automation: { eligibleWithoutSpec: [], marked: false, withSpec: ['TC-1'], ranWithSpec: [] } });
    expect(w.stage).toBe('READY_TO_RUN');
    expect(w.actions[0]).toMatch(/test:write -- --requirement=REQ-W-001/);
    const r = at({ needWrite: false, automation: { eligibleWithoutSpec: [], marked: false, withSpec: ['TC-1'], ranWithSpec: [] } });
    expect(r.actions[0]).toMatch(/npm test -- --requirement=REQ-W-001/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
function workspace(stage: 'pending' | 'approved' = 'approved', envs: Record<string, FakeEnvSpec> = { ENV_A: A }) {
  const w = makeWorkspace(stage);
  cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
  process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
  // Mặc định mọi test case của workspace khai báo READ hợp lệ (metadata thực thi nằm ngoài nội dung đã duyệt); test về quyền ghi tự đổi.
  const amDir = path.join(w.ws, 'automation', 'odoo-sales');
  fs.mkdirSync(amDir, { recursive: true });
  fs.writeFileSync(path.join(amDir, `${wsReq.id}.automation.json`), JSON.stringify({ requirementId: wsReq.id, testCases: Object.fromEntries(w.defs.map((d) => [d.id, { access: 'READ', dataStrategy: 'EXISTING_READONLY', cleanup: 'NONE' }])) }));
  const f = installFakeEnvironments(w.ws, envs);
  cleanups.push(f.restore);
  const cfg = structuredClone(f.config);
  for (const k of Object.keys(cfg.environments)) cfg.environments[k].policy = { write: 'framework-data', autoCleanup: true };
  fs.writeFileSync(path.join(f.envDir, 'odoo.json'), JSON.stringify(cfg));
  process.env.QA_AUTH_DIR = path.join(w.ws, '.auth');
  process.env.QA_REPORTS_DIR = path.join(w.ws, 'reports', 'ENV_A');
  const input = (over: Partial<GatherInput> = {}): GatherInput => ({
    root: w.ws,
    requirements: [wsReq] as Requirement[],
    defs: w.defs as TestCaseDef[],
    roles: () => ['accountant', 'noaccess'],
    ...over,
  });
  const confirmEnv = async (env = 'ENV_A') => {
    const ctx = { root: w.ws, app: 'odoo', requirement: wsReq, defs: w.defs as TestCaseDef[] };
    return processEnvDecision(ctx, { action: 'CONFIRM_ENV', environment: env, by: 'Thanh' }, yes);
  };
  const meta = (role: string, ok: boolean, problems: string[] = []) => {
    const dir = path.join(w.ws, '.auth', 'ENV_A');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `odoo-${role}.meta.json`), JSON.stringify({ environment: 'ENV_A', application: 'odoo', role, host: 'a.example.com', verifiedAt: new Date().toISOString(), ok, problems }));
    if (ok) fs.writeFileSync(path.join(dir, `odoo-${role}.json`), '{}');
  };
  return { ...w, f, input, confirmEnv, meta };
}

test.describe('WF-2 Trạng thái thật trên đĩa: tiếp tục chính xác, không nhập lại, không duyệt lại', () => {
  test('chưa APPROVE: AWAITING_APPROVAL; gọi lại nhiều lần cho cùng kết quả và không ghi thêm gì ngoài phiên làm việc', () => {
    const s = workspace('pending');
    const before = fs.readdirSync(s.ws).sort();
    const a = nextStep(s.input({ requirementId: wsReq.id }));
    expect(a).toMatchObject({ stage: 'AWAITING_APPROVAL', owner: 'user' });
    const again = nextStep(s.input({ requirementId: wsReq.id }));
    expect(again.stage).toBe(a.stage);
    expect(fs.readdirSync(s.ws).sort()).toEqual(before);
    expect(fs.existsSync(workflowFile(s.ws))).toBe(false); // nextStep chỉ đọc
  });

  test('đóng phiên Claude Code rồi gọi lại /qa-requirement không kèm requirement: nhận diện requirement đang dở từ phiên làm việc và marker, không cần nhập lại', () => {
    const s = workspace('pending');
    expect(nextStep(s.input()).stage).toBe('NO_REQUIREMENT'); // phiên mới tinh, chưa có gì để tiếp tục
    markWorkflow(s.ws, wsReq.id);
    expect(resolveActiveRequirement(s.ws)).toBe(wsReq.id);
    expect(nextStep(s.input())).toMatchObject({ requirementId: wsReq.id, stage: 'AWAITING_APPROVAL' });
    fs.rmSync(workflowFile(s.ws));
    expect(resolveActiveRequirement(s.ws)).toBeUndefined();
    const a = workspace('approved'); // có phiên thực thi đang mở (marker) thì cũng nhận ra
    expect(resolveActiveRequirement(a.ws)).toBe(wsReq.id);
  });

  test('người dùng APPROVE khi phiên Claude đã đóng: lần gọi lại sang giai đoạn 2 ngay, không hỏi lại requirement/duyệt lại', async () => {
    const s = workspace('pending');
    markWorkflow(s.ws, wsReq.id);
    expect(nextStep(s.input()).stage).toBe('AWAITING_APPROVAL');
    approve(s.ws, wsReq, s.defs, { version: 1, hash: s.hash, by: 'Thanh', channel: 'web-review' });
    const step = nextStep(s.input());
    expect(step.stage).toBe('NEEDS_ENVIRONMENT');
    expect(step.checks.find((c) => c.name === 'Phê duyệt')).toMatchObject({ ok: true });
  });

  test('REVISE / REJECT đã ghi: điều phối đúng, không cho sang giai đoạn 2', () => {
    const s = workspace('pending');
    revise(s.ws, wsReq.id, 'Thanh', 'sửa bước 2', 'chat');
    expect(nextStep(s.input({ requirementId: wsReq.id })).stage).toBe('NEEDS_REVISION');
    const r = workspace('pending');
    reject(r.ws, wsReq.id, 'Thanh', 'không cần', 'chat');
    expect(nextStep(r.input({ requirementId: wsReq.id }))).toMatchObject({ stage: 'REJECTED', owner: 'user' });
  });

  test('test case bị sửa sau khi duyệt: phê duyệt mất hiệu lực ⇒ cần trình lại, không chạy tiếp', () => {
    const s = workspace('approved');
    const changed = s.defs.map((d, i) => (i === 0 ? { ...d, expectedResult: 'đã sửa sau khi duyệt' } : d));
    const step = nextStep(s.input({ requirementId: wsReq.id, defs: changed as TestCaseDef[] }));
    expect(step.stage).toBe('NEEDS_REVISION');
    expect(step.checks.find((c) => c.name === 'Phê duyệt')).toMatchObject({ ok: false });
  });

  test('lỗi cấu hình: môi trường thiếu URL ⇒ NEEDS_SETUP, chỉ nêu TÊN biến, không lộ giá trị bí mật', () => {
    const s = workspace('approved', { ENV_X: NOURL });
    const step = nextStep(s.input({ requirementId: wsReq.id }));
    expect(step).toMatchObject({ stage: 'NEEDS_SETUP', owner: 'user' });
    expect(JSON.stringify(step)).toMatch(/FAKE_ENV_X_URL/);
    expect(JSON.stringify(step)).not.toMatch(/n@example\.com/);
  });

  test('chuỗi trạng thái đầy đủ: môi trường → đăng nhập → thăm dò → tự động hóa → chạy → hoàn tất; mỗi xác nhận chỉ hỏi một lần', async () => {
    const s = workspace('approved');
    const id = wsReq.id;
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('NEEDS_ENVIRONMENT');
    expect((await s.confirmEnv()).ok).toBe(true); // người dùng bấm nút trên web (giả lập hộp thoại)
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('NEEDS_LOGIN');
    s.meta('accountant', true);
    // Tài khoản theo nhu cầu: test case chỉ dùng vai trò mặc định (accountant) ⇒ vai trò noaccess KHÔNG bị đòi đăng nhập.
    expect(nextStep(s.input({ requirementId: id })).checks.find((c) => c.name === 'Đăng nhập')).toMatchObject({ ok: true });
    // Không có probe (ứng dụng giả) và test case chưa có spec ⇒ cần tự động hóa
    const auto = nextStep(s.input({ requirementId: id }));
    expect(auto.stage).toBe('NEEDS_AUTOMATION');
    expect(auto.owner).toBe('claude');
    markWorkflow(s.ws, id, 'automation-done');
    expect(readWorkflow(s.ws).marks).toHaveProperty('automation-done');
    // Đã đánh dấu xong, không có spec nào ⇒ không còn gì để chạy ⇒ hoàn tất (báo cáo + cleanup)
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('RUN_COMPLETE');
    // Gọi lại: vẫn dùng lại xác nhận môi trường, không hỏi lại
    expect(nextStep(s.input({ requirementId: id })).checks.find((c) => c.name === 'Môi trường')).toMatchObject({ ok: true });
  });

  test('vai trò chỉ bị đòi khi test case dùng nó (metadata role): khi đó thiếu phiên ⇒ NEEDS_LOGIN, bổ sung xong ⇒ đi tiếp', async () => {
    const s = workspace('approved');
    const id = wsReq.id;
    fs.writeFileSync(path.join(s.ws, 'automation', 'odoo-sales', `${id}.automation.json`), JSON.stringify({
      requirementId: id,
      testCases: Object.fromEntries(s.defs.map((d, n) => [d.id, { access: 'READ', dataStrategy: 'EXISTING_READONLY', cleanup: 'NONE', ...(n === 0 ? { role: 'noaccess' } : {}) }])),
    }));
    await s.confirmEnv();
    s.meta('accountant', true);
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('NEEDS_LOGIN');
    s.meta('noaccess', true);
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('NEEDS_AUTOMATION');
  });

  test('đăng nhập lỗi (meta ok=false): LOGIN_FAILED, không có hành động tự động nào, không chuyển sang môi trường khác', async () => {
    const s = workspace('approved', { ENV_A: A, ENV_B: { ...A, url: 'https://b.example.com' } });
    await s.confirmEnv('ENV_A');
    s.meta('accountant', false, ['sai mật khẩu hoặc tài khoản không tồn tại']);
    s.meta('noaccess', true);
    const step = nextStep(s.input({ requirementId: wsReq.id }));
    expect(step).toMatchObject({ stage: 'LOGIN_FAILED', owner: 'user', actions: [] });
    expect(step.summary).toMatch(/ENV_A/);
    expect(step.summary).not.toMatch(/ENV_B/);
  });

  test('thăm dò và kết quả chạy trên đĩa: probe chưa chạy ⇒ NEEDS_PROBE; probe lỗi ⇒ PROBE_FAILED; có kết quả chạy ⇒ không chạy lại', async () => {
    const s = workspace('approved');
    const id = wsReq.id;
    await s.confirmEnv();
    s.meta('accountant', true);
    s.meta('noaccess', true);
    fs.mkdirSync(path.join(s.ws, 'applications', 'odoo'), { recursive: true });
    fs.writeFileSync(path.join(s.ws, 'applications', 'odoo', 'probe.ts'), '// giả lập: ứng dụng có thăm dò\n');
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('NEEDS_PROBE');
    const probeDir = path.join(process.env.QA_REPORTS_DIR!, 'probe');
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(path.join(probeDir, 'probe-1.json'), JSON.stringify({ blockers: 2 }));
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('PROBE_FAILED');
    fs.writeFileSync(path.join(probeDir, 'probe-2.json'), JSON.stringify({ blockers: 0 }));
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('NEEDS_AUTOMATION');
    // Có spec cho TC-E-001 nhưng chưa chạy ⇒ READY_TO_RUN; có kết quả của lần chạy ⇒ RUN_COMPLETE
    fs.mkdirSync(path.join(s.ws, 'tests', 'odoo-sales'), { recursive: true });
    fs.writeFileSync(path.join(s.ws, 'tests', 'odoo-sales', 'a.spec.ts'), "test(title('TC-E-001'), tcMeta('TC-E-001'), async () => {});\ntest(title('TC-E-002'), tcMeta('TC-E-002'), async () => {});\n");
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('READY_TO_RUN');
    const run = path.join(process.env.QA_REPORTS_DIR!, 'runs', '20261105-000001');
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify({ runId: '20261105-000001', entries: [{ tcId: 'TC-E-001' }, { tcId: 'TC-E-002' }] }));
    expect(nextStep(s.input({ requirementId: id })).stage).toBe('RUN_COMPLETE');
  });

  test('quyền ghi theo metadata thực thi: chưa khai báo ⇒ mặc định GHI; khai báo READ hợp lệ ⇒ không cần chính sách ghi; từ khóa "GHI" trong nội dung không còn ảnh hưởng', async () => {
    const s = workspace('approved');
    const input = s.input({ requirementId: wsReq.id });
    // Chưa có metadata: mặc định coi là GHI (chặn).
    fs.rmSync(path.join(s.ws, 'automation'), { recursive: true, force: true });
    expect(gatherFacts(input).needWrite).toBe(true);
    // Khai báo READ hợp lệ cho mọi test case: không cần chính sách ghi, không đổi nội dung test case ⇒ phê duyệt vẫn hợp lệ.
    const readAll = Object.fromEntries(s.defs.map((d) => [d.id, { access: 'READ', dataStrategy: 'EXISTING_READONLY', cleanup: 'NONE' }]));
    const dir = path.join(s.ws, 'automation', 'odoo-sales');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${wsReq.id}.automation.json`), JSON.stringify({ requirementId: wsReq.id, testCases: readAll }));
    const f = gatherFacts(input);
    expect(f.needWrite).toBe(false);
    expect(f.approvalState).toBe('APPROVED');
    // Chữ "GHI" trong preconditions KHÔNG còn quyết định quyền ghi (nhưng đổi nội dung làm mất hiệu lực phê duyệt như mọi thay đổi khác).
    const kw = s.defs.map((d, i) => (i === 0 ? { ...d, preconditions: ['Đây là test GHI (tạo SO mới)'] } : d)) as TestCaseDef[];
    expect(gatherFacts({ ...input, defs: kw }).needWrite).toBe(false);
    // Khai báo sai (READ nhưng có cleanup) ⇒ không tin, mặc định GHI.
    const bad = { ...readAll, [s.defs[0].id]: { access: 'READ', dataStrategy: 'FACTORY', cleanup: 'REGISTRY' } };
    fs.writeFileSync(path.join(dir, `${wsReq.id}.automation.json`), JSON.stringify({ requirementId: wsReq.id, testCases: bad }));
    expect(gatherFacts(input).needWrite).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('WF-3 Thiết lập lần đầu trên máy mới', () => {
  const apps = { odoo: ['accountant', 'noaccess'] };
  function repoCopy(extra: (dir: string) => void = () => undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-setup-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'node_modules', '@playwright', 'test'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), fs.readFileSync('.claude/settings.json'));
    fs.writeFileSync(path.join(dir, '.gitignore'), fs.readFileSync('.gitignore'));
    fs.writeFileSync(path.join(dir, '.env.example'), fs.readFileSync('.env.example'));
    extra(dir);
    return dir;
  }

  test('máy mới chưa có .env: báo việc cần làm; --init tạo .env từ mẫu (không ghi đè); chưa điền thì vẫn chưa sẵn sàng; không in giá trị bí mật', () => {
    const dir = repoCopy();
    const f = installFakeEnvironments(dir, { ENV_A: { ...A, url: undefined } });
    cleanups.push(f.restore);
    for (const k of Object.keys(f.vars)) delete process.env[k];
    const r1 = runSetup({ root: dir, apps, source: {}, nodeVersion: '20.1.0', browserInstalled: true });
    expect(r1.checks.find((c) => c.name === '.env')).toMatchObject({ ok: false, level: 'blocker' });
    expect(r1.userSteps.join(' ')).toMatch(/setup -- --init/);
    expect(r1.userSteps.at(-1)).toMatch(/\/qa-requirement/);
    const r2 = runSetup({ root: dir, apps, source: {}, init: true, nodeVersion: '20.1.0', browserInstalled: true });
    expect(r2.created).toEqual(['.env']);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(fs.readFileSync('.env.example', 'utf8'));
    fs.writeFileSync(path.join(dir, '.env'), 'GIU_NGUYEN=1\n');
    const r3 = runSetup({ root: dir, apps, source: {}, init: true, nodeVersion: '20.1.0', browserInstalled: true });
    expect(r3.created).toEqual([]); // không bao giờ ghi đè
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe('GIU_NGUYEN=1\n');
    expect(r3.checks.find((c) => c.name === 'Có ít nhất một môi trường dùng được')).toMatchObject({ ok: false });
    expect(JSON.stringify(r3)).not.toMatch(/Mk#fake|ke\.toan/);
  });

  test('đủ biến của một môi trường ⇒ sẵn sàng; thiếu trình duyệt, Node cũ, thiếu .gitignore, thiếu hook đều bị báo', () => {
    const dir = repoCopy();
    const f = installFakeEnvironments(dir, { ENV_A: A });
    cleanups.push(f.restore);
    fs.writeFileSync(path.join(dir, '.env'), '');
    const ok = runSetup({ root: dir, apps, source: process.env, nodeVersion: '20.1.0', browserInstalled: true });
    expect(ok.checks.filter((c) => !c.ok && c.level === 'blocker')).toEqual([]);
    expect(ok.checks.find((c) => c.name === 'Môi trường ENV_A')).toMatchObject({ ok: true });
    const bad = runSetup({ root: dir, apps, source: process.env, nodeVersion: '16.0.0', browserInstalled: false });
    expect(bad.checks.find((c) => c.name === 'Node.js')).toMatchObject({ ok: false });
    expect(bad.userSteps.join(' ')).toMatch(/playwright install chromium/);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    fs.rmSync(path.join(dir, '.claude', 'settings.json'));
    const weak = runSetup({ root: dir, apps, source: process.env, nodeVersion: '20.1.0', browserInstalled: true });
    expect(weak.checks.find((c) => c.name === '.gitignore')).toMatchObject({ ok: false });
    expect(weak.checks.find((c) => c.name.startsWith('Hook'))).toMatchObject({ ok: false });
  });

  test('.gitignore của repo chặn đủ mọi thứ nhạy cảm/cục bộ mà setup yêu cầu', () => {
    const lines = fs.readFileSync('.gitignore', 'utf8').split(/\r?\n/).map((l) => l.trim());
    for (const need of REQUIRED_IGNORE) expect(lines, `.gitignore thiếu "${need}"`).toContain(need);
    for (const need of ['testdata/fixtures/*.json', '!testdata/fixtures/*.example.json', 'baselines/']) expect(lines).toContain(need);
  });

  test('mã nguồn dùng chung không chứa URL staging thật, mật khẩu hay phiên: không có host riêng của người phát triển trong file được theo dõi', () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        if (['node_modules', 'reports', '.auth', '.playwright-mcp', '.qa-state', 'share', 'archive', 'baselines', 'test_results', 'docs', 'src', '_inbox', 'approvals', 'requirements', 'testcases'].includes(e.name) || (d === 'testdata' && e.name !== 'fixtures')) return [];
        if (e.isDirectory()) return walk(p);
        return /\.(ts|json|md|mjs)$/.test(e.name) && e.name !== 'package-lock.json' && !/\.example\.json$/.test(e.name) && !p.startsWith(path.join('testdata', 'fixtures') + path.sep) ? [p] : [];
      });
    const hostRe = /https?:\/\/(?!(?:[\w-]+\.)*(?:example\.(?:com|org|net)|localhost|127\.0\.0\.1|github\.com|docs\.|playwright\.dev|odoo\.com|nodejs\.org|microsoft\.com|anthropic\.com|claude\.ai|claude\.com|schemas\.|json-schema\.org|google\.com)\b)[\w.-]+\.(?:com|vn|net|io)/i;
    const offenders = walk('.').filter((f) => hostRe.test(fs.readFileSync(f, 'utf8')));
    expect(offenders, `URL thật trong file dùng chung: ${offenders.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('WF-4 Một điểm bắt đầu duy nhất: /qa-requirement mô tả đủ quy trình, các lệnh npm chỉ là phương án nâng cao', () => {
  const doc = fs.readFileSync('.claude/commands/qa-requirement.md', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts as Record<string, string>;

  test('lệnh /qa-requirement bắt đầu bằng qa:next và mô tả từng bước tự động, dừng chờ APPROVE, tiếp tục sau APPROVE', () => {
    expect(doc).toMatch(/npm run qa:next/);
    for (const needle of ['qa:review', 'qa:env-web', 'odoo:probe', 'mcp__playwright__', 'Page Object', 'Test Data Factory', 'qa:finish', 'cleanup', '--requirement=<REQ-ID>']) expect(doc, needle).toContain(needle);
    expect(doc).toMatch(/KHÔNG tự APPROVE/);
    expect(doc).toContain('Lưu khác Xác nhận nghiệp vụ'); // quy tắc mốc ghi nhận áp dụng khi sinh test case
    expect(doc).toContain('Assertion đúng mốc nghiệp vụ'); // và khi viết automation
    expect(fs.readFileSync('FRAMEWORK.md', 'utf8')).toContain('## 6A. Lưu dữ liệu và Xác nhận nghiệp vụ');
    expect(doc).toMatch(/gom MỘT lần/i);
  });

  test('các lệnh hiện có vẫn còn cho debug và vận hành nâng cao; có thêm qa:next và setup', () => {
    for (const s of ['qa:approval', 'qa:env', 'qa:policy', 'qa:review', 'qa:env-web', 'qa:ready', 'qa:finish', 'report:rebuild', 'report:verify', 'cleanup:run', 'odoo:probe', 'test', 'test:write', 'test:framework', 'req:import', 'req:check', 'qa:next', 'setup']) expect(pkg[s], s).toBeTruthy();
  });

  test('README/INSTALL có hướng dẫn bắt đầu nhanh cho người dùng mới: cài, thiết lập một lần, gõ /qa-requirement', () => {
    for (const f of ['README.md', 'INSTALL.md'].filter((x) => fs.existsSync(x))) { // README của dự án gốc không nằm trong bộ cài đặt dùng chung
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).toMatch(/npm run setup/);
      expect(text, f).toMatch(/\/qa-requirement/);
    }
  });

  test('qa:next và setup chạy được từ dòng lệnh trong thư mục sạch (chỉ đọc), không in bí mật', () => {
    const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const s = workspace('pending');
    fs.cpSync(path.join(process.cwd(), 'applications'), path.join(s.ws, 'applications'), { recursive: true });
    const env = { ...process.env, ...s.f.vars, QA_ENVIRONMENTS_DIR: s.f.envDir, QA_APPROVAL_KEY_FILE: s.keyFile, QA_AUTH_DIR: path.join(s.ws, '.auth') };
    const next = spawnSync(process.execPath, [tsx, path.join(process.cwd(), 'scripts', 'next.ts'), `--requirement=${wsReq.id}`, '--json'], { cwd: s.ws, env, encoding: 'utf8', timeout: 60_000 });
    expect(next.status, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({ requirementId: wsReq.id, stage: 'AWAITING_APPROVAL', owner: 'user' });
    expect(next.stdout).not.toMatch(/Mk#fake|ke\.toan/);
    expect(JSON.parse(fs.readFileSync(workflowFile(s.ws), 'utf8')).requirementId).toBe(wsReq.id); // ghi nhớ requirement đang dở
    const again = spawnSync(process.execPath, [tsx, path.join(process.cwd(), 'scripts', 'next.ts'), '--json'], { cwd: s.ws, env, encoding: 'utf8', timeout: 60_000 });
    expect(JSON.parse(again.stdout)).toMatchObject({ requirementId: wsReq.id, stage: 'AWAITING_APPROVAL' }); // gọi lại không cần nhập lại
  });
});

// ---------------------------------------------------------------------------------------------------------------------
test.describe('WF-5 Đầu-cuối /qa-requirement bằng dữ liệu giả (không staging)', () => {
  test('requirement → test case → trình duyệt → APPROVE giả (harness) → môi trường → chính sách ghi → đăng nhập → automation → chạy → QA Report → cleanup giả', async ({}, info) => {
    const prevReg = process.env.QA_REGISTRY_FILE;
    const s = workspace('pending');
    process.env.QA_REGISTRY_FILE = path.join(s.ws, 'testdata', 'registry.jsonl');
    cleanups.push(() => {
      if (prevReg === undefined) delete process.env.QA_REGISTRY_FILE;
      else process.env.QA_REGISTRY_FILE = prevReg;
    });
    const id = wsReq.id;
    const step = () => nextStep(s.input({ requirementId: id }));
    const stage = () => step().stage;

    // 1) Requirement + test case đã có và phủ đủ BR/AC; đã trình duyệt ⇒ DỪNG chờ người dùng (Claude không tự duyệt).
    expect(step()).toMatchObject({ stage: 'AWAITING_APPROVAL', owner: 'user' });

    // 2) Metadata thực thi: TC-E-001 chỉ đọc, TC-E-002 ghi bằng Factory (khai báo tách khỏi nội dung đã duyệt ⇒ phê duyệt vẫn hợp lệ).
    const amFile = path.join(s.ws, 'automation', 'odoo-sales', `${id}.automation.json`);
    fs.writeFileSync(amFile, JSON.stringify({
      requirementId: id,
      testCases: {
        'TC-E-001': { access: 'READ', role: 'accountant', dataStrategy: 'EXISTING_READONLY', cleanup: 'NONE' },
        'TC-E-002': { access: 'WRITE', role: 'accountant', dataStrategy: 'FACTORY', cleanup: 'REGISTRY' },
      },
    }));
    expect(stage()).toBe('AWAITING_APPROVAL');

    // 3) Phê duyệt GIẢ trong harness kiểm thử (khóa tạm, thư mục tạm) + mở phiên thực thi.
    approve(s.ws, wsReq, s.defs, { version: 1, hash: s.hash, by: 'Harness' });
    beginExecution(s.ws, wsReq, s.defs);
    expect(stage()).toBe('NEEDS_ENVIRONMENT');

    // 4) Chọn + xác nhận môi trường, rồi chính sách ghi (vì có test ghi) bằng đúng hàm của giao diện web.
    await s.confirmEnv();
    expect(stage()).toBe('NEEDS_WRITE_POLICY');
    const ctx = { root: s.ws, app: 'odoo', requirement: wsReq, defs: s.defs as TestCaseDef[] };
    const pol = await processEnvDecision(ctx, { action: 'CONFIRM_POLICY', environment: 'ENV_A', by: 'Harness' }, yes);
    expect(pol.status).toBe(200);

    // 5) Đăng nhập (phiên giả) → tự động hóa → sẵn sàng chạy.
    expect(stage()).toBe('NEEDS_LOGIN');
    s.meta('accountant', true);
    s.meta('noaccess', true);
    expect(stage()).toBe('NEEDS_AUTOMATION');
    fs.mkdirSync(path.join(s.ws, 'tests', 'odoo-sales'), { recursive: true });
    fs.writeFileSync(path.join(s.ws, 'tests', 'odoo-sales', 'e2e.spec.ts'), "test(title('TC-E-001'), tcMeta('TC-E-001'), async () => {});\ntest(title('TC-E-002'), tcMeta('TC-E-002'), async () => { writeGuard(); });\n");
    expect(step()).toMatchObject({ stage: 'READY_TO_RUN', owner: 'claude' });
    expect(step().actions[0]).toMatch(/test:write -- --requirement=REQ-E-001/); // có test ghi ⇒ đường dẫn ghi có chính sách

    // 6) Tạo dữ liệu giả bằng Test Data Factory (ORM giả trong bộ nhớ) cho TC-E-002; ghi vào registry theo môi trường.
    const RUN = '20261105-120000';
    const orm = new FakeOrm(500);
    const factory = new DataFactory({ rpc: orm, recipes: odooRecipes, scope: { application: 'odoo', module: 'sales', environment: 'ENV_A', runId: RUN, requirementId: id, testCaseId: 'TC-E-002' }, writeProblems: () => [], maxRecordsPerRun: 50 });
    const h = await factory.build(salesPlan({ amount: 1000 }));
    expect(loadRegistry().filter((r) => r.runId === RUN && r.environment === 'ENV_A').length).toBeGreaterThanOrEqual(3);

    // 7) Kết quả chạy giả (video/ảnh theo trạng thái) rồi qa:finish: dựng + đối chiếu JSON/HTML/QA Summary/Bug Report.
    const runDir = path.join(process.env.QA_REPORTS_DIR!, 'runs', RUN);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    for (const f of ['v1.webm', 'v2.webm', 's2.png']) fs.writeFileSync(path.join(runDir, 'artifacts', f), 'giả');
    const entry = (d: TestCaseDef, status: string, extra: object) => ({ tcId: d.id, defHash: defHash(d), status, actual: `thực tế ${d.id}`, durationMs: 10, ...extra });
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({
      runId: RUN, startedAt: '2026-11-05T12:00:00.000Z', finishedAt: '2026-11-05T12:01:00.000Z', baseURL: 'https://a.example.com', environment: 'ENV_A', writesEnabled: true,
      entries: [
        entry(s.defs[0], 'PASS', { evidence: { video: 'artifacts/v1.webm', screenshots: [] } }),
        entry(s.defs[1], 'FAIL', { evidence: { video: 'artifacts/v2.webm', screenshots: ['artifacts/s2.png'] }, error: { message: 'expect(locator).toBeVisible() failed', failedStep: 'bước 2' } }),
      ],
    }));
    expect(stage()).toBe('RUN_COMPLETE');
    const fin = spawnSync(process.execPath, [path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(process.cwd(), 'scripts', 'qa-finish.ts'), '--env=ENV_A', `--requirement=${id}`, '--no-open'], { cwd: s.ws, env: { ...process.env, CLAUDE_PROJECT_DIR: s.ws }, encoding: 'utf8' });
    expect(fin.status, fin.stderr).toBe(0);
    expect(fin.stdout).toMatch(/KẾT QUẢ: JSON, HTML, QA Summary và Bug Report khớp nhau/);
    const html = fs.readFileSync(path.join(s.ws, 'reports', 'ENV_A', 'qa-report.html'), 'utf8');
    const card = (tc: string) => html.split('<article class="tc').find((c) => c.includes(`id="tc-${tc}"`)) ?? '';
    expect(card('TC-E-001')).not.toContain('class="shot'); // PASS: chỉ video
    expect(card('TC-E-002')).toContain('class="shot'); // FAIL: video + ảnh
    expect(fs.existsSync(path.join(s.ws, 'reports', 'ENV_A', 'bugs.json'))).toBe(true);

    // 8) Cleanup GIẢ sau khi có QA Report: dry-run không đổi gì, rồi dọn đúng dữ liệu framework trên ORM giả. Kết quả test không đổi.
    const results = fs.readFileSync(path.join(runDir, 'results.json'), 'utf8');
    const opts = { client: orm as unknown as OdooClient, handlers: odooFactoryCleanupHandlers, records: loadRegistry(), environment: 'ENV_A', policy: { write: 'framework-data', autoCleanup: true, failureRetentionHours: 48, maxRecordsPerRun: 200 }, runId: RUN } as unknown as Parameters<typeof runCleanup>[0];
    const before = orm.calls.length;
    const dry = await runCleanup({ ...opts, dryRun: true } as typeof opts);
    expect(dry.outcomes.length).toBeGreaterThan(0);
    expect(orm.calls.slice(before).filter((c) => !['search_read', 'search_count', 'read'].includes(c.method))).toHaveLength(0);
    const real = await runCleanup(opts);
    expect(real.counts.CLEANUP_BLOCKED).toBe(0);
    expect(orm.find('sale.order', h.so.id)?.state ?? 'cancel').toBe('cancel');
    expect(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8')).toBe(results);
    await info.attach('qa-report-e2e.html', { body: html, contentType: 'text/html' });
  });
});
