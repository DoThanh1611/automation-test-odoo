import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSecrets, redactHosts, scanAny, shareDecision, suspectCredentialLines, walk } from '../core/security/scan';

// Đóng gói ZIP chia sẻ AN TOÀN: chỉ mã nguồn, cấu hình mẫu và tài liệu. KHÔNG gồm .env, .auth, trace, video, ảnh chụp, node_modules.
//   npm run package:share                  # mã nguồn + tài liệu
//   npm run package:share -- --with-report # thêm báo cáo HTML/JSON (không kèm video/ảnh/trace)
//   npm run package:share -- --dry-run     # chỉ liệt kê, không tạo ZIP
//   npm run package:template               # BỘ CÀI ĐẶT dùng chung: không kèm requirement/test case/spec/fixture/registry nghiệp vụ hiện có
// Sau khi tạo, ZIP được quét lại bằng giá trị bí mật thật trên máy; nếu có rò rỉ thì xoá ZIP và báo lỗi.
const withReport = process.argv.includes('--with-report');
const dryRun = process.argv.includes('--dry-run');
const template = process.argv.includes('--template');
const root = process.cwd();

const included: string[] = [];
const excluded = new Map<string, number>();
const suspected: string[] = [];
const TEXTY = /\.(md|txt|json|yml|yaml|ts|js|cjs|mjs|html|sh)$/i;
for (const f of walk(root, (p) => ['node_modules', '.git', 'share'].includes(path.basename(p)))) {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  const d = shareDecision(rel, { withReport: withReport && !template, template });
  if (d.include && TEXTY.test(rel)) {
    const lines = suspectCredentialLines(fs.readFileSync(f, 'utf8'), { code: /\.(ts|js|cjs|mjs)$/i.test(rel) });
    if (lines.length) {
      suspected.push(`${rel} (dòng ${lines.join(', ')})`);
      excluded.set('NGHI chứa thông tin đăng nhập: bị loại, cần rà soát thủ công', (excluded.get('NGHI chứa thông tin đăng nhập: bị loại, cần rà soát thủ công') ?? 0) + 1);
      continue;
    }
  }
  if (d.include) included.push(rel);
  else excluded.set(d.reason, (excluded.get(d.reason) ?? 0) + 1);
}
console.log(`Đưa vào ZIP: ${included.length} file. Loại trừ:`);
for (const [reason, n] of excluded) console.log(`  ${String(n).padStart(4)} file — ${reason}`);
for (const s of suspected) console.log(`  CẢNH BÁO nghi chứa thông tin đăng nhập (không in nội dung): ${s}`);
if (dryRun) {
  console.log('(dry-run) Không tạo ZIP.');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const out = path.join(root, 'share', `qa-framework${template ? '-template' : ''}-${stamp}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
// Bộ cài đặt: dựng thư mục tạm để chỉnh package.json (bỏ máy chủ MCP mẫu) mà không đụng file gốc.
let srcRoot = root;
const urlSecrets = collectSecrets(root, { urls: true }).secrets;
if (template || withReport) {
  srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-template-'));
  for (const rel of included) {
    fs.mkdirSync(path.dirname(path.join(srcRoot, rel)), { recursive: true });
    // Báo cáo chia sẻ: địa chỉ môi trường (staging) được che; bản gốc trong reports/ không đổi.
    if (rel.startsWith('reports/') && TEXTY.test(rel)) fs.writeFileSync(path.join(srcRoot, rel), redactHosts(fs.readFileSync(path.join(root, rel), 'utf8'), urlSecrets));
    else fs.copyFileSync(path.join(root, rel), path.join(srcRoot, rel));
  }
}
if (template) {
  // README của bộ cài đặt = hướng dẫn nhanh (README gốc mô tả máy chủ MCP riêng của dự án này, không đi kèm).
  fs.copyFileSync(path.join(root, 'INSTALL.md'), path.join(srcRoot, 'README.md'));
  included.push('README.md');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.name = 'qa-automation-framework';
  pkg.description = 'QA Automation Framework (Playwright + TypeScript) cho Odoo và các ứng dụng web khác';
  delete pkg.main;
  delete pkg.scripts.start;
  delete pkg.scripts.dev;
  delete pkg.dependencies['@modelcontextprotocol/sdk'];
  pkg.keywords = ['qa', 'playwright', 'odoo'];
  pkg.scripts['package:template'] = 'tsx scripts/package-share.ts --template';
  fs.writeFileSync(path.join(srcRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
const list = path.join(os.tmpdir(), `share-list-${stamp}.txt`);
fs.writeFileSync(list, included.join('\n'), 'utf8');
const q = (p: string) => `'${p.replace(/'/g, "''")}'`;
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${q(out)},'Create'); ` +
  `Get-Content -LiteralPath ${q(list)} -Encoding UTF8 | ForEach-Object { if ($_) { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path ${q(srcRoot)} $_), $_, 'Optimal') } }; $zip.Dispose()`]);
fs.rmSync(list);
if (srcRoot !== root) fs.rmSync(srcRoot, { recursive: true, force: true });

// Quét lại nội dung ZIP bằng giá trị bí mật thật.
const { secrets } = collectSecrets(root, { urls: true });
const leaked = scanAny(out, secrets);
if (leaked.length) {
  fs.rmSync(out);
  console.error(`DỪNG: ZIP chứa bí mật (${leaked.join(', ')}). Đã xoá ZIP. Kiểm tra lại quy tắc loại trừ.`);
  process.exit(1);
}
console.log(`Đã tạo ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB). Quét bí mật trong ZIP: sạch (${secrets.length} giá trị đã đối chiếu).`);
