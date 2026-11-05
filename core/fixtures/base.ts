import { test as base } from '@playwright/test';
import { getApp, listApps } from '../../applications';
import type { AppConfig } from '../config/app-config';
import { env } from '../config/env';
import { getRunId } from '../config/run';
import { accessOfCached } from '../automation/meta';
import { WRITE_NOT_GRANTED_PREFIX, grantProblems, readGrant } from '../testdata/write-guard';
import { block, currentTcId } from '../utils/tc';
import { APPROVAL_BLOCK_PREFIX } from '../approval/approval';
import { tcApprovalProblem } from '../approval/gate';
import { OUT_OF_SCOPE_PREFIX, scopeFromEnv, tcScopeProblem } from '../approval/scope';
import { loadRequirements, loadTestCases } from '../testcases/loader';
import { activeEnvironment, installNavigationGuard } from '../environment/active';
import { roleMissing, type ResolvedEnvironment } from '../environment/config';
import { activeEnvKey } from '../environment/paths';
import { readMeta, sessionProblem } from '../environment/session';
import { tcEnvironmentProblem } from '../environment/state';
import { authFile } from '../utils/auth';

type Fixtures = {
  app: AppConfig;
  /** Role muốn dùng; đặt bằng test.use({ role: 'accountant' }). Để trống = role đầu tiên trong config của ứng dụng. */
  role: string;
  /** Role thực tế đang dùng (đã áp dụng mặc định). */
  activeRole: string;
  /** Môi trường đang chạy (QA_ENV), đã giải từ .env. undefined = chưa chọn/không hợp lệ (test sẽ BLOCKED). */
  environment: ResolvedEnvironment | undefined;
  /** Tự động BLOCK test nếu thiếu cấu hình/phiên đăng nhập, thay vì để fail giả. */
  precondition: void;
  /** Test ghi dữ liệu: chỉ chạy khi ALLOW_WRITE_TESTS=true. */
  writeGuard: () => void;
};

