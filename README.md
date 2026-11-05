# QA Automation Framework

Framework kiểm thử tự động theo yêu cầu nghiệp vụ (Playwright + TypeScript), điều khiển qua **Claude Code**: dán một requirement bằng tiếng Việt, framework tự sinh test case có truy vết BR/AC, dừng chờ con người **review và APPROVE**, rồi mới tự khám phá giao diện thật, viết automation, chạy theo đúng chính sách môi trường/quyền ghi đã xác nhận, và xuất **QA Report** kèm bằng chứng (video, ảnh, trace).

## 1. Framework này là gì

QA cho ứng dụng web thường tốn công ở ba chỗ: viết test case tay từ requirement, giữ an toàn khi test chạm vào môi trường và dữ liệu thật, và duy trì báo cáo/bằng chứng để đối chiếu khi có lỗi. Framework này giải quyết cả ba bằng một vòng lặp có cổng chặn do **code** kiểm soát (Approval Gate, Environment/Write Safety), không dựa vào việc AI "nhớ" phải cẩn thận.

- **Công nghệ chính:** TypeScript, Playwright Test, Playwright MCP (khám phá UI thật), Claude Code (`/qa-requirement`).
- **Phạm vi hỗ trợ đã xác minh:** lớp lõi (`core/`) không biết gì về ứng dụng cụ thể — mọi thuật ngữ Odoo chỉ xuất hiện trong comment ví dụ, trừ MỘT heuristic nhỏ nhận diện thao tác ghi của Odoo trong `core/policy/mcp.ts`. Hiện có **một** adapter ứng dụng được triển khai và kiểm chứng thật: **Odoo** (module Inventory và Sales đã chạy thật trên Odoo 19 staging; module Purchase mới ở dạng khung). **Chưa có ứng dụng thứ hai nào được kiểm chứng** — kiến trúc cho phép thêm (`npm run new:app`), nhưng đừng coi đó là đã kiểm chứng cho tới khi thật sự chạy qua.

## 2. Tính năng chính (đã hoạt động, đã kiểm chứng)

| Tính năng | Mô tả |
|---|---|
| Phân tích requirement | Nhập requirement 5 mục (Path/Business Requirement/Expected Solution/Business Rules/Acceptance Criteria), lưu nguyên văn BR/AC, khoá bằng hash (`req:import`, `req:verify`) |
| Sinh test case có truy vết | Mỗi test case liên kết tới đúng BR/AC; `req:check` xác nhận phủ đủ và nguyên văn |
| Review của con người | Giao diện web Review & Approval (`qa:review`) hoặc terminal: xem test case theo module, phủ BR/AC, lịch sử |
| **Approval Gate** | APPROVE/REVISE/REJECT có chữ ký HMAC gắn (phiên bản, hash); `npm test`/Playwright MCP bị **code** từ chối khi chưa có phê duyệt hợp lệ — xem mục 11 |
| Environment & Write Safety | Nhiều môi trường cùng ứng dụng (STAGING_A, STAGING_B, UAT...), xác nhận thực thi + xác nhận quyền ghi tách biệt, production không bao giờ được ghi tự động (ép bằng code) |
| Test Data Factory & Registry | Dữ liệu test tự sinh, gắn Environment/Run/Requirement/Test Case ID; mọi thao tác ghi chỉ trên dữ liệu có trong registry |
| Cleanup an toàn | Chỉ hủy/lưu trữ dữ liệu do chính lần chạy tạo ra và có bằng chứng sở hữu; chứng từ đã phát sinh nghiệp vụ không hoàn tác được → `CLEANUP_BLOCKED`, không đụng tới |
| QA Report | Dashboard theo requirement, cột Steps/Actual/Expected, evidence (video/ảnh/trace), Bug Report, lịch sử; `report:verify` đối chiếu JSON/HTML/tổng kết |
| Quét bí mật & đóng gói | `security:scan` (dò rò rỉ, không in giá trị), `package:share`/`package:template` (đóng gói không kèm `.env`/`.auth`/evidence thật) |

Chưa có: hỗ trợ ứng dụng thứ hai đã kiểm chứng, UI cấu hình ngoài các trang web tối giản của Approval/Environment Gate, hỗ trợ CI/CD dựng sẵn.

## 3. Bắt đầu nhanh

```bash
git clone <repo-url> && cd qa-automation-framework
npm install
npx playwright install chromium
cp .env.example .env            # điền sau, xem mục 6
npm run typecheck
npm run test:framework          # không kết nối mạng, phải đạt 100%
```

