import { inventoryModule } from './inventory/module';
import { purchaseModule } from './purchase/module';
import { salesModule } from './sales/module';
import type { OdooModuleDef } from './types';

/**
 * Đăng ký các module Odoo. Thêm module mới: `npm run new:module -- odoo <tên>` (tự tạo khung và đăng ký ở đây).
 * Lõi dùng chung không biết gì về từng module; mọi thứ riêng nằm trong applications/odoo/modules/<module>/.
 */
export const odooModules: Record<string, OdooModuleDef> = {
  [inventoryModule.key]: inventoryModule,
  [salesModule.key]: salesModule,
  [purchaseModule.key]: purchaseModule,
};

export const listOdooModules = () => Object.values(odooModules);

export function getOdooModule(key: string): OdooModuleDef {
  const m = odooModules[key];
  if (!m) throw new Error(`Module Odoo "${key}" chưa đăng ký trong applications/odoo/modules/index.ts (có: ${Object.keys(odooModules).join(', ')})`);
  return m;
}
