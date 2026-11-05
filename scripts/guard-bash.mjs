// Hook PreToolUse cho công cụ Bash/PowerShell của Claude Code: chặn các lệnh cố vượt Approval Gate bằng cách gọi thẳng API
// của giao diện review, hoặc gọi hàm phê duyệt/ghi trạng thái từ script tạm. Chạy bằng node thuần (nhanh, không cần tsx).
// Đây là lớp phụ trợ: lớp chính nằm ở backend (nonce, hộp thoại hệ điều hành, chữ ký HMAC). Lỗi đọc dữ liệu => cho qua (không chặn nhầm mọi lệnh).
import fs from 'node:fs';

const RULES = [
  [/\/review\/[0-9a-f]{16,}\/(decision|state)/i, 'gọi trực tiếp API của giao diện review'],
  [/(127\.0\.0\.1|localhost):\d+\/review\//i, 'truy cập trực tiếp giao diện review bằng dòng lệnh (người dùng phải mở bằng trình duyệt)'],
  [/\/env\/[0-9a-f]{16,}\/(decision|state)/i, 'gọi trực tiếp API của giao diện chọn môi trường'],
  [/(127\.0\.0\.1|localhost):\d+\/env\//i, 'truy cập trực tiếp giao diện chọn môi trường bằng dòng lệnh (người dùng phải mở bằng trình duyệt)'],
  [/\b(import|require)\b[^\n]{0,160}(environment\/(state|web)|policy\/policy)[^\n]{0,400}\b(confirmExecution|selectEnvironment|confirmPolicy|processEnvDecision)\s*\(/i, 'import hàm chọn/xác nhận môi trường hoặc chính sách ghi để tự xác nhận'],
  [/\b(import|require)\b[^\n]{0,120}approval\/(approval|web|server)[^\n]{0,400}\b(approve|processDecision)\s*\(/i, 'import hàm phê duyệt để tự APPROVE'],
  [/\.qa-state[\\/]+(execution|environment|policy)\.json/i, 'ghi/sửa trạng thái phiên thực thi, môi trường hoặc chính sách ghi'],
  [/QA_APPROVAL_GATE\s*=|QA_ENV\s*=\s*\S/i, 'đặt biến môi trường vượt cổng (QA_APPROVAL_GATE/QA_ENV)'],
  [/\.qa-framework[\\/]+approval\.key/i, 'truy cập khóa chữ ký phê duyệt'],
];

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '') || '{}');
  const command = String(input.tool_input?.command ?? '');
  for (const [re, why] of RULES) {
    if (re.test(command)) {
      console.error(`APPROVAL GATE: chặn lệnh vì ${why}. APPROVE/xác nhận môi trường phải do người dùng tự thực hiện (giao diện web hoặc terminal của họ).`);
      process.exit(2);
    }
  }
} catch {
  /* không đọc được: cho qua */
}
process.exit(0);