export const test = base.extend<Fixtures>({
  /** Ứng dụng của project hiện tại (metadata.app, do playwright.config.ts gắn theo tên thư mục tests/<app>-<module>). */
  app: async ({}, use, testInfo) => use(getApp((testInfo.project.metadata.app as string) || env.app || listApps()[0])),
  role: ['', { option: true }],
  activeRole: async ({ app, role }, use) => use(role || Object.keys(app.roles)[0]),
  environment: async ({ app }, use) => use(activeEnvironment(app.name)),
  precondition: [
    async ({ app, activeRole: role, environment, context }, use) => {
      // Phạm vi lần chạy: test case ngoài phạm vi (requirement khác) bị bỏ qua NGAY, trước mọi kiểm tra và kết nối. Dựa trên annotation tc, không dựa trên tiêu đề.
      const runScope = scopeFromEnv();
      const scopeProblem = runScope ? tcScopeProblem(currentTcId(), loadTestCases(), runScope) : undefined;
      if (scopeProblem) {
        base.info().annotations.push({ type: 'out-of-scope', description: scopeProblem });
        base.skip(true, `${OUT_OF_SCOPE_PREFIX}: ${scopeProblem}`);
      }
      // Approval Gate (phòng thủ chiều sâu): tự kiểm tra lại phê duyệt của test case này, không tin biến môi trường của lệnh chạy.
      const approvalProblem = tcApprovalProblem(currentTcId(), process.cwd(), loadRequirements(), loadTestCases());
      if (approvalProblem) block(`${APPROVAL_BLOCK_PREFIX}: ${approvalProblem}`, 'APPROVAL');
      // Môi trường: phải chọn, hợp lệ và được xác nhận riêng cho requirement này (phê duyệt dùng chung, xác nhận thực thi thì không).
      if (!environment) block(`Chưa chọn môi trường kiểm thử hợp lệ (QA_ENV="${activeEnvKey() ?? ''}"). Chạy qua npm test sau khi: npm run qa:env -- select/confirm.`, 'ENVIRONMENT');
      const envProblem = tcEnvironmentProblem(currentTcId(), process.cwd(), loadRequirements(), loadTestCases(), app.name, activeEnvKey());
      if (envProblem) block(`Môi trường chưa được xác nhận thực thi: ${envProblem}`, 'ENVIRONMENT');
      // Quyền ghi theo metadata thực thi (automation/*.automation.json), không theo từ khóa trong nội dung test case.
      // Chưa khai báo hoặc khai báo sai => coi là GHI: cần giấy phép ghi ngay từ đầu, không thì BLOCKED trước khi đăng nhập hay thao tác.
      if (accessOfCached(currentTcId()).access === 'WRITE') {
        const writeProblems = grantProblems({
          allowWrite: env.allowWriteTests,
          grant: readGrant(),
          host: environment!.host,
          environment: environment!.key,
          environmentKind: environment!.kind,
          environmentLabel: environment!.label,
          module: base.info().project.name,
          runId: getRunId(),
        });
        if (writeProblems.length) block(`${WRITE_NOT_GRANTED_PREFIX}: ${writeProblems.join('; ')}`, 'PERMISSION');
      }
      const cfg = app.roles[role];
      const missing = roleMissing(environment!, role);
      if (missing.length) {
        block(`Chưa có tài khoản cho role "${role}" (${cfg.description}) trên môi trường ${environment!.key}. Cần cấu hình: ${missing.join(', ')}. Hiện chưa có tài khoản phù hợp với vai trò này nên không thể kiểm chứng.`, 'PERMISSION');
      }
      const sProblem = sessionProblem(environment!, app.name, role);
      if (sProblem) block(sProblem, 'ENVIRONMENT');
      const meta = readMeta(environment!.key, app.name, role);
      base.info().annotations.push({ type: 'role', description: JSON.stringify({ role, description: cfg.description, privileged: meta?.privileged, detail: meta?.detail, environment: environment!.key }) });
      // Chặn URL thực tế khác môi trường: điều hướng trang chính sang host khác bị huỷ và làm test thất bại, không âm thầm chạy sai môi trường.
      const guard = await installNavigationGuard(context, environment!);
      await use();
      if (guard.violations.length) throw new Error(`Điều hướng sang host khác môi trường ${environment!.key} (${environment!.host}) bị chặn: ${guard.violations.join('; ')}`);
    },
    { auto: true },
  ],
  // Giấy phép ghi theo (môi trường, module, lần chạy). Module = tên project (<app>-<module>). Thiếu/lệch => BLOCKED.
  writeGuard: async ({ environment }, use, testInfo) => {
    await use(() => {
      const decl = accessOfCached(currentTcId());
      if (decl.declared && decl.access === 'READ') throw new Error(`Test case ${currentTcId()} khai báo READ trong automation/*.automation.json nhưng gọi thao tác ghi. Sửa metadata (cần xem xét quyền ghi) chứ không bỏ qua cổng ghi.`);
      const problems = grantProblems({
        allowWrite: env.allowWriteTests,
        grant: readGrant(),
        host: environment?.host,
        environment: environment?.key,
        environmentKind: environment?.kind,
        environmentLabel: environment?.label,
        module: testInfo.project.name,
        runId: getRunId(),
      });
      if (problems.length) block(`${WRITE_NOT_GRANTED_PREFIX}: ${problems.join('; ')}`, 'PERMISSION');
    });
  },
  storageState: async ({ app, activeRole: role, environment }, use) => {
    // Phiên theo (môi trường, vai trò); chỉ nạp khi đã xác minh đạt, nếu không để trống (precondition sẽ BLOCK).
    await use(environment && !sessionProblem(environment, app.name, role) ? authFile(app.name, role, environment.key) : undefined);
  },
});

export { expect } from '@playwright/test';
