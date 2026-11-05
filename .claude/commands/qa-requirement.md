---
description: QA có Approval Gate bắt buộc. Giai đoạn 1: nhập requirement, sinh test case, trình duyệt (DỪNG). Giai đoạn 2 (chỉ sau khi người dùng APPROVE): khám phá UI, automation, chạy, bug, báo cáo
argument-hint: <file requirement .md> [<app> <module>] | <REQ-ID> | <REQ-ID> APPROVE|REVISE <nhận xét>|REJECT <lý do> (hoặc để trống rồi dán requirement 5 mục)
---

Thực hiện quy trình QA cho: **$ARGUMENTS**

Người dùng có thể KHÔNG biết viết prompt: chỉ cần chạy lệnh này và dán requirement. Bạn tự thực hiện đúng quy trình dưới đây, trả lời bằng tiếng Việt, ngắn gọn. Đọc `FRAMEWORK.md` trước. Làm TUẦN TỰ, kiểm tra từng bước, chỉ dừng hỏi ở các điểm ghi "DỪNG".

Quy trình có **hai giai đoạn ngăn cách bằng Approval Gate do CODE kiểm soát** (`scripts/approval.ts`, `core/approval/`, hook trong `.claude/settings.json`, cổng trong `scripts/run-tests.ts`). Bạn không có cách nào hợp lệ để vượt cổng; đừng thử.

## Luật bất di bất dịch
1. KHÔNG sửa nội dung/ý nghĩa BR/AC, KHÔNG thêm BR/AC. Làm rõ nghiệp vụ chỉ được ghi vào `notes` của requirement, kèm nguồn.
2. KHÔNG chỉnh Expected cho khớp hành vi thực tế. Khác Expected ⇒ FAIL (bug).
3. Chưa rõ ⇒ NEEDS CLARIFICATION. Thiếu tài khoản/dữ liệu/quyền/môi trường ⇒ BLOCKED (kèm lý do). Không bao giờ tự đổi hai trạng thái này thành PASS. Test chưa chạy là NOT RUN, không phải PASS.
4. PASS chỉ khi có bằng chứng thực tế VÀ assertion kiểm chứng đúng Expected (script chạy xong chưa đủ). Phần chưa kiểm chứng ⇒ `markNeedsClarification(...)`.
5. KHÔNG đoán locator, dữ liệu hay hành vi nghiệp vụ. Locator chỉ lấy từ khám phá giao diện thật; dữ liệu chỉ lấy từ fixture do người dùng chỉ định.
6. Mặc định CHỈ ĐỌC. KHÔNG tạo/sửa/hủy/xóa chứng từ, KHÔNG đổi cấu hình/phân quyền/mật khẩu, KHÔNG sửa `.env`. **Ngoại lệ DUY NHẤT:** khi người dùng đã xác nhận chính sách ghi của môi trường (`qa:policy confirm`, hợp lệ theo `qa:policy status`), bạn được TỰ chạy `npm run test:write` và `npm run cleanup:run` để tạo/sửa/cleanup dữ liệu DO FRAMEWORK TẠO (có trong registry) mà không hỏi từng thao tác. Mọi việc khác ngoài phạm vi đó (dữ liệu nghiệp vụ có sẵn, cấu hình, phân quyền, mật khẩu, xóa cứng, chứng từ ràng buộc kế toán) vẫn: DỪNG và hỏi.
7. KHÔNG xóa/sửa requirement, test case, báo cáo, video, evidence hiện có. Không in mật khẩu/cookie ra màn hình.
8. **Approval Gate:** KHÔNG tự APPROVE (cũng không giả lập, không sửa tay `approvals/**`, không tạo/đọc khóa trong `~/.qa-framework`, không viết script gọi thẳng thư viện duyệt). KHÔNG đặt `QA_APPROVAL_GATE`. KHÔNG kết nối staging, KHÔNG gọi công cụ `mcp__playwright__*`, KHÔNG chạy `npm test`/automation trước khi `qa:approval status` báo `APPROVED` hợp lệ.
9. **APPROVE không phải quyền ghi.** Ba xác nhận độc lập của người dùng: (1) APPROVE test case, (2) xác nhận môi trường, (3) xác nhận chính sách ghi của môi trường một lần cho phiên. (2) và (3) người dùng bấm trên GIAO DIỆN WEB `npm run qa:env-web` (mỗi nút một hộp thoại hệ điều hành riêng); lệnh terminal `qa:env confirm` / `qa:policy confirm` chỉ là phương án dự phòng. Không cái nào suy ra cái nào. Chưa có (3) thì mọi thao tác ghi bị chặn; production KHÔNG BAO GIỜ có quyền ghi tự động (code ép, kể cả cấu hình sai).
10. Mọi con số báo cáo lấy từ `reports/<MÔI_TRƯỜNG>/qa-summary.md`, mọi trạng thái phê duyệt lấy từ `npm run qa:approval -- status`; không tự đếm, không tự suy đoán.
11. **Môi trường:** KHÔNG chọn môi trường thay người dùng (phải HỎI), KHÔNG tự xác nhận (giao diện web `qa:env-web` cần người dùng bấm nút và bấm Yes trên hộp thoại hệ điều hành; terminal `qa:env confirm` cần bàn phím thật). KHÔNG gọi API của giao diện bằng curl/script, KHÔNG import hàm chọn/xác nhận (hook chặn), KHÔNG sửa `.env`/`environments/*.json`/`.qa-state/**`, KHÔNG đặt `QA_ENV`. KHÔNG tự chuyển sang môi trường khác khi đăng nhập lỗi, thiếu tài khoản, thiếu dữ liệu hoặc sai phiên bản: báo BLOCKED kèm lý do và DỪNG hỏi. Mỗi kết quả/evidence/bug thuộc đúng một môi trường; không cộng gộp số liệu giữa các môi trường.
12. **Phê duyệt dùng chung, quyền thực thi và quyền ghi thì không.** APPROVE áp dụng cho mọi môi trường nếu nội dung test case không đổi, nhưng mỗi môi trường cần xác nhận thực thi riêng (nút "Xác nhận môi trường" trên `qa:env-web`) và, nếu ghi dữ liệu, xác nhận quyền ghi riêng (nút "Xác nhận chính sách ghi dữ liệu", độc lập với nút trước). Xác nhận của môi trường này không có giá trị cho môi trường khác.
13. **Web review:** không gọi/cào API của giao diện review, không mở nó bằng dòng lệnh, không dùng Playwright MCP hay điều khiển màn hình để bấm APPROVE thay người dùng; hook `scripts/guard-bash.mjs` chặn các lệnh vượt cổng. Hỏi người dùng MỘT lần gộp (không hỏi lẻ) và chỉ khi thiếu thông tin bắt buộc, có điểm mơ hồ ảnh hưởng Expected Result, hoặc cần quyền ghi.

