import path from 'node:path';
import { openOdooClient } from '../applications/odoo/session';
import { odooFactoryCleanupHandlers } from '../applications/odoo/factory-cleanup';
import { adapterCleanupHandlers, mergeHandlers } from '../applications/odoo/generic-cleanup';
import { loadAdapters } from '../core/adapters/manifest';
import { evaluate } from '../core/approval/approval';
import { resolveEnvironment } from '../core/environment/config';
import { reportsDirFor } from '../core/environment/paths';
import { readState } from '../core/environment/state';
import { effectivePolicy, policyCheck, productionReason } from '../core/policy/policy';
import { collectSecrets } from '../core/security/scan';
import { redactText } from '../core/security/scrub-trace';
import { cleanupScope, evidenceProblems, failedTestCases, runCleanup, writeCleanupReport } from '../core/testdata/cleanup-engine';
import { loadRegistry } from '../core/testdata/registry';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';
import { pickEnvironment } from './_env';

// Cleanup dữ liệu test do framework sở hữu, theo chính sách môi trường (AUTO_CLEANUP gọi script này sau QA Report).
//   npm run cleanup:run -- --run=<runId>          # dọn dữ liệu của một lần chạy (cần QA Report + Bug Report đã dựng)
//   npm run cleanup:run -- --due                  # dọn dữ liệu test FAIL đã hết thời gian giữ (retainUntil) và dữ liệu PENDING
//   npm run cleanup:run -- --run=<id> --retry-blocked   # thử lại bản ghi CLEANUP_BLOCKED
//   npm run cleanup:run -- --run=<id> --dry-run   # chỉ cho biết sẽ dọn gì, không thay đổi gì
// Không bao giờ: dọn dữ liệu ngoài registry, dữ liệu chưa có chủ sở hữu FRAMEWORK, chứng từ bị ràng buộc kế toán, hay production.
const argv = process.argv.slice(2);
const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => argv.includes(`--${n}`);
const fail = (m: string, code = 3): never => {
  console.error(`CLEANUP GATE: ${m}`);
  process.exit(code);
};

const envKey = pickEnvironment(argv)!;
const sel = readState(process.cwd()).selected!;
const resolved = resolveEnvironment(sel.application, envKey);
const env = resolved.ok ? resolved.env : fail(`môi trường ${envKey} không hợp lệ: ${resolved.problems.join('; ')}`);
const prod = productionReason(env);
if (prod) fail(`${envKey} bị coi là production (${prod}): không cleanup tự động.`);

const dryRun = flag('dry-run');
const runId = arg('run');
const due = flag('due');
if (!runId && !due) fail('chỉ định --run=<runId> hoặc --due', 2);

const reportsDir = reportsDirFor(envKey);
const registry = loadRegistry();
const now = Date.now();
// Phạm vi thực tế: bản ghi của môi trường, đúng lần chạy; --due chỉ lấy bản ghi tới hạn (RETAINED hết hạn) hoặc PENDING của test không FAIL.
// --only=model:id,model:id: thu hẹp CHÍNH XÁC vào các bản ghi chỉ định (ví dụ khi người dùng chỉ cho phép dọn đúng vài bản ghi).
// Bản ghi chỉ định mà không có trong phạm vi (sai môi trường/lần chạy/không có registry) ⇒ từ chối toàn bộ, không dọn gì.
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const { scope, unknown } = cleanupScope(registry, { environment: envKey, runId, only });
if (unknown.length) fail(`--only chứa bản ghi không có trong registry của ${envKey}${runId ? ` lần chạy ${runId}` : ''}: ${unknown.join(', ')}`, 2);
const runs = [...new Set(scope.map((r) => r.runId))];
if (!scope.length) {
  console.log(`Không có bản ghi nào của ${envKey}${runId ? ` thuộc lần chạy ${runId}` : ''} trong registry. Không có gì để dọn.`);
  process.exit(0);
}

if (!dryRun) {
  // 1) Chính sách ghi đã xác nhận cho từng requirement liên quan, và autoCleanup được bật.
  const reqs = loadRequirements();
  const defs = loadTestCases();
  const reqIds = [...new Set(scope.filter((r) => r.owner === 'FRAMEWORK').map((r) => r.requirementId).filter(Boolean))] as string[];
  for (const id of reqIds) {
    const req = reqs.find((r) => r.id === id);
    const hash = req ? evaluate(process.cwd(), req, defs.filter((d) => d.requirementId === id)).record?.approval?.hash ?? '' : '';
    const chk = policyCheck(process.cwd(), env, id, hash);
    if (!chk.ok) fail(chk.problem ?? 'chính sách chưa hợp lệ');
    if (!chk.policy.autoCleanup && !flag('manual')) fail(`chính sách của ${envKey} tắt AUTO_CLEANUP (thêm --manual nếu chính bạn đang chủ động dọn).`);
  }
  // 2) QA Report + Bug Report + evidence phải có TRƯỚC khi cleanup.
  for (const id of runs) {
    const p = evidenceProblems(reportsDir, id);
    if (p.length) fail(`chưa đủ báo cáo/evidence cho lần chạy ${id}: ${p.join('; ')}`);
  }
}

const { client } = await openOdooClient();
const secrets = collectSecrets(process.cwd()).secrets;
const failed = new Set<string>();
for (const id of runs) for (const tc of failedTestCases(reportsDir, id)) failed.add(tc);
const policy = effectivePolicy(env);
const summary = await runCleanup({
  client,
  handlers: mergeHandlers(odooFactoryCleanupHandlers, adapterCleanupHandlers(loadAdapters(process.cwd(), 'odoo').adapters)),
  records: scope,
  environment: envKey,
  policy,
  runId,
  now,
  failedTestCases: failed,
  retryBlocked: flag('retry-blocked'),
  dryRun,
  redact: (s) => redactText(s, secrets).text,
});
const report = writeCleanupReport(reportsDir, { environment: envKey, runId, dryRun }, summary);
console.log(`Cleanup${dryRun ? ' (DRY-RUN)' : ''} ${envKey}${runId ? ` lần chạy ${runId}` : ''}: ${Object.entries(summary.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'không có bản ghi nào đủ điều kiện'}`);
for (const o of summary.outcomes.filter((x) => x.status === 'CLEANUP_BLOCKED')) console.log(`  CLEANUP_BLOCKED ${o.key} (${o.reference}): ${o.reason}`);
for (const o of summary.outcomes.filter((x) => x.status === 'RETAINED')) console.log(`  RETAINED ${o.key}: ${o.reason}`);
console.log(`Báo cáo cleanup: ${path.relative(process.cwd(), report)} (kết quả kiểm thử KHÔNG bị thay đổi).`);
