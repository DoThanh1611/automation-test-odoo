import type { Condition } from '../../../../core/testdata/fixtures';

/**
 * Định dạng điều kiện RIÊNG của module Sales trong testdata/fixtures/odoo-sales.json (mục saleOrders[*].expect).
 * Được dịch sang Condition chung để lõi kiểm tra; module khác có thể dùng thẳng "conditions" chung.
 */
export interface SalesExpect {
  state?: string;
  paymentStatus?: string;
  paymentStatusNot?: string;
  dueGt?: number;
  dueLte?: number;
}

export function expectToConditions(e: SalesExpect = {}): Condition[] {
  const c: Condition[] = [];
  if (e.state !== undefined) c.push({ field: 'state', op: 'eq', value: e.state });
  if (e.paymentStatus !== undefined) c.push({ field: 'moveo_payment_status', op: 'eq', value: e.paymentStatus });
  if (e.paymentStatusNot !== undefined) c.push({ field: 'moveo_payment_status', op: 'ne', value: e.paymentStatusNot });
  if (e.dueGt !== undefined) c.push({ field: 'moveo_amount_due', op: 'gt', value: e.dueGt });
  if (e.dueLte !== undefined) c.push({ field: 'moveo_amount_due', op: 'lte', value: e.dueLte });
  return c;
}
