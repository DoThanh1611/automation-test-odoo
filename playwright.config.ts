import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { listApps } from './applications';
import { env } from './core/config/env';
import { activeBaseUrl } from './core/environment/active';
import { activeEnvKey, reportsDirFor } from './core/environment/paths';
import { getRunId } from './core/config/run';
import { scopeFromEnv, scopeGateProblems, scopeGrep } from './core/approval/scope';
import { loadRequirements, loadTestCases } from './core/testcases/loader';

// Phạm vi lần chạy (requirement/module) do scripts/run-tests.ts truyền qua QA_GATE_SCOPE. Không tin biến này: tính lại phê duyệt từ file ngay tại đây.
// Thiếu phạm vi, phạm vi rỗng, hoặc có requirement chưa duyệt hợp lệ => không có project nào chạm staging (kể cả khi tự đặt QA_APPROVAL_GATE).
const runScope = process.env.QA_APPROVAL_GATE === 'passed' ? scopeFromEnv() : undefined;
const scopeOk = !!runScope && scopeGateProblems(process.cwd(), loadRequirements(), loadTestCases(), runScope).length === 0;
const scopeTitleFilter = scopeOk ? scopeGrep(loadTestCases(), runScope!) : undefined;

// Mã lần chạy: sinh 1 lần, worker thừa kế qua QA_RUN_ID. Evidence của mỗi lần chạy nằm riêng nên chạy lại không xoá bằng chứng cũ.
const runId = getRunId();
// Kết quả ghi vào reports/<ENV>/ (môi trường do QA_ENV chỉ định) nên môi trường này không ghi đè môi trường khác.
// QA_REPORTS_DIR cho phép ghi ra nơi khác (ví dụ chạy kiểm tra thử mà không đụng báo cáo chính thức).
const reportsDir = reportsDirFor();
const runDir = path.join(reportsDir, 'runs', runId);

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];

/**
 * Tự phát hiện module test: mỗi thư mục tests/<app>-<module> là 1 project (ví dụ tests/odoo-sales).
 * <app> phải có trong applications/index.ts. Thêm module mới = tạo thư mục (xem `npm run new:module`), không sửa file này.
 */
const moduleDirs = fs
  .readdirSync('tests', { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.includes('-'))
  .map((d) => d.name);

const apps = new Set<string>();
const moduleProjects: Project[] = moduleDirs.map((dir) => {
  const appName = dir.split('-')[0];
  if (!listApps().includes(appName)) {
    throw new Error(`tests/${dir}: ứng dụng "${appName}" chưa đăng ký trong applications/index.ts`);
  }
  apps.add(appName);
  return {
    name: dir,
    testDir: `./tests/${dir}`,
    dependencies: [`setup-${appName}`],
    metadata: { app: appName },
    ...(scopeTitleFilter ? { grep: scopeTitleFilter } : {}),
    use: { baseURL: activeBaseUrl(appName) },
  };
});

const setupProjects: Project[] = [...apps].map((appName) => ({
  name: `setup-${appName}`,
  testDir: './tests/setup',
  testMatch: /.*\.setup\.ts/,
  grep: new RegExp(`auth: ${appName}/`),
  metadata: { app: appName },
  use: { video: 'off', trace: 'off', screenshot: 'off', baseURL: activeBaseUrl(appName) },
}));

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(runDir, 'artifacts'),
  // Test ghi dữ liệu: tuần tự, không retry để tránh tạo giao dịch trùng.
  workers: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(runDir, 'playwright-html'), open: 'never' }],
    ['json', { outputFile: path.join(runDir, 'playwright-results.json') }],
    ['./core/reporters/qa-reporter.ts', { outputDir: reportsDir }],
  ],
  use: {
    video: 'on',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    headless: env.headless,
    channel: env.browserChannel,
    viewport: { width: 1440, height: 900 },
    locale: 'vi-VN',
  },
  // APPROVAL GATE: project có thể kết nối staging (đăng nhập setup + module nghiệp vụ) chỉ tồn tại khi `npm test`/`npm run test:write`
  // (scripts/run-tests.ts) đã kiểm tra phê duyệt hợp lệ. Chạy thẳng `npx playwright test --project=odoo-sales` sẽ báo không có project.
  // Từng test còn tự kiểm tra lại phê duyệt trong core/fixtures/base.ts nên không thể chỉ đặt biến môi trường để qua mặt.
  projects: [
    { name: 'framework', testDir: './tests/framework' },
    // Cần thêm môi trường đã chọn + xác nhận (QA_ENV do scripts/run-tests.ts đặt): không có môi trường thì không có project nào chạm staging.
    ...(process.env.QA_APPROVAL_GATE === 'passed' && activeEnvKey() && scopeOk ? [...setupProjects, ...moduleProjects] : []),
  ],
});
