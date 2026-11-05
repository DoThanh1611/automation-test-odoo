import { test as base, expect } from '../../../../core/fixtures/base';
import { InventoryApi } from './api';
import { ReceiptPage } from './pages/receipt.page';

/** Fixture Playwright của module Inventory: API (Factory) + Page Object phiếu kho. */
export const test = base.extend<{ api: InventoryApi; receiptPage: ReceiptPage }>({
  api: async ({ page }, use) => {
    const api = new InventoryApi(page.request);
    await use(api);
    await api.trackCreatedChildren();
  },
  receiptPage: async ({ page }, use) => use(new ReceiptPage(page)),
});

export { expect };
