# QA Automation Framework (Playwright + TypeScript)

README.md/CLAUDE.md mô tả MCP server tự viết của repo; file này mô tả framework kiểm thử nằm cùng workspace.

```
Requirement → Phân tích BR/AC → Test case → Khám phá UI (Playwright MCP) → Page Object → Test → Chạy → Bug → QA Report + evidence
```

## Giao diện QA Report ("REPORT BUG REQ[...]")
`core/reporters/render-html.ts` dựng `reports/<ENV>/qa-report.html` theo bản thiết kế của người dùng: tiêu đề + Làm mới/Xuất PDF/Xuất báo cáo, bảng Chỉ số thực thi 7 ô CHỈ ĐỌC (phạm vi requirement đang xử lý; số liệu toàn bộ gồm lịch sử ở dòng riêng), thanh tab (Tất cả/Pass/Fail/Block/Need Clarify/Not run/Ma trận truy vết/Lịch sử test), thẻ từng test case (Description, Steps, Actual, Expected, video + ảnh bug có phóng to, Defect), RTM và lịch sử chạy. Các thuộc tính `data-filter`/`data-focus`/`data-status` là hợp đồng cho `report:verify`. Mức tiêu thụ của AI engine không do framework đo nên cột này hiển thị "Không ghi nhận". Test: `tests/framework/multimodule.spec.ts`, `tests/framework/phase2.spec.ts`.

## Quy trình end-to-end một lệnh
`/qa-requirement` là điểm bắt đầu duy nhất. `core/workflow/next.ts` (CLI `npm run qa:next`) suy ra BƯỚC TIẾP THEO từ trạng thái thật trên đĩa (không tin "tiến độ" lưu riêng) nên đóng phiên rồi gọi lại vẫn tiếp tục đúng chỗ; `core/workflow/setup.ts` (CLI `npm run setup`) kiểm tra cài đặt lần đầu. Các giai đoạn: NO_REQUIREMENT → NEEDS_TESTCASES → READY_TO_SUBMIT → AWAITING_APPROVAL (DỪNG chờ người dùng) → [NEEDS_REVISION | REJECTED | APPROVAL_INVALID] → NEEDS_SETUP → NEEDS_ENVIRONMENT → NEEDS_WRITE_POLICY → NEEDS_LOGIN/LOGIN_FAILED → NEEDS_PROBE/PROBE_FAILED → NEEDS_AUTOMATION → READY_TO_RUN → RUN_COMPLETE. Điều phối chỉ ĐỌC; mọi cổng (Approval, Environment, Write Policy, hook) vẫn do code kiểm soát. Test: `tests/framework/workflow.spec.ts`.

## Cấu trúc

| Thư mục | Vai trò |
|---|---|
| `core/` | **Dùng chung, không biết gì về Odoo/Sales/Purchase**: cấu hình, fixtures Playwright, write guard, registry, cleanup, báo cáo, bảo mật, phân tích requirement |
| `applications/<app>/` | Cấu hình đăng nhập + role của từng ứng dụng web (đăng ký ở `applications/index.ts`) |
| `applications/odoo/client.ts` | Client RPC dùng chung của mọi module Odoo |
| `applications/odoo/modules/<module>/` | **Mọi thứ riêng của một module**: `module.ts` (khai báo), `api.ts`, `fixtures.ts`, `pages/`, `cleanup.ts`. Đăng ký ở `modules/index.ts`. Hiện có: `sales`, `purchase` (khung, chưa có nghiệp vụ) |
| `requirements/<app>-<module>/` | Requirement (JSON, BR/AC nguyên văn + `.lock`) |
| `testcases/<app>-<module>/` | Test case sinh từ BR/AC, mỗi test case có `requirementRefs` |
| `tests/<app>-<module>/` | Script test; mỗi thư mục là một Playwright project (tự phát hiện) |
| `tests/framework/` | Test kiểm tra bản thân framework (không Odoo, không tạo dữ liệu) |
| `testdata/` | `fixtures/<app>-<module>.json` (dữ liệu ghim), `registry.jsonl` (dữ liệu automation đã tạo) |
| `reports/` | `qa-report.html`, `qa-results.json`, `bugs.json`, `runs/<runId>/` (kết quả + video/screenshot/trace từng lần chạy) |
| `scripts/` | Công cụ: chạy test, scaffold, nhập requirement, cleanup, bảo mật... |

