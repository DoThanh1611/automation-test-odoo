import path from 'node:path';
import { writeAggregate } from '../core/reporters/qa-reporter';
import { pickEnvironment, reportsFor } from './_env';

// Dựng lại reports/qa-report.html và reports/qa-results.json từ MỌI lần chạy đã lưu trong reports/runs/*/results.json.
// KHÔNG chạy lại test, không kết nối Odoo, không đổi kết quả. Dùng khi chỉ đổi giao diện report, glossary hoặc mô tả test case.
// Lưu ý: nếu NỘI DUNG KIỂM THỬ của một test case (steps, expected, testData, preconditions, refs) đã đổi sau lần chạy,
// kết quả cũ của nó hiển thị là NOT RUN (không còn áp dụng) chứ không giữ PASS.
// Dùng thư mục của môi trường đang chọn/--env (reports/<ENV>); chưa chọn môi trường thì dựng lại báo cáo cũ ở reports/.
const envKey = pickEnvironment(process.argv.slice(2), false);
const dir = reportsFor(envKey);
// --requirement=REQ-XXX: dựng lại báo cáo của một requirement (kể cả requirement cũ) từ dữ liệu đã lưu; mặc định theo requirement đang xử lý.
const focusArg = process.argv.find((a) => a.startsWith('--requirement='))?.slice(14);
const { summary } = writeAggregate(dir, focusArg);
const shown = path.relative(process.cwd(), dir).split(path.sep).join('/');
console.log(
  `Đã dựng lại ${shown}/qa-report.html${envKey ? ` (môi trường ${envKey})` : ''}: ${summary.total} test case | Passed ${summary.passed}, Failed ${summary.failed}, Blocked ${summary.blocked}, ` +
    `Needs Clarification ${summary.needsClarification}, Not Run ${summary.notRun} | Execution Pass Rate ${summary.executionPassRate ?? 'N/A'}% | Overall Pass Coverage ${summary.overallPassCoverage ?? 'N/A'}%`,
);
console.log(`Bản tổng kết (sao chép số liệu từ đây, không tự đếm): ${shown}/qa-summary.md. Đối chiếu: npm run report:verify`);
