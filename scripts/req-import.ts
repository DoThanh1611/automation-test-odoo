import fs from 'node:fs';
import path from 'node:path';
import { parseRequirement } from '../core/testcases/req-parser';
import { listRequirementFiles, readLock, sha256, writeLock } from '../core/testcases/lock';
import { verifyRequirement } from '../core/testcases/integrity';
import { findSimilarRequirements } from '../core/testcases/duplicates';
import { loadRequirements } from '../core/testcases/loader';

// Nhập requirement người dùng cung cấp (file markdown theo cấu trúc Path / Business Requirement / Expected Solution / BR / AC)
// thành requirements/<app>-<module>/<REQ-ID>.json. BR/AC được lưu NGUYÊN VĂN và KHOÁ ngay. Không ghi đè requirement đã có.
//   npm run req:import -- <app> <module> <file.md> --id=REQ-XXX [--title="Tên requirement"] [--force-similar] [--expect-sha256=<hash>]
const [app, mod, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const id = arg('id');
const fail = (m: string): never => {
  console.error(`Lỗi: ${m}`);
  process.exit(1);
};
if (!app || !mod || !file || !id) fail('cú pháp: npm run req:import -- <app> <module> <file.md> --id=REQ-XXX [--title="..."]');
if (!/^REQ-[A-Z0-9-]+$/.test(id!)) fail('--id phải dạng REQ-XXX (chữ HOA, số, gạch ngang)');
const key = `${app}-${mod}`;
if (!fs.existsSync(path.join('tests', key))) fail(`module "${key}" chưa có. Chạy: npm run new:module -- ${app} ${mod}`);
if (!fs.existsSync(file!)) fail(`không thấy file ${file}`);
// Gọi lại với CÙNG nội dung nguồn (sha256 giống bản đã nhập): không nhập lần hai, báo requirement đã có để tiếp tục theo trạng thái phê duyệt.
const rawEarly = fs.readFileSync(file!);
const existing = listRequirementFiles().find((f) => readLock(f)?.source?.sha256 === sha256(rawEarly));
if (existing) {
  const lock = readLock(existing)!;
  console.log(`ĐÃ NHẬP TRƯỚC ĐÓ: nội dung này chính là requirement ${lock.id} (${existing.split(path.sep).join('/')}, sha256 ${lock.source!.sha256}). KHÔNG nhập lần hai.`);
  console.log(`Tiếp tục theo trạng thái hiện tại: npm run qa:approval -- status --requirement=${lock.id}`);
  process.exit(0);
}


const reqFile = path.join('requirements', key, `${id}.json`);
if (fs.existsSync(reqFile)) fail(`${reqFile} đã tồn tại; không ghi đè requirement (BR/AC đã khoá).`);

const parsed = parseRequirement(fs.readFileSync(file!, 'utf8'));
if (parsed.problems.length) {
  console.error('Requirement chưa hợp lệ, CHƯA ghi gì cả:');
  for (const p of parsed.problems) console.error(`  - ${p}`);
  console.error('Sửa file requirement (hoặc hỏi lại người cung cấp) rồi chạy lại. Công cụ không tự đoán nội dung.');
  process.exit(1);
}

// Kiểm tra trùng lặp: chỉ cảnh báo, người dùng quyết định (--force-similar để vẫn nhập).
const similar = findSimilarRequirements({ id: id!, title: arg('title') ?? parsed.title ?? id!, businessRules: parsed.businessRules, acceptanceCriteria: parsed.acceptanceCriteria }, loadRequirements());
const hard = similar.filter((s) => s.hard);
if (hard.length) {
  console.error(`Mã ${id} đã được dùng bởi requirement khác (${hard.map((s) => s.id).join(', ')}), CHƯA ghi gì cả. Mã requirement phải duy nhất toàn cục; --force-similar KHÔNG áp dụng cho trùng mã.`);
  console.error('Dùng requirement đã có, hoặc hỏi người dùng mã mới.');
  process.exit(1);
}
if (similar.length && !process.argv.includes('--force-similar')) {
  console.error('Requirement này có thể TRÙNG với requirement đã có, CHƯA ghi gì cả:');
  for (const s of similar) console.error(`  - ${s.id}: ${s.reason}`);
  console.error('Hỏi người dùng: dùng requirement đã có, hay vẫn nhập mới (thêm --force-similar)?');
  process.exit(1);
}

// Bản nguồn: công cụ tự sao chép NGUYÊN BYTE (không qua Claude) và băm sha256, rồi khoá cùng BR/AC.
const raw = fs.readFileSync(file!);
const srcHash = sha256(raw);
const expected = arg('expect-sha256');
if (expected && expected.toLowerCase() !== srcHash) fail(`sha256 của file nguồn (${srcHash}) khác --expect-sha256. CHƯA ghi gì cả.`);
const isPaste = path.resolve(file!).split(path.sep).join('/').includes('/requirements/_inbox/');
const sourceFile = reqFile.replace(/\.json$/, '.source.md');

const requirement = {
  id,
  title: arg('title') ?? parsed.title ?? id,
  application: app,
  module: mod,
  path: parsed.path,
  businessRequirement: parsed.businessRequirement,
  expectedSolution: parsed.expectedSolution,
  businessRules: parsed.businessRules,
  acceptanceCriteria: parsed.acceptanceCriteria,
  notes: [],
};
fs.writeFileSync(reqFile, JSON.stringify(requirement, null, 2) + '\n');
fs.writeFileSync(sourceFile, raw);
const lines = raw.toString('utf8').split(/\r?\n/).length;
writeLock(reqFile, { file: sourceFile.split(path.sep).join('/'), sha256: srcHash, bytes: raw.length, lines, kind: isPaste ? 'paste' : 'file' });
const check = verifyRequirement(reqFile);
if (check.errors.length) {
  fs.rmSync(reqFile);
  fs.rmSync(sourceFile);
  fs.rmSync(reqFile.replace(/\.json$/, '.lock'));
  fail(`kiểm tra nguyên văn sau khi nhập thất bại, đã hủy: ${check.errors.join('; ')}`);
}
const tcFile = path.join('testcases', key, `${id}.testcases.json`);
if (!fs.existsSync(tcFile)) fs.writeFileSync(tcFile, JSON.stringify({ requirementId: id, glossary: {}, testCases: [] }, null, 2) + '\n');

console.log(`Đã nhập ${id}: ${parsed.businessRules.length} BR, ${parsed.acceptanceCriteria.length} AC (nguyên văn, đã khoá).`);
console.log(`  ${reqFile}\n  ${reqFile.replace(/\.json$/, '.lock')}\n  ${sourceFile} (bản nguồn nguyên byte)\n  ${tcFile} (chưa có test case)`);
console.log(`Nguồn: ${raw.length} byte, ${lines} dòng, sha256 ${srcHash}`);
console.log(`Đã kiểm tra: BR/AC/Path/Business Requirement/Expected Solution trong JSON khớp bản nguồn TỪNG KÝ TỰ (công cụ, không phải Claude).`);
if (isPaste) {
  console.log('LƯU Ý (văn bản dán): file nguồn do người/Claude ghi vào requirements/_inbox nên công cụ chỉ bảo đảm nguyên văn TỪ file này trở đi,');
  console.log('  chưa chứng minh được file khớp bản dán gốc. Có bản gốc thì dùng đường dẫn file, hoặc đối chiếu sha256 ở trên (--expect-sha256=<hash>).');
}
console.log(`\nBước tiếp theo: yêu cầu Claude chạy quy trình QA cho ${id} (lệnh /qa-requirement ${id}).`);
