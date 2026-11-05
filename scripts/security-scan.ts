import path from 'node:path';
import { collectSecrets, scanAny, walk } from '../core/security/scan';
import { scrubTree } from '../core/security/scrub-trace';

// Quét rò rỉ bí mật ngoài các vị trí dự kiến (.env, .auth). Chỉ đọc. KHÔNG in giá trị bí mật.
//   npm run security:scan
const root = process.cwd();
const { secrets, unscannable } = collectSecrets(root);
console.log(`Bí mật đang giữ trên máy: ${secrets.length} giá trị quét được (${[...new Set(secrets.map((s) => s.label.split(':')[0]))].join(', ') || 'không có'}).`);
for (const u of unscannable) console.log(`  CẢNH BÁO không quét được: ${u}`);

const SKIP_DIRS = ['node_modules', '.git'];
const EXPECTED = (rel: string) => rel.startsWith('.env') || rel.startsWith('.auth/'); // nơi bí mật được phép nằm
const hits: { file: string; labels: string[] }[] = [];
let scanned = 0;
for (const f of walk(root, (p) => SKIP_DIRS.includes(path.basename(p)))) {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  if (EXPECTED(rel)) continue;
  scanned++;
  const labels = scanAny(f, secrets);
  if (labels.length) hits.push({ file: rel, labels });
}
console.log(`Đã quét ${scanned} file (gồm nội dung bên trong các file .zip/trace).`);

// Cookie phiên CŨ (không còn trong .auth) vẫn có thể còn hiệu lực: đếm theo mẫu trong mọi trace, không phụ thuộc phiên hiện tại.
const dirty = scrubTree(path.join(root, 'reports'), false, secrets).filter((r) => r.replacements > 0);
if (dirty.length) {
  console.log(`CÒN cookie phiên/token trong ${dirty.length} file trace (${dirty.reduce((n, r) => n + r.replacements, 0)} giá trị). DANH SÁCH FILE CẦN XỬ LÝ:`);
  for (const r of dirty) console.log(`  - ${path.relative(root, r.file).split(path.sep).join('/')} (${r.replacements} giá trị)`);
  console.log('Làm sạch (chỉ che giá trị bí mật, giữ nguyên trace): npm run security:scrub -- --apply. Hoặc xoá file. Chưa tự xử lý vì cần bạn xác nhận.');
  process.exitCode = 1;
}
if (!hits.length) {
  console.log('KHÔNG phát hiện bí mật ngoài .env/.auth.');
} else {
  console.log(`PHÁT HIỆN bí mật ở ${hits.length} file:`);
  const byDir = new Map<string, number>();
  for (const h of hits) byDir.set(h.file.includes('/trace.zip') ? 'reports/runs/*/artifacts/**/trace.zip' : h.file, (byDir.get(h.file.includes('/trace.zip') ? 'reports/runs/*/artifacts/**/trace.zip' : h.file) ?? 0) + 1);
  for (const [k, n] of byDir) console.log(`  ${n > 1 ? `${n} file ` : ''}${k}: ${[...new Set(hits.filter((h) => (h.file.includes('/trace.zip') ? 'reports/runs/*/artifacts/**/trace.zip' : h.file) === k).flatMap((h) => h.labels))].join(', ')}`);
  process.exitCode = 1;
}
