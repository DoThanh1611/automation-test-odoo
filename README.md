<div align="center">

# QA Automation Framework

### Từ yêu cầu nghiệp vụ đến báo cáo kiểm thử — có con người kiểm soát

**Claude Code · Playwright · TypeScript · Odoo**

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853D?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Testing-Playwright-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows&logoColor=white)](#3-cài-đặt-lần-đầu-windows-và-macos)
[![macOS](https://img.shields.io/badge/macOS-supported-333333?logo=apple&logoColor=white)](#3-cài-đặt-lần-đầu-windows-và-macos)

[**Bắt đầu cài đặt**](#3-cài-đặt-lần-đầu-windows-và-macos) · [**Thử requirement mẫu**](#4-thử-requirement-đầu-tiên-bằng-claude-code) · [**Các lệnh thường dùng**](#6-các-lệnh-quan-trọng)

</div>

---

Framework giúp bạn chuyển **requirement bằng tiếng Việt** thành test case có truy vết, review và phê duyệt trước khi tự động hóa kiểm thử. Sau khi chạy, kết quả được tổng hợp thành QA Report cùng bằng chứng phù hợp.

> [!TIP]
> **Bạn có thể cài đặt và kiểm tra framework mà chưa cần tài khoản Odoo.** Hãy bắt đầu ở [Mục 3](#3-cài-đặt-lần-đầu-windows-và-macos). Chỉ cấu hình kết nối Odoo khi sẵn sàng chạy kiểm thử nghiệp vụ.

### 📚 Mục lục

| Bắt đầu | Sử dụng và tham khảo |
| --- | --- |
| [1. Framework làm được gì?](#1-framework-làm-được-gì) | [6. Các lệnh quan trọng](#6-các-lệnh-quan-trọng) |
| [2. Cần chuẩn bị gì?](#2-cần-chuẩn-bị-những-gì) | [7. Xem QA Report](#7-kết-quả-kiểm-thử-nằm-ở-đâu) |
| [3. Cài đặt Windows/macOS](#3-cài-đặt-lần-đầu-windows-và-macos) | [8. Cơ chế an toàn](#8-cơ-chế-an-toàn-cần-hiểu) |
| [4. Requirement đầu tiên](#4-thử-requirement-đầu-tiên-bằng-claude-code) | [9. Cấu trúc dự án](#9-cấu-trúc-thư-mục-đọc-nhanh) |
| [5. Kết nối Odoo](#5-muốn-chạy-test-trên-odoo-thật-thì-làm-gì) | [10. Lỗi thường gặp](#10-lỗi-thường-gặp) |

---

## 1. Framework làm được gì?

**Quy trình tổng quát:**

`Nhập requirement` → `Sinh test case` → `Review & APPROVE` → `Xác nhận môi trường` → `Chạy automation` → `QA Report`

1. **Nhận yêu cầu:** Bạn cung cấp đường dẫn chức năng, yêu cầu nghiệp vụ, quy tắc và tiêu chí chấp nhận (BR/AC).
2. **Đề xuất test case:** Claude Code phân tích requirement và tạo các kịch bản có truy vết tới BR/AC.
3. **Chờ bạn duyệt:** Bạn xem, yêu cầu sửa, rồi tự bấm **APPROVE** trên giao diện review. Claude không tự phê duyệt thay bạn.
4. **Kiểm tra môi trường:** Framework xác nhận môi trường, quyền truy cập và chính sách ghi trước khi chạy.
5. **Thực thi và báo cáo:** Playwright chạy các test đủ điều kiện; kết quả hiển thị trong QA Report cùng bằng chứng khi có.

Hiện tại, **Odoo** là ứng dụng đã có adapter và được kiểm chứng thực tế (Inventory và Sales); Purchase mới ở dạng khung. Khả năng mở rộng sang ứng dụng khác có trong kiến trúc nhưng chưa được kiểm chứng thực tế.

## 2. Cần chuẩn bị những gì?

| Thành phần | Mục đích |
| --- | --- |
| **Node.js 20+** và npm | Cài đặt và chạy framework |
| **Git** | Tải mã nguồn từ GitHub |
| **VS Code + Claude Code** | Nhập requirement và sử dụng lệnh `/qa-requirement` |
| **Chromium của Playwright** hoặc Chrome | Chạy kiểm thử trên trình duyệt |
| **Tài khoản ứng dụng thử nghiệm** | Chỉ cần khi bạn muốn chạy test nghiệp vụ thật |

Kiểm tra Node.js, npm và Git trong Terminal:

```bash
node --version
npm --version
git --version
```

Nếu một lệnh không chạy được, hãy cài công cụ tương ứng trước khi tiếp tục.

---

## 3. Cài đặt lần đầu (Windows và macOS)

> [!IMPORTANT]
> Hãy chạy lệnh trong **Terminal**, không dán vào cửa sổ chat của Claude. Mỗi bước đều thực hiện trong thư mục dự án sau khi clone.

### Bước 1 — Tải dự án

**🪟 Windows (PowerShell hoặc CMD)**

```powershell
git clone https://github.com/DoThanh1611/automation-test-odoo.git
cd automation-test-odoo
```

> Trước khi chạy, mở Terminal tại **thư mục bạn muốn lưu dự án** (ví dụ Documents). Nếu đã clone rồi, không chạy `git clone` lần nữa; chỉ cần mở Terminal tại thư mục `automation-test-odoo`.

**🍎 macOS (Terminal)**

```bash
cd ~/Documents
git clone https://github.com/DoThanh1611/automation-test-odoo.git
cd automation-test-odoo
```

**✅ Kiểm tra:** Thư mục hiện tại phải chứa `package.json`.

- Windows: `dir package.json`
- macOS: `ls package.json`

### Bước 2 — Cài các gói cần thiết

Trên **cả Windows và macOS**:

```bash
npm install
npx playwright install chromium
```

Nếu `npm install` báo `ENOENT ... package.json`, bạn đang ở sai thư mục. Hãy `cd` vào `automation-test-odoo` rồi chạy lại.

### Bước 3 — Tạo file cấu hình `.env`

**Windows CMD:**

```cmd
copy .env.example .env
```

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env
```

**macOS:**

```bash
cp .env.example .env
```

> [!NOTE]
> **Chưa cần nhập tài khoản Odoo** nếu bạn chỉ muốn kiểm tra framework trên máy mới. File `.env` chứa cấu hình riêng của bạn và không được commit lên GitHub.

### Bước 4 — Kiểm tra cài đặt (không kết nối Odoo)

Chạy lần lượt:

```bash
npm run typecheck
npm run test:framework
npm run setup -- --init
npm run qa:next
```

| Lệnh | Kết quả mong đợi |
| --- | --- |
| `npm run typecheck` | Không có lỗi TypeScript |
| `npm run test:framework` | Không có test **FAIL**; một số test có thể **SKIPPED** vì repo công khai không kèm dữ liệu nội bộ |
| `npm run setup -- --init` | Kiểm tra thiết lập, có thể chỉ ra các biến cấu hình còn thiếu |
| `npm run qa:next` | Hiển thị bước tiếp theo của quy trình QA |

> [!TIP]
> 🎉 **Hoàn thành cài đặt!** Nếu không có lỗi ở các bước kiểm tra, bạn đã có thể bắt đầu xem requirement mẫu mà chưa cần chạy test trên Odoo thật.

---

## 4. Thử requirement đầu tiên bằng Claude Code

1. Mở thư mục **`automation-test-odoo`** trong VS Code.
2. Khởi động Claude Code trong đúng thư mục này.
3. Gõ lệnh:

   ```text
   /qa-requirement example/requirements/SAMPLE-REQUIREMENT.md
   ```

4. Claude Code đọc requirement mẫu, phân tích BR/AC và đề xuất test case.
5. Xem các test case trên giao diện review hoặc tài liệu được tạo. Nếu chưa đúng, yêu cầu chỉnh sửa bằng ngôn ngữ tự nhiên.
6. **Chỉ APPROVE khi bạn hiểu test case và đã chuẩn bị môi trường test an toàn.** Sau khi phê duyệt, quy trình có thể chuyển sang kiểm tra môi trường và thực thi.

Muốn tự viết requirement, tham khảo `example/requirements/TEMPLATE.md`, với 5 phần:

- **Path:** Chức năng nằm ở đâu trên ứng dụng?
- **Business Requirement:** Người dùng cần làm gì?
- **Expected Solution:** Hệ thống phải đáp ứng thế nào?
- **Business Rules (BR):** Quy tắc cần tuân thủ?
- **Acceptance Criteria (AC):** Điều kiện nào chứng minh chức năng đúng?

**Ví dụ ngắn (dữ liệu giả):**

```text
Path: Kho > Phiếu nhập kho > Chi tiết
Business Requirement: Không cho phép ghi nhận hai xe khác nhau có cùng số máy.
Expected Solution: Khi xác nhận hoàn tất phiếu, hệ thống từ chối số máy đã được ghi nhận cho VIN khác.
BR-01: Một số máy chỉ được gắn với một VIN có hiệu lực.
AC-01: Nếu số máy chưa tồn tại, xác nhận thành công.
AC-02: Nếu số máy đã gắn với VIN khác đã hoàn tất, xác nhận bị từ chối và có thông báo rõ ràng.
```

> [!IMPORTANT]
> **Lưu ≠ Xác nhận nghiệp vụ.** Nút **Lưu** có thể chỉ ghi lại dữ liệu nháp; bước **Xác nhận/Hoàn tất** mới làm chứng từ có hiệu lực. Requirement và test case phải ghi rõ thời điểm cần kiểm tra.

## 5. Muốn chạy test trên Odoo thật thì làm gì?

Việc này **không bắt buộc** để kiểm tra cài đặt. Khi đã có môi trường staging/UAT riêng:

1. Mở `.env` và điền các URL, tên database, phiên bản dự kiến và tài khoản thử nghiệm theo tên biến trong `.env.example`.
2. Kiểm tra danh sách môi trường và vai trò trong `environments/odoo.json`.
3. Giữ `ALLOW_WRITE_TESTS=false` theo mặc định.
4. Kiểm tra cấu hình:

   ```bash
   npm run qa:env -- check
   npm run setup
   ```

5. Đi theo `/qa-requirement`, review và phê duyệt test case. Framework sẽ yêu cầu xác nhận môi trường/chính sách ghi khi cần.

> [!CAUTION]
> **Không dùng tài khoản quản trị hoặc dữ liệu thật của khách hàng để thử framework.** Việc APPROVE test case không thay thế việc xác nhận đúng môi trường. Các lệnh test nghiệp vụ có thể truy cập hoặc ghi dữ liệu tùy quyền được cấp.

---

## 6. Các lệnh quan trọng

| Lệnh | Dùng để làm gì? | Có chạm ứng dụng thật? |
| --- | --- | --- |
| `npm run typecheck` | Kiểm tra mã TypeScript | Không |
| `npm run test:framework` | Kiểm tra bản thân framework | Không |
| `npm run setup -- --init` | Khởi tạo/kiểm tra cài đặt | Không chạy test nghiệp vụ |
| `npm run qa:next` | Xem bước tiếp theo | Không chạy test nghiệp vụ |
| `/qa-requirement` (trong Claude Code) | Bắt đầu quy trình requirement → review → automation → report | **Có thể** kết nối/chạy test sau khi được duyệt và cấu hình |
| `npm test -- --requirement=<REQ-ID>` | Chạy test nghiệp vụ chỉ đọc đã đủ điều kiện | **Có kết nối** |
| `npm run test:write -- --requirement=<REQ-ID> --module=<app>-<module>` | Chạy test có thao tác ghi được cho phép | **Có ghi**, chịu kiểm soát quyền ghi |
| `npm run report:rebuild` | Dựng lại báo cáo từ kết quả lưu | Không chạy lại test |
| `npm run report:verify` | Kiểm tra dữ liệu báo cáo nhất quán | Không chạy lại test |
| `npm run security:scan` | Quét rủi ro lộ dữ liệu bí mật | Không chạy test nghiệp vụ |

**Người mới chỉ nên chạy các lệnh cài đặt và kiểm tra offline ở Mục 3.** Đừng chạy `npm test` hoặc `test:write` chỉ để xem framework có hoạt động không.

## 7. Kết quả kiểm thử nằm ở đâu?

Sau một lần chạy test nghiệp vụ, framework lưu kết quả theo môi trường:

```text
reports/<ENV>/qa-report.html      Báo cáo trực quan
reports/<ENV>/qa-summary.md       Tổng kết kết quả
reports/<ENV>/runs/<RUN-ID>/      Evidence của lần chạy (khi có)
```

QA Report có các trạng thái **PASS**, **FAIL**, **BLOCKED**, **NEEDS CLARIFICATION**, **NOT RUN**; liên kết BR/AC, từng test case và bằng chứng như ảnh, video hoặc trace. Thư mục `reports/` không được đưa lên GitHub công khai.

Trên bản clone mới chưa từng chạy test nghiệp vụ, `report:verify` có thể chưa có dữ liệu để kiểm tra. Đó **không phải** lỗi cài đặt.

## 8. Cơ chế an toàn cần hiểu

- **Approval Gate:** Test case phải được con người xem và APPROVE hợp lệ; Claude không tự duyệt thay bạn.
- **Khóa nội dung đã duyệt:** Sửa các bước hoặc expected result của test case đã duyệt sẽ cần xem và phê duyệt lại.
- **Environment/Write Safety:** Kiểm soát môi trường và quyền ghi; production không được ghi tự động.
- **Dữ liệu test có nguồn gốc:** Framework theo dõi dữ liệu do mình tạo bằng registry và bằng chứng sở hữu.
- **Cleanup có giới hạn:** Không tự hủy chứng từ đã hoàn tất, đã hạch toán hoặc có ràng buộc nghiệp vụ. Những trường hợp đó được đánh dấu `CLEANUP_BLOCKED`.
- **Phân biệt lỗi test và lỗi sản phẩm:** Test dừng do timeout hoặc sai locator không đủ cơ sở kết luận ứng dụng có bug.

Đọc thêm `FRAMEWORK.md` và `INSTALL.md` nếu bạn cần hiểu chi tiết cơ chế bảo vệ.

## 9. Cấu trúc thư mục (đọc nhanh)

```text
core/                     Logic chung: approval, môi trường, quyền ghi, dữ liệu test, báo cáo
applications/             Adapter theo ứng dụng; hiện có Odoo
example/                  Requirement và test case mẫu để tham khảo
requirements/             Requirement bạn nhập vào
testcases/                Test case được tạo từ requirement
automation/               Metadata liên quan quyền thực thi test case
approvals/                Hồ sơ và lịch sử phê duyệt (tạo khi sử dụng)
tests/framework/          Unit/integration tests cho framework, không chạm Odoo
tests/<app>-<module>/      Automation nghiệp vụ khi được tạo
scripts/                  Các lệnh npm
.claude/commands/          Lệnh Claude Code, bao gồm /qa-requirement
environments/             Khai báo các môi trường/role và tên biến cấu hình
reports/                  QA Report, kết quả và evidence tạo ở máy local
```

---

## 10. Lỗi thường gặp

**`npm ERR! ENOENT ... package.json`**  
Terminal không đứng ở thư mục gốc dự án. Chạy `cd automation-test-odoo`, rồi kiểm tra `dir package.json` (Windows) hoặc `ls package.json` (macOS).

**`npm` hoặc `node` không được nhận diện**  
Kiểm tra đã cài Node.js 20+ và mở lại Terminal.

**Thiếu trình duyệt Playwright**  
Chạy `npx playwright install chromium`. Nếu dùng Chrome sẵn có, tham khảo biến `BROWSER_CHANNEL=chrome` trong `.env`.

**Không tìm thấy `/qa-requirement` trong Claude Code**  
Mở đúng thư mục dự án có `.claude/commands/qa-requirement.md`, sau đó khởi động lại Claude Code.

**`setup` báo thiếu biến trong `.env`**  
Điền các biến cần thiết nếu muốn kết nối môi trường thử nghiệm. Không chia sẻ mật khẩu trong chat hoặc commit lên Git.

**`npm test` bị chặn vì chưa APPROVE/chưa chọn môi trường**  
Đây là hành vi bảo vệ đúng. Hãy đi qua `/qa-requirement` và các bước xác nhận, không tìm cách bỏ qua Approval Gate.

**Có test `SKIPPED` ở `test:framework`**  
Một số bài test cần fixture nghiệp vụ không được phát hành trong repo public. Quan trọng là xem lý do skip và bảo đảm không có FAIL.

**Không có QA Report sau khi vừa clone**  
Đúng thiết kế: báo cáo chỉ xuất hiện sau khi bạn thực sự chạy test nghiệp vụ.

## 11. Đọc thêm

- [`INSTALL.md`](INSTALL.md): Cấu hình và hướng dẫn đầy đủ, đặc biệt là Approval Gate.
- [`FRAMEWORK.md`](FRAMEWORK.md): Kiến trúc, giới hạn và quy tắc an toàn.
- [`example/requirements/TEMPLATE.md`](example/requirements/TEMPLATE.md): Mẫu requirement.
- [`example/requirements/SAMPLE-REQUIREMENT.md`](example/requirements/SAMPLE-REQUIREMENT.md): Ví dụ requirement giả.

---

## License

Chưa xác định. Mã nguồn công khai không tự động đồng nghĩa với việc đã được cấp phép sử dụng, sửa đổi hoặc phân phối. Kiểm tra quyền sở hữu trước khi bổ sung LICENSE.
