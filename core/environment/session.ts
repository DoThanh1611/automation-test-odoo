import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { AppConfig, SessionInfo } from '../config/app-config';
import { roleMissing, type ResolvedEnvironment } from './config';
import { authFileFor, metaFileFor } from './paths';

/** Kết quả xác minh của một (môi trường, vai trò). Không chứa mật khẩu/cookie. */
export interface SessionMeta {
  environment: string;
  application: string;
  role: string;
  host: string;
  verifiedAt: string;
  /** true chỉ khi đăng nhập được VÀ mọi kiểm tra (URL, tài khoản, phân quyền, phiên bản) đều đạt. */
  ok: boolean;
  problems: string[];
  configuredUser?: string;
  actualUser?: string;
  privileged?: boolean;
  detail?: string;
  version?: { expected?: string; actual?: string };
}

export interface VerifyFacts {
  finalUrl?: string;
  info?: SessionInfo;
  version?: string;
  cookieDomains?: string[];
}

const hostnameOf = (host: string) => host.replace(/:\d+$/, '');

/** Cookie phải thuộc đúng host của môi trường (hoặc domain cha của nó). Cookie lạ nghĩa là phiên đã đi qua host khác. */
export function foreignCookieDomains(domains: string[], env: Pick<ResolvedEnvironment, 'host'>): string[] {
  const h = hostnameOf(env.host);
  return domains.filter((d) => {
    const dom = d.replace(/^\./, '');
    return dom !== h && !h.endsWith(`.${dom}`);
  });
}

/**
 * Xác minh tài khoản, phân quyền và phiên bản (thuần hàm). Rỗng = đạt.
 * Không chứng minh được (không đọc được tài khoản/quyền/phiên bản) cũng là vấn đề: không bao giờ coi "không biết" là đạt.
 */
export function verificationProblems(o: {
  env: ResolvedEnvironment;
  role: string;
  mustBeUnprivileged?: boolean;
  configuredUser: string;
  facts: VerifyFacts;
}): string[] {
  const { env, role, facts } = o;
  const out: string[] = [];
  if (facts.finalUrl) {
    let host = '';
    try {
      host = new URL(facts.finalUrl).host;
    } catch { /* để host rỗng */ }
    if (host !== env.host) out.push(`URL thực tế sau đăng nhập (${host || facts.finalUrl}) khác môi trường ${env.key} (${env.host})`);
  }
  const foreign = foreignCookieDomains(facts.cookieDomains ?? [], env);
  if (foreign.length) out.push(`phiên có cookie của host khác môi trường ${env.key}: ${foreign.join(', ')}`);
  if (!facts.info) {
    out.push(`không xác định được tài khoản và quyền của phiên ${env.key}/${role}`);
  } else {
    if (!facts.info.login) out.push(`ứng dụng không cho biết tài khoản đang đăng nhập nên không xác minh được đúng tài khoản của vai trò "${role}"`);
    else if (facts.info.login.trim().toLowerCase() !== o.configuredUser.trim().toLowerCase()) out.push(`tài khoản đăng nhập thực tế khác tài khoản cấu hình cho vai trò "${role}" của ${env.key}`);
    if (o.mustBeUnprivileged && facts.info.privileged) out.push(`vai trò "${role}" phải là tài khoản KHÔNG có quyền quản trị nhưng tài khoản này có (${facts.info.detail})`);
  }
  if (!env.expectedVersion) out.push(`chưa cấu hình phiên bản ứng dụng kỳ vọng cho ${env.key} (biến expectedVersionVar trong .env)`);
  else if (!facts.version) out.push('không đọc được phiên bản ứng dụng thực tế');
  else if (!facts.version.startsWith(env.expectedVersion)) out.push(`phiên bản ứng dụng ${facts.version} không khớp phiên bản kỳ vọng ${env.expectedVersion} của ${env.key}`);
  return out;
}

