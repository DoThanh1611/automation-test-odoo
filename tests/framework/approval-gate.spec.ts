import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { approve, evaluate, evaluateAndSync, readRecord, recordFile, reject, revise, submit, testSetHash, versionDir } from '../../core/approval/approval';
import { beginExecution, endExecution, executionProblem, gateForRun, markerFile, tcApprovalProblem } from '../../core/approval/gate';
import { grantProblems } from '../../core/testdata/write-guard';
import { resolveEnvironment } from '../../core/environment/config';
import { confirmExecution, confirmPhrase, selectEnvironment } from '../../core/environment/state';
import { installFakeEnvironments } from './helpers/fake-env';
import { sha256, writeLock } from '../../core/testcases/lock';
import type { Requirement, TestCaseDef } from '../../core/testcases/schema';

// Framework tests cho Approval Gate. KHÔNG kết nối Odoo/staging, không ghi dữ liệu nghiệp vụ; mọi file nằm trong thư mục tạm.

const req: Requirement = {
  id: 'REQ-G-001', title: 'Requirement thử Approval Gate', application: 'odoo', module: 'sales', businessRequirement: 'b',
  businessRules: [{ id: 'BR-01', text: 'a' }], acceptanceCriteria: [{ id: 'AC-01', text: 'c' }],
};
const mkDef = (id: string, over: Partial<TestCaseDef> = {}): TestCaseDef => ({
  id, title: `Tiêu đề ${id}`, requirementRefs: ['BR-01', 'AC-01'], description: 'mô tả', preconditions: ['điều kiện'], testData: { k: 1 }, steps: ['bước 1', 'bước 2'],
  expectedResult: `kết quả ${id}`, verification: 'UI', automated: false, requirementId: req.id, application: 'odoo', module: 'sales', ...over,
});
const base = (): TestCaseDef[] => [mkDef('TC-G-001'), mkDef('TC-G-002'), mkDef('TC-G-003', { module: 'inventory', requirementRefs: ['AC-01'] })];

const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const scripts = (n: string) => path.join(process.cwd(), 'scripts', n);

let root: string;
let keyFile: string;
const prevKey = process.env.QA_APPROVAL_KEY_FILE;

test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-appr-'));
  keyFile = path.join(root, 'test-approval.key');
  process.env.QA_APPROVAL_KEY_FILE = keyFile;
});
test.afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
  else process.env.QA_APPROVAL_KEY_FILE = prevKey;
});

const approved = (defs = base()) => {
  const s = submit(root, req, defs);
  approve(root, req, defs, { version: s.record.version, hash: s.record.hash, by: 'Người duyệt A' });
  return readRecord(root, req.id)!;
};

test.describe('Approval Gate: chưa duyệt (GATE-1)', () => {
  test('chưa trình duyệt: không hợp lệ, cổng chạy từ chối, từng test case bị chặn', () => {
    const defs = base();
    expect(evaluate(root, req, defs)).toMatchObject({ state: 'NOT_SUBMITTED', ok: false });
    const g = gateForRun(root, [req], defs, ['odoo-sales']);
    expect(g.ok).toBe(false);
    expect(g.problems.join('|')).toMatch(/NOT_SUBMITTED/);
    expect(tcApprovalProblem('TC-G-001', root, [req], defs)).toMatch(/NOT_SUBMITTED/);
    expect(() => beginExecution(root, req, defs)).toThrow(/Không được bắt đầu thực thi/);
  });

  test('submit tạo PENDING_APPROVAL + Markdown theo module + bản chụp; vẫn chưa được chạy', () => {
    const defs = base();
    const res = submit(root, req, defs);
    expect(res.created).toBe(true);
    expect(res.record).toMatchObject({ status: 'PENDING_APPROVAL', version: 1, hash: testSetHash(defs, req) });
    const dir = versionDir(root, req.id, 1);
    expect(fs.readdirSync(dir).sort()).toEqual(['REVIEW.md', 'odoo-inventory.testcases.md', 'odoo-sales.testcases.md', 'testcases.snapshot.json']);
    const sales = fs.readFileSync(path.join(dir, 'odoo-sales.testcases.md'), 'utf8');
    for (const s of ['TC-G-001', 'TC-G-002', 'kết quả TC-G-001', 'bước 1', 'v1', res.record.hash]) expect(sales).toContain(s);
    expect(sales).not.toContain('TC-G-003');
    expect(fs.readFileSync(path.join(dir, 'odoo-inventory.testcases.md'), 'utf8')).toContain('TC-G-003');
    const review = fs.readFileSync(path.join(dir, 'REVIEW.md'), 'utf8');
    expect(review).toContain(`--version=1 --hash=${res.record.hash}`);
    expect(review).toMatch(/không cấp quyền ghi|APPROVE không cấp quyền ghi/);
    expect(evaluate(root, req, defs)).toMatchObject({ state: 'PENDING_APPROVAL', ok: false });
    expect(gateForRun(root, [req], defs).ok).toBe(false);
    expect(() => beginExecution(root, req, defs)).toThrow();
  });

  test('gọi lại submit khi chưa đổi gì: giữ nguyên phiên bản, không tạo bản trùng', () => {
    const defs = base();
    submit(root, req, defs);
    const again = submit(root, req, defs);
    expect(again.created).toBe(false);
    expect(again.record.version).toBe(1);
    expect(readRecord(root, req.id)!.history.filter((h) => h.action === 'SUBMIT')).toHaveLength(1);
  });

  test('test case sửa khi đang chờ duyệt: PENDING_STALE, không duyệt được phiên bản cũ', () => {
    const defs = base();
    const s = submit(root, req, defs);
    const changed = base();
    changed[0].expectedResult = 'đổi';
    expect(evaluate(root, req, changed).state).toBe('PENDING_STALE');
    expect(() => approve(root, req, changed, { version: 1, hash: s.record.hash, by: 'A' })).toThrow(/đã thay đổi sau khi trình duyệt/);
  });
});