Test dùng `core/fixtures/base.ts`; mỗi module mở rộng bằng fixture riêng (`modules/<module>/fixtures.ts`).

## 0. Nhiều môi trường (STAGING_A, STAGING_B, UAT...)

Chế độ `"confirmation": "approval"` trong `environments/<app>.json` (kèm `defaultEnvironment`): APPROVE test case là xác nhận duy nhất của người dùng, không còn màn hình xác nhận môi trường/chính sách ghi; production không bao giờ được suy ra. Mặc định `explicit` giữ hai xác nhận riêng.

Cùng một ứng dụng có thể có nhiều môi trường. Cấu hình: `environments/<app>.json` (chỉ tên biến) + `.env` (URL, tài khoản theo vai trò, phiên bản kỳ vọng). Code: `core/environment/` (`config.ts` giải biến, `state.ts` chọn/xác nhận/chặn URL, `session.ts` đăng nhập + xác minh, `paths.ts` đường dẫn theo môi trường, `active.ts` môi trường đang chạy + chặn điều hướng), CLI `npm run qa:env`.

Luồng thông thường: giao diện web `qa:env-web` (`core/environment/web.ts`, `server.ts`, `scripts/env-review.ts`; cùng mô hình bảo vệ với Review & Approval: 127.0.0.1, mã phiên, nonce dùng một lần, Host/Origin, giới hạn số lần thử, hộp thoại hệ điều hành riêng cho từng nút, nhật ký `approvals/<REQ>/web-audit.jsonl`; backend gọi lại đúng `selectEnvironment`/`confirmExecution`/`confirmPolicy` nên giữ chữ ký HMAC và mọi ràng buộc; xác nhận môi trường và xác nhận chính sách ghi là hai nút/hai hộp thoại độc lập; xác nhận còn hiệu lực thì dùng lại). Test: `tests/framework/env-web.spec.ts`. Luồng dự phòng (terminal): `qa:env select` → người dùng `qa:env confirm` (riêng từng môi trường/requirement) → `npm test` (đặt `QA_ENV`) → setup đăng nhập + xác minh (URL, tài khoản, phân quyền, phiên bản) → test → `reports/<ENV>/`. Phê duyệt test case dùng chung; xác nhận thực thi và quyền ghi (`test:write`, có khoá môi trường trong giấy phép) thì riêng từng môi trường. Đăng nhập lỗi/thiếu tài khoản/sai phiên bản ⇒ BLOCKED, không bao giờ tự chuyển môi trường. Phiên, báo cáo, evidence, Bug ID (`BUG-<ENV>-<RunID>-<TC>`), sổ dữ liệu test và fixture tách riêng theo môi trường. Chi tiết và bảng lệnh: `INSTALL.md`. Test của cơ chế này (môi trường và máy chủ Odoo giả lập, không kết nối hệ thống thật): `tests/framework/environments.spec.ts`.

## 0A. Quy trình tự động: Review web → Approval → Giai đoạn 2 → QA Report

