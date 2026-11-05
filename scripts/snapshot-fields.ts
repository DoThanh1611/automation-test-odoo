import fs from 'node:fs';
import path from 'node:path';
import { openOdooClient } from '../applications/odoo/session';
import { getOdooModule } from '../applications/odoo/modules';
import { readFieldSnapshot } from '../applications/odoo/field-baseline';
import { pickEnvironment } from './_env';

const envKey = pickEnvironment()!;

// Chụp danh sách trường (kèm module định nghĩa) làm BASELINE để phát hiện trường mới về sau. Mỗi module khai báo model cần chụp.
// CHỈ ĐỌC Odoo; ghi file baseline của module. Baseline này là ảnh chụp tại thời điểm chạy lệnh,
// KHÔNG chứng minh được rằng một requirement không thêm trường mới (cần baseline TRƯỚC triển khai).
//   npm run baseline:fields [-- --module=odoo-sales] [--overwrite]
const key = process.argv.find((a) => a.startsWith('--module='))?.slice(9) ?? 'odoo-sales';
const mod = getOdooModule(key);
if (!mod.fieldBaseline) {
  console.error(`Module ${key} chưa khai báo fieldBaseline.`);
  process.exit(1);
}
const { client, baseURL } = await openOdooClient(key);
const snapshot = await readFieldSnapshot(client, mod.fieldBaseline.models);
const out = {
  capturedAt: new Date().toISOString(),
  environment: baseURL,
  environmentKey: envKey,
  kind: 'POST-IMPLEMENTATION snapshot',
  warning: 'Đây là ảnh chụp SAU triển khai. Không dùng làm bằng chứng cho BR-10/AC-10; chỉ dùng để phát hiện thay đổi trường từ thời điểm này trở đi.',
  models: snapshot,
};
const file = mod.fieldBaseline.file;
if (fs.existsSync(file) && !process.argv.includes('--overwrite')) {
  console.error(`${file} đã tồn tại. Dùng --overwrite nếu muốn chụp lại (baseline cũ sẽ bị thay).`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`Đã lưu ${file}: ` + mod.fieldBaseline.models.map((m) => `${m}=${snapshot[m].length} trường`).join(', '));
