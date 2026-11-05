import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { listApps } from '../applications';
import { env as dotenv } from '../core/config/env';
import { getRunId } from '../core/config/run';
import { resolveEnvironment } from '../core/environment/config';
import { confirmationProblem, readState } from '../core/environment/state';
import { policyCheck, productionReason } from '../core/policy/policy';
import { gateForRun } from '../core/approval/gate';
import { SCOPE_ENV, resolveRunScope } from '../core/approval/scope';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';

// Chạy test với quyền ghi được kiểm soát, KHÔNG phụ thuộc giá trị ALLOW_WRITE_TESTS trong .env.
//   npm test                                   # CHỈ ĐỌC: ép ALLOW_WRITE_TESTS=false, xoá mọi giấy phép ghi
//   npm run test:framework                     # test kỹ thuật của framework (không Odoo); ghi tóm tắt vào reports/framework-tests.json
//   npm run test:write -- --module=odoo-sales  # CHO PHÉP GHI cho ĐÚNG MỘT module, trên môi trường này, trong lần chạy này
//   (không bàn phím) --confirm-host=<host>
//   npm test -- --requirement=REQ-SO-INV-001   # chạy ĐỘC LẬP một requirement (mặc định của /qa-requirement); thiếu thì chạy theo project/module
// Môi trường: chạy trên môi trường đã CHỌN (npm run qa:env -- select) và đã được NGƯỜI DÙNG xác nhận riêng (npm run qa:env -- confirm).
// --env=<TÊN> chỉ để khẳng định, không bao giờ tự chuyển môi trường. Kết quả/evidence/phiên/sổ dữ liệu test nằm trong thư mục riêng của môi trường.
// Giấy phép ghi = (môi trường, module, lần chạy). Nó hết hiệu lực khi lệnh kết thúc và không dùng được cho module/môi trường khác.
// Các tham số còn lại được chuyển nguyên cho `playwright test` (ví dụ: -g "TC-SO-010").
const argv = process.argv.slice(2);
const cli = path.resolve('node_modules', '@playwright', 'test', 'cli.js');
const runId = getRunId();

if (argv.includes('--framework')) {
  const tmp = path.join(os.tmpdir(), 'qa-framework-reports');
  fs.rmSync(tmp, { recursive: true, force: true });
  const rest = argv.filter((a) => a !== '--framework');
  const r = spawnSync(process.execPath, [cli, 'test', '--project=framework', ...rest], {
    stdio: 'inherit',
    env: { ...process.env, ALLOW_WRITE_TESTS: 'false', QA_WRITE_GRANT: '', QA_ENV: '', QA_REPORTS_DIR: tmp, QA_RUN_ID: runId },
  });
  // Tóm tắt tách riêng khỏi kết quả test nghiệp vụ: framework test KHÔNG tính vào Pass Coverage.
  const jsonFile = path.join(tmp, 'runs', runId, 'playwright-results.json');
  if (fs.existsSync(jsonFile)) {
    const s = JSON.parse(fs.readFileSync(jsonFile, 'utf8')).stats as { expected: number; unexpected: number; skipped: number; flaky: number; duration: number };
    const summary = { ranAt: new Date().toISOString(), runId, total: s.expected + s.unexpected + s.skipped + s.flaky, passed: s.expected, failed: s.unexpected, skipped: s.skipped, flaky: s.flaky, durationMs: Math.round(s.duration) };
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync(path.join('reports', 'framework-tests.json'), JSON.stringify(summary, null, 2));
    console.log(`Tóm tắt framework test: ${summary.passed}/${summary.total} đạt (reports/framework-tests.json)`);
  }
  process.exit(r.status ?? 1);
}