test.describe('Approval Gate: đã duyệt (GATE-2)', () => {
  test('APPROVE phải đúng phiên bản + hash + có tên người duyệt', () => {
    const defs = base();
    const s = submit(root, req, defs);
    expect(() => approve(root, req, defs, { version: 2, hash: s.record.hash, by: 'A' })).toThrow(/phiên bản đang chờ/);
    expect(() => approve(root, req, defs, { version: 1, hash: 'f'.repeat(64), by: 'A' })).toThrow(/Hash APPROVE không khớp/);
    expect(() => approve(root, req, defs, { version: 1, hash: s.record.hash, by: '  ' })).toThrow(/tên người duyệt/);
    expect(evaluate(root, req, defs).ok).toBe(false);
  });

  test('APPROVE hợp lệ: cổng mở, ghi người duyệt/thời gian/phiên bản/hash, lịch sử đủ; phiên thực thi mở được', () => {
    const defs = base();
    const rec = approved(defs);
    const ev = evaluate(root, req, defs);
    expect(ev).toMatchObject({ state: 'APPROVED', ok: true });
    expect(rec.approval).toMatchObject({ version: 1, hash: testSetHash(defs, req), by: 'Người duyệt A' });
    expect(Date.parse(rec.approval!.at)).toBeGreaterThan(0);
    expect(rec.history.map((h) => h.action)).toEqual(['SUBMIT', 'APPROVE']);
    expect(gateForRun(root, [req], defs, ['odoo-sales']).ok).toBe(true);
    expect(tcApprovalProblem('TC-G-001', root, [req], defs)).toBeUndefined();
    const m = beginExecution(root, req, defs);
    expect(m).toMatchObject({ requirementId: req.id, version: 1 });
    expect(executionProblem(root, [req], defs)).toBeUndefined();
    endExecution(root);
    expect(executionProblem(root, [req], defs)).toMatch(/Chưa có phiên thực thi/);
  });

  test('chỉ đổi `automated` (viết script sau duyệt) KHÔNG hủy phê duyệt', () => {
    const defs = base();
    approved(defs);
    const afterAutomation = base().map((d) => ({ ...d, automated: true }));
    expect(evaluate(root, req, afterAutomation)).toMatchObject({ state: 'APPROVED', ok: true });
  });

  test('APPROVE không cấp quyền ghi: write-guard hoàn toàn độc lập với phê duyệt', () => {
    approved();
    const problems = grantProblems({ allowWrite: false, grant: undefined, host: 'staging.example.com', module: 'odoo-sales', runId: 'r1' });
    expect(problems.length).toBeGreaterThan(0);
    const src = fs.readFileSync(path.join(process.cwd(), 'core', 'testdata', 'write-guard.ts'), 'utf8');
    expect(src).not.toMatch(/approval/i);
  });
});

