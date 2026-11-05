# QA Automation Framework — cài đặt nhanh

Framework Playwright + TypeScript để kiểm thử Odoo (mọi module) và các ứng dụng web khác.
Quy trình: Requirement → Test Case → truy vết BR/AC → khám phá giao diện (Playwright MCP) → Page Object → automation → chạy → Bug → Báo cáo QA.
Chi tiết đầy đủ: `FRAMEWORK.md`.

## Cài đặt nhanh trên máy mới
```
npm install
npx playwright install chromium
npm run setup -- --init     # kiểm tra, tạo .env từ mẫu; liệt kê TÊN biến còn thiếu
# điền .env một lần (không dán mật khẩu vào chat), rồi:
npm run setup               # phải báo "sẵn sàng"
```
Sau đó mở Claude Code và gõ `/qa-requirement`. Repo không chứa URL staging thật, mật khẩu, phiên đăng nhập hay evidence: những thứ đó nằm trong `.env`, `.auth/`, `reports/`, `testdata/registry*`, `testdata/fixtures/*.json` (đều bị `.gitignore`). Bộ cài đặt sạch không kèm requirement/test case nghiệp vụ: `npm run package:template`.

## Bắt đầu nhanh (người mới)

1. **Cài đặt:** `npm install` (cần Node.js 20+ và Chrome).
2. **Cấu hình môi trường:** `cp .env.example .env`, rồi tự điền địa chỉ và tài khoản kiểm thử **cho từng môi trường** (STAGING_A, STAGING_B, UAT...; xem mục "Nhiều môi trường" bên dưới). Giữ `ALLOW_WRITE_TESTS=false`. Không commit `.env`.
3. **Mở Claude Code** trong thư mục này (lần đầu hãy cho phép máy chủ Playwright MCP trong `.mcp.json`).
4. **Chạy `/qa-requirement`** rồi **dán requirement** theo mẫu 5 mục (Path / Business Requirement / Expected Solution / Business Rules / Acceptance Criteria; xem `example/requirements/TEMPLATE.md`). Muốn thử trước: `/qa-requirement example/requirements/SAMPLE-REQUIREMENT.md` (dữ liệu giả).
5. **Review và duyệt trên web (Approval Gate bắt buộc):** Claude nhập requirement, sinh test case, nộp duyệt rồi **mở giao diện web** (`npm run qa:review -- --requirement=<REQ-ID>`, chạy nền; trình duyệt tự mở, link được in ra) và **DỪNG** ở `PENDING_APPROVAL`. Trang hiển thị Requirement ID, phiên bản, hash, test case theo module, phủ BR/AC, trạng thái và lịch sử. Bạn chọn **APPROVE / REVISE / REJECT** ngay trên trang (nhập tên, nhận xét khi cần). APPROVE cần bạn gõ đúng cụm xác nhận và bấm **Yes trên hộp thoại hệ điều hành** của máy này; Claude không tự duyệt được. Chưa kết nối staging, chưa gọi Playwright MCP, chưa chạy automation. Phương án dự phòng (terminal): `npm run qa:approval -- approve --requirement=<REQ-ID> --version=<N> --hash=<sha256>`.
6. **Sau khi duyệt:** Claude tự kiểm tra cấu hình (`npm run qa:ready`: phê duyệt, môi trường, tài khoản theo vai trò, module, fixture) rồi **tự mở giao diện web chọn môi trường** (`qa:env-web`; các lệnh `qa:env select/confirm` chỉ là dự phòng) cùng các câu còn thiếu trong MỘT lần hỏi. Bạn tự **xác nhận** môi trường trong terminal (`qa:env confirm`). Sau đó Claude tự khám phá giao diện (Playwright MCP, chỉ đọc), viết Page Object/spec, chạy mọi test chỉ đọc đủ điều kiện, phân loại phần còn lại thành BLOCKED/NOT RUN/NEEDS CLARIFICATION (không PASS/FAIL giả), ghi bug. Cần tạo dữ liệu test: bạn xác nhận **một lần** chính sách ghi của môi trường (`npm run qa:policy -- confirm ...`, xem mục "Chính sách ghi..." bên dưới); Claude tự sinh dữ liệu, chạy E2E, xuất QA Report rồi tự cleanup dữ liệu do framework tạo. Không suy ra từ APPROVE hay xác nhận môi trường.
7. **Xem QA Report:** Claude chạy `npm run qa:finish` (dựng lại báo cáo, đối chiếu JSON/HTML/QA Summary/Bug Report, **tự mở** `reports/<MÔI_TRƯỜNG>/qa-report.html`; không mở được thì đưa đường dẫn). Báo cáo mặc định lọc theo requirement đang xử lý; requirement khác là lịch sử. Tổng kết bằng chữ: `reports/<MÔI_TRƯỜNG>/qa-summary.md`.