const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const wantWrite = argv.includes('--write');
const moduleKey = arg('module');
const confirmArg = arg('confirm-host');
const envArg = arg('env');
// --no-auto-cleanup: tắt cleanup tự động cho LẦN CHẠY NÀY (dữ liệu giữ nguyên để kiểm tra; chỉ có thể tắt, không bật được).
const noAutoCleanup = argv.includes('--no-auto-cleanup');
// --requirement=<REQ-ID>: chạy ĐỘC LẬP một requirement. Cổng Approval/Environment/Write Policy chỉ xét requirement này, và chỉ test case của nó được chạy
// (không kéo theo requirement khác cùng module). Không có tham số này = chạy theo project/module: MỌI requirement trong phạm vi đều phải được duyệt.
const requirementArg = arg('requirement');
const passthrough = argv.filter((a) => a !== '--write' && !a.startsWith('--confirm-host=') && !a.startsWith('--module=') && !a.startsWith('--env=') && !a.startsWith('--requirement=') && a !== '--no-auto-cleanup');

// APPROVAL GATE (bằng code): chưa có phê duyệt hợp lệ khớp hash bộ test case hiện tại thì KHÔNG mở bất kỳ kết nối nào tới staging
// (kể cả đăng nhập setup). Phê duyệt KHÔNG suy ra quyền ghi: quyền ghi (--write, xác nhận host) vẫn xin riêng bên dưới.
const allRequirements = loadRequirements();
const allDefs = loadTestCases();
const requestedProjects = wantWrite && moduleKey ? [moduleKey] : passthrough.filter((a) => a.startsWith('--project=')).map((a) => a.slice(10));
const resolvedScope = resolveRunScope(allRequirements, allDefs, { projects: requestedProjects, requirement: requirementArg });
if (!resolvedScope.scope) {
  console.error('\nPHẠM VI CHẠY không hợp lệ:');
  for (const p of resolvedScope.problems) console.error(`  - ${p}`);
  process.exit(3);
}
const runScope = resolvedScope.scope;
const scopeProjects = runScope.projects;
// Chạy riêng một requirement mà không chỉ định project: chạy đúng các project (module) có test case của requirement đó.
if (runScope.requirement && !requestedProjects.length) for (const p of scopeProjects) passthrough.unshift(`--project=${p}`);
const gate = gateForRun(process.cwd(), allRequirements, allDefs, scopeProjects, true, runScope.requirement ? runScope.requirementIds : undefined);
if (!gate.ok) {
  console.error('\nAPPROVAL GATE: TỪ CHỐI chạy test vì bộ test case chưa được phê duyệt hợp lệ:');
  for (const p of gate.problems) console.error(`  - ${p}`);
  console.error('Cần: npm run qa:approval -- submit → người dùng APPROVE (npm run qa:approval -- approve ...) → chạy lại. Chưa kết nối staging.');
  process.exit(3);
}
console.log(`Phạm vi chạy: ${runScope.requirement ? `CHỈ ${runScope.requirement} (${allDefs.filter((d) => d.requirementId === runScope.requirement).length} test case); requirement khác không bị kéo theo` : `theo project/module — mọi requirement trong phạm vi phải được duyệt (${runScope.requirementIds.join(', ') || 'không có'})`}`);
console.log(`Approval Gate: ${gate.evaluations.map((e) => `${e.requirementId} ${e.evaluation.reason}`).join(' | ') || 'không có requirement trong phạm vi'}`);

