import type { AppConfig } from '../core/config/app-config';
import { odooConfig } from './odoo/config';

/** Thêm ứng dụng mới: `npm run new:app -- <tên>` (tự tạo config và đăng ký ở đây). Core không đổi. */
const registry: Record<string, AppConfig> = {
  odoo: odooConfig,
};

export const listApps = () => Object.keys(registry);

export function getApp(name: string): AppConfig {
  const app = registry[name];
  if (!app) throw new Error(`Ứng dụng "${name}" chưa đăng ký trong applications/index.ts`);
  return app;
}
