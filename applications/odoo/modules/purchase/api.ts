import type { APIRequestContext } from '@playwright/test';
import { OdooClient } from '../../client';
import { purchaseModule } from './module';

export const PO_FIELDS = ['name', 'state', 'partner_id'];

/**
 * API của module Purchase. Hiện CHỈ có phần đọc dùng chung (fixture ghim). Chưa có hàm tạo/ghi dữ liệu nào:
 * thêm khi có requirement, qua trackCreated() để dữ liệu vào Test Data Registry và qua assertSafeToWrite() để có giấy phép ghi.
 */
export class PurchaseApi extends OdooClient {
  constructor(request: APIRequestContext) {
    super(request, purchaseModule);
  }

  /** PO nghiệp vụ được ghim trong testdata/fixtures/odoo-purchase.json (mục purchaseOrders), chỉ để ĐỌC. */
  fixturePurchaseOrder(key: string) {
    return this.fixtureRecord<{ id: number; name: string; state: string; partner_id: [number, string] }>({
      section: 'purchaseOrders',
      key,
      model: 'purchase.order',
      fields: PO_FIELDS,
    });
  }
}
