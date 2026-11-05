import type { TcStatus, TestCaseDef } from '../testcases/schema';

export interface RoleInfo {
  role: string;
  description?: string;
  /** true = tài khoản có quyền quản trị; undefined = chưa kiểm tra được. */
  privileged?: boolean;
  detail?: string;
}

export interface Evidence {
  video?: string;
  screenshots: string[];
  trace?: string;
}

/** Kết quả 1 test case trong 1 lần chạy. Đường dẫn evidence TƯƠNG ĐỐI so với thư mục của lần chạy. */
export interface TcRunEntry {
  tcId: string;
  /** Băm nội dung kiểm thử tại thời điểm chạy (xem core/testcases/hash.ts). */
  defHash: string;
  status: TcStatus;
  actual: string;
  /** Lý do cho BLOCKED / NEEDS CLARIFICATION. */
  reason?: string;
  durationMs: number;
  data?: Record<string, unknown>;
  role?: RoleInfo;
  error?: { message: string; failedStep?: string };
  /** Tóm tắt nghiệp vụ do test ghi (recordSummary) và ghi chú kỹ thuật (recordTechnical). */
  summary?: string;
  technical?: string[];
  /** Nguyên nhân BLOCKED có cấu trúc (xem core/utils/tc.ts). */
  blockedKind?: 'ENVIRONMENT' | 'PERMISSION' | 'DATA' | 'APPROVAL';
  evidence: Evidence;
}

/** Nội dung reports/runs/<runId>/results.json */
export interface RunFile {
  runId: string;
  startedAt: string;
  finishedAt: string;
  baseURL?: string;
  /** Khoá môi trường của lần chạy (ví dụ STAGING_A). Lần chạy cũ (trước khi có nhiều môi trường) không có giá trị này. */
  environment?: string;
  /** Lần chạy này có bật ALLOW_WRITE_TESTS hay không (cho phép test ghi dữ liệu). */
  writesEnabled?: boolean;
  entries: TcRunEntry[];
}

/** Kết quả hiển thị trong báo cáo tổng hợp. Đường dẫn evidence TƯƠNG ĐỐI so với thư mục reports/. */
export interface TcResult {
  def: TestCaseDef;
  status: TcStatus;
  actual: string;
  reason?: string;
  durationMs: number;
  data?: Record<string, unknown>;
  role?: RoleInfo;
  error?: { message: string; failedStep?: string };
  summary?: string;
  technical?: string[];
  blockedKind?: 'ENVIRONMENT' | 'PERMISSION' | 'DATA' | 'APPROVAL';
  /** RUN = do chính test ghi (recordSummary); HISTORICAL = viết lại từ dữ liệu đã lưu (reports/<ENV>/summaries/), kèm căn cứ. */
  summarySource?: 'RUN' | 'HISTORICAL';
  summaryBasis?: string[];
  evidence: Evidence;
  /** Lần chạy cho ra kết quả này; undefined nếu test case chưa từng chạy. */
  runId?: string;
  executedAt?: string;
  /** Định nghĩa test case đã đổi sau lần chạy gần nhất nên kết quả cũ không còn áp dụng (status = NOT RUN). */
  /** Có lần chạy CHỈ ĐỌC mới hơn đã bỏ qua test ghi này (BLOCKED vì chưa cấp quyền ghi) nên không đè lên kết quả hiển thị. */
  readOnlySkip?: { runId: string; executedAt: string };
  stale?: { runId: string; status: TcStatus; executedAt: string };
}

export interface Summary {
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  needsClarification: number;
  notRun: number;
  /** Số test case đã thực sự chạy ra kết luận = passed + failed. */
  executed: number;
  /** passed / executed (%). Không tính test BLOCKED/NEEDS CLARIFICATION/NOT RUN. null nếu chưa test nào chạy. */
  executionPassRate: number | null;
  /** passed / total (%). Phản ánh mức độ requirement đã được chứng minh đạt. */
  overallPassCoverage: number | null;
}
