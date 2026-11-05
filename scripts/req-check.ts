import { computeCoverage } from '../core/testcases/coverage';
import { verifyAllRequirements } from '../core/testcases/integrity';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';

// Kiểm tra độ phủ BR/AC theo TỪNG requirement. Thoát mã 1 nếu có BR/AC chưa có test case hoặc lỗi truy vết.
//   npm run req:check [-- --requirement=REQ-XXX] [--strict]   (--strict: requirement chưa có test case nào cũng bị coi là lỗi)
const only = process.argv.find((a) => a.startsWith('--requirement='))?.slice(14);
const strict = process.argv.includes('--strict');
const cov = computeCoverage(loadRequirements(), loadTestCases()).filter((c) => !only || c.requirementId === only);
let bad = false;
for (const c of cov) {
  const head = `${c.requirementId} [${c.application || '-'}/${c.module || '-'}] ${c.title}`;
  if (c.requirementId === '(toàn cục)') {
    console.log(`\n${head}`);
    for (const e of c.errors) console.log(`  LỖI: ${e}`);
    bad = true;
    continue;
  }
  const noTc = c.testCaseCount === 0;
  console.log(`\n${head}: ${c.testCaseCount} test case, ${c.items.length - c.uncovered.length}/${c.items.length} BR/AC đã có test case`);
  for (const i of c.items) console.log(`  ${i.id.padEnd(6)} ${i.testCases.length ? i.testCases.join(', ') : '— CHƯA CÓ TEST CASE'}`);
  for (const e of c.errors) console.log(`  LỖI: ${e}`);
  if (c.errors.length || (c.uncovered.length && !noTc) || (noTc && strict)) bad = true;
  if (noTc) console.log(`  (chưa sinh test case${strict ? ': lỗi vì --strict' : ''})`);
}
// Toàn vẹn nguyên văn của requirement (hash BR/AC + bản nguồn).
for (const r of verifyAllRequirements().filter((x) => !only || x.requirementId === only)) {
  for (const e of r.errors) console.log(`\n${r.requirementId} LỖI nguyên văn: ${e}`);
  if (r.errors.length) bad = true;
}
console.log(bad ? '\nKẾT QUẢ: CHƯA ĐẠT (còn BR/AC chưa phủ hoặc lỗi truy vết).' : '\nKẾT QUẢ: mọi BR/AC của requirement đã có test case đều được phủ.');
process.exitCode = bad ? 1 : 0;
