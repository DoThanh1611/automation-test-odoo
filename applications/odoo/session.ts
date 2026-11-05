import fs from 'node:fs';
import { request } from '@playwright/test';
import { activeEnvironment } from '../../core/environment/active';
import { requireEnvKey } from '../../core/environment/paths';
import { sessionProblem } from '../../core/environment/session';
import { authFile } from '../../core/utils/auth';
import { OdooClient } from './client';
import { getOdooModule } from './modules';

/**
 * Mở client Odoo bằng phiên đăng nhập đã xác minh của ĐÚNG môi trường đang chọn (QA_ENV): .auth/<ENV>/odoo-<role>.json.
 * Dùng cho script ngoài Playwright Test. Không có môi trường/phiên hợp lệ thì dừng, không dùng phiên của môi trường khác.
 * Truyền khoá module (ví dụ odoo-sales) để client biết quy tắc sở hữu/fixture của module đó.
 */
export async function openOdooClient(moduleKey?: string, role = 'accountant') {
  const key = requireEnvKey();
  const env = activeEnvironment('odoo');
  if (!env) throw new Error(`Môi trường ${key} không hợp lệ hoặc thiếu URL trong .env (xem: npm run qa:env -- check).`);
  const problem = sessionProblem(env, 'odoo', role);
  if (problem || !fs.existsSync(authFile('odoo', role, key))) {
    throw new Error(`${problem ?? 'Thiếu phiên đăng nhập'} (chạy: npm test hoặc npx playwright test --project=setup-odoo với QA_ENV=${key}).`);
  }
  const baseURL = env.baseUrl;
  const ctx = await request.newContext({ baseURL, storageState: authFile('odoo', role, key) });
  const client = new OdooClient(ctx, moduleKey ? getOdooModule(moduleKey) : undefined);
  return { client, baseURL, uid: await client.currentUserId(), ctx };
}