// ENVIRONMENT GATE (bằng code): phải có môi trường đã chọn, và môi trường đó phải được người dùng xác nhận RIÊNG cho từng requirement trong phạm vi
// (phê duyệt test case dùng chung được, xác nhận thực thi thì không). Không tự chuyển môi trường dù thiếu tài khoản hay đăng nhập lỗi.
const scopeApps = new Set(scopeProjects.map((p) => p.split('-')[0]));
const appName = scopeApps.size === 1 ? [...scopeApps][0] : scopeApps.size === 0 ? dotenv.app || (listApps().length === 1 ? listApps()[0] : '') : '';
if (!appName || !listApps().includes(appName)) {
  console.error('\nENVIRONMENT GATE: không xác định được ứng dụng duy nhất của lần chạy (dùng --project=<app>-<module>).');
  process.exit(3);
}
const selected = readState(process.cwd()).selected;
if (!selected) {
  console.error('\nENVIRONMENT GATE: chưa chọn môi trường kiểm thử. Chạy: npm run qa:env -- list, rồi npm run qa:env -- select --env=<TÊN>. Chưa kết nối staging.');
  process.exit(3);
}
if (envArg && envArg !== selected.environment) {
  console.error(`\nENVIRONMENT GATE: bạn yêu cầu --env=${envArg} nhưng môi trường đang chọn là ${selected.environment}. Không tự chuyển: chạy npm run qa:env -- select --env=${envArg} (và xác nhận) trước. Chưa kết nối staging.`);
  process.exit(3);
}
if (selected.application !== appName) {
  console.error(`\nENVIRONMENT GATE: môi trường đang chọn thuộc ứng dụng "${selected.application}", lần chạy này là "${appName}". Chưa kết nối staging.`);
  process.exit(3);
}
const resolvedEnv = resolveEnvironment(appName, selected.environment);
if (!resolvedEnv.ok) {
  console.error(`\nENVIRONMENT GATE: môi trường ${selected.environment} không hợp lệ: ${resolvedEnv.problems.join('; ')}. Chưa kết nối staging.`);
  process.exit(3);
}
const target = resolvedEnv.env;
const envProblems = gate.evaluations.flatMap((e) => {
  const p = confirmationProblem(process.cwd(), target, e.requirementId, e.evaluation.record?.approval?.hash ?? '');
  return p ? [`${e.requirementId}: ${p}`] : [];
});
if (envProblems.length) {
  console.error(`\nENVIRONMENT GATE: TỪ CHỐI chạy trên ${target.key} vì chưa được xác nhận thực thi hợp lệ:`);
  for (const p of envProblems) console.error(`  - ${p}`);
  process.exit(3);
}
console.log(`Environment Gate: ${target.key} (${target.label}, ${target.kind}) — ${target.host} — đã xác nhận cho ${gate.evaluations.map((e) => e.requirementId).join(', ') || 'không có requirement'}. Kết quả: reports/${target.key}/`);