14. **Chế độ APPROVE là xác nhận duy nhất** (khi `environments/<app>.json` có `"confirmation": "approval"`, mặc định của dự án này): người dùng CHỈ APPROVE test case. Môi trường dùng `defaultEnvironment`, quyền ghi theo `policy` của môi trường; KHÔNG còn màn hình chọn môi trường/xác nhận chính sách (`qa:next` không đòi `NEEDS_ENVIRONMENT`/`NEEDS_WRITE_POLICY`). Các luật 9, 11, 12 về xác nhận riêng chỉ còn áp dụng cho chế độ `explicit` và cho production. Production KHÔNG BAO GIỜ được suy ra từ APPROVE (code ép: vẫn cần xác nhận riêng, quyền ghi luôn none). Vẫn cấm: tự APPROVE, tự đổi môi trường mặc định, sửa `environments/*.json`/`.env` thay người dùng, chọn môi trường khác khi đăng nhập lỗi. Việc ghi vẫn chỉ trên dữ liệu do framework tạo (registry) và cleanup theo chính sách.

## Điểm bắt đầu duy nhất và vòng lặp điều phối
`/qa-requirement` là CÁCH DUY NHẤT người dùng bắt đầu quy trình: họ chỉ cung cấp requirement (dán hoặc file), review test case và APPROVE; mọi bước kỹ thuật còn lại do bạn tự làm, không bắt người dùng viết prompt dài hay gõ lệnh npm (các lệnh npm chỉ là phương án debug/vận hành nâng cao).

**Mỗi lần gọi (kể cả khi phiên cũ đã đóng) chạy `npm run qa:next`** (thêm `-- --requirement=<REQ-ID>` nếu `$ARGUMENTS` đã nêu; bỏ trống để tiếp tục requirement đang dở của phiên trước). Lệnh chỉ ĐỌC trạng thái thật trên đĩa (requirement, test case, phê duyệt có chữ ký, xác nhận môi trường/chính sách ghi, phiên đăng nhập, thăm dò, spec, kết quả chạy) rồi in BƯỚC TIẾP THEO và ai làm (Claude hay người dùng). Làm đúng bước đó, rồi chạy lại `qa:next`, lặp tới khi tới bước cần người dùng (DỪNG) hoặc `RUN_COMPLETE`. Không nhập lại requirement, không trình/duyệt lại khi phê duyệt còn hợp lệ, không hỏi lại xác nhận môi trường/chính sách còn hiệu lực.

| Giai đoạn (`qa:next`) | Việc làm |
|---|---|
| `NO_REQUIREMENT` | Có file trong `requirements/_inbox`: nhập (`req:import`). Không có: hỏi người dùng dán requirement hoặc đưa đường dẫn file |
| `NEEDS_TESTCASES` → `READY_TO_SUBMIT` | Sinh test case có liên kết BR/AC, `req:check`, `qa:approval -- submit`, mở giao diện review (`qa:review`, chạy nền) rồi DỪNG |
| `AWAITING_APPROVAL` | Mở lại giao diện review nếu cần rồi DỪNG chờ APPROVE/REVISE/REJECT |
| `NEEDS_REVISION` | Sửa theo nhận xét, `req:check`, trình lại, DỪNG |
| `REJECTED` / `APPROVAL_INVALID` | DỪNG, báo người dùng |
| `NEEDS_SETUP` | Thiếu cấu hình/credential trong `.env` (chỉ nêu TÊN biến): hướng dẫn `npm run setup`, người dùng điền một lần |
| `NEEDS_ENVIRONMENT` / `NEEDS_WRITE_POLICY` | Chạy nền `qa:env-web` (thêm `--need-write` khi cần ghi): người dùng bấm xác nhận trên web; xong tự tiếp tục |
| `NEEDS_ROLES` | Requirement cần vai trò chưa có tài khoản trong `.env`: nêu ĐÚNG tên biến của vai trò đó (không đòi vai trò không liên quan), người dùng điền; xong chạy lại `qa:next`. Thiếu một phần ⇒ chỉ test dùng vai trò đó BLOCKED, các test còn lại vẫn chạy |
| `NEEDS_LOGIN` / `LOGIN_FAILED` | Chạy bước đăng nhập chỉ đọc; nếu lỗi ⇒ BLOCKED và DỪNG, KHÔNG đổi môi trường/tài khoản |
| `NEEDS_PROBE` / `PROBE_FAILED` | `npm run odoo:probe`; không tương thích ⇒ báo lỗi cụ thể, DỪNG |
| `NEEDS_AUTOMATION` | Khám phá UI chỉ đọc bằng `mcp__playwright__*`, xác minh locator, tạo Page Object + spec, dữ liệu bằng Test Data Factory; xong thì `qa:next -- --mark=automation-done` |
| `READY_TO_RUN` | `npm test -- --requirement=<REQ-ID>` (hoặc `npm run test:write -- --requirement=<REQ-ID> --module=<app>-<module>` khi có chính sách ghi hợp lệ; cleanup tự động theo chính sách) |
| `RUN_COMPLETE` | `qa:finish` dựng + đối chiếu + mở QA Report (lọc theo requirement), cleanup theo chính sách, báo cáo tổng kết |

