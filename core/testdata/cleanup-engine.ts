import fs from 'node:fs';
import path from 'node:path';
import type { EffectivePolicy } from '../policy/policy';
import type { CleanupHandler, PlanItem, PlanStep } from './cleanup';
import { recordKey, setCleanupStatus, type CleanupStatus, type TestDataRecord } from './registry';

/**
 * Cleanup TỰ ĐỘNG dữ liệu do framework sở hữu. Nguyên tắc (mọi điều kiện đều bắt buộc, không có công tắc nào nới ra):
 *  - Chỉ bản ghi trong registry của ĐÚNG môi trường, origin=AUTOMATION, owner=FRAMEWORK. Không bao giờ đụng dữ liệu ngoài registry,
 *    dữ liệu BACKFILL hay dữ liệu cũ chưa có chủ sở hữu.
 *  - Quy trình huỷ do CleanupHandler của từng loại chứng từ quyết định (không xoá cứng chứng từ; chứng từ bị ràng buộc kế toán => CLEANUP_BLOCKED).
 *  - Dọn bản ghi phụ thuộc trước, bản ghi gốc sau; còn bản ghi phụ thuộc chưa dọn thì bản ghi gốc không được dọn.
 *  - Test FAIL: giữ dữ liệu `failureRetentionHours` giờ (RETAINED) để điều tra.
 *  - Mọi lỗi => CLEANUP_BLOCKED kèm bản ghi + nguyên nhân (đã che bí mật). KHÔNG BAO GIỜ ném lỗi ra ngoài và KHÔNG chạm kết quả kiểm thử.
 */
export type OutcomeStatus = 'CLEANED' | 'CLEANUP_BLOCKED' | 'RETAINED' | 'WOULD_CLEAN' | 'NOT_ELIGIBLE';

export interface CleanupOutcome {
  key: string;
  model: string;
  id: number;
  reference: string;
  environment?: string;
  runId: string;
  requirementId?: string;
  testCaseId: string;
  status: OutcomeStatus;
  reason?: string;
  steps: string[];
  retainUntil?: string;
}

export interface CleanupOptions<C> {
  client: C;
  handlers: CleanupHandler<C>[];
  /** Registry của môi trường (đã nạp). */
  records: TestDataRecord[];
  /** Môi trường đang dọn: chỉ bản ghi có đúng environment này mới được dọn. */
  environment: string;
  policy: EffectivePolicy;
  runId?: string;
  now?: number;
  /** Test case FAIL trong lần chạy (dữ liệu được giữ lại). */
  failedTestCases?: ReadonlySet<string>;
  /** Thử lại cả bản ghi đang CLEANUP_BLOCKED. */
  retryBlocked?: boolean;
  dryRun?: boolean;
  /** Che bí mật trong thông báo lỗi. */
  redact?: (s: string) => string;
  /** Thực thi một bước. Mặc định: client.call(model, method, [[id], ...args]). */
  exec?: (client: C, model: string, id: number, step: PlanStep) => Promise<unknown>;
  /** Ghi trạng thái (mặc định: registry). */
  setStatus?: (rec: TestDataRecord, status: CleanupStatus, note?: string, retainUntil?: string) => void;
}

export interface CleanupSummary {
  outcomes: CleanupOutcome[];
  counts: Record<OutcomeStatus, number>;
}

const opParts = (op: string) => {
  const i = op.lastIndexOf('.');
  return { model: op.slice(0, i), method: op.slice(i + 1) };
};

interface RpcClient {
  call(model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>): Promise<unknown>;
}

async function defaultExec(client: unknown, model: string, id: number, step: PlanStep) {
  const { model: m, method } = opParts(step.op);
  return (client as RpcClient).call(m || model, method, [[id], ...(step.args ?? [])], step.kwargs ?? {});
}

const isOwned = (r: TestDataRecord, environment: string) => r.origin === 'AUTOMATION' && r.owner === 'FRAMEWORK' && r.environment === environment;

/** Bản ghi dọn được trong lần này theo trạng thái (chưa xét retention/phụ thuộc). */
function selectable(r: TestDataRecord, o: CleanupOptions<unknown>): boolean {
  if (o.runId && r.runId !== o.runId) return false;
  if (!isOwned(r, o.environment)) return false;
  if (r.cleanupStatus === 'PENDING' || r.cleanupStatus === 'PLANNED' || r.cleanupStatus === 'RETAINED') return true;
  return Boolean(o.retryBlocked) && r.cleanupStatus === 'CLEANUP_BLOCKED';
}

