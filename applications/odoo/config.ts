import type { Page } from '@playwright/test';
import type { AppConfig, LoginContext } from '../../core/config/app-config';

export const odooConfig: AppConfig = {
  name: 'odoo',
  // URL và tài khoản theo vai trò nằm trong environments/odoo.json (tên biến) và .env (giá trị), riêng cho từng môi trường.
  roles: {
    accountant: {
      description: 'Kế toán: thuộc nhóm account.group_account_invoice',
    },
    noaccess: {
      description: 'Người dùng KHÔNG thuộc nhóm account.group_account_invoice nhưng xem được SO',
      mustBeUnprivileged: true,
    },
  },
  // Locator đã xác minh bằng Playwright MCP trên staging (màn hình /web/login, Odoo 18).
  async login(page: Page, _role: string, ctx: LoginContext) {
    await page.goto(`${ctx.baseUrl}/web/login`);
    await page.getByRole('textbox', { name: /Email/ }).fill(ctx.user);
    await page.getByRole('textbox', { name: 'Mật khẩu' }).fill(ctx.pass);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await page.waitForURL(/\/odoo/);
  },
  async inspectSession(page: Page) {
    const res = await page.request.post('/web/session/get_session_info', { data: { jsonrpc: '2.0', method: 'call', params: {} } });
    const info = (await res.json()).result ?? {};
    const privileged = Boolean(info.is_admin || info.is_system);
    return { privileged, detail: `is_admin=${Boolean(info.is_admin)}, is_system=${Boolean(info.is_system)}`, login: typeof info.username === 'string' ? info.username : undefined };
  },
  async inspectVersion(page: Page) {
    const res = await page.request.post('/web/webclient/version_info', { data: { jsonrpc: '2.0', method: 'call', params: {} } });
    const v = (await res.json()).result?.server_version;
    return typeof v === 'string' ? v : undefined;
  },
};
