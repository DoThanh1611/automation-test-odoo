import { verifyReportConsistency } from '../core/reporters/verify';
import { pickEnvironment, reportsFor } from './_env';

// Đối chiếu qa-results.json, qa-report.html, qa-summary.md với nhau và với kết quả tính lại từ reports/runs. Thoát mã 1 nếu lệch.
//   npm run report:verify
const envKey = pickEnvironment(process.argv.slice(2), false);
const { errors, summary } = verifyReportConsistency(reportsFor(envKey));
console.log(envKey ? `Môi trường: ${envKey} (reports/${envKey})` : 'Báo cáo cũ (reports/, không gắn môi trường)');
if (summary) {
  console.log(`JSON: ${summary.total} test case | PASS ${summary.passed}, FAIL ${summary.failed}, BLOCKED ${summary.blocked}, NEEDS CLARIFICATION ${summary.needsClarification}, NOT RUN ${summary.notRun}`);
}
for (const e of errors) console.log(`LỆCH: ${e}`);
console.log(errors.length ? `\nKẾT QUẢ: KHÔNG ĐỒNG BỘ (${errors.length} lệch). Chạy npm run report:rebuild rồi kiểm tra lại.` : '\nKẾT QUẢ: JSON, HTML và qa-summary.md khớp nhau và khớp dữ liệu chạy.');
process.exitCode = errors.length ? 1 : 0;
