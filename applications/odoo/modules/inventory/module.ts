import { unsupportedHandler } from '../../../../core/testdata/cleanup';
import type { OdooModuleDef } from '../types';
import { inventoryPickingCleanup } from './cleanup';

/**
 * Khai báo module Inventory. MẶC ĐỊNH CHỈ ĐỌC: ownership rỗng nghĩa là test KHÔNG được tạo/ghi model nào.
 * Khi requirement cần test GHI: khai báo ownership { model, refField (trường chữ tự do để gắn nhãn AUTOTEST), creatorField: 'create_uid' }
 * (xác minh trường bằng fields_get trên môi trường thật), thêm hàm tạo dữ liệu vào api.ts qua trackCreated().
 */
export const inventoryModule: OdooModuleDef = {
  key: 'odoo-inventory',
  application: 'odoo',
  module: 'inventory',
  title: 'Inventory',
  fixturesKey: 'odoo-inventory',
  // Phiếu kho do Factory tạo mang nhãn AUTOTEST ở trường origin. Lot/dòng hoạt động là bản ghi con của phiếu, không ghi trực tiếp.
  ownership: [{ model: 'stock.picking', refField: 'origin', creatorField: 'create_uid' }],
  // Chưa biết cách huỷ an toàn các chứng từ của module này: đánh dấu CHƯA HỖ TRỢ, không mượn quy trình của module khác.
  cleanup: [
    inventoryPickingCleanup,
    unsupportedHandler('inventory-default', [], 'Chưa xác minh quy trình huỷ an toàn cho các chứng từ khác của module inventory. Khai báo handler riêng khi đã xác minh.'),
  ],
};