**Mỗi lần gọi `/qa-requirement`, MỞ ĐẦU câu trả lời bằng khối "TÀI LIỆU REVIEW TEST CASE" mà `qa:next` in ra** (Requirement ID, phiên bản, trạng thái phê duyệt, liên kết markdown tới `REVIEW.md` và file test case; chép nguyên các liên kết, không rút gọn), TRƯỚC khi nói bất cứ điều gì khác, dù requirement đang ở trạng thái nào:
- **Chưa APPROVE** (`NOT_SUBMITTED`/`PENDING_APPROVAL`): trình duyệt nếu cần (`qa:approval -- submit`), chạy nền `qa:review -- --requirement=<REQ-ID>` để mở giao diện review (nếu chưa chạy), nêu link, rồi DỪNG. Không kết nối staging, không chạy test, không gọi Playwright MCP.
- **Đã APPROVE hợp lệ:** không bắt duyệt lại; vẫn hiển thị liên kết xem lại test case đã duyệt, version và `APPROVED`; tự tiếp tục từ bước dở dang theo `qa:next`. Không nhập lại requirement, không tạo test case trùng (`req:import` tự nhận ra nội dung đã nhập).
- **Test case thay đổi** (`PENDING_STALE`/`INVALIDATED`): phê duyệt tự mất hiệu lực theo cơ chế sẵn có; `req:check`, `submit` tạo phiên bản review MỚI (phiên bản cũ giữ nguyên), hiển thị lại liên kết mới, mở `qa:review` và DỪNG chờ APPROVE. Không bỏ qua Approval Gate.
- **REVISE bằng chat:** khi người dùng nhắn bằng ngôn ngữ tự nhiên rằng muốn sửa test case (ví dụ "TC-EIN-002 thêm bước...", "bỏ test điều chuyển"): tự xác định requirement đang xử lý (từ `qa:next`) và phiên bản đang chờ/đã duyệt, ghi nhận bằng `qa:approval -- revise --requirement=<REQ-ID> --by="<tên>" --comment="<nguyên văn>" --channel=chat` (hỏi tên một lần nếu chưa biết), sửa test case theo yêu cầu (giữ nguyên `approvals/<REQ-ID>/v<N>/` cũ; không sửa BR/AC), `req:check`, `submit` phiên bản mới, hiển thị liên kết mới và DỪNG chờ duyệt lại. Người dùng không phải gõ lệnh nào.

**Hỏi người dùng đúng khi cần, và gom MỘT lần:** chỉ hỏi khi có điểm mơ hồ ảnh hưởng Expected Result, thiếu credential bắt buộc, hoặc cần một xác nhận quyền mà người dùng chưa cấp. Lỗi kỹ thuật tự khắc phục được an toàn (trong phạm vi framework) thì tự xử lý, không hỏi. QA Report được tạo ở cuối MỖI lần chạy, kể cả khi mọi test BLOCKED/NOT RUN.

## Bước 0: xác định đang ở đâu (chi tiết các trạng thái phê duyệt)
Xác định requirement (từ `$ARGUMENTS`: file `.md`, `REQ-...`, hoặc nội dung dán) rồi chạy `npm run qa:approval -- status --requirement=<REQ-ID>` nếu requirement đã có. Tiếp tục ĐÚNG trạng thái, không tạo requirement/test case trùng:

| Trạng thái | Việc làm |
|---|---|
| Requirement chưa nhập | Giai đoạn 1 từ bước 1 |
| `NOT_SUBMITTED` (đã nhập, đã/chưa có test case) | Bổ sung test case còn thiếu rồi bước 5 (submit) |
| `PENDING_APPROVAL` | Mở lại giao diện web (`npm run qa:review -- --requirement=<REQ-ID>`, chạy nền), in link + đường dẫn file review rồi DỪNG |
| `PENDING_STALE`, `INVALIDATED`, `REVISION_REQUESTED` | Test case đã đổi hoặc cần sửa: rà soát/sửa theo nhận xét (xem "REVISE"), `req:check`, rồi submit phiên bản mới và DỪNG |
| `REJECTED` | Báo bị từ chối, DỪNG. Chỉ làm lại khi người dùng yêu cầu rõ và test case đã đổi |
| `APPROVED` (hợp lệ) | Giai đoạn 2 |
| `SIGNATURE_INVALID`, `KEY_MISSING` | Báo phê duyệt không xác minh được; người dùng duyệt lại. KHÔNG sửa file |

Nếu người dùng gọi lại với file/nội dung đã nhập: `req:import` tự nhận ra cùng nội dung ("ĐÃ NHẬP TRƯỚC ĐÓ ... REQ-XXX") và thoát an toàn; dùng requirement đó và chạy `status`. Không dùng `--force-similar`.

## Lựa chọn của người dùng: APPROVE / REVISE / REJECT
(Gọi bằng `/qa-requirement <REQ-ID> APPROVE|REVISE ...|REJECT ...` hoặc nói trong hội thoại.)
- **APPROVE:** do NGƯỜI DÙNG thực hiện trên giao diện web (`npm run qa:review -- --requirement=<REQ-ID>`: gõ cụm xác nhận + bấm Yes trên hộp thoại hệ điều hành) hoặc, phương án dự phòng, bằng lệnh terminal `npm run qa:approval -- approve --requirement=<REQ-ID> --version=<N> --hash=<sha256>`. Bạn KHÔNG thực hiện được. Sau khi người dùng báo đã duyệt (hoặc `qa:review` chạy nền kết thúc), chạy `status` để xác nhận `APPROVED`; chỉ khi đó mới sang Giai đoạn 2. Người dùng nói "duyệt" trong chat KHÔNG thay thế bước này.
- **REVISE:** `npm run qa:approval -- revise --requirement=<REQ-ID> --by="<tên người dùng; hỏi nếu chưa biết>" --comment="<nhận xét nguyên văn của người dùng>" --channel=chat`. Sau đó sửa test case theo nhận xét (không xóa phiên bản cũ: mọi phiên bản đã nằm trong `approvals/<REQ-ID>/v<N>/`; `req:check`), rồi submit phiên bản mới và DỪNG chờ duyệt lại.
- **REJECT:** `npm run qa:approval -- reject ... --comment="<lý do nguyên văn>" --channel=chat`. Không thực thi. DỪNG.

