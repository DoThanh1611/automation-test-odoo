import fs from 'node:fs';
import path from 'node:path';

/**
 * Cấu hình nhiều môi trường kiểm thử cho CÙNG một ứng dụng (STAGING_A, STAGING_B, UAT...).
 * File environments/<app>.json CHỈ chứa TÊN biến môi trường (nằm trong .env), không chứa URL, tài khoản hay mật khẩu.
 * Core không biết gì về Odoo/MISA: mọi ứng dụng dùng chung định dạng này.
 */
export type EnvKind = 'test' | 'staging' | 'uat' | 'production';
export const ENV_KINDS: EnvKind[] = ['test', 'staging', 'uat', 'production'];

export interface EnvRoleRef {
  userVar: string;
  passVar: string;
}

/**
 * Chính sách quyền thao tác của môi trường (khai báo; người dùng còn phải XÁC NHẬN: npm run qa:policy confirm).
 *  - write: 'none' = chỉ đọc; 'framework-data' = được tạo/sửa/cleanup DỮ LIỆU DO FRAMEWORK TẠO (trong registry), không đụng dữ liệu nghiệp vụ có sẵn.
 * Môi trường production luôn bị ép về 'none' bất kể khai báo (xem core/policy/policy.ts).
 */
export interface PolicyDecl {
  write?: 'none' | 'framework-data';
  autoCleanup?: boolean;
  /** Giờ giữ lại dữ liệu của test FAIL để điều tra trước khi cleanup (0 = cleanup luôn). */
  failureRetentionHours?: number;
  /** Số bản ghi tối đa framework được tạo trong một lần chạy. */
  maxRecordsPerRun?: number;
}

export interface EnvironmentDef {
  policy?: PolicyDecl;
  label: string;
  kind: EnvKind;
  /** Tên biến chứa URL gốc của môi trường. */
  urlVar: string;
  /** Tên biến chứa tên database (tuỳ chọn; dùng khi nhiều môi trường chung máy chủ). */
  dbVar?: string;
  /** Tên biến chứa phiên bản ứng dụng KỲ VỌNG (khớp tiền tố, ví dụ 18.0). Bắt buộc khai báo để xác minh phiên bản trước khi chạy. */
  expectedVersionVar: string;
  roles: Record<string, EnvRoleRef>;
}

export interface EnvironmentsFile {
  application: string;
  /**
   * 'explicit' (mặc định): người dùng xác nhận riêng môi trường (24 giờ) và chính sách ghi (8 giờ).
   * 'approval': APPROVE test case là xác nhận DUY NHẤT của người dùng; môi trường dùng `defaultEnvironment`, quyền ghi theo `policy` của
   * môi trường. Production KHÔNG BAO GIỜ được suy ra theo cách này (vẫn cần xác nhận riêng, và quyền ghi luôn bị ép về none).
   */
  confirmation?: 'explicit' | 'approval';
  defaultEnvironment?: string;
  environments: Record<string, EnvironmentDef>;
}

export const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Thư mục chứa environments/<app>.json; QA_ENVIRONMENTS_DIR chỉ dùng cho framework test (môi trường giả). */
export const environmentsDir = () => path.resolve(process.env.QA_ENVIRONMENTS_DIR ?? 'environments');
export const environmentsFile = (app: string) => path.join(environmentsDir(), `${app}.json`);

export function loadEnvironmentsFile(app: string): EnvironmentsFile | undefined {
  const f = environmentsFile(app);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as EnvironmentsFile) : undefined;
}

export function listEnvironmentKeys(app: string): string[] {
  return Object.keys(loadEnvironmentsFile(app)?.environments ?? {});
}

/**
 * Kiểm tra cấu hình (thuần hàm): tên hợp lệ, MỌI giá trị tham chiếu phải là TÊN biến (không được là URL/mật khẩu viết thẳng),
 * và không có biến nào dùng chung giữa hai môi trường (nếu dùng chung thì một môi trường có thể mượn tài khoản/URL của môi trường kia).
 */
export function validateEnvironmentsFile(file: EnvironmentsFile, knownRoles?: string[]): string[] {
  const problems: string[] = [];
  const envs = Object.entries(file.environments ?? {});
  if (!file.application) problems.push('thiếu "application"');
  if (file.confirmation !== undefined && file.confirmation !== 'explicit' && file.confirmation !== 'approval') problems.push('"confirmation" phải là explicit hoặc approval');
  if (file.confirmation === 'approval' && !(file.defaultEnvironment && file.environments?.[file.defaultEnvironment])) problems.push('chế độ approval cần "defaultEnvironment" là một môi trường đã khai báo');
  if (!envs.length) problems.push('chưa khai báo môi trường nào');
  const owner = new Map<string, string>();
  const claim = (v: string | undefined, where: string, key: string) => {
    if (v === undefined) return;
    if (!NAME_PATTERN.test(v)) {
      problems.push(`${key}.${where}: giá trị (${v.length} ký tự, không in ra) không phải tên biến môi trường; chỉ được tham chiếu TÊN biến, giá trị thật phải nằm trong .env`);
      return;
    }
    const prev = owner.get(v);
    if (prev && prev !== key) problems.push(`biến ${v} bị dùng chung bởi ${prev} và ${key}: mỗi môi trường phải có biến riêng`);
    else owner.set(v, key);
  };
  for (const [key, def] of envs) {
    if (!NAME_PATTERN.test(key)) problems.push(`tên môi trường "${key}" phải viết HOA, gồm chữ/số/gạch dưới (ví dụ STAGING_A)`);
    if (!def.label?.trim()) problems.push(`${key}: thiếu label`);
    if (!ENV_KINDS.includes(def.kind)) problems.push(`${key}: kind phải là một trong ${ENV_KINDS.join('/')}`);
    if (!def.urlVar) problems.push(`${key}: thiếu urlVar`);
    if (!def.expectedVersionVar) problems.push(`${key}: thiếu expectedVersionVar (bắt buộc để xác minh phiên bản ứng dụng)`);
    if (def.policy) {
      const p = def.policy;
      if (p.write !== undefined && !['none', 'framework-data'].includes(p.write)) problems.push(`${key}: policy.write phải là none hoặc framework-data`);
      for (const [k, v] of [['failureRetentionHours', p.failureRetentionHours], ['maxRecordsPerRun', p.maxRecordsPerRun]] as const) {
        if (v !== undefined && (!Number.isFinite(v) || v < 0)) problems.push(`${key}: policy.${k} phải là số không âm`);
      }
    }
    claim(def.urlVar, 'urlVar', key);
    claim(def.dbVar, 'dbVar', key);
    claim(def.expectedVersionVar, 'expectedVersionVar', key);
    const roles = Object.entries(def.roles ?? {});
    if (!roles.length) problems.push(`${key}: chưa khai báo vai trò nào`);
    for (const [role, ref] of roles) {
      if (knownRoles && !knownRoles.includes(role)) problems.push(`${key}: vai trò "${role}" không có trong cấu hình ứng dụng (${knownRoles.join(', ')})`);
      claim(ref.userVar, `roles.${role}.userVar`, key);
      claim(ref.passVar, `roles.${role}.passVar`, key);
      if (ref.userVar && ref.userVar === ref.passVar) problems.push(`${key}.roles.${role}: userVar và passVar không được trùng nhau`);
    }
  }
  return problems;
}

