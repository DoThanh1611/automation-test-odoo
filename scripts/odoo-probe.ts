import fs from 'node:fs';
import path from 'node:path';
import { openOdooClient } from '../applications/odoo/session';
import { runProbe } from '../applications/odoo/probe';
import { runUniversalProbe } from '../applications/odoo/probe-universal';
import { loadAdapters } from '../core/adapters/manifest';
import { activeEnvironment } from '../core/environment/active';
import { reportsDirFor } from '../core/environment/paths';
import { pickEnvironment } from './_env';

// Thăm dò Odoo CHỈ ĐỌC trên môi trường đang chọn: phiên bản, API ORM, trường dữ liệu và quyền truy cập mà Factory/cleanup/test cần.
//   npm run odoo:probe [-- --role=accountant]
// Dùng phiên đăng nhập đã xác minh (project setup-odoo, chỉ chạy sau khi phê duyệt + môi trường được xác nhận). KHÔNG tạo/ghi/gọi action.
const key = pickEnvironment()!;
const role = process.argv.find((a) => a.startsWith('--role='))?.slice(7) ?? 'accountant';
const env = activeEnvironment('odoo');
const { client, ctx, uid } = await openOdooClient(undefined, role);
const res = await ctx.post('/web/webclient/version_info', { data: { jsonrpc: '2.0', method: 'call', params: {} } });
const actualVersion = (await res.json()).result?.server_version as string | undefined;
// Mặc định thăm dò không phụ thuộc module (phiên bản, edition, tình trạng từng adapter). Bộ kiểm tra trường riêng của Sales chỉ chạy khi yêu cầu.
const adapters = loadAdapters(process.cwd(), 'odoo').adapters;
const universal = await runUniversalProbe(client, { expectedVersion: env?.expectedVersion, actualVersion, adapters });
const legacy = process.argv.includes('--with-sales-fields') ? await runProbe(client, { expectedVersion: env?.expectedVersion, actualVersion }) : undefined;
const result = legacy
  ? { ...legacy, findings: [...universal.findings, ...legacy.findings.filter((f) => f.area !== 'version')], blockers: universal.blockers + legacy.blockers }
  : { findings: universal.findings, blockers: universal.blockers, thresholdFields: [], optionalPresent: {} };

console.log(`THĂM DÒ ODOO (chỉ đọc) — môi trường ${key}, vai trò ${role}, uid ${uid}`);
for (const f of result.findings) console.log(`  [${f.ok ? 'ĐẠT' : f.severity === 'blocker' ? 'LỖI' : 'CẢNH BÁO'}] ${f.area}: ${f.detail}`);
console.log(result.blockers ? `\nKẾT QUẢ: ${result.blockers} vấn đề CHẶN. Sửa trước khi dùng Test Data Factory trên môi trường này.` : '\nKẾT QUẢ: không có vấn đề chặn (chỉ xác minh trường/quyền; các hành động như action_confirm chỉ chứng minh được khi chạy thật).');
const dir = path.join(reportsDirFor(key), 'probe');
fs.mkdirSync(dir, { recursive: true });
const iso = new Date().toISOString();
const file = path.join(dir, `probe-${iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${iso.slice(20, 23)}.json`);
fs.writeFileSync(file, JSON.stringify({ generatedAt: iso, environment: key, role, uid, actualVersion, profile: universal.profile, adapters: universal.adapters, ...result }, null, 2), { flag: 'wx' });
console.log(`Đã lưu: ${path.relative(process.cwd(), file)}`);
process.exitCode = result.blockers ? 1 : 0;