let grant = '';
let policyJson = '';
let autoCleanup = false;
if (wantWrite) {
  if (!moduleKey || !fs.existsSync(path.join('tests', moduleKey))) {
    const have = fs.readdirSync('tests', { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.includes('-')).map((d) => d.name);
    console.error(`Phải chỉ định rõ MỘT module được phép ghi: --module=<${have.join('|')}>`);
    process.exit(2);
  }
  if (moduleKey.split('-')[0] !== appName) {
    console.error(`Module "${moduleKey}" không thuộc ứng dụng "${appName}" của môi trường đang chọn.`);
    process.exit(2);
  }
  const prodReason = productionReason(target);
  if (prodReason) {
    console.error(`Môi trường ${target.key} bị coi là PRODUCTION (${prodReason}): quyền ghi dữ liệu bị từ chối, không có ngoại lệ.`);
    process.exit(2);
  }
  const host = target.host;
  // Chính sách ghi theo môi trường (qa:policy confirm): đã xác nhận MỘT lần cho phiên này thì tự cấp giấy phép ghi, không hỏi lại từng lần.
  const checks = gate.evaluations.map((e) => policyCheck(process.cwd(), target, e.requirementId, e.evaluation.record?.approval?.hash ?? ''));
  if (checks.length && checks.every((c) => c.ok)) {
    policyJson = JSON.stringify({ environment: target.key, write: checks[0].policy.write, autoCleanup: checks[0].policy.autoCleanup, failureRetentionHours: checks[0].policy.failureRetentionHours, maxRecordsPerRun: checks[0].policy.maxRecordsPerRun, sessionId: checks[0].confirmation?.sessionId });
    autoCleanup = checks[0].policy.autoCleanup && !noAutoCleanup;
    console.log(`
CHÍNH SÁCH GHI ĐÃ XÁC NHẬN cho ${target.key} (phiên ${checks[0].confirmation?.sessionId}, bởi ${checks[0].confirmation?.by}): được tự tạo/sửa/cleanup dữ liệu do framework tạo (tối đa ${checks[0].policy.maxRecordsPerRun} bản ghi). Cleanup tự động: ${autoCleanup ? 'BẬT' : 'TẮT'}.`);
    grant = JSON.stringify({ host, environment: target.key, module: moduleKey, runId });
    passthrough.unshift(`--project=${moduleKey}`);
  } else {
  if (checks.length) console.log(`(Chưa có chính sách ghi hợp lệ: ${checks.find((c) => !c.ok)?.problem}. Dùng xác nhận ghi từng lần.)`);
  console.log(`\n⚠ CHẾ ĐỘ GHI DỮ LIỆU\n  Môi trường : ${target.key} (${target.label}, ${target.kind}) — ${host}\n  Module     : ${moduleKey}\n  Lần chạy   : ${runId}`);
  console.log('  Test của module này sẽ TẠO chứng từ/bút toán trên môi trường trên. Giấy phép chỉ hiệu lực cho đúng bốn thông tin này (môi trường, host, module, lần chạy)');
  console.log('  và là xác nhận RIÊNG, không suy ra từ phê duyệt hay xác nhận thực thi. Chỉ dùng cho môi trường test/staging.');
  console.log(`  Dữ liệu tạo ra được ghi vào Test Data Registry của môi trường này (testdata/registry/${target.key}.jsonl) và KHÔNG tự động xoá.`);
  let typed = confirmArg;
  if (typed === undefined) {
    if (!process.stdin.isTTY) {
      console.error('Không có bàn phím để xác nhận. Dùng --confirm-host=<host> nếu thực sự muốn ghi.');
      process.exit(2);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    typed = (await rl.question(`Gõ lại đúng tên host "${host}" để tiếp tục (Enter để hủy): `)).trim();
    rl.close();
  }
  if (typed !== host) {
    console.error('Host xác nhận không khớp. Đã hủy, không chạy test.');
    process.exit(2);
  }
  grant = JSON.stringify({ host, environment: target.key, module: moduleKey, runId });
  passthrough.unshift(`--project=${moduleKey}`);
  }
} else {
  console.log('Chế độ CHỈ ĐỌC (ALLOW_WRITE_TESTS bị ép = false, không có giấy phép ghi). Test ghi dữ liệu sẽ BLOCKED. Muốn ghi: npm run test:write -- --module=<app>-<module>');
}

// Requirement đang xử lý (nếu phạm vi chỉ có một): báo cáo mặc định lọc theo nó.
const focusReq = runScope.requirement ?? (gate.evaluations.length === 1 ? gate.evaluations[0].requirementId : '');
const res = spawnSync(process.execPath, [cli, 'test', ...passthrough], {
  stdio: 'inherit',
  env: { ...process.env, ALLOW_WRITE_TESTS: wantWrite ? 'true' : 'false', QA_WRITE_GRANT: grant, QA_RUN_ID: runId, QA_APPROVAL_GATE: 'passed', QA_ENV: target.key, QA_FOCUS_REQ: focusReq, QA_POLICY: policyJson, [SCOPE_ENV]: JSON.stringify(runScope) },
});
// Luôn dựng lại và đối chiếu báo cáo sau mỗi lần chạy (kể cả khi mọi test BLOCKED/NOT RUN). Mở báo cáo: npm run qa:finish.
const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
const fin = spawnSync(process.execPath, [tsxCli, path.resolve('scripts', 'qa-finish.ts'), '--no-open', ...(focusReq ? [`--requirement=${focusReq}`] : [])], { stdio: 'inherit', env: { ...process.env, QA_ENV: target.key } });
// Cleanup TỰ ĐỘNG theo chính sách: chỉ SAU KHI đã có QA Report + Bug Report + evidence (qa-finish ở trên) và verify khớp. Lỗi cleanup không đổi kết quả test.
if (autoCleanup && fin.status === 0) {
  console.log('\nAUTO_CLEANUP: dọn dữ liệu test của lần chạy này theo chính sách...');
  spawnSync(process.execPath, [tsxCli, path.resolve('scripts', 'cleanup-run.ts'), `--run=${runId}`], { stdio: 'inherit', env: { ...process.env, QA_ENV: target.key } });
} else if (autoCleanup) {
  console.log('\nAUTO_CLEANUP bị bỏ qua vì báo cáo chưa đạt đối chiếu (qa:finish): dữ liệu được giữ nguyên.');
}
process.exit(res.status === 0 ? (fin.status ?? 0) : (res.status ?? 1));
