/**
 * Quy ước CHUNG cho mọi ứng dụng/module: dữ liệu do automation tạo luôn mang tham chiếu "AUTOTEST <runId> <TestCaseId>".
 * Cleanup, registry backfill và write guard đều nhận diện dữ liệu test dựa vào quy ước này.
 */
export const AUTOTEST_PREFIX = 'AUTOTEST';

/** Nhóm 1 = runId (có thể vắng với dữ liệu tạo trước khi có runId), nhóm 2 = Test Case ID. */
export const AUTOTEST_REF_PATTERN = /^AUTOTEST(?: (\d{8}-\d{6}|\d{12}))? (TC-[A-Z0-9-]+)$/;

export const autotestRef = (runId: string, testCaseId: string) => `${AUTOTEST_PREFIX} ${runId} ${testCaseId}`;
