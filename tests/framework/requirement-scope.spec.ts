import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { approve, evaluate, submit } from '../../core/approval/approval';
import { gateForRun, tcApprovalProblem } from '../../core/approval/gate';
import { SCOPE_ENV, resolveRunScope, scopeFromEnv, scopeGateProblems, scopeGrep, tcScopeProblem } from '../../core/approval/scope';
import QaReporter from '../../core/reporters/qa-reporter';
import { buildFocus } from '../../core/reporters/focus';
import type { TcResult } from '../../core/reporters/types';
import { loadRequirements, loadTestCases } from '../../core/testcases/loader';
import type { Requirement, TestCaseDef } from '../../core/testcases/schema';

// Chạy độc lập theo Requirement ID. Toàn dữ liệu giả trong thư mục tạm: KHÔNG kết nối Odoo/staging, không đụng approvals/ thật.

const mkReq = (id: string): Requirement => ({
  id, title: `Requirement ${id}`, application: 'odoo', module: 'sales', businessRequirement: 'b',
  businessRules: [{ id: 'BR-01', text: 'a' }], acceptanceCriteria: [{ id: 'AC-01', text: 'c' }],
});
const reqA = mkReq('REQ-S-A');
const reqB = mkReq('REQ-S-B');
const mkDef = (req: Requirement, id: string, module = 'sales'): TestCaseDef => ({
  id, title: `Tiêu đề ${id}`, requirementRefs: ['BR-01', 'AC-01'], description: 'mô tả', preconditions: ['điều kiện'], testData: { k: 1 }, steps: ['bước 1', 'bước 2'],
  expectedResult: `kết quả ${id}`, verification: 'UI', automated: true, requirementId: req.id, application: 'odoo', module,
});
// Hai requirement CÙNG module odoo-sales; A còn có một test case ở module khác. Có ID là tiền tố của ID khác (TC-S-1 / TC-S-10).
const defs = (): TestCaseDef[] => [mkDef(reqA, 'TC-S-1'), mkDef(reqA, 'TC-S-2'), mkDef(reqA, 'TC-S-3', 'inventory'), mkDef(reqB, 'TC-S-10'), mkDef(reqB, 'TC-S-11')];

let root: string;
const prevKey = process.env.QA_APPROVAL_KEY_FILE;
test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-scope-'));
  process.env.QA_APPROVAL_KEY_FILE = path.join(root, 'k.key');
});
test.afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
  else process.env.QA_APPROVAL_KEY_FILE = prevKey;
});
const approveReq = (req: Requirement) => {
  const mine = defs().filter((d) => d.requirementId === req.id);
  const s = submit(root, req, mine);
  approve(root, req, mine, { version: s.record.version, hash: s.record.hash, by: 'Người duyệt' });
};

test.describe('SCOPE-1 Xác định phạm vi', () => {
  test('--requirement: chỉ requirement đó và các project có test case của nó; không kéo theo requirement khác cùng module', () => {
    const r = resolveRunScope([reqA, reqB], defs(), { requirement: 'REQ-S-A' });
    expect(r.problems).toEqual([]);
    expect(r.scope).toEqual({ requirement: 'REQ-S-A', requirementIds: ['REQ-S-A'], projects: ['odoo-sales', 'odoo-inventory'] });
    const onlyOne = resolveRunScope([reqA, reqB], defs(), { requirement: 'REQ-S-A', projects: ['odoo-sales'] });
    expect(onlyOne.scope).toMatchObject({ requirementIds: ['REQ-S-A'], projects: ['odoo-sales'] });
  });

  test('--requirement không hợp lệ: requirement không tồn tại, không có test case, project không chứa test case của nó', () => {
    expect(resolveRunScope([reqA, reqB], defs(), { requirement: 'REQ-NOPE' }).problems.join('|')).toMatch(/không tồn tại/);
    expect(resolveRunScope([reqA, reqB, mkReq('REQ-S-EMPTY')], defs(), { requirement: 'REQ-S-EMPTY' }).problems.join('|')).toMatch(/chưa có test case/);
    expect(resolveRunScope([reqA, reqB], defs(), { requirement: 'REQ-S-B', projects: ['odoo-inventory'] }).problems.join('|')).toMatch(/odoo-inventory.*không chứa test case của REQ-S-B/);
    expect(resolveRunScope([reqA, reqB], defs(), { requirement: 'REQ-S-A' }).scope).toBeDefined();
  });

  test('không có --requirement: phạm vi là MỌI requirement có test case trong project (hành vi chạy theo module)', () => {
    expect(resolveRunScope([reqA, reqB], defs(), { projects: ['odoo-sales'] }).scope).toEqual({ requirementIds: ['REQ-S-A', 'REQ-S-B'], projects: ['odoo-sales'] });
    expect(resolveRunScope([reqA, reqB], defs(), { projects: ['odoo-inventory'] }).scope?.requirementIds).toEqual(['REQ-S-A']);
  });
});