- **Review & Approval trên web:** `core/approval/web.ts` (logic quyết định + trang HTML), `core/approval/server.ts` (máy chủ 127.0.0.1), `core/approval/open.ts` (mở trình duyệt, hộp thoại hệ điều hành), CLI `npm run qa:review`. Backend gọi lại approve/revise/reject của `core/approval/approval.ts` nên giữ nguyên hash, chữ ký HMAC, lịch sử và tự INVALIDATED; `approvals/<REQ>/web-audit.jsonl` ghi mọi lần thử (kể cả bị từ chối). APPROVE cần: đúng phiên bản + hash + toàn vẹn requirement, cụm xác nhận gõ tay, và xác nhận của người thật qua hộp thoại hệ điều hành. Hook `scripts/guard-bash.mjs` (Bash/PowerShell) chặn lệnh gọi API review hoặc đặt biến vượt cổng; hook MCP giữ nguyên. Terminal `qa:approval approve` vẫn là phương án dự phòng.
- **Giai đoạn 2:** `npm run qa:ready` (`core/automation/readiness.ts`) kiểm tra offline phê duyệt, môi trường, tài khoản, spec, fixture; phân loại dự kiến ELIGIBLE/BLOCKED/NOT RUN/NEEDS CLARIFICATION và gom MỘT danh sách câu hỏi. Không tạo PASS/FAIL giả; kết quả thật chỉ đến từ lần chạy.
- **Đóng lần làm việc:** `npm run qa:finish` (và `npm test` tự gọi) dựng lại báo cáo, đối chiếu JSON/HTML/QA Summary/Bug Report và mở QA Report; chạy cả khi không test nào chạy được. Báo cáo theo môi trường (`reports/<ENV>/`) có khối **requirement đang xử lý** (`focus`): danh sách mặc định lọc theo requirement đó, số liệu toàn bộ/lịch sử tách riêng. Khối này có thêm nguồn kết quả (lần chạy gần nhất / các lần trước = lịch sử / chưa từng chạy). Chạy độc lập theo requirement (`--requirement`): `core/approval/scope.ts`. Test: `tests/framework/approval-web.spec.ts`, `tests/framework/phase2.spec.ts`, `tests/framework/requirement-scope.spec.ts`.

## 0B. Chính sách ghi, Test Data Factory, registry, cleanup

**Phạm vi cleanup (bất biến):** framework chỉ được hủy, archive hoặc dọn bản ghi do chính lần chạy kiểm thử tạo ra, có bằng chứng quyền sở hữu (registry `origin=AUTOMATION`, `owner=FRAMEWORK`, đúng môi trường, và nhãn AUTOTEST hoặc liên kết với chứng từ test trên Odoo) và được xác nhận an toàn ngay trước khi dọn. Không sửa hoặc xóa dữ liệu có sẵn, dữ liệu không rõ nguồn gốc (BACKFILL, ngoài registry) hay dữ liệu đã phát sinh nghiệp vụ không hoàn tác an toàn; các trường hợp đó là `CLEANUP_BLOCKED` hoặc không được chọn, và do người phụ trách nghiệp vụ xử lý.

Quyền ghi theo test case lấy từ metadata thực thi `automation/<app>-<module>/<REQ>.automation.json` (READ/WRITE, role, chiến lược dữ liệu, cleanup), tách khỏi nội dung test case đã duyệt (không đổi hash/phê duyệt). Chưa khai báo hoặc khai báo sai ⇒ mặc định GHI (chặn); test khai báo READ mà gọi `writeGuard()`/Factory sẽ lỗi. Chi tiết: `automation/README.md`.

**Thích ứng mọi module Odoo (Community, Enterprise, bên thứ ba, tùy chỉnh):** lõi không biết model nghiệp vụ nào. Khám phá chỉ đọc (`applications/odoo/introspect.ts`: phiên bản, edition, module đã cài, `fields_get`, nút trên form) sinh ra **adapter khai báo** `adapters/<app>/<module>.adapter.json` (model, nhãn AUTOTEST, các bước Confirm/Validate/Post/Cancel có thật, cách dọn). Adapter ghi phiên bản/edition/dấu vết cấu trúc đã kiểm chứng; môi trường khác đi ⇒ `REVERIFY`, thiếu module ⇒ `UNAVAILABLE` (test BLOCKED vì thiếu điều kiện môi trường, không phải FAIL). Factory tổng quát (`applications/odoo/generic.ts`) tự dựng phụ thuộc theo lược đồ và chạy các bước kèm kiểm tra trạng thái; cleanup tổng quát (`generic-cleanup.ts`) dọn theo adapter, trạng thái cuối ⇒ `CLEANUP_BLOCKED`. Tài khoản chỉ được đòi cho vai trò mà test case dùng (`core/automation/roles.ts`, trạng thái `NEEDS_ROLES`). **Giới hạn:** adapter/factory tự sinh mới được kiểm chứng trên Odoo GIẢ (`tests/framework/universal.spec.ts`); giá trị do onchange tính, wizard đặc thù và quy trình huỷ của từng module chưa được kiểm chứng trên Odoo thật, nên lần đầu cho mỗi module phải chạy `--no-auto-cleanup` và xem kết quả.

