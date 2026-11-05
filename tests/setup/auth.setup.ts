import { test as setup } from '@playwright/test';
import { getApp, listApps } from '../../applications';
import { resolveEnvironment, roleMissing } from '../../core/environment/config';
import { requireEnvKey } from '../../core/environment/paths';
import { establishSession } from '../../core/environment/session';
import { tcEnvironmentProblem } from '../../core/environment/state';
import { evaluate } from '../../core/approval/approval';
import { scopeFromEnv } from '../../core/approval/scope';
import { loadRequirements, loadTestCases } from '../../core/testcases/loader';

// Chạy trong project setup-<app> (video/trace tắt để mật khẩu không nằm trong evidence).
// Mỗi project chỉ chạy các test có tên "auth: <app>/..." nhờ `grep` trong playwright.config.ts.
// Chỉ đăng nhập vào ĐÚNG môi trường QA_ENV, theo từng vai trò; phiên lưu riêng .auth/<ENV>/<app>-<role>.json.
// Đăng nhập lỗi thì dừng ở vai trò đó: KHÔNG thử môi trường hoặc tài khoản khác.
for (const appName of listApps()) {
  const app = getApp(appName);
  for (const role of Object.keys(app.roles)) {
    setup(`auth: ${app.name}/${role}`, async ({ page }) => {
      // Approval Gate: đăng nhập staging chỉ khi có ít nhất một requirement đã duyệt hợp lệ (cổng chính ở scripts/run-tests.ts).
      const reqs = loadRequirements();
      const defs = loadTestCases();
      // Chỉ xét requirement trong phạm vi lần chạy (chạy riêng một requirement thì không xét requirement khác).
      const runScope = scopeFromEnv();
      const inScope = runScope ? reqs.filter((r) => runScope.requirementIds.includes(r.id)) : reqs;
      const approved = inScope.filter((r) => evaluate(process.cwd(), r, defs.filter((d) => d.requirementId === r.id)).ok);
      if (!approved.length) throw new Error('Approval Gate: chưa có requirement nào được phê duyệt hợp lệ; không đăng nhập staging.');

      // Environment Gate: môi trường phải được chọn và được xác nhận thực thi riêng cho ít nhất một requirement đã duyệt.
      const key = requireEnvKey();
      const resolved = resolveEnvironment(app.name, key);
      if (!resolved.ok) throw new Error(`Môi trường ${key} không hợp lệ: ${resolved.problems.join('; ')}`);
      const firstDef = (r: (typeof reqs)[number]) => defs.find((d) => d.requirementId === r.id);
      const confirmed = approved.filter((r) => firstDef(r) && !tcEnvironmentProblem(firstDef(r)!.id, process.cwd(), reqs, defs, app.name, key));
      if (!confirmed.length) throw new Error(`Environment Gate: môi trường ${key} chưa được xác nhận thực thi cho requirement nào; không đăng nhập.`);

      const missing = roleMissing(resolved.env, role);
      setup.skip(missing.length > 0, `Thiếu biến môi trường của ${key}/${role}: ${missing.join(', ')}`);
      const meta = await establishSession({ page, app, env: resolved.env, role });
      // Không đạt xác minh: không ném lỗi (để không dừng cả lần chạy); các test dùng vai trò này sẽ BLOCKED với đúng lý do (xem sessionProblem).
      if (!meta.ok) {
        console.warn(`XÁC MINH KHÔNG ĐẠT ${key}/${role}: ${meta.problems.join('; ')}`);
        setup.info().annotations.push({ type: 'verification-failed', description: meta.problems.join('; ') });
      }
    });
  }
}
