import '../core/config/env'; // nạp .env nếu đã có
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { getApp, listApps } from '../applications';
import { runSetup } from '../core/workflow/setup';

// Thiết lập lần đầu / kiểm tra cài đặt. OFFLINE, không kết nối staging, không in giá trị bí mật.
//   npm run setup [-- --init]     # --init: tạo .env từ .env.example nếu chưa có (không bao giờ ghi đè)
const apps = Object.fromEntries(listApps().map((a) => [a, Object.keys(getApp(a).roles)]));
let browserInstalled: boolean | undefined;
try {
  browserInstalled = fs.existsSync(chromium.executablePath());
} catch {
  browserInstalled = false;
}
const r = runSetup({ root: process.cwd(), apps, init: process.argv.includes('--init'), browserInstalled });

console.log('\nKIỂM TRA CÀI ĐẶT QA AUTOMATION FRAMEWORK');
for (const c of r.checks) console.log(`  [${c.ok ? 'ĐẠT' : c.level === 'blocker' ? 'LỖI' : c.level === 'warn' ? 'CẢNH BÁO' : 'CHƯA'}] ${c.name}: ${c.detail}`);
for (const f of r.created) console.log(`\nĐã tạo ${f} (không ghi đè file có sẵn).`);
const blockers = r.checks.filter((c) => !c.ok && c.level === 'blocker');
console.log(blockers.length ? `\nKẾT QUẢ: còn ${blockers.length} việc chặn quy trình.` : '\nKẾT QUẢ: sẵn sàng.');
console.log(`\nViệc người dùng cần làm (một lần):\n${r.userSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
process.exitCode = blockers.length ? 1 : 0;