- `core/policy/policy.ts`: chính sách hiệu lực theo môi trường (`effectivePolicy`, production luôn `none`), xác nhận một lần cho phiên (`confirmPolicy`/`policyCheck`, chữ ký HMAC cùng khóa phê duyệt), CLI `npm run qa:policy`. Runner (`scripts/run-tests.ts`) có chính sách hợp lệ thì tự cấp giấy phép ghi và đặt `QA_POLICY`; sau `qa:finish` tự gọi `scripts/cleanup-run.ts` nếu `autoCleanup`.
- `core/testdata/factory.ts` + `applications/odoo/factory.ts`: Test Data Factory (công thức partner/product/serial/sale.order/delivery/payment, `build(plan)` theo thứ tự phụ thuộc, cổng ghi + giới hạn bản ghi, đăng ký registry ngay khi tạo).
- `core/testdata/registry.ts`: sổ riêng mỗi môi trường (`testdata/registry/<ENV>.jsonl`), bản ghi có `environment`, `requirementId`, `testCaseId`, `runId`, `owner`, `dependsOn`, trạng thái `PENDING`/`RETAINED`/`CLEANED`/`CLEANUP_BLOCKED`.
- `core/testdata/cleanup-engine.ts` + `applications/odoo/factory-cleanup.ts` (và handler Sales): cleanup theo thứ tự phụ thuộc, giữ dữ liệu test FAIL, chặn chứng từ bị ràng buộc, báo cáo riêng, không đổi kết quả test. Test: `tests/framework/data-policy.spec.ts` (ORM giả `helpers/fake-orm.ts`).

## 1. Chạy test chỉ đọc (mặc định)

```bash
npm run typecheck
npm run test:framework                  # test của framework; kết quả ghi riêng vào reports/framework-tests.json
npm test                                # CHỈ ĐỌC: ép ALLOW_WRITE_TESTS=false, bỏ mọi giấy phép ghi
npm test -- --project=odoo-sales        # một module: MỌI requirement có test case trong module đều phải được duyệt
npm test -- --requirement=REQ-SO-INV-001 # MỘT requirement (mặc định của /qa-requirement): chỉ cổng + test case của nó; không kéo theo requirement khác cùng module
npm test -- -g "TC-SO-001"              # một test case
```

Test cần ghi dữ liệu sẽ **BLOCKED** (đúng thiết kế). **Giữ `ALLOW_WRITE_TESTS=false` trong `.env`.** `npx playwright test` trực tiếp vẫn đọc `.env`, nên `.env` phải là `false`.

## 2. Cấp quyền chạy test ghi dữ liệu

Chỉ khi bạn chủ động, **theo từng (môi trường, module, lần chạy)**:

```bash
npm run test:write -- --module=odoo-sales -g "TC-SO-010"
```
Lệnh hiển thị môi trường/module/lần chạy rồi **bắt gõ lại đúng tên host**. Giấy phép chỉ hiệu lực cho đúng ba thông tin đó và hết hiệu lực khi lệnh kết thúc. Thêm các lớp bảo vệ:
- Chỉ ghi lên dữ liệu **do chính lần chạy tạo** (`assertSafeToWrite`: có trong registry, tham chiếu `AUTOTEST <runId> <TC>`, đúng người tạo). Dữ liệu nghiệp vụ có sẵn và dữ liệu của người khác không bao giờ qua được.
- Nút ghi trên giao diện (ví dụ Xác nhận phiếu thu) chỉ bấm được qua hàm yêu cầu giấy phép ghi.
- Mỗi module khai báo model được ghi (`ownership`) trong `module.ts`. **Không khai báo = module chỉ đọc.**
- Test ghi dữ liệu không tự động bị xóa; dữ liệu được ghi vào registry (mục 9).

## 3. Thêm module Odoo mới