# GIAI ĐOẠN 1: Generate & Review (không staging, không Playwright MCP, không automation)

### 1. Nhận requirement
- `$ARGUMENTS` là đường dẫn file `.md` ⇒ dùng file đó. Là `REQ-...` đã có trong `requirements/` ⇒ bỏ qua bước nhập (xem Bước 0).
- Để trống hoặc là nội dung dán trực tiếp ⇒ lưu NGUYÊN VĂN vào `requirements/_inbox/<tên-ngắn>.md` (thư mục này bị `.gitignore`, không đóng gói). Nếu chưa có nội dung, hỏi người dùng dán requirement theo mẫu `example/requirements/TEMPLATE.md` (5 mục: Path / Business Requirement / Expected Solution / Business Rules / Acceptance Criteria). Chạy thử: `example/requirements/SAMPLE-REQUIREMENT.md` (toàn dữ liệu giả).
- **Lưu NGUYÊN VĂN từng ký tự**: không thêm `**`/gạch đầu dòng, không đổi tiêu đề, không sửa lỗi chính tả/khoảng trắng/dấu câu của người dùng (kể cả lỗi rõ ràng như chữ thừa hay khoảng trắng trước dấu chấm). Công cụ đọc được cả tiêu đề dạng "3. Business Rules (*)" và "Path / Đường dẫn màn hình (*)". Nếu `req:import` báo lỗi cấu trúc: DỪNG và báo người dùng, KHÔNG viết lại văn bản để vừa với công cụ. Phát hiện lỗi chính tả trong nguồn thì chỉ ghi nhận trong báo cáo cuối, không sửa. Ví dụ: nguồn có "hóa đQơn" thì file lưu cũng phải là "hóa đQơn"; nguồn có "Số pin ." thì giữ " ." đúng như vậy. Trước khi ghi file, so lại từng dòng với bản dán; nếu người dùng đưa đường dẫn file thì dùng file đó, không chép lại.

### 2. Xác định Application, Module, Requirement ID
- Nếu `$ARGUMENTS` có kèm `<app> <module>` sau tên file thì dùng luôn, không hỏi.
- **Requirement mẫu** `example/requirements/SAMPLE-REQUIREMENT.md` (toàn dữ liệu giả): mặc định application `odoo`, module `demo` (chưa có thì `npm run new:module -- odoo demo`), `--id=REQ-SAMPLE-001`; KHÔNG hỏi lại về Path của requirement mẫu.
- Application/Module suy ra từ mục Path (ví dụ "Bán hàng → ..." ⇒ `odoo` / `sales`, "Mua hàng" ⇒ `purchase`). Xem các module đã có ở `applications/` và `tests/`. Path mơ hồ hoặc không khớp ⇒ DỪNG, hỏi người dùng; không đoán.
- Đặt `--id=REQ-<MÃ>-<NNN>` (chữ HOA, ví dụ `REQ-PO-001`), không trùng requirement đã có.
- Module chưa có ⇒ `npm run new:module -- <app> <module>`; ứng dụng chưa có ⇒ `npm run new:app -- <app>`.
- **Requirement liên quan nhiều module:** nhập MỘT lần vào module chính (giữ một Requirement ID và một bộ BR/AC). Với module khác tạo thêm `testcases/<app>-<module2>/<REQ-ID>.testcases.json` có `"application"` và `"module"` của module đó ở cấp bộ (cùng `requirementId`). Test case vẫn truy vết về cùng BR/AC; ID test case duy nhất toàn cục. Một requirement = MỘT phê duyệt cho toàn bộ test case của mọi module.

### 3. Nhập requirement và kiểm tra trùng lặp
- `npm run req:import -- <app> <module> <file.md> --id=REQ-XXX`. Công cụ tách 5 mục, lưu BR/AC nguyên văn, khoá bằng hash, và **báo trùng** với requirement đã có.
- Báo lỗi cấu trúc ⇒ hỏi người dùng sửa, không tự đoán. Báo trùng ⇒ DỪNG, hỏi: dùng requirement cũ hay vẫn nhập mới. **KHÔNG BAO GIỜ tự thêm `--force-similar`**: chỉ dùng khi chính người dùng đã nói rõ trong tin nhắn là vẫn muốn nhập bản mới. Trùng MÃ requirement thì không có cách vượt qua. Không tự tạo/sao chép file requirement thủ công để né công cụ.
- **Nguyên văn do công cụ bảo đảm, không do bạn:** `req:import` tự sao chép bản nguồn nguyên byte vào `requirements/<app>-<module>/<REQ-ID>.source.md`, băm sha256, khoá, rồi tự đối chiếu JSON với bản nguồn từng ký tự. KHÔNG tự tạo/sửa `requirements/**/*.json`, `.lock`, `.source.md`. Sau khi nhập chạy `npm run req:verify -- --requirement=<REQ-ID>` và đưa sha256 vào báo cáo cuối. Nếu người dùng dán văn bản: công cụ chỉ bảo đảm nguyên văn TỪ file `_inbox` trở đi; nói rõ điều này và gợi ý dùng đường dẫn file hoặc `--expect-sha256`.
- Đọc BR/AC, liệt kê điểm mơ hồ (sẽ thành NEEDS CLARIFICATION).

