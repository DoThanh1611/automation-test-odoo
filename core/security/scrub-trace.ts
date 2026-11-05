import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectSecrets, walk, type Secret } from './scan';

/**
 * Làm sạch file trace Playwright (.zip): thay cookie phiên, header Authorization và các giá trị bí mật đã biết bằng [REDACTED].
 * Trace vẫn mở được bằng `npx playwright show-trace`; chỉ các giá trị bí mật bị che. Dữ liệu nghiệp vụ trong ảnh chụp trang KHÔNG bị che
 * (không thể che tự động), nên trace vẫn là tài liệu nội bộ.
 */
const REDACTED = '[REDACTED]';
const TEXT_ENTRY = /\.(trace|network|stacks|json|txt|md)$/i;

const BUILTIN: [RegExp, string][] = [
  [/(session_id=)[A-Za-z0-9_\-%.]{12,}/g, `$1${REDACTED}`],
  [/("name"\s*:\s*"(?:authorization|x-csrf-token|x-api-key)"\s*,\s*"value"\s*:\s*")[^"]*(")/gi, `$1${REDACTED}$2`],
  // Dạng văn bản: "Authorization: Bearer <token>", "Authorization=Basic <...>", và token Bearer đứng riêng.
  [/(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s"',;]+/gi, `$1${REDACTED}`],
  [/(bearer\s+)[A-Za-z0-9._~+\/\-]{8,}={0,2}/gi, `$1${REDACTED}`],
];

const ps = (command: string) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
const q = (p: string) => `'${p.replace(/'/g, "''")}'`; // trích dẫn đường dẫn cho PowerShell

export interface ScrubResult {
  file: string;
  entries: number;
  replacements: number;
  applied: boolean;
}

/** Áp dụng các quy tắc che lên 1 chuỗi, trả về chuỗi mới và số lần thay. Hàm thuần, dễ kiểm thử. */
export function redactText(text: string, secrets: Secret[]): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [re, rep] of BUILTIN) out = out.replace(re, (...m) => { count++; return rep.replace(/\$(\d)/g, (_s, i) => m[Number(i)] ?? ''); });
  for (const s of secrets) {
    if (s.value.includes('@')) continue; // email là thông tin định danh, không phải bí mật xác thực
    const parts = out.split(s.value);
    if (parts.length > 1) { count += parts.length - 1; out = parts.join(REDACTED); }
  }
  return { text: out, count };
}

/** Làm sạch 1 file zip. apply=false: chỉ đếm, không ghi. Ghi an toàn: dựng zip mới, kiểm tra đủ mục, rồi mới thay thế bản gốc. */
export function scrubZip(zip: string, secrets: Secret[], apply: boolean): ScrubResult {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-')); // đường dẫn ASCII: tar/PowerShell không vướng tiếng Việt
  try {
    const src = path.join(work, 'in.zip');
    const dir = path.join(work, 'x');
    fs.copyFileSync(zip, src);
    ps(`Expand-Archive -LiteralPath ${q(src)} -DestinationPath ${q(dir)} -Force`);
    const files = [...walk(dir)];
    let replacements = 0;
    for (const f of files) {
      if (!TEXT_ENTRY.test(f)) continue;
      const { text, count } = redactText(fs.readFileSync(f, 'utf8'), secrets);
      if (count && apply) fs.writeFileSync(f, text, 'utf8');
      replacements += count;
    }
    if (!apply || replacements === 0) return { file: zip, entries: files.length, replacements, applied: false };

    const out = path.join(work, 'out.zip');
    ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${q(dir)}, ${q(out)}, [IO.Compression.CompressionLevel]::Optimal, $false)`);
    const names = ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${q(out)}); $z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`)
      .split(/\r?\n/).map((s) => s.trim().replace(/\\/g, '/')).filter((s) => s && !s.endsWith('/'));
    const expected = files.map((f) => path.relative(dir, f).replace(/\\/g, '/'));
    if (names.length !== expected.length || expected.some((e) => !names.includes(e))) {
      throw new Error(`Zip sau khi làm sạch không đủ mục (${names.length}/${expected.length}); giữ nguyên bản gốc ${zip}`);
    }
    fs.copyFileSync(out, zip);
    return { file: zip, entries: files.length, replacements, applied: true };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Các file zip chứa dữ liệu trace trong 1 thư mục (trace.zip và bản sao của báo cáo HTML Playwright). */
export function findTraceZips(root: string): string[] {
  return [...walk(root)].filter((f) => /(^|[\\/])trace\.zip$/i.test(f) || /[\\/]playwright-html[\\/]data[\\/][^\\/]+\.zip$/i.test(f));
}

export function scrubTree(root: string, apply: boolean, secrets = collectSecrets().secrets): ScrubResult[] {
  return findTraceZips(root).map((z) => scrubZip(z, secrets, apply));
}
