import fs from 'node:fs';
import path from 'node:path';
import { defHash } from '../testcases/hash';
import { WRITE_NOT_GRANTED_PREFIX } from '../testdata/write-guard';
import { APPROVAL_BLOCK_PREFIX } from '../approval/approval';
import type { TcStatus, TestCaseDef } from '../testcases/schema';
import { historicalSummaryFor, type SummaryFile } from './summaries';
import type { RunFile, Summary, TcResult } from './types';

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

export function computeSummary(results: TcResult[], generatedAt = new Date().toISOString()): Summary {
  const count = (s: TcStatus) => results.filter((r) => r.status === s).length;
  const passed = count('PASS');
  const failed = count('FAIL');
  return {
    generatedAt,
    total: results.length,
    passed,
    failed,
    blocked: count('BLOCKED'),
    needsClarification: count('NEEDS CLARIFICATION'),
    notRun: count('NOT RUN'),
    executed: passed + failed,
    executionPassRate: pct(passed, passed + failed),
    overallPassCoverage: pct(passed, results.length),
  };
}

/**
 * Gộp mọi lần chạy đã lưu thành 1 bảng kết quả theo định nghĩa test case HIỆN TẠI.
 * - Mỗi test case lấy kết quả của lần chạy GẦN NHẤT có chạy nó (không bao giờ tạo kết quả giả).
 * - Nếu định nghĩa test case đã đổi sau lần chạy đó (hash khác) -> NOT RUN, kết quả cũ chỉ giữ trong `stale`.
 * - Chưa từng chạy: NEEDS CLARIFICATION nếu định nghĩa còn điểm chưa rõ và không có script tự động, ngược lại NOT RUN.
 */
export function aggregate(defs: TestCaseDef[], runs: RunFile[], summaries: Record<string, SummaryFile> = {}) {
  const ordered = [...runs].sort((a, b) => a.runId.localeCompare(b.runId));
  const results: TcResult[] = defs.map((def) => {
    let latest: { run: RunFile; entry: RunFile['entries'][number] } | undefined;
    let readOnlySkip: TcResult['readOnlySkip'];
    for (const run of ordered) {
      const entry = run.entries.find((e) => e.tcId === def.id);
      if (!entry) continue;
      // Lần chạy CHỈ ĐỌC không thực thi test ghi (BLOCKED vì chưa cấp quyền ghi): đó là "chưa thực hiện", không phải kết luận mới,
      // nên không đè lên kết luận PASS/FAIL thật của lần chạy trước có cùng định nghĩa test case.
      // Cũng vậy với test bị chặn vì chưa/không còn phê duyệt (Approval Gate): không phải kết luận kiểm thử.
      const notGranted = entry.status === 'BLOCKED' && Boolean(entry.reason?.startsWith(WRITE_NOT_GRANTED_PREFIX) || entry.reason?.startsWith(APPROVAL_BLOCK_PREFIX));
      if (notGranted && latest && ['PASS', 'FAIL'].includes(latest.entry.status) && latest.entry.defHash === entry.defHash) {
        readOnlySkip = { runId: run.runId, executedAt: run.finishedAt };
        continue;
      }
      latest = { run, entry };
      readOnlySkip = undefined;
    }
    const prefix = (p?: string, runId?: string) => (p ? `runs/${runId}/${p}` : undefined);

    if (!latest) {
      const neverRunNC = Boolean(def.needsClarification) && !def.automated;
      return {
        def,
        status: neverRunNC ? 'NEEDS CLARIFICATION' : 'NOT RUN',
        actual: neverRunNC ? 'Chưa kiểm chứng: xem lý do bên dưới.' : 'Chưa thực thi.',
        reason: neverRunNC ? def.needsClarification : undefined,
        durationMs: 0,
        evidence: { screenshots: [] },
      } satisfies TcResult;
    }

    const { run, entry } = latest;
    const evidence = {
      video: prefix(entry.evidence.video, run.runId),
      screenshots: entry.evidence.screenshots.map((p) => prefix(p, run.runId)!),
      trace: prefix(entry.evidence.trace, run.runId),
    };
    if (entry.defHash !== defHash(def)) {
      return {
        def,
        status: 'NOT RUN',
        actual: `Định nghĩa test case đã thay đổi sau lần chạy ${run.runId}; kết quả cũ (${entry.status}) không còn áp dụng. Cần chạy lại.`,
        durationMs: 0,
        evidence: { screenshots: [] },
        stale: { runId: run.runId, status: entry.status, executedAt: run.finishedAt },
      } satisfies TcResult;
    }
    // Ưu tiên tóm tắt do chính test ghi; thiếu thì dùng tóm tắt lịch sử có căn cứ (chỉ khi trạng thái và hash khớp đúng lần chạy này).
    const hist = entry.summary ? undefined : historicalSummaryFor(summaries, run.runId, def.id, entry.status, entry.defHash);
    return {
      def,
      status: entry.status,
      actual: entry.actual,
      reason: entry.reason,
      durationMs: entry.durationMs,
      data: entry.data,
      role: entry.role,
      error: entry.error,
      summary: entry.summary ?? hist?.summary,
      summarySource: entry.summary ? 'RUN' : hist ? 'HISTORICAL' : undefined,
      summaryBasis: hist?.basis,
      technical: entry.technical,
      blockedKind: entry.blockedKind,
      evidence,
      runId: run.runId,
      executedAt: run.finishedAt,
      readOnlySkip,
    } satisfies TcResult;
  });
  return { results, summary: computeSummary(results) };
}

export const runDir = (reportsDir: string, runId: string) => path.join(reportsDir, 'runs', runId);

export function loadRuns(reportsDir: string): RunFile[] {
  const dir = path.join(reportsDir, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'results.json')))
    .map((d) => JSON.parse(fs.readFileSync(path.join(dir, d.name, 'results.json'), 'utf8')) as RunFile);
}