### 4. Sinh test case có truy vết
- Ghi vào `testcases/<app>-<module>/<REQ-ID>.testcases.json` theo `example/testcases/TEMPLATE.md`: id duy nhất toàn cục (ví dụ TC-PO-001), title, `requirementRefs` (BR/AC), description, preconditions, testData, steps, expectedResult (bám sát BR/AC, không thêm quy tắc mới), verification (UI/BACKEND), automated (`false` ở giai đoạn này), `needsClarification` nếu chưa rõ; bổ sung `glossary`.
- Mỗi BR/AC có ít nhất một test case. Chỉ sinh từ BR/AC đã có.
- **`needsClarification` CHỈ dành cho điểm mơ hồ của chính BR/AC** (trích đúng câu chưa rõ). KHÔNG dùng nó cho việc thiếu môi trường (URL, tài khoản, tên kỹ thuật, bản ghi để ghim): đó là thông tin kiểm thử còn thiếu, ghi vào báo cáo cuối.
- **AC/BR có nhiều trường hợp độc lập** ("lần lượt", "từng", "mỗi", hoặc liệt kê nhiều giá trị/trường/vai trò cần thử riêng) phải kiểm thử ĐẦY ĐỦ TỪNG trường hợp: mỗi trường hợp một test case riêng với TC-ID riêng, cùng `requirementRefs`. Không gộp. Spec được phép tham số hóa nhưng mỗi trường hợp phải có `tcMeta('TC-...')` riêng. `req:check` báo lỗi nếu AC có "lần lượt/từng/mỗi" chỉ có 1 test case; chỉ khi thực sự là một kịch bản mới ghi `singleCaseReason` kèm lý do.
- **Lưu khác Xác nhận nghiệp vụ** (`FRAMEWORK.md`, mục 6A): trước khi viết test case, xác định mốc ghi nhận của chứng từ. BR/AC ghi "lưu"/"chặn lưu" mà chứng từ có bước xác nhận riêng ⇒ `needsClarification` và hỏi BA, KHÔNG tự chọn mốc, KHÔNG sửa BR/AC. Steps nêu rõ thao tác cuối (Lưu hay nút xác nhận cụ thể); tiền điều kiện "đã có/đã gắn" phải là dữ liệu đã qua mốc ghi nhận.
- `npm run req:check -- --requirement=<REQ-ID>` phải báo mọi BR/AC được phủ và nguyên văn đạt. Thiếu ⇒ bổ sung test case, KHÔNG sửa BR/AC.

### 5. Trình duyệt (submit), mở giao diện Web review rồi DỪNG
- Chạy `npm run qa:approval -- submit --requirement=<REQ-ID>`. Công cụ từ chối nếu thiếu phủ/lỗi nguyên văn; nếu đạt, nó sinh `approvals/<REQ-ID>/v<N>/` gồm `REVIEW.md`, `<app>-<module>.testcases.md` cho từng module, `testcases.snapshot.json`, và đặt trạng thái `PENDING_APPROVAL`. Gọi lại khi chưa đổi gì thì không tạo phiên bản mới.
- **Mở giao diện Review & Approval trên web:** chạy `npm run qa:review -- --requirement=<REQ-ID>` với `run_in_background` (máy chủ cục bộ chỉ nghe 127.0.0.1, tự mở trình duyệt, in link). Hiển thị link đó cho người dùng (và cách mở thủ công nếu trình duyệt không tự mở). Giao diện cho thấy Requirement ID, phiên bản, hash, test case theo module, phủ BR/AC, trạng thái và lịch sử; người dùng chọn APPROVE / REVISE / REJECT, nhập tên và nhận xét ngay trên đó. Bạn KHÔNG gọi API của giao diện, KHÔNG mở nó bằng curl/PowerShell, KHÔNG bấm thay người dùng (kể cả qua Playwright MCP hay điều khiển màn hình): APPROVE cần người dùng gõ cụm xác nhận và bấm Yes trên hộp thoại hệ điều hành; hook sẽ chặn các lệnh vượt cổng.
- Liên kết các file Markdown (dạng liên kết markdown tương đối, kèm `REVIEW.md`), phiên bản và hash để người dùng đọc offline nếu muốn.
- Báo: số test case theo module, phủ BR/AC, điểm cần làm rõ của BR/AC, trạng thái `PENDING_APPROVAL`. Phương án dự phòng nếu không dùng được web: lệnh terminal `npm run qa:approval -- approve --requirement=<REQ-ID> --version=<N> --hash=<sha256>` (người dùng tự gõ).
- **DỪNG TẠI ĐÂY.** Không kiểm tra `.env`, không gọi Playwright MCP/ToolSearch tìm MCP, không viết Page Object/spec, không chạy test, không kết nối staging. Khi tiến trình `qa:review` chạy nền kết thúc (có thông báo "QUYẾT ĐỊNH: ..."), chạy `npm run qa:approval -- status` để xác nhận: `APPROVED` ⇒ sang Giai đoạn 2; `REVISION_REQUESTED` ⇒ sửa theo nhận xét, `req:check`, submit phiên bản mới, mở lại `qa:review`; `REJECTED` ⇒ DỪNG. Người dùng nói "duyệt" trong chat KHÔNG thay thế bước này.

# GIAI ĐOẠN 2: Approve & Execute (chỉ khi `status` báo `APPROVED` hợp lệ)

### 6. Mở phiên thực thi
`npm run qa:approval -- begin --requirement=<REQ-ID>` (từ chối nếu không có phê duyệt hợp lệ khớp hash). Hook của dự án chỉ cho phép `mcp__playwright__*` khi phiên này còn hiệu lực; sửa test case làm phê duyệt mất hiệu lực và chặn ngay.
- Ngay sau đó chạy `npm run qa:ready -- --requirement=<REQ-ID>` (bước 7) để thấy MỘT lần mọi việc còn thiếu; gộp câu hỏi chọn môi trường (6A) với các câu khác thành một lần hỏi duy nhất. APPROVE không đồng nghĩa với chọn/xác nhận môi trường hay quyền ghi.
- **Không được sửa nội dung test case đã duyệt** (title, steps, expectedResult, testData, requirementRefs...). Chỉ được đặt `automated: true` khi đã có spec. Cần đổi nội dung ⇒ DỪNG thực thi, báo người dùng; đổi xong phải submit lại và chờ duyệt lại.

