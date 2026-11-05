/** Định dạng bắt buộc của runId: YYYYMMDD-HHmmss. Cleanup/registry nhận diện dữ liệu test dựa vào định dạng này. */
export const RUN_ID_PATTERN = /^\d{8}-\d{6}$/;

/**
 * Mã lần chạy (runId) dùng chung cho cả tiến trình chính, worker, reporter và dữ liệu test.
 * Được sinh MỘT lần (khi playwright.config.ts nạp) và truyền cho worker qua biến môi trường QA_RUN_ID.
 * Có thể đặt tay (phải đúng định dạng): QA_RUN_ID=20261103-090000 npx playwright test ...
 */
export function getRunId(): string {
  if (!process.env.QA_RUN_ID) {
    const d = new Date().toISOString(); // 2026-11-02T17:59:37.130Z -> 20261102-175937
    process.env.QA_RUN_ID = `${d.slice(0, 10).replace(/-/g, '')}-${d.slice(11, 19).replace(/:/g, '')}`;
  }
  if (!RUN_ID_PATTERN.test(process.env.QA_RUN_ID)) {
    throw new Error(`QA_RUN_ID="${process.env.QA_RUN_ID}" không đúng định dạng YYYYMMDD-HHmmss (cần để cleanup nhận diện dữ liệu test)`);
  }
  return process.env.QA_RUN_ID;
}

export const RUNS_DIR = 'reports/runs';
