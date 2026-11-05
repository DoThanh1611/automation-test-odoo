# Adapter theo module

Mỗi file `adapters/<app>/<module>.adapter.json` là **khai báo** (không phải mã) về cách framework làm việc với một module ứng dụng:
model nào, trường nhãn AUTOTEST, các bước nghiệp vụ có thật trên giao diện (Confirm, Validate, Post...), và cách dọn dữ liệu test.

- Adapter được Claude **tự sinh** từ khám phá chỉ đọc môi trường thật (`fields_get`, form view) khi requirement chạm tới một module chưa có adapter. Người dùng không viết.
- Dùng được cho Community, Enterprise, module bên thứ ba và module tùy chỉnh; không có danh sách module cố định.
- Mỗi adapter ghi phiên bản/edition đã kiểm chứng và dấu vết cấu trúc trường. Môi trường khác phiên bản chính/edition hoặc cấu trúc trường đổi ⇒ `REVERIFY` (khám phá lại trước khi tin). Thiếu module ⇒ `UNAVAILABLE` (test liên quan BLOCKED vì thiếu điều kiện môi trường, không phải lỗi nghiệp vụ).
- Cách dọn không chắc chắn được ghi là `unsupported` ⇒ `CLEANUP_BLOCKED`; framework không đoán.
- `origin: "derived"` là bản tự sinh chưa được người/Claude kiểm chứng trên Odoo thật; đổi thành `curated` sau khi đã chạy thật và xác nhận.

Adapter chứa tên model nội bộ của doanh nghiệp nên **không** được đưa vào bộ cài đặt dùng chung (`npm run package:template`).