### 6A. Chọn và xác nhận môi trường (BẮT BUỘC, trước khi kết nối Playwright MCP)
1. `npm run qa:env -- list` (chỉ in tên môi trường, host, biến còn thiếu; không in giá trị bí mật) và `npm run qa:env -- check` (cấu hình hợp lệ). Môi trường được khai báo trong `environments/<app>.json` (chỉ tên biến); URL và tài khoản theo vai trò nằm trong `.env`.
2. **Dùng lại nếu đã hợp lệ:** `npm run qa:env-web -- --requirement=<REQ-ID> --check` (thêm `--need-write` nếu có test cần tạo dữ liệu). Thoát 0 ⇒ môi trường đang chọn đã được xác nhận hợp lệ (và chính sách ghi nếu cần), chưa hết hạn, cấu hình/phê duyệt không đổi ⇒ DÙNG LẠI, KHÔNG hỏi lại, sang bước 6 ngay. Thoát 1 (chưa có, hết hạn 24 giờ/8 giờ, đổi host/chính sách/phê duyệt) ⇒ bước 3.
3. **Mở giao diện web chọn môi trường (NGƯỜI DÙNG thao tác, không gõ lệnh):** chạy NỀN (`run_in_background`) `npm run qa:env-web -- --requirement=<REQ-ID> [--need-write]`. Lệnh in link, tự mở trình duyệt, hiện mọi môi trường trong `environments/` (tên, loại, ứng dụng, host, vai trò; không có mật khẩu/token). Người dùng chọn môi trường, bấm "Xác nhận môi trường" (và, nếu cần ghi, nút RIÊNG "Xác nhận chính sách ghi dữ liệu"); mỗi nút có hộp thoại hệ điều hành riêng. Bạn KHÔNG chọn, KHÔNG xác nhận, KHÔNG gọi API của trang. Nói với người dùng: "Mở giao diện chọn môi trường, chọn môi trường và xác nhận" rồi CHỜ thông báo hoàn tất của lệnh nền; xong thì TỰ TIẾP TỤC Giai đoạn 2, không bắt người dùng nhập lại lệnh hay gõ `qa:env`/`qa:policy`. Môi trường đổi so với trước: đóng trình duyệt Playwright MCP đang mở (`browser_close`) trước khi dùng phiên mới. Lệnh `qa:env select/confirm` và `qa:policy confirm` chỉ là phương án dự phòng khi giao diện web không dùng được.
   Nếu đổi từ môi trường khác: đóng trình duyệt Playwright MCP đang mở (`browser_close`) trước, không dùng lại cookie/phiên của môi trường cũ; phiên MCP mới chạy với `--isolated` và (nếu cần đăng nhập sẵn) `--storage-state=.auth/<TÊN>/<app>-<role>.json`, mỗi vai trò một phiên riêng.
4. Sau khi lệnh nền báo hoàn tất, chạy `npm run qa:env -- status` để xác nhận hợp lệ. Chưa hợp lệ ⇒ DỪNG, KHÔNG gọi `mcp__playwright__*` (hook sẽ chặn).
5. Hook còn chặn mọi lệnh Playwright MCP có URL khác host của môi trường đã chọn. Gặp chặn này là đúng hành vi: không tìm cách né, không đổi môi trường để "cho chạy được".
6. Xác minh trước khi chạy do code đảm nhiệm khi đăng nhập (project `setup-<app>`): URL thực tế đúng môi trường, đúng tài khoản của vai trò, phân quyền (vai trò `noaccess` không được là quản trị), phiên bản ứng dụng khớp `*_VERSION` của môi trường. Không đạt ⇒ test dùng vai trò đó BLOCKED kèm lý do; báo lại cho người dùng, không đổi môi trường/tài khoản.

### 6B. Chính sách ghi và dữ liệu test (khi có test cần dữ liệu)
- `npm run qa:policy -- show` cho biết chính sách hiệu lực của môi trường đã chọn (chỉ in cấu hình, không kết nối). Môi trường chỉ đọc hoặc production ⇒ không đề nghị ghi; test cần dữ liệu là BLOCKED kèm lý do.
- Cần ghi/tạo dữ liệu ⇒ chạy giao diện web ở 6A với `--need-write`: nút "Xác nhận chính sách ghi dữ liệu" nằm cùng trang nhưng độc lập với xác nhận môi trường, chỉ bật cho môi trường có chính sách phù hợp (production/chỉ đọc bị khóa). Bạn không tự xác nhận được. Sau đó `qa:policy status` phải báo HỢP LỆ. (Dự phòng: người dùng tự gõ `npm run qa:policy -- confirm --env=<TÊN> --requirement=<REQ-ID>`.)
- Có chính sách hợp lệ: `npm run test:write -- --env=<TÊN> --module=<app>-<module>` tự cấp giấy phép ghi (không hỏi lại host). Dữ liệu sinh bằng Test Data Factory (`core/testdata/factory.ts`, `applications/<app>/factory.ts`: khách hàng, sản phẩm, serial, SO, DO, thanh toán), mỗi bản ghi gắn Environment/Run/Requirement/Test Case ID trong registry. ƯU TIÊN dữ liệu tự tạo; KHÔNG dùng hay sửa dữ liệu nghiệp vụ có sẵn.
- Thứ tự bắt buộc sau khi chạy: kết quả → QA Report + Bug Report + evidence (`qa:finish`, `npm test` tự gọi) → cleanup (`AUTO_CLEANUP` tự gọi `cleanup:run`, hoặc chạy `npm run cleanup:run -- --run=<RunID>`). Test FAIL: dữ liệu được giữ (RETAINED) theo `failureRetentionHours`; dọn sau bằng `npm run cleanup:run -- --due`.
- **Thao tác ghi qua Playwright MCP cũng bị cổng này:** hook phân loại theo ý định (click/gõ có nhãn Lưu, Xác nhận, Tạo hóa đơn, Hủy, Xóa, Validate, Thanh toán, Import...; phím Lưu; mã tự do gọi RPC không phải đọc hoặc click/gõ). Chưa có chính sách ghi hợp lệ hoặc môi trường là production ⇒ hook chặn (`WRITE POLICY GATE`); được qua thì ghi nhật ký `.qa-state/mcp-writes.jsonl`. Đây là heuristic: khi có chính sách, bạn vẫn CHỈ được ghi lên bản ghi trong registry (do Factory tạo), không bao giờ lên dữ liệu có sẵn. Ưu tiên tạo dữ liệu bằng Factory/`test:write` thay vì bấm tay qua MCP.
- Trước khi dùng Factory lần đầu trên một môi trường thật: `npm run odoo:probe` (chỉ đọc) xác minh phiên bản, API ORM, trường và quyền. Lần chạy đầu: `--no-auto-cleanup` để giữ dữ liệu, rồi `cleanup:run --dry-run`.
- Cleanup chỉ động vào bản ghi trong registry có owner FRAMEWORK đúng môi trường; chứng từ bị ràng buộc kế toán/kho ⇒ `CLEANUP_BLOCKED` kèm nguyên nhân (không đổi kết quả test). Báo các bản ghi CLEANUP_BLOCKED/RETAINED trong báo cáo cuối (`reports/<ENV>/cleanup/`).

