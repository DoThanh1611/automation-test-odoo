# Fixture ghim bản ghi nghiệp vụ

Thư mục này chứa các file `<app>-<module>.json` (hoặc `<ENV>/<app>-<module>.json`) ghim các bản ghi có sẵn trong môi trường kiểm thử, **chỉ để đọc**.
File thật chứa host và tên chứng từ thật nên **bị `.gitignore`** (không lên GitHub, không vào bộ cài đặt dùng chung). Chỉ file `*.example.json` (dữ liệu giả) được theo dõi.

Máy mới: không có fixture thì các test cần bản ghi ghim báo BLOCKED kèm lý do (đúng thiết kế), các test còn lại vẫn chạy. Muốn dùng: sao chép `example/testdata/fixtures/odoo-sales.example.json` vào thư mục này rồi ghim bản ghi thật của bạn.
