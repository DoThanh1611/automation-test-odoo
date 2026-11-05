import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Quét rò rỉ bí mật: tìm GIÁ TRỊ bí mật thật (mật khẩu, cookie phiên, email đăng nhập) trong các file.
 * KHÔNG BAO GIỜ in giá trị bí mật; chỉ trả về nhãn (ví dụ "cookie:odoo-accountant:session_id") và đường dẫn file.
 */
export interface Secret {
  label: string;
  value: string;
  /** 'url': địa chỉ môi trường (không phải bí mật xác thực, nhưng không được lộ trong gói chia sẻ công khai). */
  kind?: 'url';
}

const TEXT_EXT = new Set(['.json', '.html', '.md', '.yml', '.yaml', '.txt', '.log', '.js', '.ts', '.cjs', '.mjs', '.network', '.trace', '.sh', '.csv', '.xml', '.env']);
/** Mật khẩu ngắn hơn ngưỡng này không thể quét tin cậy (khớp ngẫu nhiên khắp nơi). */
export const MIN_SCANNABLE_LENGTH = 6;

/** Thu thập bí mật hiện có trên máy: biến môi trường dạng mật khẩu/token trong .env, email đăng nhập và cookie phiên trong .auth. */
export function collectSecrets(root = process.cwd(), opts: { urls?: boolean } = {}): { secrets: Secret[]; unscannable: string[] } {
  const secrets: Secret[] = [];
  const unscannable: string[] = [];
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m || !m[2]) continue;
      const [, key, value] = m;
      if (/(PASS|PASSWORD|TOKEN|SECRET|KEY)$/.test(key)) {
        if (value.length < MIN_SCANNABLE_LENGTH) unscannable.push(`${key} (độ dài ${value.length} < ${MIN_SCANNABLE_LENGTH}: mật khẩu quá yếu, không quét được)`);
        else secrets.push({ label: key, value });
      } else if (/USER$/.test(key) && value.includes('@')) {
        secrets.push({ label: key, value });
      } else if (opts.urls && /_URL$/.test(key) && /^https?:\/\//i.test(value)) {
        try {
          const u = new URL(value);
          secrets.push({ label: `URL:${key}`, value: u.origin, kind: 'url' }, { label: `URL:${key}`, value: u.host, kind: 'url' });
        } catch { /* URL hỏng: bỏ qua */ }
      }
    }
  }
  const authDir = path.join(root, '.auth');
  if (fs.existsSync(authDir)) {
    // .auth/<app>-<role>.json (cũ) và .auth/<ENV>/<app>-<role>.json (theo môi trường)
    for (const full of [...walk(authDir)].filter((x) => x.endsWith('.json') && !x.endsWith('.meta.json'))) {
      const f = path.relative(authDir, full).split(path.sep).join('/');
      const state = JSON.parse(fs.readFileSync(full, 'utf8'));
      for (const c of state.cookies ?? []) {
        if (/session|token|auth/i.test(c.name) && String(c.value).length >= MIN_SCANNABLE_LENGTH) {
          secrets.push({ label: `cookie:${f.replace('.json', '').replace('/', '-')}:${c.name}`, value: String(c.value) });
        }
      }
    }
  }
  return { secrets, unscannable };
}

export function* walk(dir: string, skip: (p: string) => boolean = () => false): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skip(p)) continue;
    if (e.isDirectory()) yield* walk(p, skip);
    else yield p;
  }
}

/** Nhãn các bí mật xuất hiện trong 1 file văn bản (rỗng nếu không có hoặc không phải văn bản). */
export function scanTextFile(file: string, secrets: Secret[]): string[] {
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) return [];
  const content = fs.readFileSync(file, 'utf8');
  return secrets.filter((s) => content.includes(s.value) || content.includes(encodeURIComponent(s.value))).map((s) => s.label);
}

