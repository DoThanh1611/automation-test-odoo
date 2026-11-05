import type { Locator, Page } from '@playwright/test';
import type { SafeWriteToken } from '../../../../../core/testdata/write-guard';

/** Popup "Register Payment" mở từ nút Thu tiền trên SO. Locator xác minh bằng Playwright MCP trên staging. */
export class RegisterPaymentDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly paymentTypeSend: Locator;
  readonly paymentTypeReceive: Locator;
  readonly customer: Locator;
  readonly salesOrder: Locator;
  readonly amount: Locator;
  readonly currency: Locator;
  readonly memo: Locator;
  // Hai nút này GHI dữ liệu nên là private: chỉ dùng được qua confirm()/save() với giấy phép ghi (SafeWriteToken).
  private readonly confirmButton: Locator;
  private readonly saveButton: Locator;
  readonly cancelButton: Locator;

  constructor(private page: Page) {
    this.root = page.getByRole('dialog');
    this.title = this.root.locator('.modal-title');
    this.paymentTypeSend = this.root.getByRole('radio', { name: 'Gửi' });
    this.paymentTypeReceive = this.root.getByRole('radio', { name: 'Nhận' });
    this.customer = this.root.getByRole('combobox', { name: 'Khách hàng' });
    this.salesOrder = this.root.getByRole('combobox', { name: 'Đơn bán hàng' });
    this.amount = this.root.getByRole('textbox', { name: 'Số tiền' });
    this.currency = this.root.getByRole('combobox').nth(2); // ô tiền tệ không có nhãn; xác minh bằng giá trị 'VND' trong test
    this.memo = this.root.getByRole('textbox', { name: 'Nội dung giao dịch' });
    this.confirmButton = this.root.getByRole('button', { name: 'Xác nhận' });
    this.saveButton = this.root.getByRole('button', { name: 'Lưu' });
    this.cancelButton = this.root.getByRole('button', { name: 'Huỷ bỏ' });
  }

  /** Chặn ghi nhầm: giấy phép phải là của đúng SO đang mở trên màn hình. */
  private assertTokenMatchesPage(token: SafeWriteToken) {
    const onThisOrder = new RegExp('/orders/' + token.id + '(?:[/?#]|$)').test(this.page.url());
    if (token.model !== 'sale.order' || !onThisOrder) {
      throw new Error('Từ chối ghi: giấy phép ghi không thuộc SO đang mở (' + this.page.url() + ')');
    }
  }

  /** Bấm Xác nhận (GHI dữ liệu: tạo và ghi sổ phiếu thu). Bắt buộc có giấy phép từ OdooApi.assertSafeToWrite(). */
  async confirm(token: SafeWriteToken) {
    this.assertTokenMatchesPage(token);
    await this.confirmButton.click();
  }

  /** Bấm Lưu (GHI dữ liệu: tạo phiếu thu nháp). Bắt buộc có giấy phép ghi. */
  async save(token: SafeWriteToken) {
    this.assertTokenMatchesPage(token);
    await this.saveButton.click();
  }

  /** Đọc các giá trị đang hiển thị trong popup, dùng để ghi Actual Result. */
  async readValues() {
    return {
      title: (await this.title.innerText()).trim(),
      receive: await this.paymentTypeReceive.isChecked(),
      customer: await this.customer.inputValue(),
      salesOrder: await this.salesOrder.inputValue(),
      amount: await this.amount.inputValue(),
      currency: await this.currency.inputValue(),
      memo: await this.memo.inputValue(),
    };
  }

  async fillAmount(vnd: number) {
    await this.amount.fill(vnd.toLocaleString('de-DE')); // định dạng vi-VN của Odoo: 4.000.000
    await this.amount.blur();
  }
}
