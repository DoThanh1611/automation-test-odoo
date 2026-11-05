import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { env } from '../config/env';
import { activeEnvKey } from '../environment/paths';
import { getRunId } from '../config/run';
import { scrubTree } from '../security/scrub-trace';
import { defHash } from '../testcases/hash';
import { loadGlossary, loadRequirements, loadTestCases } from '../testcases/loader';
import type { TcStatus, TestCaseDef } from '../testcases/schema';
import { aggregate, loadRuns, runDir } from './aggregate';
import { loadSummaries } from './summaries';
import { buildBugs } from './bugs';
import { buildFocus, resolveFocusId } from './focus';
import { renderHtml } from './render-html';
import { buildSummaryMarkdown } from './summary';
import { evaluate } from '../approval/approval';
import { runDurationMs, type RunMeta } from './render-extras';
import { sanitizeEntry } from './sanitize';
import type { RoleInfo, RunFile, TcRunEntry } from './types';

const ansi = /\u001b\[[0-9;]*m/g;
/** Không để mật khẩu/token lọt vào report. */
const redact = (s: string) =>
  s.replace(ansi, '').replace(/(password|passwd|pass|token|authorization|session_id)(["'=:\s]+)[^\s"',;]+/gi, '$1$2[REDACTED]');

/** Rút gọn thông báo lỗi Playwright thành vài dòng dễ đọc (bỏ phần Call log). */
function summarizeError(msg: string): string {
  const head = msg.split(/\n\s*Call log:/)[0];
  const lines = head.split('\n').map((l) => l.trim()).filter(Boolean);
  return `Lỗi: ${lines.slice(0, 5).join(' · ')}`;
}

function flatten(steps: TestStep[]): TestStep[] {
  return steps.flatMap((s) => [s, ...flatten(s.steps)]);
}

/**
 * Mỗi lần chạy ghi reports/runs/<runId>/results.json (cùng video/screenshot/trace trong thư mục đó),
 * sau đó gộp MỌI lần chạy thành reports/qa-results.json + reports/qa-report.html.
 * Chạy lại một phần test không làm mất kết quả/bằng chứng của các test khác.
 */
export default class QaReporter implements Reporter {
  private reportsDir: string;
  private runId = getRunId();
  private entries = new Map<string, TcRunEntry>();
  private defs: TestCaseDef[] = [];
  private startedAt = new Date().toISOString();
  private baseURL?: string;

  private environment = activeEnvKey();

  constructor(options: { outputDir?: string } = {}) {
    this.reportsDir = path.resolve(options.outputDir ?? 'reports');
  }

  onBegin(_config: FullConfig, _suite: Suite) {
    this.defs = loadTestCases();
    this.startedAt = new Date().toISOString();
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const tcId = test.annotations.find((a) => a.type === 'tc')?.description;
    const def = this.defs.find((d) => d.id === tcId);
    if (!tcId || !def) return; // test kỹ thuật/setup: không nằm trong bảng test case
    if (test.annotations.some((a) => a.type === 'out-of-scope')) return; // ngoài phạm vi lần chạy (requirement khác): không ghi kết quả, không đổi lịch sử

    const anns = (t: string) => test.annotations.filter((a) => a.type === t).map((a) => a.description ?? '');
    const blocked = anns('blocked')[0];
    const clarify = anns('needs-clarification');
    const failed = result.status === 'failed' || result.status === 'timedOut' || result.status === 'interrupted';

    // Thứ tự ưu tiên: BLOCKED > FAIL > NEEDS CLARIFICATION > PASS. Một assertion lỗi luôn thắng ghi chú "chưa xác minh hết".
    let status: TcStatus;
    if (blocked) status = 'BLOCKED';
    else if (failed) status = 'FAIL';
    else if (clarify.length) status = 'NEEDS CLARIFICATION';
    else if (result.status === 'passed') status = 'PASS';
    else status = 'NOT RUN';

    const rel = (p?: string) => (p ? path.relative(runDir(this.reportsDir, this.runId), p).replace(/\\/g, '/') : undefined);
    const att = (name: string, type?: string) =>
      result.attachments.filter((a) => a.path && (a.name === name || (type && a.contentType === type)));

    let actual = anns('actual')[0] ?? '';
    let error: TcRunEntry['error'];
    if (status === 'FAIL') {
      const failedStep = flatten(result.steps).find((s) => s.error && s.category === 'test.step');
      const msg = redact(result.error?.message ?? 'Unknown error');
      error = { message: msg, failedStep: failedStep?.title };
      actual ||= summarizeError(msg);
    } else if (status === 'PASS') {
      actual ||= 'Test đạt các assertions nhưng CHƯA ghi giá trị quan sát cụ thể (thiếu recordActual trong test).';
    } else {
      actual ||= 'Chưa thực thi đầy đủ: xem lý do.';
    }

    const dataEntries = anns('data').map((d) => JSON.parse(d));
    const data = Object.assign({}, ...dataEntries);
    const roleAnn = anns('role')[0];
    this.baseURL ??= test.parent.project()?.use?.baseURL;

    this.entries.set(tcId, sanitizeEntry({
      tcId,
      defHash: defHash(def),
      status,
      actual,
      reason: status === 'BLOCKED' ? blocked : status === 'NEEDS CLARIFICATION' ? clarify.join(' | ') : undefined,
      durationMs: result.duration,
      data: Object.keys(data).length ? data : undefined,
      role: roleAnn ? (JSON.parse(roleAnn) as RoleInfo) : undefined,
      error,
      blockedKind: status === 'BLOCKED' ? (anns('blocked-kind')[0] as TcRunEntry['blockedKind']) || undefined : undefined,
      summary: anns('summary')[0] || undefined,
      technical: anns('technical').length ? anns('technical') : undefined,
      evidence: {
        video: rel(att('video')[0]?.path),
        screenshots: att('screenshot', 'image/png').map((a) => rel(a.path)!),
        trace: rel(att('trace')[0]?.path),
      },
    }));
  }

  onEnd(_result: FullResult) {
    // `playwright test --list` hoặc lần chạy không có test case nào: không tạo/ghi đè gì.
    if (this.entries.size === 0) return;

    const dir = runDir(this.reportsDir, this.runId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'results.json');
    // Cùng runId chạy nhiều lần (ví dụ QA_RUN_ID đặt tay): gộp theo tcId, không làm mất test case đã chạy.
    const prev: RunFile | undefined = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
    // Không bao giờ gộp/ghi đè kết quả của môi trường khác (ví dụ QA_REPORTS_DIR trỏ nhầm vào thư mục của môi trường khác).
    if (prev && prev.environment !== this.environment) {
      throw new Error(`Từ chối ghi ${file}: thư mục này thuộc môi trường "${prev.environment ?? 'cũ (không ghi rõ)'}", lần chạy hiện tại là "${this.environment ?? 'không có'}".`);
    }
    const merged = new Map<string, TcRunEntry>((prev?.entries ?? []).map((e) => [e.tcId, e]));
    for (const [id, e] of this.entries) merged.set(id, e);
    const run: RunFile = {
      runId: this.runId,
      startedAt: prev?.startedAt ?? this.startedAt,
      finishedAt: new Date().toISOString(),
      baseURL: this.baseURL ?? prev?.baseURL,
      environment: this.environment,
      writesEnabled: env.allowWriteTests,
      entries: [...merged.values()],
    };
    fs.writeFileSync(file, JSON.stringify(run, null, 2));

    // Che cookie phiên/Authorization trong trace của lần chạy này (cả bản sao của báo cáo HTML Playwright).
    try {
      const done = scrubTree(dir, true).filter((x) => x.applied);
      if (done.length) console.log(`Đã che ${done.reduce((n, x) => n + x.replacements, 0)} giá trị bí mật trong ${done.length} file trace.`);
    } catch (e) {
      console.warn(`CẢNH BÁO: chưa làm sạch được trace (${(e as Error).message}). Chạy: npm run security:scrub -- --apply`);
    }

    writeAggregate(this.reportsDir);
    console.log(`\nQA report: ${path.join(this.reportsDir, 'qa-report.html')} (lần chạy ${this.runId})`);
  }
}

/** Kết quả framework/unit test gần nhất (do npm run test:framework ghi), tách riêng khỏi test nghiệp vụ. */
function readFrameworkTests(reportsDir: string) {
  const f = path.join(reportsDir, 'framework-tests.json');
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as { ranAt: string; total: number; passed: number; failed: number; skipped: number }) : undefined;
}

/** Tóm tắt 1 lần chạy cho phần Lịch sử chạy test; đường dẫn evidence tính tương đối so với reports/. */
export function runMeta(r: RunFile, defs: TestCaseDef[]): RunMeta {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const prefix = (p?: string) => (p ? `runs/${r.runId}/${p}` : undefined);
  const counts: Record<string, number> = {};
  for (const e of r.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const scopes = [...new Set(r.entries.map((e) => byId.get(e.tcId)).map((d) => (d ? `${d.application ?? '-'}/${d.module ?? '-'}` : 'không rõ')))].sort();
  const byRequirement: Record<string, { testCases: number; counts: Record<string, number> }> = {};
  for (const e of r.entries) {
    const rid = byId.get(e.tcId)?.requirementId;
    if (!rid) continue;
    const b = (byRequirement[rid] ??= { testCases: 0, counts: {} });
    b.testCases++;
    b.counts[e.status] = (b.counts[e.status] ?? 0) + 1;
  }
  return {
    runId: r.runId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    testCases: r.entries.length,
    writesEnabled: r.writesEnabled,
    scopes,
    counts,
    requirementIds: Object.keys(byRequirement).sort(),
    byRequirement,
    durationMs: runDurationMs(r.startedAt, r.finishedAt),
    entries: r.entries.map((e) => ({ tcId: e.tcId, title: byId.get(e.tcId)?.title ?? '(test case không còn trong định nghĩa)', status: e.status, actual: e.actual, reason: e.reason, video: prefix(e.evidence.video), screenshots: e.evidence.screenshots.map((p) => prefix(p)!), trace: prefix(e.evidence.trace) })),
  };
}

/** Dựng reports/qa-results.json, bugs.json và qa-report.html từ tất cả lần chạy đã lưu. Dùng chung với `npm run report:rebuild`. */
export function writeAggregate(reportsDir: string, focusRequirementId?: string) {
  const runs = loadRuns(reportsDir);
  // Một thư mục báo cáo chỉ thuộc MỘT môi trường: trộn kết quả hai môi trường làm số liệu sai.
  const envs = [...new Set(runs.map((r) => r.environment).filter(Boolean))] as string[];
  if (envs.length > 1) throw new Error(`Thư mục ${reportsDir} chứa kết quả của nhiều môi trường (${envs.join(', ')}); mỗi môi trường phải có thư mục báo cáo riêng.`);
  const environment = envs[0];
  const defs = loadTestCases();
  const allRequirements = loadRequirements();
  const focusId = resolveFocusId(allRequirements, focusRequirementId);
  const sums = loadSummaries(reportsDir);
  for (const p of sums.problems) console.warn(`CẢNH BÁO: bỏ qua tóm tắt lịch sử không hợp lệ (${p}).`);
  const { results, summary } = aggregate(defs, runs, sums.files);
  const bugs = buildBugs(defs, runs);
  const frameworkTests = readFrameworkTests(reportsDir);
  const focus = focusId ? buildFocus(focusId, allRequirements, results, bugs, summary.generatedAt) : undefined;
  const runsMeta = runs.map((r) => runMeta(r, defs)).sort((a, b) => a.runId.localeCompare(b.runId));
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'qa-results.json'), JSON.stringify({ environment, summary, focus, runs: runsMeta, frameworkTests, bugs: { total: bugs.length, open: bugs.filter((b) => b.status === 'OPEN').length }, testCases: results }, null, 2));
  fs.writeFileSync(path.join(reportsDir, 'bugs.json'), JSON.stringify({ generatedAt: summary.generatedAt, note: 'Tự sinh từ test FAIL; QA cần xác nhận có phải lỗi sản phẩm không.', bugs }, null, 2));
  const requirements = loadRequirements();
  const approvals = requirements.map((r) => {
    const ev = evaluate(process.cwd(), r, defs.filter((d) => d.requirementId === r.id));
    return { id: r.id, state: ev.state, reason: ev.reason, version: ev.record?.version };
  });
  const approvers: Record<string, { by: string; at: string }> = {};
  for (const r of requirements) {
    const ap = evaluate(process.cwd(), r, defs.filter((d) => d.requirementId === r.id)).record?.approval;
    if (ap) approvers[r.id] = { by: ap.by, at: ap.at };
  }
  fs.writeFileSync(
    path.join(reportsDir, 'qa-report.html'),
    renderHtml({ summary, results, glossary: loadGlossary(), requirements, runs: runsMeta, bugs, focus, approvers, environment }),
  );
  fs.writeFileSync(path.join(reportsDir, 'qa-summary.md'), buildSummaryMarkdown(summary, results, requirements, approvals, environment, focus));
  return { summary, results, bugs, focus };
}