```bash
npm run new:module -- odoo inventory
```
Tạo `applications/odoo/modules/inventory/{module,api,fixtures}.ts`, `pages/`, các thư mục requirement/testcases/tests, `testdata/fixtures/odoo-inventory.json`, và tự đăng ký module. **Không** sinh requirement hay test case mẫu. Mặc định module **chỉ đọc** và cleanup **chưa hỗ trợ**. Việc còn lại: ghim dữ liệu vào fixture; khai báo `ownership` và handler cleanup khi cần ghi (xác minh trường bằng `fields_get`).

## 4. Thêm ứng dụng web mới (MISA, ...)

```bash
npm run new:app -- misa
npm run new:module -- misa invoices
```
Tạo `applications/misa/config.ts` (đăng nhập + role), đăng ký, thêm biến `MISA_*` vào `.env.example`. Việc cần làm tay: viết `login()` bằng locator đã xác minh. Ứng dụng không phải Odoo tự viết client riêng và dùng `core/testdata/write-guard` cho quyền ghi. Lõi không đổi.

## 5. Cung cấp requirement

Dán theo mẫu `example/requirements/TEMPLATE.md` (5 mục: Path, Business Requirement, Expected Solution, Business Rules `BR-xx:`, Acceptance Criteria `AC-xx:`) vào một file `.md`, rồi:

```bash
npm run req:import -- odoo purchase ./yeu-cau.md --id=REQ-PO-001
```
Công cụ chỉ **tách phần**, giữ **nguyên văn** BR/AC, từ chối nếu thiếu mục hoặc trùng mã (không tự đoán), rồi khoá BR/AC (`.lock`). Làm rõ nghiệp vụ về sau ghi vào `notes`, **không** sửa BR/AC (test FW-05 sẽ lỗi nếu BR/AC bị đổi).

## 6. Cách Claude tạo test case

Gõ `/qa-requirement REQ-PO-001`. Quy trình có **Approval Gate bắt buộc**: Giai đoạn 1 (nhập → sinh test case → `req:check` → submit, trạng thái `PENDING_APPROVAL`, file Markdown review ở `approvals/<REQ-ID>/v<N>/`) rồi DỪNG, tuyệt đối chưa staging/Playwright MCP/automation. Người dùng APPROVE (tự gõ trong terminal, gắn phiên bản + hash), REVISE (giữ phiên bản cũ) hoặc REJECT. Giai đoạn 2 (chỉ sau APPROVE hợp lệ): khám phá UI bằng Playwright MCP → Page Object + test → typecheck/framework test → chạy chỉ đọc → bug → báo cáo. Sửa test case sau khi duyệt tự hủy phê duyệt; quyền ghi staging xin riêng. Kiểm soát bằng code (xem INSTALL.md, mục Approval Gate): `scripts/run-tests.ts`, `playwright.config.ts`, `core/fixtures/base.ts`, hook `.claude/settings.json`. Quy tắc cứng (xem `.claude/commands/qa-requirement.md`): không sửa BR/AC, không chỉnh expected theo hành vi thực tế, không tự chuyển BLOCKED/NEEDS CLARIFICATION thành PASS, không ghi dữ liệu khi chưa được cấp quyền. Ba chốt chặn do công cụ thực thi (không tin vào việc Claude tự làm): (1) AC có "lần lượt/từng/mỗi" mà chỉ có 1 test case bị `req:check` báo lỗi; (2) `req:import` sao chép bản nguồn nguyên byte, khoá sha256 và tự đối chiếu BR/AC từng ký tự (`npm run req:verify`); (3) `npm run report:rebuild` sinh `qa-results.json`, `qa-report.html`, `qa-summary.md` từ cùng một nguồn và `npm run report:verify` đối chiếu cả ba với dữ liệu chạy. Mã BR/AC được truy vết **theo từng requirement** (`BR-01` của hai requirement khác nhau là hai mục khác nhau).

## 6A. Lưu dữ liệu và Xác nhận nghiệp vụ

Lưu chỉ ghi lại thông tin đang nhập. Xác nhận mới là lúc chứng từ được ghi nhận và các kiểm tra nghiệp vụ có thể chạy. Một giá trị đã Lưu trên chứng từ chưa xác nhận là dữ liệu nháp, chưa phải thông tin có hiệu lực.

