import '../core/config/env'; // nạp .env (URL, tài khoản theo môi trường) vào process.env
import { getApp, listApps } from '../applications';
import { evaluate } from '../core/approval/approval';
import { nativeConfirm, openInBrowser } from '../core/approval/open';
import { startEnvServer } from '../core/environment/server';
import { sessionStatus, type EnvHumanConfirmInfo, type EnvWebContext } from '../core/environment/web';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';

// Giao diện Web chọn môi trường + xác nhận chính sách ghi cho MỘT requirement đã APPROVE (thay cho qa:env select/confirm và qa:policy confirm).
//   npm run qa:env-web -- --requirement=REQ-XXX [--need-write] [--change] [--check] [--no-open] [--port=N]
// Chạy nền (run_in_background): nếu môi trường đang chọn đã được xác nhận hợp lệ (và chính sách ghi nếu --need-write) thì DÙNG LẠI, không mở giao diện.
// Ngược lại in link, mở trình duyệt, chờ NGƯỜI DÙNG bấm "Xác nhận môi trường" (và "Xác nhận chính sách ghi dữ liệu") rồi tự thoát để Claude tiếp tục Giai đoạn 2.
// Mỗi nút cần hộp thoại hệ điều hành riêng của máy này. Lệnh này KHÔNG có tham số nào tự chọn hoặc tự xác nhận thay người dùng.
//   --check : chỉ in trạng thái dùng lại (thoát 0 = đã đủ, 1 = cần người dùng thao tác), không mở giao diện.
//   --change: bắt mở giao diện dù đã có môi trường hợp lệ (đổi môi trường).
// Phương án dự phòng: npm run qa:env -- select/confirm và npm run qa:policy -- confirm (terminal).
const root = process.cwd();
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);
const fail = (m: string, code = 1): never => {
  console.error(`Lỗi: ${m}`);
  process.exit(code);
};
const reqId = arg('requirement') ?? fail('thiếu --requirement=REQ-XXX', 2);
const needWrite = flag('need-write');

const requirement = loadRequirements().find((r) => r.id === reqId) ?? fail(`không có requirement ${reqId}`);
const app = requirement.application;
if (!listApps().includes(app)) fail(`ứng dụng "${app}" của requirement chưa đăng ký`);
const getContext = (): EnvWebContext => ({
  root,
  app,
  requirement,
  defs: loadTestCases().filter((d) => d.requirementId === reqId),
  roleDescription: (role) => getApp(app).roles[role]?.description,
});

const ev = evaluate(root, requirement, getContext().defs);
if (!ev.ok) fail(`${reqId} chưa có phê duyệt hợp lệ (${ev.state}: ${ev.reason}). APPROVE test case trước (npm run qa:review -- --requirement=${reqId}).`);

const report = (s = sessionStatus(getContext(), needWrite)) => {
  console.log(`Môi trường: ${s.selected ?? '(chưa chọn)'} — ${s.envValid ? 'ĐÃ XÁC NHẬN, còn hiệu lực' : s.envDetail}`);
  if (needWrite || s.policyValid) console.log(`Chính sách ghi: ${!s.envValid ? '(chưa xét)' : !s.policyEligible ? 'môi trường CHỈ ĐỌC (không được ghi tự động)' : s.policyValid ? 'ĐÃ XÁC NHẬN, còn hiệu lực' : 'chưa xác nhận'}`);
};

const initial = sessionStatus(getContext(), needWrite);
if (flag('check')) {
  report(initial);
  process.exit(initial.satisfied ? 0 : 1);
}
if (initial.satisfied && !flag('change')) {
  console.log(`DÙNG LẠI xác nhận hợp lệ cho ${reqId}, không hỏi lại. (Muốn đổi môi trường: thêm --change.)`);
  report(initial);
  process.exit(0);
}

const dialog = (i: EnvHumanConfirmInfo): Promise<boolean> =>
  i.kind === 'ENV'
    ? nativeConfirm(
        'Xác nhận môi trường kiểm thử',
        `Cho phép THỰC THI kiểm thử ${i.requirementId} trên môi trường:\n${i.environment} (${i.label}, ${i.envKind})\nHost: ${i.host}\nVai trò tài khoản: ${i.roles.join(', ')}\nNgười xác nhận: ${i.by}\n\nChỉ đọc, hiệu lực 24 giờ. Đây KHÔNG phải quyền ghi dữ liệu.\nChọn Yes CHỈ khi chính bạn muốn dùng môi trường này.`,
      )
    : nativeConfirm(
        'Xác nhận chính sách GHI dữ liệu',
        `Cho phép framework TỰ TẠO, SỬA và CLEANUP dữ liệu test trên ${i.environment} (${i.host}) cho ${i.requirementId}.\nNgười xác nhận: ${i.by}\n\n${i.policyLines.slice(1).join('\n')}\n\nChọn Yes CHỈ khi chính bạn đồng ý. Xác nhận này độc lập với xác nhận môi trường.`,
      );

let last = '';
const server = await startEnvServer({
  getContext,
  confirm: dialog,
  idleMs: 2 * 3600 * 1000,
  port: arg('port') ? Number(arg('port')) : undefined,
  onDecision: (a) => {
    last = a;
  },
});

console.log(`\nGIAO DIỆN CHỌN MÔI TRƯỜNG cho ${reqId}:\n  ${server.url}\n`);
if (!flag('no-open')) console.log(openInBrowser(server.url) ? 'Đã mở trình duyệt. Nếu không thấy, mở link trên.' : 'Không tự mở được trình duyệt; hãy mở link trên.');
console.log(`Đang chờ người dùng bấm "Xác nhận môi trường"${needWrite ? ' và "Xác nhận chính sách ghi dữ liệu"' : ''}. Chưa kết nối staging, chưa thay đổi dữ liệu.`);

// Xong khi trạng thái (tính lại từ file ký) đủ điều kiện. Không tin cờ nào khác.
await new Promise<void>((resolve) => {
  const t = setInterval(() => {
    if (sessionStatus(getContext(), needWrite).satisfied) {
      clearInterval(t);
      resolve();
    }
  }, 500);
});
await new Promise((r) => setTimeout(r, 3000)); // để trang kịp hiển thị kết quả
const done = sessionStatus(getContext(), needWrite);
console.log(`\nHOÀN TẤT (${last || 'đã xác nhận'}). Có thể tiếp tục Giai đoạn 2 ngay, không cần gõ lệnh.`);
report(done);
await server.close();
process.exit(0);