Thiếu môi trường/tài khoản thì test BLOCKED và Claude hỏi lại, không bao giờ tự kết luận PASS.

Luồng cho người mới: **dán requirement → nhận link review → bấm APPROVE trên web → chọn và xác nhận môi trường → Claude tự làm phần còn lại → QA Report tự mở**. Claude chỉ dừng hỏi khi thật sự cần bạn (thiếu thông tin bắt buộc, BR/AC mơ hồ, môi trường/tài khoản, quyền ghi) và gom mọi câu hỏi vào MỘT lần.

### Approval Gate (chi tiết)

| Lệnh | Việc |
|---|---|
| `npm run qa:approval -- submit --requirement=REQ-XXX` | Sinh Markdown review, trạng thái `PENDING_APPROVAL` (gọi lại khi chưa đổi gì thì không tạo phiên bản mới) |
| `npm run qa:approval -- status [--requirement=REQ-XXX]` | Trạng thái, hiệu lực phê duyệt, lịch sử (người duyệt, thời gian, phiên bản, hash) |
| `npm run qa:approval -- approve --requirement=REQ-XXX --version=N --hash=<sha256>` | APPROVE đúng phiên bản + hash; chỉ trong terminal có bàn phím, gõ lại cụm xác nhận |
| `npm run qa:approval -- revise\|reject --requirement=REQ-XXX --by="Tên" --comment="..."` | REVISE (giữ mọi phiên bản cũ) / REJECT (không thực thi) |
| `npm run qa:review -- --requirement=REQ-XXX` | **Giao diện web** Review & Approval (chạy nền, mở trình duyệt, tự thoát sau quyết định). APPROVE: gõ cụm xác nhận + Yes trên hộp thoại hệ điều hành; REVISE/REJECT cần tên + nhận xét. Backend dùng cùng hàm approve/revise/reject nên giữ HMAC, hash, lịch sử, INVALIDATED; nhật ký mọi lần thử: `approvals/<REQ>/web-audit.jsonl` |
| `npm run qa:ready -- --requirement=REQ-XXX` | Kiểm tra sẵn sàng Giai đoạn 2 (offline), phân loại dự kiến, gom câu hỏi |
| `npm run qa:finish -- [--requirement=REQ-XXX]` | Dựng lại + đối chiếu báo cáo + mở QA Report (bắt buộc sau mỗi lần làm việc, kể cả khi không test nào chạy) |
| `npm run qa:approval -- begin\|end --requirement=REQ-XXX` | Mở/đóng phiên thực thi (cần phê duyệt hợp lệ) cho Playwright MCP |

Giao diện web chỉ là một kênh nhập: máy chủ chỉ nghe 127.0.0.1, kiểm tra Host/Origin, mã phiên, nonce, giới hạn số lần thử, và với APPROVE cần xác nhận của người thật (hộp thoại hệ điều hành; hiện hỗ trợ Windows và macOS, nền tảng khác dùng lệnh terminal). Hook `scripts/guard-bash.mjs` chặn lệnh gọi API review hoặc import hàm duyệt. Giới hạn: không chống được người có toàn quyền điều khiển máy (ví dụ điều khiển màn hình).

Cơ chế bằng code: (0) `npm test`/`npm run test:write` từ chối chạy (thoát mã 3, chưa đăng nhập staging) khi chưa có phê duyệt hợp lệ; (2) `playwright.config.ts` không đăng ký project kết nối staging nếu không qua cổng; (3) từng test tự kiểm tra lại phê duyệt (BLOCKED nếu không hợp lệ) và phạm vi lần chạy (test của requirement khác bị bỏ qua trước khi kết nối; `playwright.config.ts` tính lại phê duyệt của phạm vi từ file nên gọi thẳng `npx playwright test` kèm tự đặt biến cũng không có project nào chạm staging); (4) hook `PreToolUse` trong `.claude/settings.json` chặn `mcp__playwright__*` khi không có phiên thực thi hợp lệ; (5) bản ghi phê duyệt có chữ ký HMAC bằng khóa ở thư mục người dùng (`~/.qa-framework/approval.key`, đổi bằng `QA_APPROVAL_KEY_FILE`), nên sửa tay file JSON không tạo được phê duyệt. Phê duyệt chỉ có hiệu lực trên máy giữ khóa đó: máy khác cần duyệt lại. Giới hạn: đây là chốt chặn cho Claude và các lệnh của framework, không thay thế quyền hạn hệ điều hành đối với người có toàn quyền trên máy.