const tarExe = () => (process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

/**
 * Giải nén ZIP vào thư mục tạm (bsdtar). Trả về thư mục; người gọi tự dọn.
 * tar.exe trên Windows không mở được đường dẫn có tiếng Việt (tên thư mục artifacts), nên sao chép sang tên ASCII trước.
 */
export function extractZip(zip: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  const ascii = path.join(dest, 'in.zip');
  fs.copyFileSync(zip, ascii);
  const out = path.join(dest, 'x');
  fs.mkdirSync(out);
  execFileSync(tarExe(), ['-xf', ascii, '-C', out], { stdio: 'ignore' });
  fs.rmSync(ascii);
  return dest;
}

/** Quét 1 file: văn bản trực tiếp; .zip (trace) thì giải nén rồi quét từng file bên trong. */
export function scanAny(file: string, secrets: Secret[]): string[] {
  if (file.toLowerCase().endsWith('.zip')) {
    const dir = extractZip(file);
    try {
      const found = new Set<string>();
      for (const f of walk(dir)) {
        // trace Playwright lưu request/response dạng .network/.trace (NDJSON) không có phần mở rộng văn bản chuẩn
        const content = fs.readFileSync(f, 'utf8');
        for (const s of secrets) if (content.includes(s.value) || content.includes(encodeURIComponent(s.value))) found.add(s.label);
      }
      return [...found];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return scanTextFile(file, secrets);
}

// ---- Quy tắc gói chia sẻ (ZIP) ----
/** Đường dẫn (tương đối, dấu /) KHÔNG BAO GIỜ được đưa vào ZIP chia sẻ. */
const NEVER = [
  /(^|\/)node_modules\//,
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.auth\//,
  /(^|\/)\.playwright-mcp\//,
  /(^|\/)requirements\/_inbox\//,
  /(^|\/)\.claude\/settings\.local\.json$/,
  /(^|\/)test-results\//,
  /(^|\/)trace\.zip$/,
  /\.zip$/,
  /(^|\/)test_results\//,
  /(^|\/)playwright-html\//,
];
// reports/ (cũ) và reports/<ENV>/ (theo môi trường): chỉ các file tổng hợp và results.json của từng lần chạy.
/** Che địa chỉ môi trường (origin/host) trong nội dung báo cáo trước khi chia sẻ. */
export function redactHosts(text: string, secrets: Secret[]): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.kind === 'url').sort((a, b) => b.value.length - a.value.length)) out = out.split(s.value).join('[ENV-URL]');
  return out;
}
const REPORT_FILES = /^reports\/(?:[A-Z][A-Z0-9_]*\/)?(qa-report\.html|qa-results\.json|bugs\.json|framework-tests\.json|cleanup-plan\.(json|md))$|^reports\/(?:[A-Z][A-Z0-9_]*\/)?runs\/[^/]+\/results\.json$/;
export const ENV_EXAMPLE = '.env.example';
/** File ở thư mục gốc được phép vào ZIP. Muốn chia sẻ thêm file khác: thêm vào đây có chủ đích sau khi rà soát. */
export const ROOT_ALLOWED = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts', '.gitignore', 'README.md', 'CLAUDE.md', 'FRAMEWORK.md', 'INSTALL.md', '.mcp.json']);

/**
 * Bộ cài đặt dùng chung (--template): KHÔNG kèm dữ liệu/ca kiểm thử nghiệp vụ hiện có (requirement, test case, spec, fixture ghim bản ghi thật,
 * registry, baseline trường), cũng không kèm máy chủ MCP mẫu (src/), CLAUDE.md và README của dự án gốc.
 * Các file mẫu (TEMPLATE.*, README.md trong thư mục requirements/testcases) vẫn được đưa vào.
 */
const TEMPLATE_EXCLUDED = [
  /^requirements\/[^/]+\/.+/,
  /^testcases\/[^/]+\/.+/,
  /^automation\/[^/]+\/.+/,
  /^adapters\/[^/]+\/.+/,
  /^approvals\//,
  /^tests\/(?!framework\/|setup\/)[^/]+\/.+/,
  /^testdata\/registry\.jsonl$/,
  /^testdata\/registry\/.+\.jsonl$/,
  /^testdata\/fixtures\/.+\.json$/,
  /^baselines\//,
  /^src\//,
  /^(CLAUDE|README)\.md$/,
  /^package-lock\.json$/,
];
const TEMPLATE_KEEP = /^(requirements|testcases)\/[^/]+\/README\.md$/;
export const DIRS_ALLOWED = new Set(['core', 'applications', 'scripts', 'tests', 'requirements', 'testcases', 'automation', 'adapters', 'baselines', 'testdata', 'src', 'approvals', 'environments', 'example']);

const CRED_WORDS = /(password|passwd|pwd|mật khẩu|mat khau|secret|api[_ -]?key|token)/i;

/**
 * Lớp quét thứ hai: tìm DÒNG trông giống thông tin đăng nhập (từ khoá + giá trị giống mật khẩu) trong file văn bản.
 * Trả về số dòng, KHÔNG trả nội dung. Dùng cho file được phép vào ZIP để bắt bí mật không nằm trong .env.
 */
