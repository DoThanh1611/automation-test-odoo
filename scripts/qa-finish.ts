import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openInBrowser } from '../core/approval/open';
import { writeAggregate } from '../core/reporters/qa-reporter';
import { verifyReportConsistency } from '../core/reporters/verify';
import { pickEnvironment, reportsFor } from './_env';

// Đóng một lần thực hiện: dựng lại báo cáo, đối chiếu JSON/HTML/QA Summary/Bug Report, rồi mở QA Report.
// BẮT BUỘC chạy sau mỗi lần làm việc, kể cả khi mọi test BLOCKED/NOT RUN hoặc không chạy được test nào. Không chạy test, không kết nối staging.
//   npm run qa:finish -- [--requirement=REQ-XXX] [--env=<TÊN>] [--no-open]
// Báo cáo của môi trường đang chọn nằm ở reports/<ENV>/; mặc định lọc theo requirement đang xử lý (các requirement khác là lịch sử).
const argv = process.argv.slice(2);
const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const envKey = pickEnvironment(argv, false);
const dir = reportsFor(envKey);
const rel = path.relative(process.cwd(), dir).split(path.sep).join('/');

const { summary, focus } = writeAggregate(dir, arg('requirement'));
const { errors } = verifyReportConsistency(dir);
console.log(`Báo cáo ${envKey ? `môi trường ${envKey}` : '(cũ, không gắn môi trường)'}: ${rel}/`);
if (focus) {
  const f = focus.summary;
  console.log(`Requirement đang xử lý ${focus.requirementId}: ${f.total} test case | PASS ${f.passed}, FAIL ${f.failed}, BLOCKED ${f.blocked}, NEEDS CLARIFICATION ${f.needsClarification}, NOT RUN ${f.notRun} | Bug mở ${focus.bugs.open}/${focus.bugs.total}`);
}
console.log(`Toàn bộ requirement (gồm lịch sử): ${summary.total} test case | PASS ${summary.passed}, FAIL ${summary.failed}, BLOCKED ${summary.blocked}, NEEDS CLARIFICATION ${summary.needsClarification}, NOT RUN ${summary.notRun}`);
for (const e of errors) console.log(`LỆCH: ${e}`);
console.log(errors.length ? `KẾT QUẢ: KHÔNG ĐỒNG BỘ (${errors.length} lệch). Điều tra, không tự sửa số.` : 'KẾT QUẢ: JSON, HTML, QA Summary và Bug Report khớp nhau và khớp dữ liệu chạy.');

const html = path.join(dir, 'qa-report.html');
console.log(`QA Report: ${html}`);
if (!argv.includes('--no-open')) console.log(openInBrowser(pathToFileURL(html).href) ? 'Đã mở QA Report trên trình duyệt.' : 'Không tự mở được; mở đường dẫn trên.');
console.log(`Tổng kết bằng chữ (nguồn số liệu để báo cáo): ${rel}/qa-summary.md`);
process.exitCode = errors.length ? 1 : 0;