### 7. Kiểm tra sẵn sàng (tự động, offline) và gom câu hỏi MỘT lần
Chạy `npm run qa:ready -- --requirement=<REQ-ID>`. Lệnh KHÔNG kết nối mạng, tự kiểm tra: phê duyệt, môi trường đã chọn + xác nhận, tài khoản từng vai trò (chỉ tên biến), module/spec đã có, fixture ghim; phân loại dự kiến từng test case (ELIGIBLE / BLOCKED / NOT RUN / NEEDS CLARIFICATION) và in danh sách **CÂU HỎI CẦN NGƯỜI DÙNG**.
- **Giảm tối đa câu hỏi:** chỉ hỏi những gì lệnh liệt kê (thiếu thông tin bắt buộc, điểm mơ hồ ảnh hưởng Expected Result, môi trường chưa xác nhận, quyền ghi). Mọi thứ tự xác minh được an toàn thì TỰ làm, không hỏi.
- **Gom thành MỘT lần hỏi** (một AskUserQuestion nhiều câu, hoặc một danh sách đánh số), không hỏi từng câu rải rác. Xong mới tiếp tục.
- Kiểm tra Playwright MCP dùng được (`mcp__playwright__browser_*`, dùng ToolSearch nếu bị trì hoãn). Dự án có `.mcp.json`.
- `canConnect` sai (chưa phê duyệt / chưa chọn-xác nhận môi trường) ⇒ KHÔNG kết nối MCP/staging; thiếu tài khoản/MCP ⇒ không đoán, test cần nó là BLOCKED/NOT RUN, tuyệt đối không PASS; sang bước 11.

### 8. Khám phá giao diện thật (chỉ đọc) và viết automation (tự động)
Chỉ khi bước 7 cho phép kết nối. Làm liền một mạch, không dừng hỏi từng bước:
- Dùng Playwright MCP duyệt đúng đường dẫn menu trong Path: ghi lại màn hình, nút, trường, locator thật; xác minh chức năng thực tế; KHÔNG tạo/sửa dữ liệu. Với Odoo kiểm tra trường/model bằng `fields_get` trước khi dùng.
- Tạo Page Object trong `applications/<app>/modules/<module>/pages/` (ứng dụng không phải Odoo: `applications/<app>/pages/`), API riêng trong `api.ts`, spec trong `tests/<app>-<module>/` (mỗi test gắn `tcMeta('TC-...')`, dùng `test.step`, `recordActual(...)` bằng giá trị quan sát thật). Locator chỉ nằm trong Page Object và chỉ lấy từ giao diện thật. Chưa khám phá được: chỉ để khung, KHÔNG viết locator, kể cả ví dụ/chú thích.
- **Dữ liệu SO/DO để kiểm tra:** ưu tiên TỰ TẠO bằng Factory (8A), không hỏi người dùng. Chỉ khi không thể tự tạo mới được phép TỰ tìm ứng viên bằng truy vấn CHỈ ĐỌC (search_read) để ĐỀ XUẤT; không tự ghim hay tự dùng. Ghim vào `testdata/fixtures/<ENV>/<app>-<module>.json` chỉ sau khi người dùng chọn (gộp vào câu hỏi ở bước 7). Không chọn "bản ghi mới nhất". Thiếu fixture ⇒ BLOCKED. Không dùng bản ghi nghiệp vụ có sẵn cho thao tác ghi.
- Test cần tạo/sửa dữ liệu (SO, DO, serial, thanh toán...): viết bằng Test Data Factory (dữ liệu tự tạo, qua cổng ghi). Chỉ CHẠY khi chính sách ghi đã được người dùng xác nhận (bước 6B); chưa có thì test BLOCKED, không tự xác nhận.
- **Assertion đúng mốc nghiệp vụ** (`FRAMEWORK.md`, mục 6A): khi khám phá, xác minh nút và trạng thái của mốc ghi nhận trên giao diện thật. Assertion chạy sau đúng mốc mà test case nêu và đọc bản ghi có hiệu lực, không chỉ dòng nháp. FAIL xảy ra trước mốc ghi nhận không được kết luận là hệ thống thiếu kiểm tra ở mốc đó; `recordActual`/`recordSummary` phải nêu test dừng ở bước nào.
- Test case đã duyệt không bị sửa; chỉ đặt `automated: true` khi đã có spec.

