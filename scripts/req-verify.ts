import { verifyAllRequirements } from '../core/testcases/integrity';

// Kiểm tra requirement gốc còn NGUYÊN VĂN so với bản nguồn đã khoá (hash + so từng ký tự). Thoát mã 1 nếu có lỗi.
//   npm run req:verify [-- --requirement=REQ-XXX]
const only = process.argv.find((a) => a.startsWith('--requirement='))?.slice(14);
const results = verifyAllRequirements().filter((r) => !only || r.requirementId === only);
let bad = false;
for (const r of results) {
  const state = r.errors.length ? 'LỖI' : r.sourceVerified ? 'ĐẠT (đã đối chiếu bản nguồn)' : 'ĐẠT HASH BR/AC (chưa đối chiếu bản nguồn)';
  console.log(`${r.requirementId}: ${state}${r.sourceSha256 ? ` | nguồn ${r.sourceKind} sha256 ${r.sourceSha256}` : ''}`);
  for (const e of r.errors) console.log(`  LỖI: ${e}`);
  for (const w of r.warnings) console.log(`  lưu ý: ${w}`);
  if (r.errors.length) bad = true;
}
if (!results.length) console.log('Chưa có requirement nào.');
console.log(bad ? '\nKẾT QUẢ: CÓ requirement không còn nguyên văn.' : '\nKẾT QUẢ: mọi requirement còn nguyên văn so với bản khoá/bản nguồn.');
process.exitCode = bad ? 1 : 0;
