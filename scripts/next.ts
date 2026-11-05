import '../core/config/env'; // nạp .env (cấu hình môi trường) vào process.env
import { getApp, listApps } from '../applications';
import { listOpenRequirements, markWorkflow, nextStep, readWorkflow, resolveActiveRequirement } from '../core/workflow/next';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';
import { formatReview } from '../core/workflow/review';

// Bước tiếp theo của quy trình /qa-requirement, suy ra từ TRẠNG THÁI THỰC TẾ (không cần nhớ phiên trước). CHỈ ĐỌC, không kết nối mạng.
//   npm run qa:next [-- --requirement=REQ-XXX] [--json] [--list]
//   npm run qa:next -- --requirement=REQ-XXX --mark=automation-done   # Claude đánh dấu đã tạo xong spec cho các test case tự động hóa được
// Không có --requirement: dùng requirement đang dở của phiên làm việc (.qa-state/workflow.json) hoặc phiên thực thi đang mở.
// Dành cho Claude (và người vận hành khi debug). Người dùng thông thường chỉ cần gõ /qa-requirement.
const root = process.cwd();
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const json = process.argv.includes('--json');
const requirements = loadRequirements();
const defs = loadTestCases();
const input = {
  root,
  requirements,
  defs,
  roles: (app: string) => (listApps().includes(app) ? Object.keys(getApp(app).roles) : []),
  roleDescription: undefined,
};

if (process.argv.includes('--list')) {
  const open = listOpenRequirements(input);
  console.log(json ? JSON.stringify(open) : open.length ? open.map((o) => `${o.id}  ${o.stage}`).join('\n') : 'Không có requirement nào đang dở.');
  process.exit(0);
}

const explicit = arg('requirement');
const reqId = resolveActiveRequirement(root, explicit);
if (reqId && requirements.some((r) => r.id === reqId)) {
  // Ghi nhớ requirement đang xử lý để lần gọi lại /qa-requirement sau khi đóng phiên tiếp tục đúng chỗ.
  const mark = arg('mark');
  if (explicit || mark) markWorkflow(root, reqId, mark);
}
const step = nextStep({ ...input, requirementId: reqId });

if (json) {
  console.log(JSON.stringify(step, null, 2));
  process.exit(0);
}
if (step.review) console.log(`\n${formatReview(step.review)}`);
console.log(`\nBƯỚC TIẾP THEO${step.requirementId ? ` — ${step.requirementId}` : ''}: ${step.stage} (${step.owner === 'user' ? 'cần NGƯỜI DÙNG' : step.owner === 'claude' ? 'Claude tự làm' : 'không cần làm gì'})`);
console.log(step.summary);
for (const c of step.checks) console.log(`  [${c.ok ? 'ĐẠT' : 'CHƯA'}] ${c.name}: ${c.detail}`);
if (step.actions.length) console.log(`\nClaude làm tiếp:\n${step.actions.map((a) => `  - ${a}`).join('\n')}`);
if (step.userActions.length) console.log(`\nNgười dùng cần làm:\n${step.userActions.map((a) => `  - ${a}`).join('\n')}`);
if (!reqId) {
  const w = readWorkflow(root);
  if (w.requirementId) console.log(`\n(Phiên trước đang xử lý ${w.requirementId} nhưng requirement này không còn trong requirements/.)`);
}
