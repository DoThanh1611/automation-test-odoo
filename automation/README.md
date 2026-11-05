# Metadata thực thi (automation)

Mỗi requirement có một file `automation/<ứng dụng>-<module>/<REQ-ID>.automation.json` khai báo CÁCH CHẠY từng test case. File này **tách khỏi nội dung test case đã duyệt** (`testcases/`): sửa hoặc bổ sung nó khi viết Page Object/automation spec **không** làm đổi hash hay mất phê duyệt.

```json
{
  "requirementId": "REQ-XXX-001",
  "testCases": {
    "TC-XXX-001": { "access": "READ",  "role": "accountant", "dataStrategy": "EXISTING_READONLY", "cleanup": "NONE" },
    "TC-XXX-002": { "access": "WRITE", "role": "accountant", "dataStrategy": "FACTORY",           "cleanup": "REGISTRY" }
  }
}
```

| Trường | Giá trị |
|---|---|
| `access` | `READ` (chỉ đọc) hoặc `WRITE` (tạo/sửa dữ liệu) |
| `role` | khóa vai trò trong cấu hình ứng dụng (bỏ trống = vai trò mặc định) |
| `dataStrategy` | `NONE`, `EXISTING_READONLY` (cho READ); `FACTORY`, `SELF_CREATED`, `EXISTING_WRITE` (cho WRITE) |
| `cleanup` | `NONE` (bắt buộc với READ); `REGISTRY` hoặc `MANUAL` (bắt buộc với WRITE) |

## Quy tắc an toàn

- **Chưa khai báo hoặc khai báo sai ⇒ coi là WRITE** và bị chặn nếu chưa có giấy phép ghi + chính sách ghi đã xác nhận. Không có chuyện "chưa biết nên cho chạy".
- Test khai báo `READ` mà gọi `writeGuard()` hoặc Test Data Factory sẽ lỗi ngay (khai báo sai, không bỏ qua cổng ghi).
- Approval Gate, Environment Gate, Write Policy, chữ ký HMAC và audit log không đổi; metadata chỉ quyết định test nào được coi là có ghi.
- Kiểm tra: framework test `AM-1`/`AM-2` (cú pháp, đồng bộ với test case, test có automation phải có khai báo).
