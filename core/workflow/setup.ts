import fs from 'node:fs';
import path from 'node:path';
import { environmentsDir, listEnvironmentKeys, loadEnvironmentsFile, resolveEnvironment, validateEnvironmentsFile } from '../environment/config';

/**
 * Thiết lập lần đầu trên máy mới (OFFLINE, không kết nối mạng, không in giá trị bí mật):
 * công cụ cần có, .env (tạo từ .env.example nếu chưa có, không bao giờ ghi đè), cấu hình môi trường (chỉ TÊN biến còn thiếu),
 * .gitignore chặn bí mật và kết quả chạy, hook của Claude Code. Trả về danh sách kiểm tra + việc người dùng còn phải làm một lần.
 */
export interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** blocker = chưa chạy được quy trình; warn = nên làm. */
  level: 'blocker' | 'warn' | 'info';
}

export interface SetupOptions {
  root: string;
  source?: NodeJS.ProcessEnv;
  /** Tạo .env từ .env.example nếu chưa có. */
  init?: boolean;
  /** Ứng dụng đã đăng ký và vai trò của chúng (core không biết ứng dụng). */
  apps: Record<string, string[]>;
  nodeVersion?: string;
  /** Đã cài trình duyệt Playwright chưa (kiểm tra offline do bên gọi thực hiện). */
  browserInstalled?: boolean;
}

export const REQUIRED_IGNORE = ['.env', '.env.*', '!.env.example', '.auth/', 'reports/', 'share/', '*.zip', 'node_modules/', '.playwright-mcp/', '.qa-state/', 'requirements/_inbox/', 'testdata/registry.jsonl', 'testdata/registry/'];

export function runSetup(o: SetupOptions): { checks: SetupCheck[]; userSteps: string[]; created: string[] } {
  const checks: SetupCheck[] = [];
  const created: string[] = [];
  const add = (name: string, ok: boolean, detail: string, level: SetupCheck['level'] = 'blocker') => checks.push({ name, ok, detail, level });
  const source = o.source ?? process.env;

  const major = Number((o.nodeVersion ?? process.versions.node).split('.')[0]);
  add('Node.js', major >= 18, `phiên bản ${o.nodeVersion ?? process.versions.node} (cần từ 18 trở lên)`);
  add('Phụ thuộc (npm install)', fs.existsSync(path.join(o.root, 'node_modules', '@playwright', 'test')), 'node_modules đã có @playwright/test', 'blocker');
  if (o.browserInstalled !== undefined) add('Trình duyệt Playwright', o.browserInstalled, o.browserInstalled ? 'đã cài' : 'chưa cài: chạy npx playwright install chromium', 'blocker');

  const envFile = path.join(o.root, '.env');
  const example = path.join(o.root, '.env.example');
  if (!fs.existsSync(envFile) && o.init && fs.existsSync(example)) {
    fs.copyFileSync(example, envFile, fs.constants.COPYFILE_EXCL);
    created.push('.env');
  }
  add('.env', fs.existsSync(envFile), fs.existsSync(envFile) ? (created.includes('.env') ? 'vừa tạo từ .env.example (chưa có giá trị thật)' : 'đã có') : 'chưa có: chạy npm run setup -- --init để tạo từ .env.example', 'blocker');
  add('.env.example', fs.existsSync(example), 'mẫu cấu hình (không chứa bí mật)', 'warn');

  const ignore = fs.existsSync(path.join(o.root, '.gitignore')) ? fs.readFileSync(path.join(o.root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()) : [];
  const missingIgnore = REQUIRED_IGNORE.filter((l) => !ignore.includes(l));
  add('.gitignore', !missingIgnore.length, missingIgnore.length ? `thiếu: ${missingIgnore.join(', ')}` : 'chặn bí mật, phiên đăng nhập, kết quả chạy và sổ dữ liệu test', 'blocker');

  const settingsFile = path.join(o.root, '.claude', 'settings.json');
  let hooks = '';
  try {
    hooks = JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks ?? {});
  } catch { /* thiếu hoặc hỏng */ }
  add('Hook an toàn của Claude Code', /mcp__playwright__/.test(hooks) && /Bash/.test(hooks), '.claude/settings.json chặn Playwright MCP khi chưa đủ cổng và chặn lệnh vượt cổng', 'blocker');

  const envVarsMissing: string[] = [];
  for (const [app, roles] of Object.entries(o.apps)) {
    const file = loadEnvironmentsFile(app);
    if (!file) {
      add(`Môi trường ${app}`, false, `thiếu ${path.relative(o.root, path.join(environmentsDir(), `${app}.json`))}`, 'blocker');
      continue;
    }
    const problems = validateEnvironmentsFile(file, roles);
    add(`Khai báo môi trường ${app}`, !problems.length, problems.length ? problems.join('; ') : `${Object.keys(file.environments).length} môi trường, chỉ tham chiếu TÊN biến`, 'blocker');
    for (const key of listEnvironmentKeys(app)) {
      const r = resolveEnvironment(app, key, source);
      if (r.ok) {
        const miss = Object.values(r.env.roles).flatMap((x) => x.missing);
        add(`Môi trường ${key}`, !miss.length, miss.length ? `thiếu biến tài khoản: ${miss.join(', ')}` : `sẵn sàng (${r.env.kind}, ${r.env.host})`, 'info');
        envVarsMissing.push(...miss);
      } else {
        add(`Môi trường ${key}`, false, r.problems.join('; '), 'info');
        envVarsMissing.push(...r.problems);
      }
    }
  }
  const usable = checks.filter((c) => c.name.startsWith('Môi trường ') && c.level === 'info' && c.ok).length;
  add('Có ít nhất một môi trường dùng được', usable > 0, usable > 0 ? `${usable} môi trường` : 'điền .env cho ít nhất một môi trường (xem .env.example)', 'blocker');

  const userSteps: string[] = [];
  if (!checks.find((c) => c.name === 'Phụ thuộc (npm install)')?.ok) userSteps.push('npm install');
  if (checks.find((c) => c.name === 'Trình duyệt Playwright' && !c.ok)) userSteps.push('npx playwright install chromium');
  if (!fs.existsSync(envFile)) userSteps.push('npm run setup -- --init (tạo .env từ mẫu)');
  if (usable === 0) userSteps.push('Mở .env và điền một lần: URL, phiên bản Odoo kỳ vọng, tài khoản theo vai trò của ít nhất một môi trường (tên biến xem .env.example). Không dán mật khẩu vào chat.');
  userSteps.push('Mở Claude Code trong thư mục dự án và gõ /qa-requirement, rồi dán requirement.');
  return { checks, userSteps, created };
}
