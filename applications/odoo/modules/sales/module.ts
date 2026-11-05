import type { OdooModuleDef } from '../types';
import { salesBackfill } from './backfill';
import { salesCleanup } from './cleanup';
import { FIELD_BASELINE_FILE, FIELD_MODELS } from './fields-baseline';

/** Khai báo module Sales. Chỉ module này được tạo/ghi sale.order trong test; quy trình cleanup riêng cho SO và phiếu thu. */
export const salesModule: OdooModuleDef = {
  key: 'odoo-sales',
  application: 'odoo',
  module: 'sales',
  title: 'Bán hàng (Sales)',
  fixturesKey: 'odoo-sales',
  ownership: [{ model: 'sale.order', refField: 'client_order_ref', creatorField: 'create_uid' }],
  cleanup: [salesCleanup],
  backfill: salesBackfill,
  fieldBaseline: { models: [...FIELD_MODELS], file: FIELD_BASELINE_FILE },
};
