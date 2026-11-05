import fs from 'node:fs';
import path from 'node:path';
import { getApp } from '../applications';
import { evaluate } from '../core/approval/approval';
import { buildReadiness, scanSpecs } from '../core/automation/readiness';
import { env as dotenv } from '../core/config/env';
import { resolveEnvironment, roleMissing } from '../core/environment/config';
import { fixturesDirFor, reportsDirFor } from '../core/environment/paths';
import { confirmationProblem, readState } from '../core/environment/state';
import { policyCheck } from '../core/policy/policy';
import { loadAutomation } from '../core/automation/meta';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';

// Kiểm tra sẵn sàng Giai đoạn 2, OFFLINE (không kết nối mạng, không đăng nhập, không ghi dữ liệu nghiệp vụ):
//   npm run qa:ready -- --requirement=REQ-XXX
// Xác minh phê duyệt, môi trường đã chọn + xác nhận, tài khoản theo vai trò (chỉ tên biến), module/spec, fixture; phân loại dự kiến từng
// test case (ELIGIBLE/BLOCKED/NOT RUN/NEEDS CLARIFICATION) và gom MỘT danh sách câu hỏi. Ghi kết quả vào reports/<ENV>/readiness/ (file mới, không ghi đè).
const root = process.cwd();
const reqId = process.argv.find((a) => a.startsWith('--requirement='))?.slice(14);
if (!reqId) {
  console.error('Lỗi: thiếu --requirement=REQ-XXX');
  process.exit(2);
}
const requirement = loadRequirements().find((r) => r.id === reqId);
if (!requirement) {
  console.error(`Lỗi: không có requirement ${reqId}`);
  process.exit(1);
}
const defs = loadTestCases().filter((d) => d.requirementId === reqId);
const ev = evaluate(root, requirement, defs);
const app = getApp(requirement.application || dotenv.app);
const selected = readState(root).selected;

let environment;
let writePolicy: { ok: boolean; detail: string } | undefined;
let environmentProblem: string | undefined;
let roleMiss: Record<string, string[]> = {};
if (!selected) environmentProblem = 'Chưa chọn môi trường kiểm thử: mở giao diện web để người dùng chọn và xác nhận (npm run qa:env-web -- --requirement=<REQ-ID>); dự phòng: npm run qa:env -- list, rồi select.';
else if (selected.application !== app.name) environmentProblem = `Môi trường đang chọn thuộc ứng dụng "${selected.application}", requirement thuộc "${app.name}".`;
else {
  const r = resolveEnvironment(app.name, selected.environment);
  if (!r.ok) environmentProblem = `Môi trường ${selected.environment} không hợp lệ: ${r.problems.join('; ')}`;
  else {
    environment = { key: r.env.key, label: r.env.label, kind: r.env.kind, host: r.env.host };
    roleMiss = Object.fromEntries(Object.keys(app.roles).map((role) => [role, roleMissing(r.env, role)]));
    if (ev.record?.approval) {
      const pc = policyCheck(root, r.env, reqId, ev.record.approval.hash);
      writePolicy = { ok: pc.ok, detail: pc.ok ? `đã xác nhận (phiên ${pc.confirmation?.sessionId}); tự cleanup: ${pc.policy.autoCleanup ? 'bật' : 'tắt'}` : (pc.problem ?? 'chưa xác nhận') };
    }
    environmentProblem = ev.record?.approval ? confirmationProblem(root, r.env, reqId, ev.record.approval.hash) : 'Chưa có phê duyệt hợp lệ để xác nhận môi trường.';
  }
}

const keys = [...new Set(defs.map((d) => `${d.application ?? '-'}-${d.module ?? '-'}`))];
const fixtureDir = selected ? fixturesDirFor(selected.environment) : undefined;
const fixtureModules = new Set(keys.filter((k) => fixtureDir && fs.existsSync(path.join(fixtureDir, `${k}.json`))));
const result = buildReadiness({
  requirementId: reqId,
  defs,
  approval: { ok: ev.ok, reason: `${ev.state}: ${ev.reason}` },
  environment,
  environmentProblem,
  roleMissing: roleMiss,
  defaultRole: Object.keys(app.roles)[0],
  specs: scanSpecs('tests', keys),
  automation: loadAutomation().files,
  fixtureModules,
  writePolicy,
});

console.log(`\nSẴN SÀNG GIAI ĐOẠN 2 — ${reqId}${result.environment ? ` — môi trường ${result.environment}` : ''}`);
for (const c of result.checks) console.log(`  [${c.ok ? 'ĐẠT' : 'CHƯA'}] ${c.name}: ${c.detail}`);
console.log(`\nDự kiến: ELIGIBLE ${result.counts.ELIGIBLE} · BLOCKED ${result.counts.BLOCKED} · NOT RUN ${result.counts['NOT RUN']} · NEEDS CLARIFICATION ${result.counts['NEEDS CLARIFICATION']} (đây là dự báo, không phải kết quả kiểm thử)`);
for (const t of result.testCases) console.log(`  ${t.classification.padEnd(19)} ${t.tcId}  ${t.reason}`);
console.log(result.questions.length ? `\nCÂU HỎI CẦN NGƯỜI DÙNG (gom một lần):\n${result.questions.map((q, n) => `  ${n + 1}. ${q}`).join('\n')}` : '\nKhông có câu hỏi nào cần người dùng.');
console.log(`\nBước tiếp theo:\n${result.nextSteps.map((s) => `  - ${s}`).join('\n')}`);
if (selected) {
  const dir = path.join(reportsDirFor(selected.environment), 'readiness');
  fs.mkdirSync(dir, { recursive: true });
  const iso = new Date().toISOString(); // YYYYMMDD-HHmmss-SSS: không đụng tên khi chạy liên tiếp trong cùng một giây
  const stamp = `${iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${iso.slice(20, 23)}`;
  const file = path.join(dir, `${reqId}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2), { flag: 'wx' });
  console.log(`\nĐã lưu: ${path.relative(root, file).split(path.sep).join('/')}`);
}
