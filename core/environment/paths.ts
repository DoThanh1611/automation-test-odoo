import path from 'node:path';

/**
 * Mọi thứ phát sinh khi chạy đều nằm trong thư mục RIÊNG của môi trường (QA_ENV), nên môi trường này không thể ghi đè môi trường kia:
 *   .auth/<ENV>/<app>-<role>.json        phiên đăng nhập (cookie/storage state) theo môi trường và vai trò
 *   reports/<ENV>/runs/<runId>/...       kết quả, evidence (video/ảnh/trace), Run ID
 *   reports/<ENV>/bugs.json, qa-*.{json,html,md}
 *   testdata/registry/<ENV>.jsonl        sổ dữ liệu test do automation tạo
 *   testdata/fixtures/<ENV>/<key>.json   bản ghi ghim (ID khác nhau giữa các môi trường)
 * Dữ liệu cũ nằm ở đường dẫn cũ (reports/, .auth/odoo-*.json, testdata/registry.jsonl) được giữ nguyên, không bị đụng tới.
 */
export const activeEnvKey = (): string | undefined => process.env.QA_ENV?.trim() || undefined;

export function requireEnvKey(key = activeEnvKey()): string {
  if (!key) throw new Error('Chưa chọn môi trường kiểm thử (QA_ENV). Chọn bằng: npm run qa:env -- select --env=<TÊN>.');
  return key;
}

/** Thư mục ghi kết quả. QA_REPORTS_DIR (chạy thử/framework test) được ưu tiên; không có môi trường thì dùng reports/ (chỉ framework). */
export function reportsDirFor(key = activeEnvKey()): string {
  if (process.env.QA_REPORTS_DIR) return path.resolve(process.env.QA_REPORTS_DIR);
  return path.resolve('reports', ...(key ? [key] : []));
}

export const authDir = (key: string) => path.resolve(process.env.QA_AUTH_DIR ?? '.auth', key);
export const authFileFor = (key: string, app: string, role: string) => path.join(authDir(key), `${app}-${role}.json`);
export const metaFileFor = (key: string, app: string, role: string) => path.join(authDir(key), `${app}-${role}.meta.json`);

export function registryPathFor(key = activeEnvKey()): string {
  if (process.env.QA_REGISTRY_FILE) return path.resolve(process.env.QA_REGISTRY_FILE);
  return key ? path.resolve('testdata', 'registry', `${key}.jsonl`) : path.resolve('testdata', 'registry.jsonl');
}

export function fixturesDirFor(key = activeEnvKey()): string {
  if (process.env.QA_FIXTURES_DIR) return path.resolve(process.env.QA_FIXTURES_DIR);
  return path.resolve('testdata', 'fixtures', ...(key ? [key] : []));
}