/** Độ sâu phụ thuộc: bản ghi không phụ thuộc ai = 0. Dọn theo độ sâu GIẢM DẦN (con trước, gốc sau). Chu trình => undefined. */
function depths(records: TestDataRecord[]): Map<string, number> | undefined {
  const byKey = new Map(records.map((r) => [`${r.model}:${r.recordId}`, r]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (k: string): number => {
    if (memo.has(k)) return memo.get(k)!;
    if (visiting.has(k)) throw new Error('cycle');
    visiting.add(k);
    const r = byKey.get(k);
    const deps = [...(r?.dependsOn ?? []), ...(r?.parent ? [r.parent] : [])].filter((d) => byKey.has(d));
    const v = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(k);
    memo.set(k, v);
    return v;
  };
  try {
    for (const k of byKey.keys()) depth(k);
  } catch {
    return undefined;
  }
  return memo;
}

/**
 * Phạm vi cleanup: bản ghi của đúng môi trường, đúng lần chạy, và (nếu có) CHỈ các bản ghi "model:id" được chỉ định.
 * Bản ghi chỉ định mà không nằm trong phạm vi (sai môi trường/lần chạy/không có trong registry) ⇒ `unknown` không rỗng ⇒ bên gọi phải từ chối toàn bộ.
 */
export function cleanupScope(registry: TestDataRecord[], o: { environment: string; runId?: string; only?: string[] }): { scope: TestDataRecord[]; unknown: string[] } {
  const inEnv = registry.filter((r) => r.environment === o.environment && (!o.runId || r.runId === o.runId));
  const keys = (r: TestDataRecord) => `${r.model}:${r.recordId}`;
  const unknown = (o.only ?? []).filter((k) => !inEnv.some((r) => keys(r) === k));
  return { scope: o.only ? inEnv.filter((r) => o.only!.includes(keys(r))) : inEnv, unknown };
}

export async function runCleanup<C>(o: CleanupOptions<C>): Promise<CleanupSummary> {
  const now = o.now ?? Date.now();
  const redact = o.redact ?? ((s: string) => s);
  const setStatus = o.setStatus ?? ((r, st, note, until) => setCleanupStatus(r, st, note, until));
  const exec = o.exec ?? defaultExec;
  const outcomes: CleanupOutcome[] = [];
  const out = (r: TestDataRecord, status: OutcomeStatus, reason?: string, steps: string[] = [], retainUntil?: string) =>
    outcomes.push({ key: `${r.model}:${r.recordId}`, model: r.model, id: r.recordId, reference: r.reference, environment: r.environment, runId: r.runId, requirementId: r.requirementId, testCaseId: r.testCaseId, status, reason, steps, retainUntil });
  const mark = (r: TestDataRecord, status: CleanupStatus, note?: string, until?: string) => {
    if (!o.dryRun) setStatus(r, status, note, until);
  };

  const all = o.records.filter((r) => !o.runId || r.runId === o.runId);
  const candidates = all.filter((r) => selectable(r, o as CleanupOptions<unknown>));
  const rank = depths(all);
  if (!rank) {
    for (const r of candidates) {
      out(r, 'CLEANUP_BLOCKED', 'quan hệ phụ thuộc của dữ liệu test có chu trình; không xác định được thứ tự dọn');
      mark(r, 'CLEANUP_BLOCKED', 'phụ thuộc có chu trình');
    }
    return summarize(outcomes);
  }
  const key = (r: TestDataRecord) => `${r.model}:${r.recordId}`;
  const order = [...candidates].sort((a, b) => (rank.get(key(b)) ?? 0) - (rank.get(key(a)) ?? 0) || a.recordId - b.recordId);

  // 1) Retention của test FAIL.
  const held = new Map<string, string>(); // key -> retainUntil (còn hiệu lực)
  for (const r of order) {
    if (!o.failedTestCases?.has(r.testCaseId) || o.policy.failureRetentionHours <= 0) continue;
    const until = r.retainUntil ?? new Date(now + o.policy.failureRetentionHours * 3600_000).toISOString();
    if (Date.parse(until) > now) {
      held.set(key(r), until);
      if (r.cleanupStatus !== 'RETAINED' || r.retainUntil !== until) mark(r, 'RETAINED', `Test case ${r.testCaseId} FAIL: giữ để điều tra tới ${until}`, until);
    }
  }
  // Bản ghi gốc của bản ghi đang giữ cũng phải giữ (không dọn gốc khi con còn).
  const holdByDependents = (r: TestDataRecord): string | undefined => {
    for (const d of all) {
      if (d === r) continue;
      const dependsOnR = d.parent === key(r) || (d.dependsOn ?? []).includes(key(r));
      if (dependsOnR && held.has(key(d))) return held.get(key(d));
    }
    return undefined;
  };

  // 2) Lập kế hoạch theo handler (chỉ đọc), rồi thực thi theo thứ tự con trước gốc.
  const items = new Map<string, { item: PlanItem; handler: CleanupHandler<C> }>();
  const planable = order.filter((r) => !held.has(key(r)));
  for (const h of o.handlers) {
    const mine = planable.filter((r) => h.models.includes(r.model));
    if (!mine.length) continue;
    try {
      for (const it of await h.plan({ client: o.client, records: mine })) items.set(`${it.model}:${it.id}`, { item: it, handler: h });
    } catch (e) {
      for (const r of mine) {
        const why = `không lập được kế hoạch cleanup: ${redact((e as Error).message)}`;
        out(r, 'CLEANUP_BLOCKED', why);
        mark(r, 'CLEANUP_BLOCKED', why);
      }
      for (const r of mine) held.set(key(r), '');
    }
  }

  const settled = new Set<string>(); // đã dọn xong (hoặc đã sạch) trong lần này
  for (const r of order) {
    const k = key(r);
    if (outcomes.some((x) => x.key === k)) continue; // đã có kết quả (lỗi lập kế hoạch)
    if (held.has(k) && held.get(k)) {
      out(r, 'RETAINED', `Test case ${r.testCaseId} FAIL: giữ để điều tra tới ${held.get(k)}`, [], held.get(k));
      continue;
    }
    const holdUntil = holdByDependents(r);
    if (holdUntil) {
      const why = `giữ vì bản ghi phụ thuộc đang được giữ để điều tra tới ${holdUntil}`;
      out(r, 'RETAINED', why, [], holdUntil);
      mark(r, 'RETAINED', why, holdUntil);
      continue;
    }
    // Còn bản ghi phụ thuộc (của framework) chưa dọn => không dọn gốc.
    const pending = all.filter((d) => d !== r && (d.parent === k || (d.dependsOn ?? []).includes(k)) && d.cleanupStatus !== 'CLEANED' && !settled.has(key(d)));
    if (pending.length) {
      const why = `còn bản ghi phụ thuộc chưa dọn: ${pending.map(key).join(', ')}`;
      out(r, 'CLEANUP_BLOCKED', why);
      mark(r, 'CLEANUP_BLOCKED', why);
      continue;
    }
    const entry = items.get(k);
    if (!entry) {
      const why = `CHƯA HỖ TRỢ: không có quy trình cleanup cho ${r.model}`;
      out(r, 'CLEANUP_BLOCKED', why);
      mark(r, 'CLEANUP_BLOCKED', why);
      continue;
    }
    const { item, handler } = entry;
    if (!handler.supported) {
      const why = `CHƯA HỖ TRỢ: ${handler.unsupportedReason ?? handler.id}`;
      out(r, 'CLEANUP_BLOCKED', why);
      mark(r, 'CLEANUP_BLOCKED', why);
      continue;
    }
    if (item.alreadyClean) {
      out(r, o.dryRun ? 'WOULD_CLEAN' : 'CLEANED', 'đã ở trạng thái đã dọn');
      mark(r, 'CLEANED', 'đã ở trạng thái đã dọn');
      settled.add(k);
      continue;
    }
    if (!item.eligible || !item.steps.length) {
      const why = item.blockers.join('; ') || 'không có bước cleanup an toàn';
      out(r, 'CLEANUP_BLOCKED', why);
      mark(r, 'CLEANUP_BLOCKED', why);
      continue;
    }
    if (o.dryRun) {
      out(r, 'WOULD_CLEAN', undefined, item.steps.map((s) => s.op));
      settled.add(k);
      continue;
    }
    const done: string[] = [];
    try {
      for (const step of item.steps) {
        await exec(o.client, r.model, r.recordId, step);
        done.push(step.op);
      }
      out(r, 'CLEANED', undefined, done);
      mark(r, 'CLEANED', `đã dọn: ${done.join(' → ')}`);
      settled.add(k);
    } catch (e) {
      const why = `bước ${item.steps[done.length]?.op ?? '?'} lỗi: ${redact((e as Error).message)}${done.length ? ` (đã làm: ${done.join(' → ')})` : ''}`;
      out(r, 'CLEANUP_BLOCKED', why, done);
      mark(r, 'CLEANUP_BLOCKED', why);
    }
  }
  return summarize(outcomes);
}

function summarize(outcomes: CleanupOutcome[]): CleanupSummary {
  const counts: Record<OutcomeStatus, number> = { CLEANED: 0, CLEANUP_BLOCKED: 0, RETAINED: 0, WOULD_CLEAN: 0, NOT_ELIGIBLE: 0 };
  for (const o of outcomes) counts[o.status]++;
  return { outcomes, counts };
}

// ---- Điều kiện tiên quyết: QA Report + Bug Report + evidence phải có TRƯỚC khi cleanup ----
/** Lý do chưa được cleanup vì báo cáo/evidence của lần chạy chưa đầy đủ. Rỗng = đủ. */
export function evidenceProblems(reportsDir: string, runId: string): string[] {
  const out: string[] = [];
  const results = path.join(reportsDir, 'runs', runId, 'results.json');
  if (!fs.existsSync(results)) {
    out.push(`chưa có kết quả của lần chạy ${runId} (runs/${runId}/results.json)`);
    return out;
  }
  const t = fs.statSync(results).mtimeMs;
  for (const f of ['qa-report.html', 'qa-results.json', 'qa-summary.md', 'bugs.json']) {
    const p = path.join(reportsDir, f);
    if (!fs.existsSync(p)) out.push(`thiếu ${f} (chạy npm run qa:finish trước khi cleanup)`);
    else if (fs.statSync(p).mtimeMs + 1 < t) out.push(`${f} cũ hơn kết quả của lần chạy ${runId} (chạy npm run qa:finish)`);
  }
  return out;
}

/** Test case FAIL trong lần chạy (đọc từ results.json của lần chạy; chỉ đọc). */
export function failedTestCases(reportsDir: string, runId: string): Set<string> {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(reportsDir, 'runs', runId, 'results.json'), 'utf8')) as { entries: { tcId: string; status: string }[] };
    return new Set(run.entries.filter((e) => e.status === 'FAIL').map((e) => e.tcId));
  } catch {
    return new Set();
  }
}