test.describe('Approval Gate: sửa sau khi duyệt (GATE-3)', () => {
  test('sửa test case sau duyệt: tự hủy phê duyệt, ghi INVALIDATE, cổng đóng, phiên thực thi bị chặn', () => {
    const defs = base();
    approved(defs);
    beginExecution(root, req, defs);
    const changed = base();
    changed[1].steps = [...changed[1].steps, 'bước thêm sau khi duyệt'];
    const ev = evaluateAndSync(root, req, changed);
    expect(ev).toMatchObject({ state: 'INVALIDATED', ok: false });
    expect(readRecord(root, req.id)).toMatchObject({ status: 'INVALIDATED' });
    expect(readRecord(root, req.id)!.history.map((h) => h.action)).toEqual(['SUBMIT', 'APPROVE', 'INVALIDATE']);
    expect(gateForRun(root, [req], changed).ok).toBe(false);
    expect(tcApprovalProblem('TC-G-002', root, [req], changed)).toMatch(/INVALIDATED/);
    expect(executionProblem(root, [req], changed)).toMatch(/INVALIDATED/);
    expect(fs.existsSync(markerFile(root))).toBe(true); // marker còn nhưng không còn đủ điều kiện
  });

  test('thêm/xóa/đổi tên test case cũng hủy phê duyệt', () => {
    const defs = base();
    approved(defs);
    expect(evaluate(root, req, [...defs, mkDef('TC-G-004')]).ok).toBe(false);
    expect(evaluate(root, req, defs.slice(1)).ok).toBe(false);
    const renamed = base();
    renamed[0].title = 'đổi tên';
    expect(evaluate(root, req, renamed).ok).toBe(false);
  });

  test('duyệt lại sau khi sửa: phiên bản v2, v1 và lịch sử vẫn còn', () => {
    const defs = base();
    approved(defs);
    const changed = base();
    changed[0].expectedResult = 'mong đợi mới';
    evaluateAndSync(root, req, changed);
    const s2 = submit(root, req, changed);
    expect(s2.record).toMatchObject({ status: 'PENDING_APPROVAL', version: 2 });
    expect(fs.existsSync(path.join(versionDir(root, req.id, 1), 'odoo-sales.testcases.md'))).toBe(true);
    const snap1 = JSON.parse(fs.readFileSync(path.join(versionDir(root, req.id, 1), 'testcases.snapshot.json'), 'utf8'));
    expect(snap1.testCases[0].expectedResult).toBe('kết quả TC-G-001'); // test case cũ không bị mất
    expect(evaluate(root, req, changed).ok).toBe(false);
    approve(root, req, changed, { version: 2, hash: s2.record.hash, by: 'Người duyệt B' });
    const ev = evaluate(root, req, changed);
    expect(ev.ok).toBe(true);
    expect(ev.record!.approval).toMatchObject({ version: 2, by: 'Người duyệt B' });
    expect(ev.record!.history.map((h) => h.action)).toEqual(['SUBMIT', 'APPROVE', 'INVALIDATE', 'SUBMIT', 'APPROVE']);
  });

  test('bản ghi bị sửa tay / giả mạo / thiếu khoá đều không được coi là đã duyệt', () => {
    const defs = base();
    approved(defs);
    const file = recordFile(root, req.id);
    const good = fs.readFileSync(file, 'utf8');
    const forged = JSON.parse(good);
    forged.approval.by = 'Kẻ giả mạo';
    fs.writeFileSync(file, JSON.stringify(forged));
    expect(evaluate(root, req, defs)).toMatchObject({ state: 'SIGNATURE_INVALID', ok: false });
    // tự viết APPROVED từ PENDING mà không có chữ ký hợp lệ
    fs.writeFileSync(file, good);
    fs.rmSync(keyFile);
    expect(evaluate(root, req, defs)).toMatchObject({ state: 'KEY_MISSING', ok: false });
    // tạo khoá mới (máy khác) cũng không xác minh được chữ ký cũ
    fs.writeFileSync(keyFile, 'ab'.repeat(32));
    expect(evaluate(root, req, defs)).toMatchObject({ state: 'SIGNATURE_INVALID', ok: false });
    const noSig = JSON.parse(good);
    delete noSig.approval;
    fs.writeFileSync(file, JSON.stringify(noSig));
    expect(evaluate(root, req, defs).ok).toBe(false);
  });
});

