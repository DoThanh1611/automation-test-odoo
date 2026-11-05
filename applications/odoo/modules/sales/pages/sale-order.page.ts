import type { Locator, Page } from '@playwright/test';
import { RegisterPaymentDialog } from './register-payment.dialog';

/** Số tiền hiển thị kiểu "48.680.000 ₫" -> 48680000. */
export const parseVnd = (text: string) => Number(text.replace(/[^\d-]/g, ''));

/** Form chi tiết đơn bán hàng (Bán hàng → Đơn hàng → Đơn hàng → chi tiết). */
export class SaleOrderPage {
  readonly collectButton: Locator;
  readonly paymentTab: Locator;
  readonly formHeader: Locator;
  readonly title: Locator;
  readonly dialog: RegisterPaymentDialog;
  /** Ô "Ngưỡng thanh toán (%)" trên form SO. Locator xác minh trên giao diện thật (Odoo 19, STAGING_A): textbox có nhãn này. */
  readonly thresholdInput: Locator;

  constructor(private page: Page) {
    this.formHeader = page.locator('.o_form_view .o_statusbar_buttons').first();
    this.title = page.locator('.o_form_view h1').first();
    this.collectButton = this.formHeader.getByRole('button', { name: 'Thu tiền', exact: true });
    this.paymentTab = page.getByRole('tab', { name: 'Thanh toán / Phải thu' });
    this.dialog = new RegisterPaymentDialog(page);
    this.thresholdInput = page.getByRole('textbox', { name: 'Ngưỡng thanh toán (%)' });
  }

  async open(soId: number) {
    await this.page.goto(`/odoo/orders/${soId}`);
    await this.formHeader.waitFor();
  }

  /** Các nút đang hiển thị trên thanh nút của SO. Dùng để chứng minh form đã tải xong khi kiểm tra "không thấy nút". */
  visibleButtons() {
    return this.formHeader.locator('button:visible').allInnerTexts();
  }

  async openCollectDialog() {
    await this.collectButton.click();
    await this.dialog.root.waitFor();
    return this.dialog;
  }

  /** Ngưỡng thanh toán đang hiển thị trên form (hiển thị kiểu "80,00" -> 80). */
  async readThreshold() {
    await this.thresholdInput.waitFor();
    const text = (await this.thresholdInput.inputValue()).trim();
    return { text, value: Number(text.replace(/\./g, '').replace(',', '.')) };
  }

  private field(name: string) {
    return this.page.locator(`.o_form_view [name="${name}"]`).first();
  }

  async openPaymentTab() {
    await this.paymentTab.click();
  }

  /** Đọc khối "Tổng hợp thu tiền" trong tab Thanh toán / Phải thu. */
  async readPaymentSummary() {
    await this.openPaymentTab();
    return {
      total: parseVnd(await this.field('amount_total').innerText()),
      paid: parseVnd(await this.field('moveo_amount_paid').innerText()),
      due: parseVnd(await this.field('moveo_amount_due').innerText()),
      statusLabel: (await this.field('moveo_payment_status').innerText()).trim(),
    };
  }
}
