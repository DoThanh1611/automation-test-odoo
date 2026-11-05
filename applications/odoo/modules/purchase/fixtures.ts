import { test as base, expect } from '../../../../core/fixtures/base';
import { PurchaseApi } from './api';

/** Fixture Playwright của module Purchase. Thêm Page Object vào đây khi đã khám phá giao diện bằng Playwright MCP. */
export const test = base.extend<{ api: PurchaseApi }>({
  api: async ({ page }, use) => {
    const api = new PurchaseApi(page.request);
    await use(api);
    await api.trackCreatedChildren();
  },
});

export { expect };