test.describe('Approval Gate: REVISE và REJECT (GATE-4)', () => {
  test('REVISE: bắt buộc nhận xét, không mất test case cũ, không chạy được, phải sửa mới trình lại', () => {
    const defs = base();
    submit(root, req, defs);
    expect(() => revise(root, req.id, 'Người duyệt', '  ')).toThrow(/nhận xét/);
    const rec = revise(root, req.id, 'Người duyệt', 'Thiếu trường hợp thiếu Số pin');
    expect(rec.status).toBe('REVISION_REQUESTED');
    expect(rec.history.at(-1)).toMatchObject({ action: 'REVISE', by: 'Người duyệt', comment: 'Thiếu trường hợp thiếu Số pin' });
    expect(fs.existsSync(path.join(versionDir(root, req.id, 1), 'testcases.snapshot.json'))).toBe(true);
    expect(evaluate(root, req, defs)).toMatchObject({ state: 'REVISION_REQUESTED', ok: false });
    expect(gateForRun(root, [req], defs).ok).toBe(false);
    expect(() => submit(root, req, defs)).toThrow(/chưa thay đổi/);
    const revised = [...defs, mkDef('TC-G-004')];
    const s2 = submit(root, req, revised);
    expect(s2.record).toMatchObject({ status: 'PENDING_APPROVAL', version: 2 });
    expect(JSON.parse(fs.readFileSync(path.join(versionDir(root, req.id, 1), 'testcases.snapshot.json'), 'utf8')).testCases).toHaveLength(3);
  });

  test('REVISE được cả khi đã APPROVE: rút lại phê duyệt', () => {
    const defs = base();
    approved(defs);
    revise(root, req.id, 'Người duyệt', 'Rút lại, cần xem lại');
    expect(evaluate(root, req, defs)).toMatchObject({ state: 'REVISION_REQUESTED', ok: false });
    expect(readRecord(root, req.id)!.approval).toBeUndefined();
  });

  test('REJECT: không thực thi, không trình lại bản y nguyên, trình lại được khi test case đã đổi', () => {
    const defs = base();
    submit(root, req, defs);
    expect(() => reject(root, req.id, '', 'lý do')).toThrow(/tên/);
    expect(() => reject(root, req.id, 'Người duyệt', '')).toThrow(/lý do/);
    const rec = reject(root, req.id, 'Người duyệt', 'Không đúng phạm vi');
    expect(rec.status).toBe('REJECTED');
    expect(evaluate(root, req, defs)).toMatchObject({ state: 'REJECTED', ok: false });
    expect(gateForRun(root, [req], defs).ok).toBe(false);
    expect(() => approve(root, req, defs, { version: 1, hash: rec.hash, by: 'A' })).toThrow(/chỉ APPROVE được khi PENDING_APPROVAL/);
    expect(() => submit(root, req, defs)).toThrow(/bị từ chối/);
    expect(fs.existsSync(path.join(versionDir(root, req.id, 1), 'odoo-sales.testcases.md'))).toBe(true);
    const s2 = submit(root, req, [...defs, mkDef('TC-G-005')]);
    expect(s2.record.version).toBe(2);
  });
});

