import crypto from 'node:crypto';
import type { TestCaseDef } from './schema';

/**
 * Băm các trường quyết định NỘI DUNG KIỂM THỬ (không gồm mô tả/ghi chú). Kết quả chạy lưu kèm hash này;
 * nếu định nghĩa test case đổi sau đó, kết quả cũ bị đánh dấu "không còn áp dụng" thay vì được giữ nguyên PASS.
 */
export const defHash = (d: TestCaseDef): string =>
  crypto.createHash('sha1').update(JSON.stringify([d.requirementRefs, d.preconditions, d.testData, d.steps, d.expectedResult])).digest('hex').slice(0, 12);
