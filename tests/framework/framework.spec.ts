import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { aggregate, computeSummary } from '../../core/reporters/aggregate';
import type { RunFile, TcRunEntry } from '../../core/reporters/types';
import { defHash } from '../../core/testcases/hash';
import { loadRequirements, loadTestCases } from '../../core/testcases/loader';
import { listRequirementFiles, lockFileFor, requirementHash } from '../../core/testcases/lock';
import type { TestCaseDef } from '../../core/testcases/schema';
import { loadRegistry, recordsOfRun, registerRecord, setCleanupStatus } from '../../core/testdata/registry';

// Framework tests: KHÔNG kết nối Odoo, KHÔNG tạo dữ liệu. Chạy: npm run test:framework

const walk = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    : [];

test.describe('Test Data Registry (FW-03)', () => {
  let tmp: string;
  test.beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
    process.env.QA_REGISTRY_FILE = path.join(tmp, 'registry.jsonl');
  });
  test.afterEach(() => {
    delete process.env.QA_REGISTRY_FILE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = { testCaseId: 'TC-X-001', application: 'odoo', model: 'sale.order', reference: 'AUTOTEST r1 TC-X-001' };

  test('đăng ký đủ thông tin tối thiểu, mặc định PENDING + AUTOMATION', () => {
    const r = registerRecord({ ...base, recordId: 1, runId: 'r1' });
    expect(r).toMatchObject({ runId: 'r1', testCaseId: 'TC-X-001', application: 'odoo', model: 'sale.order', recordId: 1, cleanupStatus: 'PENDING', origin: 'AUTOMATION' });
    expect(new Date(r.createdAt).getTime()).not.toBeNaN();
    expect(loadRegistry()).toHaveLength(1);
  });

  test('đăng ký lặp cùng bản ghi không tạo bản sao', () => {
    registerRecord({ ...base, recordId: 1, runId: 'r1' });
    registerRecord({ ...base, recordId: 1, runId: 'r2' });
    expect(loadRegistry()).toHaveLength(1);
    expect(loadRegistry()[0].runId).toBe('r1');
  });

  test('dùng chung nhiều ứng dụng/model: cùng recordId khác application/model là bản ghi khác nhau', () => {
    registerRecord({ ...base, recordId: 7, runId: 'r1' });
    registerRecord({ ...base, recordId: 7, runId: 'r1', application: 'misa', model: 'invoice' });
    registerRecord({ ...base, recordId: 7, runId: 'r1', model: 'account.payment' });
    expect(loadRegistry()).toHaveLength(3);
  });

  test('lọc theo runId và cập nhật trạng thái cleanup bằng sự kiện (append-only)', () => {
    registerRecord({ ...base, recordId: 1, runId: 'r1' });
    registerRecord({ ...base, recordId: 2, runId: 'r2' });
    setCleanupStatus({ application: 'odoo', model: 'sale.order', recordId: 1 }, 'CLEANED', 'ok');
    expect(recordsOfRun('r1')[0].cleanupStatus).toBe('CLEANED');
    expect(recordsOfRun('r2')[0].cleanupStatus).toBe('PENDING');
    expect(fs.readFileSync(process.env.QA_REGISTRY_FILE!, 'utf8').trim().split('\n')).toHaveLength(3); // 2 created + 1 status
  });
});