test.describe('SCOPE-2 Approval Gate theo phạm vi', () => {
  test('A đã duyệt, B chưa trình: chạy riêng A được; chạy riêng B bị chặn; chạy cả module bị chặn vì B', () => {
    approveReq(reqA);
    const all = [reqA, reqB];
    const forA = gateForRun(root, all, defs(), ['odoo-sales'], false, ['REQ-S-A']);
    expect(forA.ok).toBe(true);
    expect(forA.evaluations.map((e) => e.requirementId)).toEqual(['REQ-S-A']);

    const forB = gateForRun(root, all, defs(), ['odoo-sales'], false, ['REQ-S-B']);
    expect(forB.ok).toBe(false);
    expect(forB.problems.join('|')).toMatch(/REQ-S-B: NOT_SUBMITTED/);
    expect(forB.problems.join('|')).not.toMatch(/REQ-S-A/);

    const wholeModule = gateForRun(root, all, defs(), ['odoo-sales']);
    expect(wholeModule.ok).toBe(false);
    expect(wholeModule.evaluations.map((e) => e.requirementId)).toEqual(['REQ-S-A', 'REQ-S-B']);
    expect(wholeModule.problems.join('|')).toMatch(/REQ-S-B: NOT_SUBMITTED/);
  });

  test('cả hai đã duyệt: chạy cả module hợp lệ; một requirement bị sửa test case sau khi duyệt thì chạy riêng chính nó bị chặn nhưng requirement kia không bị ảnh hưởng', () => {
    approveReq(reqA);
    approveReq(reqB);
    expect(gateForRun(root, [reqA, reqB], defs(), ['odoo-sales']).ok).toBe(true);
    const changed = defs();
    changed.find((d) => d.id === 'TC-S-10')!.expectedResult = 'đã sửa sau khi duyệt';
    expect(gateForRun(root, [reqA, reqB], changed, ['odoo-sales'], false, ['REQ-S-B']).ok).toBe(false);
    expect(gateForRun(root, [reqA, reqB], changed, ['odoo-sales'], false, ['REQ-S-A']).ok).toBe(true);
    expect(gateForRun(root, [reqA, reqB], changed, ['odoo-sales']).ok).toBe(false);
    expect(tcApprovalProblem('TC-S-10', root, [reqA, reqB], changed)).toMatch(/REQ-S-B/);
    expect(tcApprovalProblem('TC-S-1', root, [reqA, reqB], changed)).toBeUndefined();
  });

  test('requirement chọn không có trong phạm vi project: bị chặn, không bỏ qua im lặng', () => {
    approveReq(reqA);
    const g = gateForRun(root, [reqA, reqB], defs(), ['odoo-purchase'], false, ['REQ-S-A']);
    expect(g.ok).toBe(false);
    expect(g.problems.join('|')).toMatch(/REQ-S-A: không có requirement\/test case này trong phạm vi chạy/);
  });

  test('scopeGateProblems tính lại từ file: phạm vi rỗng, không nhất quán, chứa requirement chưa duyệt đều bị từ chối', () => {
    approveReq(reqA);
    const all = [reqA, reqB];
    expect(scopeGateProblems(root, all, defs(), { requirement: 'REQ-S-A', requirementIds: ['REQ-S-A'], projects: ['odoo-sales'] })).toEqual([]);
    expect(scopeGateProblems(root, all, defs(), { requirementIds: [], projects: [] }).join('|')).toMatch(/không có requirement nào/);
    expect(scopeGateProblems(root, all, defs(), { requirement: 'REQ-S-A', requirementIds: ['REQ-S-A', 'REQ-S-B'], projects: ['odoo-sales'] }).join('|')).toMatch(/không nhất quán/);
    expect(scopeGateProblems(root, all, defs(), { requirementIds: ['REQ-S-A', 'REQ-S-B'], projects: ['odoo-sales'] }).join('|')).toMatch(/REQ-S-B: NOT_SUBMITTED/);
    expect(scopeGateProblems(root, all, defs(), { requirement: 'REQ-S-B', requirementIds: ['REQ-S-B'], projects: ['odoo-sales'] }).join('|')).toMatch(/REQ-S-B: NOT_SUBMITTED/);
    expect(scopeGateProblems(root, all, defs(), { requirement: 'REQ-NOPE', requirementIds: ['REQ-NOPE'], projects: ['odoo-sales'] }).length).toBeGreaterThan(0);
  });
});