test.describe('Approval Gate: thực thi bằng code (GATE-5)', () => {
  function workspace(withApproval: boolean) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-gate-ws-'));
    fs.mkdirSync(path.join(ws, 'requirements', 'odoo-sales'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'testcases', 'odoo-sales'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'requirements', 'odoo-sales', `${req.id}.json`), JSON.stringify(req));
    writeLock(path.join(ws, 'requirements', 'odoo-sales', `${req.id}.json`));
    const defs = [mkDef('TC-G-001'), mkDef('TC-G-002')];
    fs.writeFileSync(path.join(ws, 'testcases', 'odoo-sales', `${req.id}.testcases.json`), JSON.stringify({ requirementId: req.id, testCases: defs.map(({ requirementId, application, module, ...d }) => d) }));
    const keyF = path.join(ws, 'k.key');
    const env = { ...process.env, QA_APPROVAL_KEY_FILE: keyF, CLAUDE_PROJECT_DIR: ws };
    if (withApproval) {
      const prev = process.env.QA_APPROVAL_KEY_FILE;
      process.env.QA_APPROVAL_KEY_FILE = keyF;
      try {
        const loaded = defs.map((d) => ({ ...d }));
        const s = submit(ws, req, loaded);
        approve(ws, req, loaded, { version: 1, hash: s.record.hash, by: 'A' });
        beginExecution(ws, req, loaded);
        // Môi trường GIẢ: chọn + xác nhận thực thi riêng (hook MCP yêu cầu thêm bước này ngoài phê duyệt).
        const fake = installFakeEnvironments(ws, { TEST_ENV: { url: 'https://env-a.example.com', version: '18.0', roles: { accountant: { user: 'a@example.com', pass: 'p' } } } });
        try {
          const r = resolveEnvironment('odoo', 'TEST_ENV');
          if (!r.ok) throw new Error(r.problems.join('; '));
          selectEnvironment(ws, 'odoo', 'TEST_ENV');
          confirmExecution(ws, { env: r.env, requirementId: req.id, approvalHash: s.record.hash, by: 'A', typed: confirmPhrase(r.env) });
          Object.assign(env, fake.vars);
        } finally {
          fake.restore();
        }
      } finally {
        if (prev === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
        else process.env.QA_APPROVAL_KEY_FILE = prev;
      }
    }
    return { ws, env, defs };
  }
  const hook = (ws: string, env: NodeJS.ProcessEnv, tool: string) =>
    spawnSync(process.execPath, [tsx, scripts('approval.ts'), 'hook'], { cwd: ws, env, input: JSON.stringify({ tool_name: tool }), encoding: 'utf8' });

  test('hook chặn Playwright MCP khi chưa duyệt (exit 2), cho qua công cụ khác', () => {
    const { ws, env } = workspace(false);
    try {
      const blocked = hook(ws, env, 'mcp__playwright__browser_navigate');
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toMatch(/APPROVAL GATE: chặn mcp__playwright__browser_navigate/);
      expect(hook(ws, env, 'Read').status).toBe(0);
      expect(hook(ws, env, 'mcp__claude_ai_Odoo_MO__odoo_search_read').status).toBe(0); // hook chỉ áp dụng cho Playwright MCP
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('hook cho qua khi đã duyệt + có phiên thực thi; chặn lại ngay khi test case bị sửa', () => {
    const { ws, env } = workspace(true);
    try {
      expect(hook(ws, env, 'mcp__playwright__browser_navigate').status).toBe(0);
      const withBom = spawnSync(process.execPath, [tsx, scripts('approval.ts'), 'hook'], { cwd: ws, env, input: '\uFEFF{"tool_name":"mcp__playwright__browser_click"}', encoding: 'utf8' });
      expect(withBom.status, withBom.stderr).toBe(0); // đầu vào có BOM (PowerShell) vẫn đọc được
      const f = path.join(ws, 'testcases', 'odoo-sales', `${req.id}.testcases.json`);
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      j.testCases[0].expectedResult = 'đã bị sửa sau khi duyệt';
      fs.writeFileSync(f, JSON.stringify(j));
      const r = hook(ws, env, 'mcp__playwright__browser_click');
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/INVALIDATED/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('hook fail-closed: dữ liệu vào hỏng cũng chặn', () => {
    const { ws, env } = workspace(true);
    try {
      const r = spawnSync(process.execPath, [tsx, scripts('approval.ts'), 'hook'], { cwd: ws, env, input: '{không phải json', encoding: 'utf8' });
      expect(r.status).toBe(2);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('npm test (run-tests.ts) từ chối chạy khi chưa duyệt: thoát mã 3, chưa khởi động Playwright', () => {
    const { ws, env } = workspace(false);
    try {
      const r = spawnSync(process.execPath, [tsx, scripts('run-tests.ts'), '--project=odoo-sales'], { cwd: ws, env, encoding: 'utf8' });
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/APPROVAL GATE: TỪ CHỐI chạy test/);
      expect(r.stderr).toMatch(/NOT_SUBMITTED/);
      expect(fs.existsSync(path.join(ws, 'reports'))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('npm run test:write cũng bị chặn bởi Approval Gate trước cả bước xác nhận quyền ghi', () => {
    const { ws, env } = workspace(false);
    try {
      fs.mkdirSync(path.join(ws, 'tests', 'odoo-sales'), { recursive: true });
      const r = spawnSync(process.execPath, [tsx, scripts('run-tests.ts'), '--write', '--module=odoo-sales', '--confirm-host=x'], { cwd: ws, env, encoding: 'utf8' });
      expect(r.status).toBe(3);
      expect(r.stderr).toMatch(/APPROVAL GATE/);
      expect(r.stdout).not.toMatch(/CHẾ ĐỘ GHI DỮ LIỆU/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('APPROVE từ lệnh CLI không bàn phím (Claude/tự động hóa) bị từ chối, trạng thái không đổi', () => {
    const { ws, env } = workspace(false);
    try {
      const run = (...a: string[]) => spawnSync(process.execPath, [tsx, scripts('approval.ts'), ...a], { cwd: ws, env, encoding: 'utf8', input: '' });
      const sub = run('submit', `--requirement=${req.id}`);
      expect(sub.status, sub.stdout + sub.stderr).toBe(0);
      expect(sub.stdout).toMatch(/PENDING_APPROVAL/);
      expect(sub.stdout).toMatch(/odoo-sales\.testcases\.md/);
      expect(sub.stdout).toMatch(/DỪNG: chưa được kết nối staging/);
      const hash = readRecord(ws, req.id)!.hash;
      const ap = run('approve', `--requirement=${req.id}`, '--version=1', `--hash=${hash}`, '--by=Claude');
      expect(ap.status).toBe(2);
      expect(ap.stderr).toMatch(/NGƯỜI DÙNG/);
      expect(readRecord(ws, req.id)!.status).toBe('PENDING_APPROVAL');
      // gọi lại submit: vẫn đúng trạng thái đang chờ, không phiên bản mới
      const again = run('submit', `--requirement=${req.id}`);
      expect(again.stdout).toMatch(/không tạo phiên bản mới/);
      // REVISE qua CLI được (chỉ thu hẹp quyền) và ghi người/nhận xét
      const rv = run('revise', `--requirement=${req.id}`, '--by=Người duyệt', '--comment=Cần thêm trường hợp', '--channel=chat');
      expect(rv.status, rv.stderr).toBe(0);
      expect(readRecord(ws, req.id)!.history.at(-1)).toMatchObject({ action: 'REVISE', by: 'Người duyệt', channel: 'chat' });
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('chạy thẳng playwright (không qua run-tests) không thấy project kết nối staging', () => {
    const cli = path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.QA_APPROVAL_GATE;
    const r = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json'], { cwd: process.cwd(), env, encoding: 'utf8' });
    const projects = new Set((JSON.parse(r.stdout).suites as { suites?: unknown[]; specs?: unknown[] }[]).length ? [...r.stdout.matchAll(/"projectName":\s*"([^"]+)"/g)].map((m) => m[1]) : []);
    expect([...projects]).toEqual(['framework']);
    const forced = spawnSync(process.execPath, [cli, 'test', '--list', '--project=setup-odoo'], { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(forced.status).not.toBe(0);
    expect(forced.stdout + forced.stderr).toMatch(/not found|không/i);
  });
});

test.describe('Gọi lại lệnh không tạo requirement trùng (GATE-6)', () => {
  const importScript = scripts('req-import.ts');
  const RAW = ['Tiêu đề', 'Path: Menu A', 'Business Requirement', 'x', 'Expected Solution', 'y', 'Business Rules', 'BR-01: a', 'Acceptance Criteria', 'AC-01: c'].join('\n') + '\n';
  test('cùng nội dung nguồn nhập lần hai (kể cả mã khác): báo đã nhập, không tạo requirement mới, thoát 0', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resume-'));
    try {
      for (const d of ['tests/odoo-x', 'requirements/odoo-x', 'testcases/odoo-x']) fs.mkdirSync(path.join(ws, d), { recursive: true });
      const src = path.join(ws, 's.md');
      fs.writeFileSync(src, RAW);
      const run = (...a: string[]) => spawnSync(process.execPath, [tsx, importScript, ...a], { cwd: ws, encoding: 'utf8' });
      expect(run('odoo', 'x', src, '--id=REQ-R-001').status).toBe(0);
      const before = fs.readdirSync(path.join(ws, 'requirements/odoo-x')).sort();
      for (const id of ['REQ-R-001', 'REQ-R-002']) {
        const again = run('odoo', 'x', src, `--id=${id}`);
        expect(again.status, again.stderr).toBe(0);
        expect(again.stdout).toMatch(/ĐÃ NHẬP TRƯỚC ĐÓ.*REQ-R-001/);
        expect(again.stdout).toContain(sha256(Buffer.from(RAW)));
      }
      expect(fs.readdirSync(path.join(ws, 'requirements/odoo-x')).sort()).toEqual(before);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
