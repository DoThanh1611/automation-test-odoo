import fs from 'node:fs';
import { listRequirementFiles, lockFileFor, writeLock } from '../core/testcases/lock';

// Tạo khoá cho requirement CHƯA có khoá. Không ghi đè khoá cũ (trừ khi --force, dùng khi BR/AC được thay đổi CÓ CHỦ ĐÍCH bởi BA).
const force = process.argv.includes('--force');
for (const f of listRequirementFiles()) {
  if (fs.existsSync(lockFileFor(f)) && !force) { console.log(`giữ nguyên khoá: ${lockFileFor(f)}`); continue; }
  writeLock(f);
  console.log(`đã khoá: ${lockFileFor(f)}`);
}
