import type { Locator, Page } from '@playwright/test';

/**
 * Phiếu kho (nhập/xuất/điều chuyển) và hộp thoại "Hoạt động chi tiết" với cột "Số máy (EIN)".
 * Locator lấy từ khám phá giao diện thật trên STAGING_A (Odoo 19, tiếng Việt): nút "Chi tiết" trên dòng sản phẩm, hộp thoại
 * "Hoạt động chi tiết" có nút "Lưu"/"Huỷ bỏ", ô số máy là td[name="engine_number"] trong dòng chứa tên serial; nút hoàn tất phiếu là "Xác nhận".
 */
export class ReceiptPage {
  constructor(readonly page: Page) {}

  get title() {
    return this.page.locator('.o_form_view .o_breadcrumb, .breadcrumb').first();
  }
  get detailsButton() {
    return this.page.getByRole('button', { name: 'Chi tiết' }).first();
  }
  get dialog() {
    return this.page.getByRole('dialog');
  }
  get saveInDialog() {
    return this.dialog.getByRole('button', { name: 'Lưu' });
  }
  get validateButton() {
    return this.page.getByRole('button', { name: 'Xác nhận', exact: true });
  }
  /** Thông báo lỗi/cảnh báo của Odoo (hộp thoại lỗi hoặc thông báo nổi). */
  get errorMessage() {
    return this.page.locator('.o_error_dialog, .modal .o_dialog_error, .o_notification.border-danger, .o_notification.border-warning, .o_notification_content');
  }

  async open(pickingId: number) {
    await this.page.goto(`/odoo/action-stock.action_picking_tree_all/${pickingId}`);
    await this.detailsButton.waitFor();
  }

  async openDetails() {
    await this.detailsButton.click();
    await this.dialog.getByRole('columnheader', { name: /Số máy \(EIN\)/ }).waitFor();
  }

  row(lotName: string): Locator {
    return this.dialog.locator('tr.o_data_row', { hasText: lotName });
  }

  engineCell(lotName: string): Locator {
    return this.row(lotName).locator('td[name="engine_number"]');
  }

  /** Nhập số máy vào dòng của serial rồi bấm Lưu trong hộp thoại. */
  async setEngine(lotName: string, engine: string) {
    await this.engineCell(lotName).click();
    // Khi vào chế độ sửa, các ô của dòng thành ô nhập nên không còn khớp theo chữ của serial: dùng dòng đang được chọn.
    const input = this.dialog.locator('tr.o_data_row.o_selected_row td[name="engine_number"] input');
    await input.fill(engine);
    await this.saveInDialog.click();
  }

  async engineShown(lotName: string): Promise<string> {
    return (await this.engineCell(lotName).innerText()).trim();
  }

  async closeDetails() {
    if (await this.dialog.isVisible()) await this.dialog.getByRole('button', { name: 'Huỷ bỏ' }).click();
  }
}