export function suspectCredentialLines(text: string, opts: { code?: boolean } = {}): number[] {
  if (opts.code) {
    // Mã nguồn: chỉ bắt kiểu gán thẳng một chuỗi cố định cho tên giống mật khẩu/khoá; tránh báo nhầm tên biến và kiểu dữ liệu.
    const literal = /(password|passwd|secret|api[_-]?key|token)\w*\s*[:=]\s*['"`][^'"`\s$]{6,}['"`]/i;
    return text.split(/\r?\n/).flatMap((l, i) => (literal.test(l) ? [i + 1] : []));
  }
  const looksLikeSecret = (v: string) => {
    const t = v.replace(/^[\[\]'"\s`]+|[\[\]'"\s`,;]+$/g, '');
    if (t.length < 6 || /\s/.test(t)) return false;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(t)).length;
    return classes >= 3 && !/^https?:|^[./]|\.(ts|js|json|md)$/.test(t);
  };
  const out: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!CRED_WORDS.test(line)) return;
    const tokens = line.split(/[:=|]/).slice(1).flatMap((s) => s.split(/\s+/)).filter(Boolean);
    const cells = line.includes('|') ? line.split('|').map((c) => c.trim()) : [];
    if ([...tokens, ...cells].some(looksLikeSecret)) out.push(i + 1);
  });
  // Bảng markdown: tiêu đề có Password/Mật khẩu thì các ô cùng cột ở các dòng dưới cũng đáng ngờ.
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.includes('|') || !CRED_WORDS.test(line)) return;
    const col = line.split('|').findIndex((c) => CRED_WORDS.test(c));
    for (let j = i + 1; j < lines.length && lines[j].includes('|'); j++) {
      const cell = lines[j].split('|')[col];
      if (cell && looksLikeSecret(cell) && !out.includes(j + 1)) out.push(j + 1);
    }
  });
  return out.sort((a, b) => a - b);
}

/** Quyết định file nào được vào gói chia sẻ. `.env.example` luôn được phép dù khớp mẫu `.env.*`. */
export function shareDecision(rel: string, opts: { withReport?: boolean; template?: boolean } = {}): { include: boolean; reason: string } {
  const p = rel.replace(/\\/g, '/');
  if (opts.template && !TEMPLATE_KEEP.test(p) && TEMPLATE_EXCLUDED.some((r) => r.test(p))) {
    return { include: false, reason: 'bộ cài đặt dùng chung: không kèm dữ liệu/ca kiểm thử nghiệp vụ hiện có' };
  }
  if (p === ENV_EXAMPLE) return { include: true, reason: 'mẫu cấu hình (không chứa bí mật)' };
  if (NEVER.some((r) => r.test(p))) return { include: false, reason: 'bí mật hoặc dữ liệu nhạy cảm (không bao giờ chia sẻ)' };
  // DANH SÁCH TRẮNG: file nào không được liệt kê rõ thì không vào ZIP (an toàn hơn danh sách loại trừ).
  if (!p.includes('/')) {
    return ROOT_ALLOWED.has(p)
      ? { include: true, reason: 'cấu hình/tài liệu thuộc danh sách cho phép' }
      : { include: false, reason: 'file ở thư mục gốc không nằm trong danh sách cho phép (có thể chứa thông tin đăng nhập/dữ liệu khách hàng)' };
  }
  const top = p.split('/')[0];
  // .claude: chỉ các lệnh dùng chung (commands/); settings/quyền cục bộ của người dùng không bao giờ vào ZIP.
  if (top === '.claude') {
    return p.startsWith('.claude/commands/') || p === '.claude/settings.json'
      ? { include: true, reason: 'lệnh/hook Claude dùng chung (Approval Gate)' }
      : { include: false, reason: 'cấu hình Claude cục bộ' };
  }
  if (top !== 'reports' && !DIRS_ALLOWED.has(top)) return { include: false, reason: `thư mục "${top}" không nằm trong danh sách cho phép` };
  if (p.startsWith('reports/')) {
    if (REPORT_FILES.test(p)) return opts.withReport ? { include: true, reason: 'báo cáo (--with-report)' } : { include: false, reason: 'báo cáo: chỉ đưa vào khi có --with-report' };
    // Còn lại (video, ảnh, trace, error-context): chứa dữ liệu khách hàng thật và/hoặc cookie phiên, không đóng gói.
    return { include: false, reason: 'video/ảnh/trace/artifacts chứa dữ liệu khách hàng thật hoặc cookie phiên: chia sẻ qua kênh được kiểm soát, không đóng gói' };
  }
  return { include: true, reason: 'mã nguồn/tài liệu' };
}
