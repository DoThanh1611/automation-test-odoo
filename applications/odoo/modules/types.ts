import type { CleanupHandler } from '../../../core/testdata/cleanup';
import type { OwnershipRule } from '../../../core/testdata/write-guard';
import type { OdooClient } from '../client';

/**
 * Khai báo của MỘT module Odoo (Sales, Purchase, Inventory, Accounting...). Mọi thứ riêng của module nằm trong
 * applications/odoo/modules/<module>/ và được đăng ký ở applications/odoo/modules/index.ts.
 * Lõi dùng chung (client RPC, write guard, registry, báo cáo) chỉ làm việc thông qua khai báo này.
 */
export interface OdooModuleDef {
  /** Khoá đầy đủ, khớp tên thư mục test: odoo-sales. */
  key: string;
  application: 'odoo';
  /** Tên module ngắn: sales. */
  module: string;
  title: string;
  /** File fixture: testdata/fixtures/<fixturesKey>.json. */
  fixturesKey: string;
  /** Model mà module được phép TẠO và GHI trong test, kèm trường dán nhãn AUTOTEST. Rỗng = module chỉ đọc. */
  ownership: OwnershipRule[];
  /** Quy trình cleanup theo từng loại chứng từ. Loại chưa có quy trình an toàn phải khai báo là chưa hỗ trợ. */
  cleanup: CleanupHandler<OdooClient>[];
  /** Nhận diện dữ liệu AUTOTEST tạo trước khi có registry. Chỉ đọc Odoo, chỉ ghi registry cục bộ. */
  backfill?: (client: OdooClient) => Promise<{ found: number; registered: number; skipped: string[] }>;
  /** Danh sách trường cần chụp baseline để phát hiện trường mới. */
  fieldBaseline?: { models: string[]; file: string };
}
