import path from 'node:path';
import { readState } from '../core/environment/state';

/**
 * Môi trường cho các script phụ (cleanup:plan, registry:backfill, baseline:fields, report:*): lấy từ --env=<TÊN> hoặc môi trường đang chọn
 * (npm run qa:env -- select). Nếu --env khác môi trường đang chọn thì từ chối (không tự chuyển môi trường). Đặt QA_ENV cho phần còn lại của tiến trình.
 */
export function pickEnvironment(argv = process.argv.slice(2), required = true): string | undefined {
  const arg = argv.find((a) => a.startsWith('--env='))?.slice(6);
  const selected = readState(process.cwd()).selected?.environment;
  if (arg && selected && arg !== selected) {
    console.error(`Bạn yêu cầu --env=${arg} nhưng môi trường đang chọn là ${selected}. Không tự chuyển: chạy npm run qa:env -- select --env=${arg} trước.`);
    process.exit(3);
  }
  const key = arg ?? selected;
  if (!key && required) {
    console.error('Chưa chọn môi trường. Chạy: npm run qa:env -- select --env=<TÊN> (xem danh sách: npm run qa:env -- list).');
    process.exit(3);
  }
  if (key) process.env.QA_ENV = key;
  return key;
}

/** Thư mục báo cáo của môi trường (reports/<ENV>); không có môi trường thì thư mục cũ reports/ (dữ liệu trước khi có nhiều môi trường). */
export function reportsFor(key: string | undefined): string {
  return path.resolve('reports', ...(key ? [key] : []));
}