test.describe('SCOPE-3 Lọc test case theo metadata chính xác', () => {
  const scopeA = { requirement: 'REQ-S-A', requirementIds: ['REQ-S-A'], projects: ['odoo-sales', 'odoo-inventory'] };

  test('scopeGrep: khớp đúng ID của requirement, có biên (TC-S-1 không khớp TC-S-10/TC-S-11), không khớp requirement khác', () => {
    const g = scopeGrep(defs(), scopeA)!;
    for (const t of ['[odoo-sales] › collect.spec.ts › TC-S-1 Tiêu đề TC-S-1', 'TC-S-2 abc', 'x TC-S-3']) expect(g.test(t), t).toBe(true);
    for (const t of ['[odoo-sales] › collect.spec.ts › TC-S-10 Tiêu đề', 'TC-S-11 abc', 'TC-S-12', 'TC-S-1-bis', 'auth: odoo/accountant']) expect(g.test(t), t).toBe(false);
    expect(scopeGrep(defs(), { requirementIds: ['REQ-S-A', 'REQ-S-B'], projects: [] })).toBeUndefined(); // chạy module: không lọc theo tiêu đề
  });

  test('tcScopeProblem dựa trên test case ID gắn qua metadata: ngoài phạm vi và test không gắn test case đều bị loại khi chạy riêng requirement', () => {
    expect(tcScopeProblem('TC-S-1', defs(), scopeA)).toBeUndefined();
    expect(tcScopeProblem('TC-S-3', defs(), scopeA)).toBeUndefined();
    expect(tcScopeProblem('TC-S-10', defs(), scopeA)).toMatch(/TC-S-10 thuộc REQ-S-B, ngoài phạm vi/);
    expect(tcScopeProblem('UNKNOWN', defs(), scopeA)).toMatch(/không gắn test case nào của REQ-S-A/);
    const mod = { requirementIds: ['REQ-S-A', 'REQ-S-B'], projects: ['odoo-sales'] };
    expect(tcScopeProblem('TC-S-10', defs(), mod)).toBeUndefined();
    expect(tcScopeProblem('UNKNOWN', defs(), mod)).toBeUndefined(); // chạy module như trước: test kỹ thuật vẫn chạy
    expect(tcScopeProblem('TC-S-1', defs(), { requirementIds: ['REQ-S-B'], projects: [] })).toMatch(/ngoài phạm vi/);
  });

  test('scopeFromEnv: đọc đúng, từ chối dữ liệu hỏng', () => {
    expect(scopeFromEnv({ [SCOPE_ENV]: JSON.stringify(scopeA) })).toEqual(scopeA);
    expect(scopeFromEnv({})).toBeUndefined();
    expect(scopeFromEnv({ [SCOPE_ENV]: '{không phải json' })).toBeUndefined();
    expect(scopeFromEnv({ [SCOPE_ENV]: JSON.stringify({ requirementIds: 'REQ-S-A', projects: [] }) })).toBeUndefined();
  });
});

