import { openOdooClient } from '../applications/odoo/session';
import { listOdooModules } from '../applications/odoo/modules';
import { loadRegistry } from '../core/testdata/registry';
import { pickEnvironment } from './_env';

pickEnvironment(); // sổ dữ liệu test và phiên đăng nhập là của môi trường đang chọn

// Nhận diện dữ liệu AUTOTEST tạo TRƯỚC khi có registry (theo mẫu tham chiếu nghiêm ngặt) và đăng ký với origin=BACKFILL.
// Mỗi module tự khai báo cách nhận diện (backfill). Chỉ ĐỌC Odoo; chỉ ghi file testdata/registry.jsonl cục bộ. Chạy lại an toàn.
//   npm run registry:backfill [-- --module=odoo-sales]
const only = process.argv.find((a) => a.startsWith('--module='))?.slice(9);
for (const mod of listOdooModules().filter((m) => !only || m.key === only)) {
  if (!mod.backfill) {
    console.log(`[${mod.key}] không khai báo backfill: bỏ qua.`);
    continue;
  }
  const { client, baseURL } = await openOdooClient(mod.key);
  const before = loadRegistry().length;
  const r = await mod.backfill(client);
  for (const s of r.skipped) console.log(`  bỏ qua (tham chiếu không đúng mẫu AUTOTEST): ${s}`);
  console.log(`[${mod.key}] Registry: ${before} -> ${loadRegistry().length} bản ghi (tìm thấy ${r.found}, bỏ qua ${r.skipped.length}). Odoo (${new URL(baseURL).host}) không bị thay đổi.`);
}
