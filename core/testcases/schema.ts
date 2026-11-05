export type Verification = 'UI' | 'BACKEND';
export type TcStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NEEDS CLARIFICATION' | 'NOT RUN';

/** Ghi chú nghiệp vụ do người dùng/BA xác nhận sau này. KHÔNG thay thế BR/AC gốc. */
export interface RequirementNote {
  id: string;
  date: string;
  source: string;
  text: string;
  /** BR/AC và Test Case mà ghi chú này làm rõ. */
  affects: string[];
}

export interface Requirement {
  id: string;
  title: string;
  application: string;
  module: string;
  path?: string;
  businessRequirement: string;
  /** Giải pháp mong đợi do người dùng cung cấp (tuỳ chọn, lưu nguyên văn). */
  expectedSolution?: string;
  businessRules: { id: string; text: string }[];
  acceptanceCriteria: { id: string; text: string }[];
  notes?: RequirementNote[];
}

/** Định nghĩa tĩnh của test case. Actual/Status/Evidence là kết quả chạy -> nằm trong reports/, không sửa file này. */
export interface TestCaseDef {
  id: string;
  title: string;
  requirementRefs: string[]; // BR-xx / AC-xx
  description: string;
  preconditions: string[];
  testData: Record<string, unknown>;
  steps: string[];
  expectedResult: string;
  verification: Verification;
  /** Có script tự động tương ứng trong tests/ hay không. */
  automated: boolean;
  /** Điền khi expected result chưa xác định đủ trong requirement. */
  needsClarification?: string;
  /**
   * Chỉ dùng khi AC có từ "lần lượt/từng/mỗi" nhưng THỰC SỰ chỉ là một trường hợp (ví dụ "từng SO" chỉ nói về phạm vi).
   * Phải nêu lý do; nếu không, AC nhiều trường hợp độc lập bắt buộc có từ 2 test case trở lên (mỗi trường hợp một TC-ID riêng).
   */
  singleCaseReason?: string;
  /** Gắn tự động khi nạp từ bộ test case + requirement (không lưu trong file, không tính vào hash nội dung kiểm thử). */
  requirementId?: string;
  application?: string;
  module?: string;
}

export interface TestCaseSuite {
  requirementId: string;
  /** Requirement liên quan nhiều module: bộ test case của module khác khai báo module/application của chính nó (mặc định lấy theo requirement). */
  application?: string;
  module?: string;
  /** Giải thích biến/thuật ngữ xuất hiện trong test case (key = đúng chữ trong steps/testData). Reporter tự chú thích. */
  glossary?: Record<string, string>;
  testCases: TestCaseDef[];
}