## Nhiều môi trường cho cùng một ứng dụng (STAGING_A, STAGING_B, UAT...)

**Chế độ APPROVE là xác nhận duy nhất (mặc định của repo):** trong `environments/<app>.json`, `"confirmation": "approval"` + `"defaultEnvironment"` làm cho việc APPROVE test case là xác nhận DUY NHẤT của người dùng: không còn màn hình chọn môi trường hay xác nhận chính sách ghi; môi trường mặc định được dùng và quyền ghi theo `policy` của nó. Production không bao giờ được suy ra (vẫn cần xác nhận riêng, quyền ghi luôn none). Đặt `"confirmation": "explicit"` (hoặc bỏ khai báo) để quay lại hai xác nhận riêng như mô tả bên dưới.

Mỗi môi trường có URL và tài khoản theo vai trò **riêng**. `environments/<app>.json` chỉ chứa **tên biến**; URL, tài khoản, mật khẩu, phiên bản kỳ vọng nằm trong `.env` (xem `.env.example`, ví dụ `ODOO_STAGING_A_URL`, `ODOO_STAGING_A_ACCOUNTANT_USER`). Không dùng chung biến giữa hai môi trường; `npm run qa:env -- check` báo cấu hình sai.

| Lệnh | Việc |
|---|---|
| `npm run qa:env -- list` | Các môi trường, loại, host, biến còn thiếu (chỉ tên biến, không in giá trị) |
| `npm run qa:env -- check` | Kiểm tra cấu hình và `.env` (không kết nối mạng) |
| `npm run qa:env-web -- --requirement=REQ-XXX [--need-write] [--check] [--change]` | **Giao diện web chọn môi trường** (luồng thông thường, thay cho select/confirm và qa:policy confirm): Claude chạy nền, bạn chọn môi trường rồi bấm "Xác nhận môi trường" và (nếu cần ghi) nút riêng "Xác nhận chính sách ghi dữ liệu". `--check` chỉ kiểm tra xem có thể dùng lại không; `--change` ép mở lại để đổi môi trường |
| `npm run qa:env -- select --env=STAGING_A` | **Chọn** môi trường làm việc (chưa xác nhận, chưa kết nối). Claude hỏi bạn chọn ở đầu Giai đoạn 2 |
| `npm run qa:env -- confirm --env=STAGING_A --requirement=REQ-XXX` | **Bạn** xác nhận cho phép thực thi trên đúng môi trường này (gõ lại `EXECUTE <ENV> <host>`, cần bàn phím thật) |
| `npm run qa:env -- status` | Môi trường đang chọn, xác nhận còn hiệu lực, nơi lưu kết quả |
| `npm run qa:env -- revoke --env=STAGING_A` / `clear` | Thu hồi xác nhận / bỏ chọn |
| `npm run qa:env -- adopt-legacy --env=STAGING_A` | **Sao chép** (không di chuyển) sổ dữ liệu test cũ `testdata/registry.jsonl` vào môi trường này |

Quy tắc bằng code:

