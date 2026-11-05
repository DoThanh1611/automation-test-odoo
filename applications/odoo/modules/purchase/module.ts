import { unsupportedHandler } from '../../../../core/testdata/cleanup';
import type { OdooModuleDef } from '../types';

const WHY =
  'Chưa xác minh quy trình huỷ an toàn cho loại chứng từ này của Purchase (PO, hóa đơn mua, phiếu nhập kho, thanh toán NCC). ' +
  'KHÔNG áp dụng quy trình huỷ SO/phiếu thu của Sales. Cần xác minh riêng khi có requirement.';

/**
 * Khai báo module Purchase. CHƯA có nghiệp vụ, test case hay thao tác ghi: chỉ là hạ tầng để nhận requirement Purchase.
 * Đã xác minh chỉ đọc trên staging (2026-11-03): purchase.order có trường partner_ref (char), origin, create_uid, state, partner_id.
 */
export const purchaseModule: OdooModuleDef = {
  key: 'odoo-purchase',
  application: 'odoo',
  module: 'purchase',
  title: 'Mua hàng (Purchase)',
  fixturesKey: 'odoo-purchase',
  // Khi requirement Purchase cần test GHI dữ liệu: PO do automation tạo được gắn nhãn AUTOTEST vào partner_ref (Vendor Reference).
  ownership: [{ model: 'purchase.order', refField: 'partner_ref', creatorField: 'create_uid' }],
  // Mọi loại chứng từ có thể phát sinh từ Purchase đều CHƯA HỖ TRỢ cleanup cho tới khi được xác minh riêng.
  cleanup: [
    unsupportedHandler('purchase-order', ['purchase.order'], WHY),
    // stock.picking thuộc module Inventory (chủ sở hữu phiếu kho); Purchase chỉ khai báo stock.move chưa hỗ trợ.
    unsupportedHandler('purchase-stock-move', ['stock.move'], WHY),
    unsupportedHandler('purchase-vendor-bill', ['account.move'], WHY),
  ],
};