Mở thư mục bằng VS Code + Claude Code, gõ:

```
/qa-requirement
```

rồi dán một requirement (có thể thử ngay bằng `/qa-requirement example/requirements/SAMPLE-REQUIREMENT.md`, dữ liệu giả). Luồng đầy đủ: **Clone → Setup → `/qa-requirement` → Review → APPROVE → tự thực thi → QA Report**. Chi tiết: mục 7. Từng bước có thể dừng hỏi khi thiếu thông tin — framework gom mọi câu hỏi vào một lần, không hỏi vặt.

## 4. Yêu cầu hệ thống

**Bắt buộc:**
- Node.js 20 trở lên (và npm đi kèm).
- Trình duyệt Chromium của Playwright (`npx playwright install chromium`) hoặc Chrome có sẵn trên máy.
- [Claude Code](https://claude.com/claude-code) hoặc VS Code + Claude Code extension (framework điều khiển qua Claude Code; không có chế độ CLI thuần cho `/qa-requirement`).
- Tài khoản kiểm thử (không phải tài khoản quản trị thật) trên ứng dụng bạn định kiểm thử, nếu muốn chạy automation thật.

**Tùy chọn:**
- `BROWSER_CHANNEL=chrome` trong `.env` nếu muốn dùng Chrome cài sẵn thay vì Chromium của Playwright.
- Một môi trường Odoo (staging/UAT) nếu bạn kiểm thử Odoo; framework không đi kèm Odoo.

Playwright MCP server (`@playwright/mcp`, khai báo sẵn trong `.mcp.json`) được Claude Code tự khởi chạy qua `npx` khi cần — không phải cài riêng.

## 5. Cài đặt

```bash
npm install
npx playwright install chromium   # hoặc dùng Chrome: BROWSER_CHANNEL=chrome trong .env
cp .env.example .env
npm run setup -- --init           # kiểm tra cài đặt, liệt kê TÊN biến .env còn thiếu (không đọc được giá trị)
```

Điền `.env` một lần (xem mục 6), sau đó:

```bash
npm run setup       # phải báo "sẵn sàng"
npm run typecheck
npm run test:framework
```

`npm run test:framework` không kết nối ứng dụng nào — đây là cách kiểm tra cài đặt đúng mà không cần `.env` đầy đủ.

## 6. Cấu hình môi trường

Sao chép `.env.example` thành `.env` (không commit `.env`). File này gồm:

- `APP=odoo` — ứng dụng đang kiểm thử, khớp tên thư mục trong `applications/`.
- Mỗi môi trường (STAGING_A, STAGING_B, UAT...) một bộ biến riêng: `ODOO_STAGING_A_URL`, `..._DB`, `..._VERSION` (phiên bản kỳ vọng, framework đối chiếu trước khi chạy), và một cặp `..._USER`/`..._PASS` cho **từng vai trò** (ví dụ `accountant`, `noaccess`). Danh sách môi trường/vai trò khai báo ở `environments/<app>.json` (chỉ tên biến, không chứa giá trị).
- `ALLOW_WRITE_TESTS=false` — **giữ nguyên false**. Test ghi dữ liệu chỉ chạy qua `npm run test:write`, sau khi bạn xác nhận chính sách ghi; không set biến này để "mở khoá" trước.
- `BROWSER_CHANNEL`, `HEADLESS` — tuỳ chọn trình duyệt.

Không bao giờ dùng tài khoản quản trị thật cho vai trò `noaccess` — framework tự phát hiện và chặn test phân quyền thay vì cho kết quả sai. Kiểm tra cấu hình: `npm run qa:env -- check` (không kết nối mạng).

## 7. Requirement đầu tiên

1. Mở Claude Code trong thư mục dự án, gõ `/qa-requirement` và dán requirement theo 5 mục của `example/requirements/TEMPLATE.md` (Path / Business Requirement / Expected Solution / Business Rules / Acceptance Criteria). Muốn thử an toàn trước: `/qa-requirement example/requirements/SAMPLE-REQUIREMENT.md` (toàn dữ liệu giả).
2. Claude phân tích, tách BR/AC, sinh test case có liên kết BR/AC rõ ràng.
3. Bạn **review** test case trên giao diện web mà Claude tự mở (hoặc file Markdown offline).
4. Cần sửa gì, trả lời bằng ngôn ngữ tự nhiên ("TC-EIN-002 thêm bước...") — Claude ghi nhận, sửa, trình lại.
5. Bạn **APPROVE** ngay trên trang web (gõ cụm xác nhận + bấm Yes trên hộp thoại hệ điều hành của máy bạn). **Claude không tự APPROVE được dưới bất kỳ hình thức nào** — đây là cổng do code kiểm soát, không phải quy ước.
6. Sau APPROVE, Claude tự kiểm tra môi trường/quyền ghi (mở trang xác nhận nếu chưa có), rồi tự khám phá giao diện thật bằng Playwright MCP, viết automation, chạy mọi test đủ điều kiện.
7. Bạn xem **QA Report** (Claude tự mở), gồm kết quả PASS/FAIL/BLOCKED, Steps/Actual/Expected, evidence và Bug Report.

Chi tiết từng bước, kể cả khi phiên làm việc bị đóng giữa chừng: `INSTALL.md`.

## 8. Chạy test

| Lệnh | Khi nào dùng | Có kết nối/ghi dữ liệu không |
|---|---|---|
| `npm run typecheck` | Luôn chạy trước khi commit | Không |
| `npm run test:framework` | Kiểm tra chính framework (Approval Gate, cleanup, reporter...) | Không, an toàn tuyệt đối |
| `npm test -- --requirement=<REQ-ID>` | Chạy test nghiệp vụ **chỉ đọc** của một requirement đã APPROVE | **Có kết nối** ứng dụng thật (chỉ đọc); bị từ chối nếu chưa có phê duyệt + môi trường hợp lệ |
| `npm run test:write -- --requirement=<REQ-ID> --module=<app>-<module>` | Chạy test cần **tạo/sửa dữ liệu** | **Có ghi dữ liệu** trên ứng dụng thật (chỉ dữ liệu do framework tạo); cần xác nhận chính sách ghi riêng trước |
| `npm run report:rebuild` | Dựng lại QA Report từ kết quả đã lưu, không chạy lại test | Không |
| `npm run report:verify` | Đối chiếu JSON/HTML/tổng kết khớp nhau | Không |

**Cảnh báo:** `npm test` và `npm run test:write` kết nối tới ứng dụng thật được cấu hình trong `.env`. Đừng chạy chúng trừ khi bạn hiểu rõ môi trường đang trỏ tới đâu; cổng Approval/Environment sẽ từ chối nếu thiếu điều kiện, nhưng không thay thế việc bạn tự kiểm tra `.env` trỏ đúng môi trường test.

## 9. QA Report

Mở `reports/<MÔI_TRƯỜNG>/qa-report.html` (Claude tự mở sau `qa:finish`). Gồm:

- **Dashboard:** số test case theo trạng thái (PASS/FAIL/BLOCKED/NEEDS CLARIFICATION/NOT RUN), tỉ lệ pass, lọc theo requirement đang xử lý.
- **Thẻ test case:** Steps – Actual – Expected bằng ngôn ngữ nghiệp vụ, Chi tiết kỹ thuật thu gọn, Evidence (video toàn trình, ảnh chụp khi FAIL, trace) thu gọn mặc định.
- **Bug Report:** bug mở/đã thay thế (SUPERSEDED khi lần chạy sau PASS hoặc test case đổi), phân loại nghi sản phẩm/nghi hạ tầng.
- **Ma trận truy vết & Lịch sử:** BR/AC ↔ test case, các lần chạy trước.

Tổng kết dạng chữ (nguồn số liệu chính thức): `reports/<MÔI_TRƯỜNG>/qa-summary.md`.

## 10. Cấu trúc dự án

```
core/            Lõi không biết gì về ứng dụng cụ thể: Approval Gate, Environment/Write Safety,
                 Test Data Factory + registry, cleanup engine, QA reporter
applications/    Adapter theo từng ứng dụng (hiện có: odoo/), chia theo module (inventory/sales/purchase)
                 — Page Object, API, công thức dữ liệu (recipe)
requirements/    Requirement đã nhập (BR/AC khoá nguyên văn) + TEMPLATE.md + SAMPLE-REQUIREMENT.md
testcases/       Test case sinh ra từ requirement, có liên kết BR/AC
automation/      Metadata quyền thực thi (READ/WRITE) theo test case, tách khỏi nội dung đã duyệt
approvals/       Hồ sơ phê duyệt có chữ ký (REVIEW.md, lịch sử APPROVE/REVISE/REJECT)
adapters/        Adapter tự sinh cho module Odoo chưa có code riêng (khám phá chỉ đọc)
tests/framework/ Test của chính framework (an toàn, không kết nối ứng dụng nào)
tests/<app>-<module>/  Test nghiệp vụ tự sinh (chỉ xuất hiện sau khi một module được automation)
scripts/         Mọi lệnh npm (qa:*, req:*, cleanup:*, security:*, setup...)
.claude/commands/qa-requirement.md   Quy trình mà lệnh /qa-requirement thực thi
reports/<ENV>/   Kết quả, evidence, QA Report theo từng môi trường (không commit)
```

## 11. An toàn & Approval Gate

- Mặc định **mọi test chỉ đọc**. `npm test`/Playwright MCP bị **code** từ chối (thoát mã lỗi) khi chưa có phê duyệt hợp lệ khớp hash — không phải quy ước, không có cách hợp lệ nào để Claude tự vượt qua.
- Claude **không bao giờ tự APPROVE**, tự sửa file phê duyệt, hay tự chọn/xác nhận môi trường thay bạn.
- **Test case đã APPROVE không bị sửa.** Thay đổi nội dung (steps, expected...) làm phê duyệt tự mất hiệu lực; phải trình và duyệt lại.
- **Cleanup chỉ động vào dữ liệu do chính lần chạy tạo ra**, có bằng chứng sở hữu (registry + nhãn do framework gắn). Dữ liệu có sẵn, dữ liệu không rõ nguồn gốc, hoặc chứng từ đã phát sinh nghiệp vụ không hoàn tác an toàn (đã đối soát, đã hoàn tất, bị khoá kỳ kế toán...) → `CLEANUP_BLOCKED`, không bao giờ bị đụng tới, không tự xoá chứng từ nghiệp vụ.
- **Production không bao giờ được ghi tự động**, kể cả khi cấu hình sai (ép bằng code ở nhiều lớp: chính sách hiệu lực, xác nhận, runner, cleanup).
- Lỗi do chính automation (timeout, sai locator) được phân biệt khỏi lỗi sản phẩm thật; không kết luận bug khi automation dừng trước mốc nghiệp vụ cần kiểm tra.

Chi tiết cơ chế (chữ ký HMAC, các lớp chặn bằng code, giới hạn): `INSTALL.md` mục "Approval Gate (chi tiết)", `FRAMEWORK.md`.

## 12. Xử lý sự cố

| Vấn đề | Cách xử lý |
|---|---|
| `npm run setup` báo thiếu biến `.env` | Lệnh chỉ in **tên** biến còn thiếu, không bao giờ in giá trị. Điền vào `.env`, không dán giá trị vào chat/log. |
| Playwright báo thiếu trình duyệt | `npx playwright install chromium`, hoặc đặt `BROWSER_CHANNEL=chrome` nếu dùng Chrome có sẵn. |
| Claude Code không nhận `/qa-requirement` | Kiểm tra đang mở đúng thư mục gốc dự án (có `.claude/commands/qa-requirement.md`); khởi động lại Claude Code. |
| `npm test` thoát ngay, báo chưa có phê duyệt/môi trường | Đúng hành vi của Approval Gate — không phải lỗi. Chạy `/qa-requirement` để đi đúng quy trình thay vì gọi `npm test` trực tiếp. |
| Đăng nhập lỗi khi chạy automation | Test của vai trò đó → BLOCKED kèm lý do; framework không tự đổi tài khoản/môi trường. Kiểm tra lại URL/tài khoản/phiên bản trong `.env`. |
| Test case ở trạng thái BLOCKED | Thường là thiếu quyền ghi, thiếu tài khoản theo vai trò, hoặc thiếu dữ liệu ghim (`testdata/fixtures/`). QA Report nêu lý do cụ thể từng test case. |
| Không thấy video/ảnh/trace trong QA Report | Evidence nằm trong `reports/<ENV>/runs/<RunID>/`; thư mục này không commit lên Git — chỉ tồn tại trên máy đã chạy test. |
| `report:verify` báo lệch | Không tự sửa số liệu — báo lỗi kèm điều tra, vì đây là dấu hiệu dữ liệu không nhất quán giữa JSON/HTML/tổng kết. |

---

## Tài liệu liên quan

- `INSTALL.md` — hướng dẫn cài đặt và Approval Gate chi tiết hơn.
- `FRAMEWORK.md` — tài liệu đầy đủ: nhiều môi trường, Test Data Factory, adapter tự thích ứng cho module Odoo bất kỳ, mốc Lưu vs Xác nhận nghiệp vụ, v.v.
- `example/requirements/TEMPLATE.md`, `example/testcases/TEMPLATE.md` — mẫu requirement/test case.

## License

Chưa xác định (quyết định còn mở — xem `LICENSE` nếu được thêm sau).
