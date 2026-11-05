# Mẫu test case

Test case do Claude sinh từ BR/AC đã import (không tự thêm BR/AC). Lưu thành `testcases/<app>-<module>/<REQ-ID>.testcases.json`
(`npm run req:import` tạo sẵn file rỗng). Chỉ file `*.json` trong thư mục này được nạp; file này là tài liệu nên không bị nạp.

```json
{
  "requirementId": "REQ-XXX",
  "glossary": { "tên_biến_trong_steps": "ý nghĩa bằng tiếng Việt, báo cáo sẽ tự chú thích" },
  "testCases": [
    {
      "id": "TC-XXX-001",
      "title": "Tên ngắn gọn của kịch bản",
      "requirementRefs": ["BR-01", "AC-01"],
      "description": "Kịch bản kiểm tra điều gì.",
      "preconditions": ["Đăng nhập bằng role ...", "Có bản ghi ... (khai báo trong testdata/fixtures/<app>-<module>.json)"],
      "testData": { "role": "accountant", "record": "khoá fixture" },
      "steps": ["Bước 1", "Bước 2"],
      "expectedResult": "Kết quả mong đợi, bám sát BR/AC gốc.",
      "verification": "UI",
      "automated": false
    }
  ]
}
```

Quy tắc:

- `requirementRefs` chỉ trỏ tới BR/AC có thật trong requirement; mỗi BR/AC phải có ít nhất một test case (`npm run req:check`).
- AC/BR có nhiều trường hợp độc lập ("lần lượt", "từng", "mỗi"; ví dụ "lần lượt để thiếu từng thông tin") cần MỖI trường hợp một test case riêng (TC-ID riêng, cùng `requirementRefs`). Spec được tham số hóa bằng vòng lặp nhưng mỗi trường hợp phải có `tcMeta('TC-...')` riêng. `req:check` báo lỗi nếu chỉ có 1 test case; chỉ khi thực sự là một kịch bản mới dùng `"singleCaseReason": "lý do"`.
- `verification`: `UI` (kiểm tra qua giao diện) hoặc `BACKEND` (kiểm tra dữ liệu qua API).
- `automated: true` chỉ khi đã có spec tương ứng trong `tests/<app>-<module>/`.
- Chưa rõ kết quả mong đợi: điền `needsClarification` (trạng thái NEEDS CLARIFICATION), không đoán.
- Sửa nội dung kiểm thử (steps, expectedResult, ...) làm kết quả cũ thành NOT RUN cho tới khi chạy lại.
- Không bao giờ sửa Expected để khớp Actual.