test.describe('Tổng hợp kết quả (FW-04)', () => {
  const mkDef = (id: string, over: Partial<TestCaseDef> = {}): TestCaseDef => ({
    id, title: id, requirementRefs: ['BR-01'], description: '', preconditions: [], testData: {}, steps: ['s'],
    expectedResult: 'e', verification: 'UI', automated: true, ...over,
  });
  const entry = (def: TestCaseDef, status: TcRunEntry['status'], extra: Partial<TcRunEntry> = {}): TcRunEntry => ({
    tcId: def.id, defHash: defHash(def), status, actual: 'a', durationMs: 1000, evidence: { screenshots: [] }, ...extra,
  });
  const run = (runId: string, entries: TcRunEntry[]): RunFile => ({ runId, startedAt: runId, finishedAt: runId, entries });

  test('Execution Pass Rate KHÁC Overall Pass Coverage; BLOCKED/NC/NOT RUN không tính là đạt', () => {
    const defs = ['A', 'B', 'C', 'D', 'E'].map((x) => mkDef(x));
    const { summary } = aggregate(defs, [run('r1', [entry(defs[0], 'PASS'), entry(defs[1], 'PASS'), entry(defs[2], 'FAIL'), entry(defs[3], 'BLOCKED', { reason: 'x' })])]);
    expect(summary).toMatchObject({ total: 5, passed: 2, failed: 1, blocked: 1, notRun: 1, executed: 3 });
    expect(summary.executionPassRate).toBe(66.7); // 2 / (2+1)
    expect(summary.overallPassCoverage).toBe(40); // 2 / 5
  });

  test('chưa test nào chạy: tỉ lệ thực thi là null, coverage 0%, không có PASS giả', () => {
    const defs = [mkDef('A'), mkDef('B')];
    const { summary, results } = aggregate(defs, []);
    expect(summary.executionPassRate).toBeNull();
    expect(summary.overallPassCoverage).toBe(0);
    expect(results.every((r) => r.status === 'NOT RUN')).toBe(true);
  });

  test('chạy lại một phần: test không chạy lại GIỮ kết quả và bằng chứng của lần trước', () => {
    const defs = [mkDef('A'), mkDef('B')];
    const ev = { video: 'artifacts/a/video.webm', screenshots: [] };
    const { results } = aggregate(defs, [
      run('r1', [entry(defs[0], 'PASS', { evidence: ev }), entry(defs[1], 'PASS')]),
      run('r2', [entry(defs[1], 'FAIL')]),
    ]);
    const a = results.find((r) => r.def.id === 'A')!;
    expect(a.status).toBe('PASS');
    expect(a.runId).toBe('r1');
    expect(a.evidence.video).toBe('runs/r1/artifacts/a/video.webm'); // đường dẫn trỏ đúng thư mục lần chạy
    expect(results.find((r) => r.def.id === 'B')!.status).toBe('FAIL'); // lần chạy mới nhất thắng
  });

  test('định nghĩa test case đổi sau lần chạy: kết quả cũ KHÔNG còn được tính là PASS', () => {
    const old = mkDef('A', { steps: ['bước cũ'] });
    const changed = mkDef('A', { steps: ['bước mới'] });
    const { results, summary } = aggregate([changed], [run('r1', [entry(old, 'PASS')])]);
    expect(results[0].status).toBe('NOT RUN');
    expect(results[0].stale?.status).toBe('PASS');
    expect(summary.passed).toBe(0);
  });

  test('thay đổi mô tả/ghi chú (không phải nội dung kiểm thử) không làm kết quả cũ mất hiệu lực', () => {
    const a = mkDef('A');
    expect(defHash({ ...a, description: 'mô tả mới', needsClarification: 'ghi chú' })).toBe(defHash(a));
  });

  test('chưa từng chạy: có điểm chưa rõ + không tự động hoá => NEEDS CLARIFICATION, ngược lại NOT RUN', () => {
    const { results } = aggregate([mkDef('A', { automated: false, needsClarification: 'cần làm rõ' }), mkDef('B', { automated: false })], []);
    expect(results.map((r) => r.status)).toEqual(['NEEDS CLARIFICATION', 'NOT RUN']);
  });

  test('computeSummary đếm đúng từng trạng thái', () => {
    const d = mkDef('A');
    const mk = (status: TcRunEntry['status']) => ({ def: d, status, actual: '', durationMs: 0, evidence: { screenshots: [] } });
    const s = computeSummary([mk('PASS'), mk('NEEDS CLARIFICATION'), mk('NEEDS CLARIFICATION')]);
    expect(s).toMatchObject({ total: 3, passed: 1, needsClarification: 2, executed: 1, executionPassRate: 100 });
    expect(s.overallPassCoverage).toBe(33.3);
  });
});

