import { evaluateAndSync } from '../core/approval/approval';
import { nativeConfirm, openInBrowser } from '../core/approval/open';
import { startReviewServer } from '../core/approval/server';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';

// Giao diện Web Review & Approval cho MỘT requirement (Approval Gate trên trình duyệt).
//   npm run qa:review -- --requirement=REQ-XXX [--no-open] [--port=N]
// Chạy ở chế độ nền (run_in_background): in link, mở trình duyệt, chờ người dùng bấm APPROVE/REVISE/REJECT rồi tự thoát (kèm kết quả).
// APPROVE trên web cần: gõ đúng cụm xác nhận + bấm Yes trên hộp thoại hệ điều hành của máy này. Không có tham số nào bỏ qua hai bước đó.
// Phương án dự phòng: npm run qa:approval -- approve ... (terminal).
const root = process.cwd();
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const reqId = arg('requirement');
const fail = (m: string, code = 1): never => {
  console.error(`Lỗi: ${m}`);
  process.exit(code);
};
if (!reqId) fail('thiếu --requirement=REQ-XXX', 2);

const getContext = () => {
  const requirement = loadRequirements().find((r) => r.id === reqId);
  if (!requirement) throw new Error(`không có requirement ${reqId}`);
  return { root, requirement, defs: loadTestCases().filter((d) => d.requirementId === reqId) };
};

const first = getContext();
const ev = evaluateAndSync(root, first.requirement, first.defs);
if (ev.state !== 'PENDING_APPROVAL') {
  console.log(`${reqId} đang ở trạng thái ${ev.state} (${ev.reason}). Không cần mở giao diện duyệt${ev.state === 'NOT_SUBMITTED' ? ': chạy npm run qa:approval -- submit trước' : ''}.`);
  process.exit(ev.ok ? 0 : 1);
}

let decided: string | undefined;
const server = await startReviewServer({
  root,
  requirementId: reqId!,
  getContext,
  idleMs: 2 * 3600 * 1000,
  port: arg('port') ? Number(arg('port')) : undefined,
  confirm: (i) => nativeConfirm('Xác nhận APPROVE test case', `Duyệt ${i.requirementId} phiên bản v${i.version}\nHash ${i.hash.slice(0, 12)}...\nNgười duyệt: ${i.by}\n\nChọn Yes CHỈ khi chính bạn đã đọc và đồng ý. APPROVE không chọn môi trường và không cấp quyền ghi dữ liệu.`),
  onDecision: (a) => {
    decided = a;
  },
});

console.log(`\nGIAO DIỆN REVIEW & APPROVAL ${reqId} (v${ev.record?.version}, hash ${ev.record?.hash.slice(0, 12)}…):\n  ${server.url}\n`);
if (!process.argv.includes('--no-open')) console.log(openInBrowser(server.url) ? 'Đã mở trình duyệt. Nếu không thấy, mở link trên.' : 'Không tự mở được trình duyệt; hãy mở link trên.');
console.log('Đang chờ người dùng quyết định (APPROVE / REVISE / REJECT). Chưa kết nối staging, chưa thay đổi dữ liệu.');

const done = new Promise<void>((resolve) => {
  const t = setInterval(() => {
    if (decided) {
      clearInterval(t);
      resolve();
    }
  }, 500);
});
await done;
await new Promise((r) => setTimeout(r, 3000)); // để trang kịp hiển thị kết quả
const after = evaluateAndSync(root, first.requirement, first.defs);
console.log(`\nQUYẾT ĐỊNH: ${decided} → trạng thái ${after.state}. ${after.reason}`);
console.log(after.ok ? 'Có thể tiếp tục Giai đoạn 2 (chọn và xác nhận môi trường).' : 'Không thực thi. Xem approvals/ để biết nhận xét.');
await server.close();
process.exit(0);
