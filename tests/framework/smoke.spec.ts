import { test, expect } from '@playwright/test';
import { validateTraceability } from '../../core/testcases/loader';

// Test kỹ thuật (không thuộc bảng Test Case nghiệp vụ): xác nhận pipeline video/screenshot/trace/report hoạt động.
test('FW-01 Playwright chạy được, trang local render và video được lưu', async ({ page }) => {
  await page.setContent('<h1 id="t">Framework OK</h1>');
  await expect(page.locator('#t')).toHaveText('Framework OK');
});

test('FW-02 Traceability: mọi BR/AC tham chiếu hợp lệ', async () => {
  const { errors } = validateTraceability();
  expect(errors).toEqual([]);
});
