import path from 'node:path';
import { scrubTree } from '../core/security/scrub-trace';

// Che cookie phiên/Authorization/mật khẩu trong các file trace.zip.
//   npm run security:scrub                       # MẶC ĐỊNH chỉ báo cáo (không sửa file nào)
//   npm run security:scrub -- --apply            # ghi đè bằng bản đã làm sạch (kiểm tra đủ mục trước khi thay)
//   npm run security:scrub -- --path <thư mục>   # giới hạn phạm vi (mặc định: reports)
const apply = process.argv.includes('--apply');
const i = process.argv.indexOf('--path');
const root = path.resolve(i >= 0 ? process.argv[i + 1] : 'reports');
const results = scrubTree(root, apply);
for (const r of results) console.log(`${r.applied ? 'ĐÃ LÀM SẠCH' : r.replacements ? 'CẦN LÀM SẠCH' : 'sạch'}: ${path.relative(process.cwd(), r.file)} (${r.entries} mục, ${r.replacements} giá trị bí mật)`);
const dirty = results.filter((r) => r.replacements > 0 && !r.applied).length;
console.log(`Tổng ${results.length} file; ${dirty} file còn chứa bí mật${apply ? '' : ' (chưa sửa: dùng --apply để làm sạch)'}.`);
process.exitCode = dirty ? 1 : 0;