1. **Phê duyệt dùng chung, quyền thực thi thì không.** APPROVE áp dụng cho mọi môi trường nếu nội dung test case không đổi, nhưng mỗi môi trường phải được bạn xác nhận riêng (`confirm`): có chữ ký, gắn host và hash phê duyệt, hết hạn sau 24 giờ, mất hiệu lực nếu phê duyệt hoặc host trong `.env` đổi. Quyền **ghi dữ liệu** (`test:write`) là xác nhận thứ ba, riêng cho (môi trường, host, module, lần chạy); môi trường loại `production` bị từ chối ghi.
2. **Chặn khi chưa chọn/chưa xác nhận hoặc URL lạ.** `npm test`, `test:write`, hook Playwright MCP và từng test đều từ chối. Hook MCP chặn mọi lệnh có URL khác host của môi trường đã chọn; test chặn điều hướng trang chính sang host khác.
3. **Không tự chuyển môi trường.** Đăng nhập lỗi, thiếu tài khoản hoặc sai phiên bản thì test của vai trò đó BLOCKED kèm lý do; không thử môi trường/tài khoản khác. Muốn đổi: tự `select` + `confirm` lại.
4. **Xác minh trước khi chạy** (project `setup-<app>`): URL thực tế đúng môi trường, tài khoản thực tế đúng tài khoản của vai trò, phân quyền (vai trò `noaccess` không được là quản trị), phiên bản khớp `*_VERSION`. "Không đọc được" coi là không đạt.
5. **Tách riêng theo môi trường:** phiên `.auth/<ENV>/<app>-<role>.json`, kết quả/evidence/Run ID/Bug/báo cáo `reports/<ENV>/`, sổ dữ liệu `testdata/registry/<ENV>.jsonl`, fixture `testdata/fixtures/<ENV>/`. Bug ID: `BUG-<ENV>-<RunID>-<TC>`. Trộn kết quả hai môi trường trong một thư mục bị từ chối. Dữ liệu cũ (`reports/`, `.auth/odoo-*.json`, `testdata/registry.jsonl`) được giữ nguyên.
6. **Playwright MCP:** khi đổi môi trường hãy đóng trình duyệt MCP (`browser_close`) và dùng phiên mới; nên chạy MCP với `--isolated --storage-state=.auth/<ENV>/<app>-<role>.json`. Hook không kiểm soát được cookie trong hồ sơ trình duyệt MCP, đây là việc của người vận hành.

Chuyển từ cấu hình cũ (`ODOO_URL`, `ODOO_ACCOUNTANT_USER`...): đổi tên biến trong `.env` thành bộ biến của môi trường tương ứng (ví dụ `ODOO_STAGING_A_URL`) và thêm `ODOO_STAGING_A_VERSION`. Kết quả cũ trong `reports/` vẫn dựng lại được bằng `npm run report:rebuild` khi chưa chọn môi trường.

## Chính sách ghi, dữ liệu test tự sinh và cleanup (staging chuyên dụng cho kiểm thử)

**Quyền ghi của từng test case** do metadata thực thi quyết định (`automation/<app>-<module>/<REQ>.automation.json`: READ/WRITE, vai trò, chiến lược dữ liệu, cleanup), **không** suy từ chữ trong nội dung test case. Metadata nằm ngoài nội dung đã duyệt nên bổ sung khi viết automation không làm mất phê duyệt. Test case chưa khai báo được coi là GHI và bị chặn cho tới khi có chính sách ghi. Xem `automation/README.md`.

Staging được coi là môi trường chuyên dụng cho kiểm thử: **sau khi bạn xác nhận MỘT lần chính sách của môi trường cho phiên chạy, Claude được tự tạo, sửa và cleanup dữ liệu DO FRAMEWORK TẠO** mà không xin phép từng thao tác. Dữ liệu nghiệp vụ có sẵn không bao giờ bị dùng/sửa/xóa.

| Lệnh | Việc |
|---|---|
| `npm run qa:policy -- show [--env=STAGING_A]` | Chính sách hiệu lực (khai báo ở mục `policy` của `environments/<app>.json`; production luôn `none`) |
| `npm run qa:policy -- confirm --env=STAGING_A --requirement=REQ-XXX` | **Bạn** xác nhận chính sách một lần (gõ `ALLOW-WRITE <ENV> <host> <hash>`, cần bàn phím thật). Hiệu lực 8 giờ, mất hiệu lực nếu đổi chính sách/phê duyệt/host |
| `npm run qa:policy -- status` / `revoke --env=...` | Xem / thu hồi xác nhận |
| `npm run test:write -- --env=STAGING_A --module=odoo-sales` | Chạy test ghi: có chính sách hợp lệ thì tự cấp giấy phép (không hỏi host nữa); sau đó dựng QA Report rồi tự cleanup nếu `autoCleanup` bật |
| `npm run cleanup:run -- --run=<RunID> [--dry-run] [--retry-blocked]` / `--due` | Cleanup thủ công/thử lại/dọn dữ liệu test FAIL đã hết hạn giữ. Chỉ chạy khi báo cáo của lần chạy đã dựng |