/** Ghi báo cáo cleanup riêng (không đụng kết quả kiểm thử): reports/<ENV>/cleanup/cleanup-<runId>-<mốc>.json|md. */
export function writeCleanupReport(reportsDir: string, meta: { environment: string; runId?: string; dryRun: boolean }, s: CleanupSummary): string {
  const dir = path.join(reportsDir, 'cleanup');
  fs.mkdirSync(dir, { recursive: true });
  const iso = new Date().toISOString();
  const stamp = `${iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${iso.slice(20, 23)}`;
  const base = path.join(dir, `cleanup-${meta.runId ?? 'all'}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ generatedAt: iso, ...meta, counts: s.counts, outcomes: s.outcomes }, null, 2) + '\n', { flag: 'wx' });
  const md = [
    `# Cleanup dữ liệu test${meta.dryRun ? ' (DRY-RUN)' : ''} — ${meta.environment}${meta.runId ? ` — lần chạy ${meta.runId}` : ''}`, '',
    'Cleanup KHÔNG thay đổi kết quả kiểm thử. Chỉ dữ liệu trong registry do framework sở hữu.', '',
    '| Trạng thái | Số lượng |', '|---|---|', ...Object.entries(s.counts).map(([k, v]) => `| ${k} | ${v} |`), '',
    '| Bản ghi | Tham chiếu | Requirement | Test case | Trạng thái | Nguyên nhân |', '|---|---|---|---|---|---|',
    ...s.outcomes.map((o) => `| ${o.key} | ${o.reference} | ${o.requirementId ?? '-'} | ${o.testCaseId} | ${o.status} | ${(o.reason ?? o.steps.join(' → ')).replace(/\|/g, '\\|')} |`), '',
  ];
  fs.writeFileSync(`${base}.md`, md.join('\n'));
  return `${base}.md`;
}

export { recordKey };