Quy tắc khi làm việc với requirement:

1. Trước khi viết test case, xác định **mốc ghi nhận** của chứng từ: bước nào làm thông tin có hiệu lực, và kiểm tra nghiệp vụ được mong đợi ở bước nào.
2. Requirement ghi "lưu" hoặc "chặn lưu" mà chứng từ có bước xác nhận riêng thì đó là điểm mơ hồ ảnh hưởng Expected: hỏi BA, ghi `needsClarification`. Không tự đổi BR/AC và không tự chọn mốc.
3. Test case nêu rõ thao tác cuối là Lưu hay nút xác nhận cụ thể, và Expected thuộc mốc nào.
4. Tiền điều kiện kiểu "đã có", "đã gắn", "đã ghi nhận" phải được dựng bằng dữ liệu đã qua mốc ghi nhận, không dùng dữ liệu nháp.
5. Assertion chạy sau đúng mốc và đọc bản ghi có hiệu lực, không chỉ đọc dòng nháp.
6. Báo cáo nêu test đã dừng ở mốc nào. FAIL xảy ra trước mốc ghi nhận không được dùng để kết luận hệ thống thiếu kiểm tra ở mốc đó.

Mốc ghi nhận theo loại chứng từ (nhãn nút và cơ chế phải xác minh trên giao diện thật của từng môi trường, kể cả khi module đã tùy biến):

| Chứng từ | Lưu | Mốc ghi nhận | Tình trạng |
|---|---|---|---|
| Phiếu kho (nhập, xuất, điều chuyển) | Lưu ở Hoạt động chi tiết là trung gian; "Sẵn sàng" chưa phải hoàn tất | Nút "Xác nhận" trên phiếu (`button_validate`), trạng thái `done` | Đã xác minh trên STAGING_A; chặn trùng EIN do người dùng kiểm tra thủ công |
| Đơn bán hàng | Báo giá chưa phải đơn đã xác nhận | `sale.order.action_confirm` | Chưa xác minh nhãn nút |
| Đơn mua hàng | Yêu cầu báo giá chưa phải đơn đã xác nhận | `purchase.order.button_confirm` | Chưa xác minh trên môi trường |
| Thanh toán, hóa đơn | Bản nháp chưa ghi sổ | `action_post` | Chưa xác minh nhãn nút |
| Liên hệ | Thường không có bước xác nhận, Lưu có thể chính là mốc ghi nhận | Xác định theo từng requirement | Chưa xác minh; không mặc định |

Lưu ý: trên phiếu kho, `action_confirm` chỉ đưa phiếu sang "Sẵn sàng", còn nút có nhãn "Xác nhận" mới hoàn tất phiếu. Cùng một chữ "xác nhận" có thể chỉ hai bước khác nhau, nên test case ghi rõ nhãn nút và trạng thái sau đó. Gặp loại chứng từ mới thì bổ sung một dòng vào bảng này sau khi đã xác minh.

## 7. Xem QA Report