### 8A. Adapter tự thích ứng cho BẤT KỲ module Odoo nào (Community, Enterprise, bên thứ ba, tùy chỉnh)
Không có danh sách module cố định. Với mỗi module mà test case chạm tới, trước khi viết Factory/spec:
1. Xem `adapters/odoo/<module>.adapter.json` (xem `adapters/README.md`). Có rồi ⇒ `reuseDecision` (`core/adapters/manifest.ts`): `REUSE` dùng luôn; `REVERIFY` (khác phiên bản chính/edition hoặc cấu trúc trường đổi) ⇒ khám phá lại và sinh lại trước khi tin; `UNAVAILABLE` (module chưa cài) ⇒ test liên quan BLOCKED vì THIẾU ĐIỀU KIỆN MÔI TRƯỜNG, không ghi FAIL nghiệp vụ.
2. Chưa có ⇒ khám phá CHỈ ĐỌC bằng `applications/odoo/introspect.ts` (`environmentProfile`, `modelMeta`, `formButtons`, `deriveAdapter`) kèm Playwright MCP cho giao diện, rồi `saveAdapter`. Adapter chỉ ghi bước nghiệp vụ (Confirm/Validate/Post/Cancel...) mà nút ĐÃ CÓ trên form thật; bước không có ⇒ không đoán tên phương thức.
3. Dữ liệu test: `applications/odoo/generic.ts` (`prepareGeneric`, `planForModel`) tự dựng phụ thuộc theo lược đồ model (quan hệ bắt buộc được TẠO MỚI, chỉ dữ liệu cấu hình như công ty/tiền tệ/đơn vị tính/kho được CHỌN), chạy các bước (`steps: ['confirm','validate'...]`) và kiểm tra trạng thái sau mỗi bước. Không tự dựng được (one2many bắt buộc, quan hệ vòng, thiếu cấu hình) ⇒ `UnresolvedData` ⇒ test BLOCKED kèm nguyên nhân; viết công thức curated cho model đó nếu cần. KHÔNG hỏi người dùng chọn SO/PO/DO/sản phẩm khi có thể tự tạo.
4. Cleanup: `applications/odoo/generic-cleanup.ts` sinh handler từ adapter (huỷ bằng nút Cancel đã xác minh, lưu trữ master data); chứng từ đã ở trạng thái cuối ⇒ `CLEANUP_BLOCKED`; cách dọn chưa xác minh ⇒ `unsupported`. Handler chuyên biệt (như Sales) luôn thắng.
5. Adapter tự sinh (`origin: derived`) CHƯA được kiểm chứng trên Odoo thật: lần chạy đầu một module mới dùng `--no-auto-cleanup`, xem kết quả rồi mới tin; báo rõ điều này trong báo cáo cuối.

### 9. Kiểm tra tĩnh
`npm run typecheck` và `npm run test:framework` phải đạt trước khi chạy test thật.

### 10. Chạy tất cả test chỉ đọc đủ điều kiện
`npm test -- --requirement=<REQ-ID>` (MẶC ĐỊNH khi chạy `/qa-requirement <REQ-ID>`: chỉ requirement này; cổng Approval/Environment/Write Policy chỉ xét nó; chỉ test case của nó được liệt kê và chạy, không kéo theo requirement khác cùng module; chạy toàn module `--project=<app>-<module>` thì MỌI requirement trong module phải được duyệt; không dùng module để né một requirement chưa duyệt) cho từng module có test ELIGIBLE (chạy trên môi trường đã chọn và xác nhận; kết quả/evidence ở `reports/<MÔI_TRƯỜNG>/runs/<RunID>/`; cổng tự từ chối nếu thiếu phê duyệt/môi trường: đó là hành vi đúng, đừng né). Test ghi dữ liệu: chưa có chính sách ghi hợp lệ ⇒ BLOCKED (đúng thiết kế). Có chính sách (bước 6B) ⇒ `npm run test:write -- --env=<TÊN> --module=<app>-<module>`, tự cleanup theo chính sách sau khi có báo cáo. Chưa có chính sách mà người dùng muốn ghi ⇒ trình bày kế hoạch (module, MÔI TRƯỜNG, dữ liệu sẽ tạo, cách cleanup) và đưa lệnh `qa:policy confirm` để họ tự gõ. Production bị từ chối.
- Test không đủ điều kiện được phân loại đúng: BLOCKED (thiếu tài khoản/dữ liệu/quyền/môi trường), NOT RUN (chưa có spec hoặc không chạy), NEEDS CLARIFICATION (BR/AC mơ hồ). Không tạo PASS/FAIL giả. Không test nào chạy được thì không chạy Playwright nhưng VẪN sang bước 11.
- Test FAIL tự sinh Bug Report (`reports/<MÔI_TRƯỜNG>/bugs.json`). Xem phân loại "nghi lỗi hạ tầng", chạy lại để xác nhận trước khi kết luận bug. Kết quả/evidence các lần chạy trước được giữ nguyên.

### 11. Báo cáo và đóng phiên (BẮT BUỘC, kể cả khi mọi test BLOCKED/NOT RUN)
Luôn chạy `npm run qa:finish -- --requirement=<REQ-ID>`: lệnh dựng lại (`report:rebuild`), đối chiếu JSON/HTML/QA Summary/Bug Report (`report:verify`, phải báo "khớp"; lệch thì điều tra, không tự sửa số) và TỰ MỞ QA Report của môi trường (`reports/<MÔI_TRƯỜNG>/qa-report.html`); nếu không mở được thì đưa đường dẫn trực tiếp cho người dùng. Báo cáo mặc định lọc theo requirement đang xử lý; các requirement khác chỉ là lịch sử. Cuối cùng `npm run qa:approval -- end`.

## Kết thúc: báo cáo ngắn gọn
- **Giai đoạn 1:** requirement + sha256 nguồn, số test case theo module, phủ BR/AC, điểm cần làm rõ, trạng thái phê duyệt (phiên bản, hash), các liên kết file review, và xác nhận "chưa kết nối staging, chưa thay đổi dữ liệu".
- **Giai đoạn 2:** trạng thái phê duyệt (người duyệt, thời gian, phiên bản), **môi trường đã chạy (tên, loại, host) và ai xác nhận thực thi**, kết quả xác minh tài khoản/phân quyền/phiên bản. **Mọi con số PHẢI sao chép nguyên từ `reports/<MÔI_TRƯỜNG>/qa-summary.md`**, KHÔNG tự đếm: số test case theo trạng thái (PASS/FAIL/BLOCKED/NEEDS CLARIFICATION/NOT RUN), Execution Pass Rate, Overall Pass Coverage, phủ BR/AC.
- BR/AC nào chưa phủ hoặc chưa kiểm chứng, vì sao. Bug (nếu có) và phân loại.
- Việc nào đã thực sự chạy, việc nào chưa (ví dụ chưa khám phá UI vì thiếu môi trường/MCP) và còn thiếu thông tin gì (URL, tài khoản theo vai trò, dữ liệu ghim, làm rõ nghiệp vụ, quyền chạy test ghi).
- Xác nhận rõ: có hay không thay đổi dữ liệu trên hệ thống kiểm thử, và trên môi trường nào.