test.describe('SCOPE-4 Không qua mặt bằng cách gọi thẳng Playwright / lệnh chạy', () => {
  const cli = path.join('node_modules', '@playwright', 'test', 'cli.js');
  const listProjects = (extra: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [cli, 'test', '--list', '--project=odoo-sales', '--reporter=list'], {
      env: { ...process.env, QA_APPROVAL_GATE: 'passed', QA_ENV: 'STAGING_A', QA_REPORTS_DIR: path.join(root, 'rep'), ...extra }, encoding: 'utf8',
    });

  test('tự đặt QA_APPROVAL_GATE + QA_ENV nhưng phạm vi thiếu / hỏng / chứa requirement không tồn tại: không có project nào chạm staging', () => {
    for (const scope of [undefined, '{hỏng', JSON.stringify({ requirementIds: [], projects: [] }), JSON.stringify({ requirement: 'REQ-NOPE', requirementIds: ['REQ-NOPE'], projects: ['odoo-sales'] })]) {
      const r = listProjects(scope === undefined ? {} : { [SCOPE_ENV]: scope });
      expect(r.status, String(scope)).not.toBe(0);
      expect(r.stdout).not.toMatch(/collect-payment|confirmed-rules/);
      expect(`${r.stdout}${r.stderr}`).toMatch(/odoo-sales/); // báo "project not found"
    }
  });

  test('phạm vi hợp lệ của REQ-SO-INV-001 (dữ liệu thật, chỉ đọc): Playwright liệt kê project nhưng KHÔNG liệt kê test của REQ-SO-COLLECT-PAYMENT cùng module', () => {
    const reqs = loadRequirements();
    const all = loadTestCases();
    const real = reqs.find((r) => r.id === 'REQ-SO-INV-001');
    // Phê duyệt thật được ký bằng khóa thật: trả biến khóa về giá trị ban đầu (beforeEach đã đổi sang khóa tạm).
    process.env.QA_APPROVAL_KEY_FILE = prevKey;
    if (prevKey === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
    test.skip(!real || !evaluate(process.cwd(), real, all.filter((d) => d.requirementId === real.id)).ok, 'REQ-SO-INV-001 hiện không ở trạng thái APPROVED hợp lệ');
    const scope = JSON.stringify({ requirement: 'REQ-SO-INV-001', requirementIds: ['REQ-SO-INV-001'], projects: ['odoo-sales'] });
    const r = listProjects({ [SCOPE_ENV]: scope });
    // Có project (không báo "project not found") nhưng không test nào của requirement khác được liệt kê, dù chúng nằm trong cùng thư mục tests/odoo-sales.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/Project\(s\) "odoo-sales" not found/);
    expect(r.stdout).not.toMatch(/TC-SO-00\d/);
    const specIds = fs.readdirSync(path.join('tests', 'odoo-sales')).filter((f) => f.endsWith('.spec.ts')).flatMap((f) => fs.readFileSync(path.join('tests', 'odoo-sales', f), 'utf8').match(/TC-[A-Z]+-[A-Z]*-?\d+/g) ?? []);
    const mineInSpecs = specIds.filter((id) => all.find((d) => d.id === id)?.requirementId === 'REQ-SO-INV-001');
    for (const id of new Set(mineInSpecs)) expect(r.stdout).toContain(id); // test của chính requirement vẫn được liệt kê
  });

  test('scripts/run-tests.ts từ chối --requirement sai trước khi kết nối bất cứ thứ gì (exit 3)', () => {
    const tsx = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
    const run = (...args: string[]) => spawnSync(process.execPath, [tsx, path.join('scripts', 'run-tests.ts'), ...args], { env: { ...process.env, QA_REPORTS_DIR: path.join(root, 'rep') }, encoding: 'utf8' });
    const none = run('--requirement=REQ-NOPE');
    expect(none.status).toBe(3);
    expect(none.stderr).toMatch(/PHẠM VI CHẠY không hợp lệ[\s\S]*REQ-NOPE.*không tồn tại/);
    const existing = loadRequirements().find((r) => loadTestCases().some((d) => d.requirementId === r.id));
    const wrongProject = run(`--requirement=${existing?.id ?? 'REQ-NOPE'}`, '--project=odoo-nope');
    expect(wrongProject.status).toBe(3);
    // Máy mới không có requirement nghiệp vụ: vẫn bị từ chối (requirement không tồn tại); có requirement: project sai bị từ chối.
    expect(wrongProject.stderr).toMatch(existing ? new RegExp(`odoo-nope.*không chứa test case của ${existing.id}`) : /không tồn tại/);
    expect(`${none.stdout}${wrongProject.stdout}`).not.toMatch(/Environment Gate|CHẾ ĐỘ GHI/);
  });

  test('run-tests.ts truyền phạm vi qua QA_GATE_SCOPE và chỉ lọc theo --requirement (nguồn)', () => {
    const src = fs.readFileSync(path.join('scripts', 'run-tests.ts'), 'utf8');
    expect(src).toMatch(/!a\.startsWith\('--requirement='\)/); // không chuyển --requirement thô cho Playwright
    expect(src).toMatch(/\[SCOPE_ENV\]: JSON\.stringify\(runScope\)/);
    expect(src).toMatch(/gateForRun\(process\.cwd\(\), allRequirements, allDefs, scopeProjects, true, runScope\.requirement \? runScope\.requirementIds : undefined\)/);
  });
});

test.describe('SCOPE-5 Báo cáo phân biệt kết quả hiện tại và lịch sử', () => {
  const result = (def: TestCaseDef, runId?: string): TcResult => ({ def, status: runId ? 'PASS' : 'NOT RUN', actual: '', durationMs: 0, evidence: { screenshots: [] }, runId });

  test('buildFocus: kết quả từ lần chạy gần nhất, từ các lần trước (lịch sử) và chưa từng chạy được tách riêng; requirement khác không lẫn vào', () => {
    const d = defs();
    const results = [result(d[0], '20261105-100000'), result(d[1], '20261104-090000'), result(d[2]), result(d[3], '20261105-100000'), result(d[4], '20261105-100000')];
    const f = buildFocus('REQ-S-A', [reqA, reqB], results, [], '2026-11-05T00:00:00Z');
    expect(f.summary.total).toBe(3);
    expect(f.provenance).toEqual({ latestRunId: '20261105-100000', fromLatestRun: 1, fromEarlierRuns: 1, neverRun: 1 });
    expect(buildFocus('REQ-S-B', [reqA, reqB], results, [], 'x').provenance).toEqual({ latestRunId: '20261105-100000', fromLatestRun: 2, fromEarlierRuns: 0, neverRun: 0 });
    expect(buildFocus('REQ-S-A', [reqA, reqB], [result(d[0])], [], 'x').provenance.latestRunId).toBeUndefined();
  });

  test('reporter bỏ qua test ngoài phạm vi: không ghi kết quả vào lần chạy', () => {
    const rep = new QaReporter({ outputDir: path.join(root, 'reports') }) as unknown as { onBegin: (c: unknown, s: unknown) => void; onTestEnd: (t: unknown, r: unknown) => void; entries: Map<string, unknown> };
    rep.onBegin({}, {});
    const tc = (id: string, extra: { type: string; description: string }[]) => ({ annotations: [{ type: 'tc', description: id }, ...extra] });
    rep.onTestEnd(tc('TC-SO-001', [{ type: 'out-of-scope', description: 'ngoài phạm vi' }]), { status: 'skipped' });
    rep.onTestEnd(tc('KHONG-CO', []), { status: 'passed' });
    expect(rep.entries.size).toBe(0);
  });
});