Mở `reports/qa-report.html`: **tổng quan → danh sách → chi tiết**. Ở đầu trang là 8 ô chỉ số (Total, PASS, FAIL, BLOCKED, NEEDS CLARIFICATION, NOT RUN, Execution Pass Rate, Overall Pass Coverage). Bấm ô trạng thái để mở danh sách đã lọc (BLOCKED/NEEDS CLARIFICATION kèm lý do); bấm hai ô tỷ lệ để xem công thức và số liệu cấu thành; "Bỏ lọc" / "Về tổng quan" đưa về trạng thái đầu. Mọi mục (danh sách, lịch sử chạy, Bug, Truy vết BR/AC) mặc định thu gọn. (Báo cáo tự được dựng sau mỗi lần chạy; `npm run report:rebuild` dựng lại từ kết quả đã lưu, không chạy lại test).
- **Execution Pass Rate** = Passed / (Passed + Failed). **Overall Pass Coverage** = Passed / Tổng test case. Hai chỉ số khác nhau; BLOCKED, NEEDS CLARIFICATION, NOT RUN không được tính là đạt.
- Lọc theo trạng thái, **Application, Module, Requirement**, loại kiểm tra; tìm theo mã.
- **Truy vết BR/AC**: mỗi BR/AC nguyên văn kèm test case và trạng thái; BR/AC chưa phủ bị đánh dấu.
- Mỗi test case: Description/Step/Expected/Actual, video, screenshot, trace, role chạy (cảnh báo khi là tài khoản quản trị), lý do BLOCKED/NEEDS CLARIFICATION.
- **Lịch sử chạy**: mỗi lần một dòng (thời điểm, application/module, số test, PASS/FAIL/BLOCKED/NEEDS CLARIFICATION/NOT RUN, thời lượng; thiếu mốc thời gian hợp lệ thì ghi "Không có dữ liệu"); bấm vào để xem kết quả và bằng chứng riêng của lần đó.
- **Lần chạy chỉ đọc không đè kết quả của test ghi**: test ghi bị BLOCKED vì chưa cấp quyền ghi là "chưa thực hiện", nên báo cáo vẫn hiển thị kết luận PASS/FAIL thật của lần chạy trước (cùng định nghĩa test case) kèm ghi chú.
- Giữ **lịch sử các lần chạy** (`reports/runs/<runId>/`); chạy lại một phần không xóa kết quả cũ. Nếu nội dung kiểm thử của test case đổi sau lần chạy, kết quả cũ hiện NOT RUN.
- Báo cáo **không** hiển thị framework/unit test và phần "cách đọc báo cáo" (đã loại khỏi mã sinh báo cáo). Framework test vẫn chạy bằng `npm run test:framework`, kết quả ghi vào `reports/framework-tests.json`.

## 8. Đọc Bug Report

Mục **Bug** trong báo cáo và `reports/bugs.json`, tự sinh từ mọi test FAIL trong toàn bộ lịch sử: Bug ID (`BUG-<runId>-<TC>`), Related Test Case, Steps to Reproduce, Expected, Actual, Evidence, Application, Module, Requirement, Run ID, thời gian phát hiện, Environment (máy chủ, role, quyền ghi). Đây là **báo cáo phát hiện, không phải kết luận**:
- `ĐANG MỞ`: lần chạy gần nhất của test case vẫn lỗi. `ĐÃ CÓ LẦN CHẠY SAU`: đã có kết quả mới hơn.
- `nghi lỗi hạ tầng` (mạng/trình duyệt như `ECONNRESET`, timeout điều hướng): chạy lại trước khi coi là bug. `Lỗi nghiệp vụ nghi ngờ`: kết quả thực tế khác mong đợi, kèm bằng chứng (thiếu bằng chứng sẽ được đánh dấu); QA xác nhận.
- **Kiểm chứng lại**: `Đã kiểm chứng lại` khi cùng test case (cùng định nghĩa) lỗi ở ≥ 2 lần chạy; `Không tái hiện` khi lần chạy sau PASS; `Chưa kiểm chứng lại` còn lại. Framework không tự chạy lại test và không đổi trạng thái test để làm đẹp báo cáo.

## 9. Quản lý dữ liệu AUTOTEST

- Mỗi lần chạy có `runId` (`YYYYMMDD-HHmmss`). Chứng từ do automation tạo mang tham chiếu `AUTOTEST <runId> <TC>` và được ghi vào **Test Data Registry** (`testdata/registry.jsonl`: runId, Test Case ID, application, module, model, recordId, reference, createdAt, cleanupStatus, origin). **Không tự động xóa**.
- `npm run registry:backfill`: đăng ký dữ liệu cũ (origin BACKFILL). Chỉ đọc Odoo.
- `npm run cleanup:plan [-- --module=odoo-sales] [-- --run=<runId>]`: **lập kế hoạch chỉ đọc** theo từng module (`reports/cleanup-plan.json|md`): kiểm tra liên kết, đối soát, khoá sổ...; đánh dấu bản ghi không đủ điều kiện.
- **Loại chứng từ chưa có quy trình hủy đã xác minh hiển thị `CHƯA HỖ TRỢ`**, không có bước nào được đề xuất. Không bao giờ mượn quy trình hủy SO cho PO, hóa đơn hay chứng từ kho.
- **Thực thi cleanup chưa được triển khai.** Khi được triển khai, cần cổng riêng: `--execute --module=<key> --plan-id=<mã> --confirm="<câu xác nhận>"` và `ALLOW_CLEANUP=true` (cổng đã có và được kiểm thử; không handler nào có hàm thực thi).
- Chứng từ đã ghi sổ không xóa cứng; Sales dự kiến: phiếu thu Reset to Draft → Cancel, SO Mở khoá → Hủy (xem `reports/cleanup-plan.md`).

