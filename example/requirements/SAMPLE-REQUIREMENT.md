**[NEW REQUIREMENT] Mẫu: Hiển thị nút "Duyệt" trên phiếu đề nghị**

Path: Ứng dụng mẫu → Phiếu đề nghị → Chi tiết phiếu

**Business Requirement**

Người duyệt cần thấy nút "Duyệt" trên phiếu đề nghị để xử lý phiếu đang chờ duyệt.

**Expected Solution**

Thêm nút "Duyệt" vào màn hình chi tiết phiếu đề nghị, chỉ hiển thị khi phiếu đúng điều kiện.

**Business Rules**

- BR-01: Nút "Duyệt" chỉ hiển thị khi phiếu ở trạng thái "Chờ duyệt".
- BR-02: Chỉ người dùng thuộc nhóm "Người duyệt" mới thấy nút "Duyệt".

**Acceptance Criteria**

- AC-01: Phiếu ở trạng thái "Chờ duyệt", người dùng thuộc nhóm "Người duyệt": thấy nút "Duyệt".
- AC-02: Phiếu ở trạng thái "Nháp": không thấy nút "Duyệt".
- AC-03: Người dùng không thuộc nhóm "Người duyệt": không thấy nút "Duyệt" ở bất kỳ trạng thái nào.

<!--
Đây là requirement MẪU, toàn bộ nội dung là giả, không gắn với hệ thống thật. Dùng để chạy thử quy trình:
  /qa-requirement example/requirements/SAMPLE-REQUIREMENT.md
Khi chưa có môi trường kiểm thử, Claude vẫn nhập requirement và sinh test case; test sẽ ở trạng thái BLOCKED/NOT RUN, không có PASS.
-->
