import type { APIRequestContext } from '@playwright/test';
import { getRunId } from '../../../../core/config/run';
import { activeBaseUrl } from '../../../../core/environment/active';
import { autotestRef } from '../../../../core/testdata/autotest';
import { FixtureError, loadFixtures, type FixtureFile } from '../../../../core/testdata/fixtures';
import { recordData } from '../../../../core/utils/tc';
import { OdooClient, type ChildRecord, type CreatedRecord } from '../../client';
import { expectToConditions, type SalesExpect } from './expect';
import { salesModule } from './module';

export interface SaleOrderRec {
  id: number;
  name: string;
  state: string;
  moveo_payment_status: 'unpaid' | 'partial' | 'paid';
  moveo_amount_due: number;
  moveo_amount_paid: number;
  amount_total: number;
  partner_id: [number, string];
  company_id: [number, string];
  currency_id: [number, string];
}

export const SO_FIELDS = [
  'name', 'state', 'moveo_payment_status', 'moveo_amount_due', 'moveo_amount_paid',
  'amount_total', 'partner_id', 'company_id', 'currency_id',
];

interface SalesFixtures extends FixtureFile {
  saleOrders: Record<string, { name: string; purpose?: string; expect: SalesExpect }>;
  orderFactory: { partner: { id: number; name: string }; product: { id: number; name: string } };
}

export const describeSo = (so: SaleOrderRec, kind: string) => ({
  [kind]: so.name,
  'state': so.state,
  'moveo_payment_status': so.moveo_payment_status,
  'moveo_amount_due': so.moveo_amount_due,
  'amount_total': so.amount_total,
});

/** API của module Sales: mọi logic riêng của sale.order / phiếu thu nằm ở đây, không nằm trong lõi dùng chung. */
export class SalesApi extends OdooClient {
  constructor(request: APIRequestContext) {
    super(request, salesModule);
  }

  async getSaleOrder(id: number): Promise<SaleOrderRec> {
    const [so] = await this.searchRead<SaleOrderRec>('sale.order', [['id', '=', id]], SO_FIELDS);
    return so;
  }

  /**
   * Lấy SO nghiệp vụ ĐƯỢC GHIM TƯỜNG MINH trong testdata/fixtures/odoo-sales.json, chỉ để ĐỌC.
   * Kiểm tra lại điều kiện expect mỗi lần; nếu SO không còn thỏa (người khác đã đổi) hoặc môi trường không khớp thì ném FixtureError.
   */
  fixtureSaleOrder(key: string): Promise<SaleOrderRec> {
    return this.fixtureRecord<SaleOrderRec>({
      section: 'saleOrders',
      key,
      model: 'sale.order',
      fields: SO_FIELDS,
      extraConditions: (spec) => expectToConditions(spec.expect),
      describe: (so) => describeSo(so, `SO cố định (fixture ${key})`),
    });
  }

  /**
   * Tạo SO test (không thuế, 1 dòng) với tổng tiền xác định, rồi xác nhận. Ghi dữ liệu: chỉ gọi sau writeGuard().
   * ref là mã test case (ví dụ TC-SO-008). Khách hàng/sản phẩm lấy từ fixture "orderFactory" (đã kiểm tra tên), không tự chọn.
   */
  async createConfirmedSaleOrder(amount: number, ref: string): Promise<SaleOrderRec> {
    // Tự chặn ngay tại điểm tạo dữ liệu, không chỉ dựa vào việc test nhớ gọi writeGuard().
    const blockers = this.writeBlockers();
    if (blockers.length) throw new Error(`Từ chối tạo dữ liệu: ${blockers.join('; ')}`);
    const { orderFactory } = loadFixtures<SalesFixtures>(salesModule.fixturesKey, activeBaseUrl('odoo'));
    for (const [model, item] of [['res.partner', orderFactory.partner], ['product.product', orderFactory.product]] as const) {
      const [rec] = await this.searchRead<{ name: string }>(model, [['id', '=', item.id]], ['name']);
      if (rec?.name !== item.name) throw new FixtureError(`orderFactory: ${model}#${item.id} hiện là "${rec?.name}", fixture khai báo "${item.name}"`);
    }
    const reference = autotestRef(getRunId(), ref);
    const id = await this.call<number>('sale.order', 'create', [{
      partner_id: orderFactory.partner.id,
      client_order_ref: reference,
      order_line: [[0, 0, { product_id: orderFactory.product.id, product_uom_qty: 1, price_unit: amount, tax_ids: [[6, 0, []]] }]],
    }]);
    this.trackCreated('sale.order', id, reference);
    await this.call('sale.order', 'action_confirm', [[id]]);
    const so = await this.getSaleOrder(id);
    if (Math.round(so.amount_total) !== amount) throw new Error(`SO test ${so.name} có tổng ${so.amount_total}, mong đợi ${amount}`);
    if (Math.round(so.moveo_amount_due) !== amount) throw new Error(`SO test ${so.name} có còn phải thu ${so.moveo_amount_due}, mong đợi ${amount}`);
    recordData(describeSo(so, 'SO test vừa tạo'));
    return so;
  }

  /** Phiếu thu phát sinh từ SO test được đăng ký vào Test Data Registry khi teardown. */
  protected async discoverChildren(c: CreatedRecord): Promise<ChildRecord[]> {
    if (c.model !== 'sale.order') return [];
    const pays = await this.searchRead<any>('account.payment', [['moveo_sale_order_id', '=', c.id]], ['name']);
    return pays.map((p) => ({ model: 'account.payment', id: p.id, reference: p.name, parent: `sale.order:${c.id}` }));
  }

  /** Số phiếu thu liên kết SO (dùng để chứng minh thao tác đọc/từ chối không tạo phiếu thu). */
  paymentCount(soId: number) {
    return this.count('account.payment', [['moveo_sale_order_id', '=', soId]]);
  }

  paymentsOfSaleOrder(soId: number) {
    return this.searchRead<any>('account.payment', [['moveo_sale_order_id', '=', soId]], [
      'name', 'state', 'payment_type', 'partner_type', 'partner_id', 'company_id', 'currency_id', 'amount', 'memo', 'moveo_sale_order_id',
    ]);
  }
}