`policy` (trong `environments/<app>.json`): `write` (`none` | `framework-data`), `autoCleanup`, `failureRetentionHours` (giữ dữ liệu test FAIL để điều tra, mặc định 48; 0 = dọn ngay), `maxRecordsPerRun` (mặc định 200). `.env`: `AUTO_CLEANUP=false` chỉ có thể TẮT; `QA_PRODUCTION_HOSTS=host1,host2` thêm một lớp chặn.

Quy tắc bằng code:

1. **Ba xác nhận độc lập:** APPROVE test case, xác nhận môi trường (`qa:env`), xác nhận chính sách ghi (`qa:policy`). Không cái nào suy ra cái nào. Giấy phép ghi vẫn khóa theo (môi trường, host, module, lần chạy).
2. **Production không bao giờ có quyền ghi tự động, kể cả cấu hình sai:** bị chặn nếu `kind=production`, hoặc tên/khoá/nhãn/host có từ `prod`/`production`/`live`, hoặc host nằm trong `QA_PRODUCTION_HOSTS`. Chặn ở chính sách hiệu lực, xác nhận, giấy phép ghi, runner và cleanup.
3. **Test Data Factory** (`core/testdata/factory.ts`, công thức Odoo ở `applications/odoo/factory.ts`): tự sinh khách hàng, sản phẩm, serial, SO, DO, thanh toán theo thứ tự phụ thuộc (`salesPlan(...)`). Mỗi bản ghi mang tên/tham chiếu `AUTOTEST`, thẻ `QA env=… run=… req=… tc=…` trong dữ liệu, và được đăng ký ngay vào registry với Environment ID, Run ID, Requirement ID, Test Case ID, owner `FRAMEWORK`, quan hệ phụ thuộc. Bản ghi hệ thống tự sinh (ví dụ phiếu giao của SO) cũng được đăng ký. Giới hạn số bản ghi mỗi lần chạy; chỉ sửa được bản ghi do chính lần chạy này tạo.
4. **Thứ tự bắt buộc:** kết quả → QA Report + Bug Report + evidence (`qa:finish`) → cleanup. Cleanup từ chối chạy nếu báo cáo chưa có hoặc cũ hơn kết quả.
5. **Cleanup chỉ động vào dữ liệu framework:** bản ghi trong registry của đúng môi trường, origin `AUTOMATION`, owner `FRAMEWORK`. Không đụng dữ liệu ngoài registry, dữ liệu cũ chưa có chủ sở hữu, `BACKFILL`. Dọn con trước gốc sau; huỷ/lưu trữ chứ không xoá chứng từ. Chứng từ bị ràng buộc kế toán/kho (đã đối soát, kỳ khoá, đã hoá đơn, phiếu giao hoàn tất...) ⇒ `CLEANUP_BLOCKED` kèm bản ghi + nguyên nhân (đã che bí mật). Lỗi cleanup **không** làm thay đổi kết quả kiểm thử.
6. **Test FAIL:** dữ liệu được giữ (`RETAINED`, kể cả bản ghi gốc) tới hết `failureRetentionHours`; sau đó `cleanup:run --due`. Báo cáo cleanup: `reports/<ENV>/cleanup/`.
7. **Bí mật:** URL, tài khoản, mật khẩu, cookie nằm trong `.env`/`.auth/`/`.qa-state/` (đều bị `.gitignore`); `package:share` coi địa chỉ staging trong `.env` là bí mật, che trong báo cáo chia sẻ và quét ZIP.

8. **Playwright MCP cũng bị cổng ghi:** hook phân loại thao tác theo ý định (click/gõ có nhãn Lưu, Xác nhận, Tạo hóa đơn, Hủy, Xóa, Validate, Thanh toán...; phím Lưu; mã tự do gọi RPC ghi hoặc click/gõ). Chưa có chính sách ghi hợp lệ hoặc là production ⇒ bị chặn; được qua thì ghi `.qa-state/mcp-writes.jsonl`. Đây là heuristic, không thay thế quy tắc "chỉ ghi lên bản ghi trong registry".
9. **Lần kiểm chứng đầu trên môi trường thật:** `npm run odoo:probe` (chỉ đọc: phiên bản, API ORM, trường, quyền), rồi chạy một test case với `npm run test:write -- --env=<TÊN> --module=<app>-<module> --no-auto-cleanup` (giữ dữ liệu), rồi `npm run cleanup:run -- --run=<RunID> --dry-run`.