test.describe('Tính toàn vẹn dữ liệu kiểm thử (FW-05)', () => {
  test('BR/AC gốc không bị sửa (so với khoá); ghi chú chỉ tham chiếu BR/AC/TC có thật', () => {
    const reqs = loadRequirements();
    const files = listRequirementFiles();
    test.skip(files.length === 0, 'Chưa có requirement nào (bộ cài đặt dùng chung không kèm requirement nghiệp vụ)');
    const tcIds = new Set(loadTestCases().map((t) => t.id));
    for (const f of files) {
      const req = JSON.parse(fs.readFileSync(f, 'utf8'));
      const lock = lockFileFor(f);
      expect(fs.existsSync(lock), `thiếu khoá ${lock} (chạy npm run requirements:lock)`).toBe(true);
      expect(requirementHash(req), `BR/AC trong ${f} đã bị thay đổi so với khoá`).toBe(JSON.parse(fs.readFileSync(lock, 'utf8')).sha256);
      const known = new Set<string>([...req.businessRules, ...req.acceptanceCriteria].map((x: { id: string }) => x.id));
      for (const n of req.notes ?? []) {
        for (const ref of n.affects as string[]) expect(known.has(ref) || tcIds.has(ref), `${n.id} tham chiếu ${ref} không tồn tại`).toBe(true);
      }
    }
    expect(reqs.length).toBe(files.length);
  });

  test('mỗi test case tự động hoá có script (tcMeta) và mỗi script trỏ về test case có thật', () => {
    const defs = loadTestCases();
    // Chỉ quét spec của các module nghiệp vụ (tests/<app>-<module>); test của framework tự dùng mã giả để thử cơ chế.
    const moduleDirs = fs.readdirSync('tests', { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.includes('-')).map((d) => path.join('tests', d.name));
    const specText = moduleDirs.flatMap((d) => walk(d)).filter((f) => f.endsWith('.spec.ts')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const scripted = new Set([...specText.matchAll(/tcMeta\('(TC-[A-Z0-9-]+)'\)/g)].map((m) => m[1]));
    for (const d of defs.filter((x) => x.automated)) expect(scripted.has(d.id), `${d.id} đánh dấu automated nhưng chưa có script`).toBe(true);
    for (const id of scripted) expect(defs.some((d) => d.id === id), `script trỏ tới ${id} không có trong testcases/`).toBe(true);
  });

  test('cấu trúc dự án: mỗi tests/<app>-<module> có requirements + testcases; ứng dụng đã đăng ký', () => {
    for (const dir of fs.readdirSync('tests', { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.includes('-'))) {
      expect(fs.existsSync(path.join('requirements', dir.name)), `thiếu requirements/${dir.name}`).toBe(true);
      expect(fs.existsSync(path.join('testcases', dir.name)), `thiếu testcases/${dir.name}`).toBe(true);
      expect(fs.existsSync(path.join('applications', dir.name.split('-')[0], 'config.ts'))).toBe(true);
    }
    for (const p of ['core/reporters/aggregate.ts', 'core/testdata/registry.ts', 'scripts/cleanup-autotest.ts']) expect(fs.existsSync(p)).toBe(true);
  });

  test('scripts lập kế hoạch/chụp baseline CHỈ ĐỌC: không gọi RPC ghi/huỷ/xoá', () => {
    const write = /\.(call|tryCall)\(\s*['"][^'"]+['"]\s*,\s*['"](write|create|unlink|copy|action_\w+|button_\w+|reconcile\w*)['"]/;
    for (const f of ['scripts/cleanup-autotest.ts', 'scripts/registry-backfill.ts', 'scripts/snapshot-fields.ts']) {
      expect(write.test(fs.readFileSync(f, 'utf8')), `${f} có gọi RPC ghi`).toBe(false);
    }
  });
});

test.describe('Bằng chứng trong báo cáo (FW-06)', () => {
  const reportsDir = 'reports';
  const resultsFile = path.join(reportsDir, 'qa-results.json');
  test.skip(!fs.existsSync(resultsFile), 'Chưa có reports/qa-results.json (chưa chạy test nào)');

  test('mỗi test đã thực thi có video; FAIL có screenshot + chi tiết lỗi; mọi đường dẫn tồn tại', () => {
    const { testCases, summary } = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
    const problems: string[] = [];
    for (const t of testCases) {
      const executed = t.status === 'PASS' || t.status === 'FAIL' || (t.runId && t.status === 'NEEDS CLARIFICATION');
      const files = [t.evidence.video, t.evidence.trace, ...t.evidence.screenshots].filter(Boolean) as string[];
      for (const f of files) if (!fs.existsSync(path.join(reportsDir, f))) problems.push(`${t.def.id}: thiếu file ${f}`);
      if (executed && !t.evidence.video) problems.push(`${t.def.id} (${t.status}) đã thực thi nhưng không có video`);
      if (t.status === 'FAIL' && !(t.evidence.screenshots.length && t.error?.message)) problems.push(`${t.def.id} FAIL thiếu screenshot hoặc chi tiết lỗi`);
      if (t.status === 'BLOCKED' && !t.reason) problems.push(`${t.def.id} BLOCKED không có lý do`);
      if (t.status === 'NEEDS CLARIFICATION' && !t.reason && !t.def.needsClarification) problems.push(`${t.def.id} NEEDS CLARIFICATION không có lý do`);
      if (t.status === 'PASS' && t.stale) problems.push(`${t.def.id} PASS nhưng kết quả đã cũ`);
    }
    expect(problems).toEqual([]);
    expect(summary.passed + summary.failed + summary.blocked + summary.needsClarification + summary.notRun).toBe(summary.total);
  });
});