/** Che giá trị bí mật trong thông báo lỗi (bỏ qua giá trị quá ngắn để không làm hỏng văn bản). */
const redact = (s: string, secrets: (string | undefined)[]) => secrets.reduce<string>((t, x) => (x && x.length >= 4 ? t.split(x).join('[REDACTED]') : t), s);

function writeMeta(meta: SessionMeta, file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
}

export const readMeta = (key: string, app: string, role: string): SessionMeta | undefined => {
  const f = metaFileFor(key, app, role);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as SessionMeta) : undefined;
};

/**
 * Đăng nhập MỘT vai trò trên ĐÚNG môi trường được chỉ định và xác minh phiên. Không bao giờ thử môi trường khác:
 * đăng nhập lỗi => ok=false với lý do, không có đường quay lui sang môi trường/tài khoản khác.
 * Phiên (storage state) chỉ được lưu khi mọi kiểm tra đạt, vào .auth/<ENV>/<app>-<role>.json.
 */
export async function establishSession(o: { page: Page; app: AppConfig; env: ResolvedEnvironment; role: string }): Promise<SessionMeta> {
  const { page, app, env, role } = o;
  const cred = env.roles[role];
  const meta: SessionMeta = { environment: env.key, application: app.name, role, host: env.host, verifiedAt: new Date().toISOString(), ok: false, problems: [], configuredUser: cred?.user };
  const metaFile = metaFileFor(env.key, app.name, role);
  const missing = roleMissing(env, role);
  if (missing.length || !cred?.user || !cred.pass) {
    meta.problems.push(`thiếu biến môi trường: ${missing.join(', ')}`);
    writeMeta(meta, metaFile);
    return meta;
  }

  try {
    await app.login(page, role, { baseUrl: env.baseUrl, user: cred.user, pass: cred.pass, db: env.db });
  } catch (e) {
    meta.problems.push(`đăng nhập thất bại trên ${env.key}/${role}: ${redact((e as Error).message.split('\n')[0], [cred.user, cred.pass])}. Không tự chuyển sang môi trường hoặc tài khoản khác`);
    writeMeta(meta, metaFile);
    return meta;
  }

  const facts: VerifyFacts = { finalUrl: page.url(), cookieDomains: (await page.context().cookies()).map((c) => c.domain) };
  try {
    facts.info = await app.inspectSession?.(page);
  } catch { /* không đọc được: verificationProblems báo */ }
  try {
    facts.version = await app.inspectVersion?.(page);
  } catch { /* như trên */ }
  meta.actualUser = facts.info?.login;
  meta.privileged = facts.info?.privileged;
  meta.detail = facts.info?.detail;
  meta.version = { expected: env.expectedVersion, actual: facts.version };
  meta.problems = verificationProblems({ env, role, mustBeUnprivileged: app.roles[role]?.mustBeUnprivileged, configuredUser: cred.user, facts });
  meta.ok = meta.problems.length === 0;
  if (meta.ok) {
    const file = authFileFor(env.key, app.name, role);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.context().storageState({ path: file });
  }
  writeMeta(meta, metaFile);
  return meta;
}

/** Lý do không dùng được phiên của (môi trường, vai trò) khi chạy test; undefined = dùng được. */
export function sessionProblem(env: ResolvedEnvironment, app: string, role: string): string | undefined {
  const meta = readMeta(env.key, app, role);
  if (!meta) return `Chưa có phiên đăng nhập đã xác minh cho ${env.key}/${role} (project setup-${app} chưa chạy hoặc chưa thành công)`;
  if (meta.environment !== env.key || meta.host !== env.host) return `Phiên ${env.key}/${role} được xác minh cho host "${meta.host}" nhưng môi trường hiện trỏ tới "${env.host}"; cần đăng nhập lại`;
  if (!meta.ok) return `Phiên ${env.key}/${role} chưa đạt xác minh: ${meta.problems.join('; ')}`;
  if (!fs.existsSync(authFileFor(env.key, app, role))) return `Không có file phiên ${env.key}/${role}`;
  return undefined;
}
