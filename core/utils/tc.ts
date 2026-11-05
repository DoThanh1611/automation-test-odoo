import { test, type TestInfo } from '@playwright/test';

/** Gắn test với Test Case ID để reporter truy vết. Dùng trong tests/: test(`${tcTitle(tc)}`, tcMeta(tc.id), ...) */
export const tcMeta = (id: string) => ({ annotation: [{ type: 'tc', description: id }] });

/** Ghi nhận Actual Result thực tế quan sát được (không bao giờ điền giả). */
export function recordActual(text: string, info: TestInfo = test.info()) {
  info.annotations.push({ type: 'actual', description: text });
}

/** Tóm tắt kết quả thực tế bằng ngôn ngữ nghiệp vụ (1-2 câu, nêu khác biệt với mong đợi nếu có). Hiển thị ở mục chính của báo cáo. */
export function recordSummary(text: string, info: TestInfo = test.info()) {
  info.annotations.push({ type: 'summary', description: text });
}

/** Chi tiết kỹ thuật (mã bản ghi, giá trị đọc từ hệ thống...) đi vào mục thu gọn "Chi tiết kỹ thuật"; không làm dài phần mô tả chính. */
export function recordTechnical(text: string, info: TestInfo = test.info()) {
  info.annotations.push({ type: 'technical', description: text });
}

/** Nguyên nhân BLOCKED có cấu trúc (không suy ra từ từ khóa): ENVIRONMENT = môi trường/phiên/phiên bản; PERMISSION = thiếu quyền hoặc tài khoản vai trò; DATA = không có/không dựng được dữ liệu; APPROVAL = chưa được phê duyệt. */
export type BlockedKind = 'ENVIRONMENT' | 'PERMISSION' | 'DATA' | 'APPROVAL';

/** Không đủ điều kiện chạy (thiếu môi trường/quyền/dữ liệu) -> BLOCKED, không phải PASS/FAIL. Nên truyền `kind` để báo cáo phân loại chính xác. */
export function block(reason: string, kind?: BlockedKind, info: TestInfo = test.info()) {
  info.annotations.push({ type: 'blocked', description: reason });
  if (kind) info.annotations.push({ type: 'blocked-kind', description: kind });
  test.skip(true, `BLOCKED: ${reason}`);
}

/**
 * Test đã chạy xong phần kiểm chứng được nhưng CÒN điều kiện chưa xác minh (thiếu baseline, cần thao tác ghi bị cấm...).
 * Không skip test: video/evidence vẫn có. Test case được báo NEEDS CLARIFICATION, không bao giờ PASS (trừ khi có assertion FAIL).
 */
export function markNeedsClarification(unverified: string, info: TestInfo = test.info()) {
  info.annotations.push({ type: 'needs-clarification', description: unverified });
}

/** Nghiệp vụ chưa rõ -> NEEDS CLARIFICATION. */
export function needsClarification(question: string, info: TestInfo = test.info()) {
  info.annotations.push({ type: 'needs-clarification', description: question });
  test.skip(true, `NEEDS CLARIFICATION: ${question}`);
}

/** Test case ID gắn qua tcMeta (dùng để đăng ký dữ liệu test theo đúng test case). */
export function currentTcId(info: TestInfo = test.info()): string {
  return info.annotations.find((a) => a.type === 'tc')?.description ?? 'UNKNOWN';
}

/** Ghi dữ liệu thực tế đã dùng khi chạy (ví dụ SO nào) để hiển thị trong report. */
export function recordData(data: Record<string, unknown>, info: TestInfo = test.info()) {
  info.annotations.push({ type: "data", description: JSON.stringify(data) });
}
