import type { Page } from '@playwright/test';

/**
 * Page Object của form Đơn mua hàng (PO). KHUNG TRỐNG: chưa có locator vì chưa khám phá giao diện Purchase.
 * Khi có requirement: dùng Playwright MCP để xác minh từng locator trên giao diện thật rồi mới thêm vào đây. Không đoán selector.
 */
export class PurchaseOrderPage {
  constructor(protected page: Page) {}
}