- `npm run cleanup:plan` của module chưa có bản ghi nào trong registry và chưa đăng nhập vẫn chạy được (không kết nối hệ thống).

## 10. Xử lý BLOCKED và NEEDS CLARIFICATION

- **BLOCKED**: thiếu điều kiện để chạy (tài khoản theo vai trò, dữ liệu ghim đã đổi, môi trường không khớp, chưa cấp quyền ghi). Lý do hiển thị trong báo cáo. Gỡ bằng cách bổ sung điều kiện đó (điền `.env`, cập nhật fixture, cấp quyền ghi) rồi chạy lại. **Không** sửa test để vượt qua.
- **NEEDS CLARIFICATION**: requirement chưa đủ rõ, hoặc test đã chạy nhưng còn phần chưa kiểm chứng được. Gỡ bằng cách người có thẩm quyền làm rõ → ghi vào `notes` của requirement (kèm nguồn) → cập nhật test case → chạy lại. Không tự điều chỉnh expected.
- Hai trạng thái này không bao giờ được tính là đạt.

## Role và tài khoản

Mỗi ứng dụng khai báo nhiều role (mỗi role một cặp biến môi trường + mô tả) trong `applications/<app>/config.ts`; test chọn bằng `test.use({ role })`. Project `setup-<app>` ghi `.auth/<app>-<role>.meta.json` (tài khoản có quyền quản trị không): báo cáo cảnh báo khi một role chạy bằng tài khoản quản trị (chưa chứng minh hành vi của đúng vai trò). Role đặt `mustBeUnprivileged` sẽ BLOCKED nếu cấu hình nhầm tài khoản quản trị.

## Bảo vệ bí mật và chia sẻ

| Thứ | Nhạy cảm | Bảo vệ |
|---|---|---|
| `.env` | mật khẩu | `.gitignore`, không vào ZIP |
| `.auth/` | cookie phiên | `.gitignore`, không vào ZIP |
| `trace.zip` | request mạng có cookie | tự che cookie/Authorization sau mỗi lần chạy; `npm run security:scrub` kiểm tra/làm sạch trace cũ |
| video, ảnh | dữ liệu khách hàng thật | `.gitignore`; không đóng gói |
| kết quả/báo cáo | có thể vô tình ghi bí mật | mọi chuỗi qua bộ lọc che bí mật trước khi ghi |

- `npm run security:scan`: quét toàn dự án (cả trong file zip), liệt kê file cần xử lý, không in giá trị.
- `npm run package:share [-- --with-report]`: ZIP theo **danh sách trắng**, tự quét lại và xóa ZIP nếu rò rỉ. Không bao giờ kèm video/ảnh/trace.
- `npm run package:template`: **bộ cài đặt dùng chung** (`share/qa-framework-template-<thời điểm>.zip`): mã nguồn lõi, module mẫu, `.env.example`, `example/requirements/TEMPLATE.md`, `example/testcases/TEMPLATE.md`, `INSTALL.md`, `FRAMEWORK.md`, framework test. **Không** kèm requirement/test case/spec/fixture/registry/baseline nghiệp vụ hiện có, `.env`, `.auth`, báo cáo, video, trace. Giải nén vào thư mục mới → `npm install` → `npm run typecheck` → `npm run test:framework` (xem `INSTALL.md`).
- `npm run requirements:lock`, `npm run baseline:fields`: khoá BR/AC; chụp baseline trường (ảnh chụp SAU triển khai, không chứng minh "không thêm trường").