**Chưa kiểm chứng trên Odoo thật:** các lệnh ORM của Factory và các bước cleanup (huỷ thanh toán/phiếu giao/SO, lưu trữ khách hàng-sản phẩm, xoá serial chưa dùng) theo API Odoo 18 nhưng mới chạy trên ORM giả lập. Lần đầu trên staging hãy chạy MỘT test case, xem `reports/<ENV>/cleanup/`; lỗi được ghi `CLEANUP_BLOCKED` thay vì làm hỏng dữ liệu.

## 1. Cài đặt (chi tiết)

Yêu cầu: Node.js 20+ và Chrome (hoặc `npx playwright install chromium`).

```bash
npm install
cp .env.example .env     # rồi tự điền; KHÔNG commit .env
npm run typecheck
npm run test:framework   # tự kiểm tra framework, không kết nối hệ thống nào
```

## 2. Cấu hình

Điền `.env` (xem chú thích trong `.env.example`): với mỗi môi trường, địa chỉ, phiên bản kỳ vọng và tài khoản theo từng vai trò. Danh sách môi trường ở `environments/<app>.json`. Kiểm tra: `npm run qa:env -- check`.
Giữ `ALLOW_WRITE_TESTS=false`. Test ghi dữ liệu chỉ chạy bằng `npm run test:write -- --module=<app>-<module>` trên môi trường đã chọn và xác nhận (gõ lại tên host; production bị từ chối).

## 3. Thêm ứng dụng / module

```bash
npm run new:module -- odoo purchase     # module Odoo mới (tự đăng ký, không cần sửa playwright.config.ts)
npm run new:app -- misa                 # ứng dụng web khác Odoo
```

Lệnh chỉ tạo khung (thư mục, fixture mẫu, API/Page Object trống); không sinh requirement hay test case mẫu.

## 4. Dùng với requirement thật

1. Soạn requirement theo `example/requirements/TEMPLATE.md` (Path / Business Requirement / Expected Solution / Business Rules / Acceptance Criteria).
2. `npm run req:import -- <app> <module> <file.md> --id=REQ-XXX` (công cụ sao chép bản nguồn nguyên byte, khoá sha256, BR/AC giữ nguyên văn; kiểm tra lại bất cứ lúc nào bằng `npm run req:verify`). Văn bản dán trực tiếp chỉ được bảo đảm nguyên văn từ file lưu trong `requirements/_inbox` trở đi: có thể dùng đường dẫn file hoặc `--expect-sha256=<hash>` để chắc chắn.
3. Test case theo `example/testcases/TEMPLATE.md` (AC có nhiều trường hợp độc lập: mỗi trường hợp một test case); kiểm tra phủ và nguyên văn: `npm run req:check`.
4. Sau khi chạy: `npm run report:rebuild` rồi `npm run report:verify` (JSON, HTML và `reports/qa-summary.md` phải khớp nhau; số liệu tổng kết lấy từ `qa-summary.md`).
4. Ghim bản ghi dùng để kiểm thử trong `testdata/fixtures/<ENV>/<app>-<module>.json` (mỗi môi trường một file vì ID khác nhau; không dùng "bản ghi mới nhất").
5. Chạy chỉ đọc (sau `qa:env select` + `confirm`): `npm test -- --requirement=<REQ-ID>` (một requirement; cổng chỉ xét requirement đó) hoặc `npm test -- --project=<app>-<module>` (cả module: mọi requirement trong module phải được duyệt). Báo cáo: `reports/<ENV>/qa-report.html`.
6. Dựng lại báo cáo không chạy lại test: `npm run report:rebuild`.

Trong Claude Code có thể dùng lệnh `/qa-requirement` để chạy cả quy trình; Claude sẽ dừng hỏi khi thiếu thông tin nghiệp vụ, tài khoản hoặc cần thao tác thay đổi dữ liệu.

## 5. An toàn

- Mọi test mặc định chỉ đọc; không tạo/sửa/xóa chứng từ.
- `npm run cleanup:plan`: chỉ lập kế hoạch (dry-run), không xóa gì.
- `npm run security:scan`: dò bí mật trong báo cáo/trace; `npm run security:scrub`: che cookie trong trace (mặc định chỉ báo cáo).
- `npm run package:share` / `npm run package:template`: đóng gói không kèm `.env`, `.auth`, trace, video.