// ---- Giải biến môi trường thành ngữ cảnh môi trường ----
export interface ResolvedRole {
  role: string;
  userVar: string;
  passVar: string;
  user?: string;
  pass?: string;
  /** Tên biến còn thiếu (không bao giờ chứa giá trị). */
  missing: string[];
}

export interface ResolvedEnvironment {
  policy?: PolicyDecl;
  application: string;
  key: string;
  label: string;
  kind: EnvKind;
  baseUrl: string;
  origin: string;
  /** host[:port], dùng để so khớp URL thực tế. */
  host: string;
  db?: string;
  expectedVersion?: string;
  roles: Record<string, ResolvedRole>;
}

export type ResolveResult = { ok: true; env: ResolvedEnvironment } | { ok: false; problems: string[] };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const val = (source: NodeJS.ProcessEnv, name?: string) => {
  const v = name ? source[name] : undefined;
  return v && v.trim() ? v.trim() : undefined;
};

export function resolveEnvironment(app: string, key: string, source: NodeJS.ProcessEnv = process.env): ResolveResult {
  const file = loadEnvironmentsFile(app);
  if (!file) return { ok: false, problems: [`chưa có file cấu hình environments/${app}.json`] };
  const def = file.environments[key];
  if (!def) return { ok: false, problems: [`môi trường "${key}" không có trong environments/${app}.json (có: ${Object.keys(file.environments).join(', ') || 'không có'})`] };
  const cfgProblems = validateEnvironmentsFile(file);
  if (cfgProblems.length) return { ok: false, problems: cfgProblems.map((p) => `cấu hình: ${p}`) };

  const raw = val(source, def.urlVar);
  if (!raw) return { ok: false, problems: [`thiếu biến ${def.urlVar} (URL của ${key}) trong .env`] };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problems: [`${def.urlVar} không phải URL hợp lệ`] };
  }
  const problems: string[] = [];
  if (url.username || url.password) problems.push(`${def.urlVar} không được chứa tài khoản/mật khẩu trong URL`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) problems.push(`${def.urlVar} phải là https (http chỉ cho phép với localhost của môi trường giả lập)`);
  if (url.search || url.hash) problems.push(`${def.urlVar} không được có query/fragment`);
  if (problems.length) return { ok: false, problems };

  const roles: Record<string, ResolvedRole> = {};
  for (const [role, ref] of Object.entries(def.roles)) {
    const user = val(source, ref.userVar);
    const pass = val(source, ref.passVar);
    roles[role] = { role, userVar: ref.userVar, passVar: ref.passVar, user, pass, missing: [!user && ref.userVar, !pass && ref.passVar].filter(Boolean) as string[] };
  }
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  return {
    ok: true,
    env: {
      application: app, key, label: def.label, kind: def.kind, policy: def.policy,
      baseUrl: base, origin: url.origin, host: url.host,
      db: val(source, def.dbVar), expectedVersion: val(source, def.expectedVersionVar), roles,
    },
  };
}

/** Hai môi trường khác tên nhưng trỏ cùng một đích (cùng origin + database) là cấu hình nhầm: kết quả sẽ lẫn nhau. */
export function ambiguousTargets(envs: ResolvedEnvironment[]): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const e of envs) {
    const id = `${e.origin}|${e.db ?? ''}`;
    const prev = seen.get(id);
    if (prev) out.push(`${prev} và ${e.key} cùng trỏ tới ${e.origin}${e.db ? ` (db ${e.db})` : ''}`);
    else seen.set(id, e.key);
  }
  return out;
}

export function resolveAll(app: string, source: NodeJS.ProcessEnv = process.env) {
  const keys = listEnvironmentKeys(app);
  const results = keys.map((k) => ({ key: k, result: resolveEnvironment(app, k, source) }));
  const resolved = results.flatMap((r) => (r.result.ok ? [r.result.env] : []));
  return { results, ambiguous: ambiguousTargets(resolved) };
}

export const roleMissing = (env: ResolvedEnvironment, role: string): string[] => env.roles[role]?.missing ?? [`(vai trò "${role}" không khai báo cho ${env.key})`];
