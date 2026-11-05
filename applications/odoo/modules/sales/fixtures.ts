import { test as base, expect } from '../../../../core/fixtures/base';
import { getRunId } from '../../../../core/config/run';
import { accessOfCached } from '../../../../core/automation/meta';
import { env as dotenv } from '../../../../core/config/env';
import { DataFactory, FactoryError, type FactoryScope } from '../../../../core/testdata/factory';
import { grantProblems, readGrant } from '../../../../core/testdata/write-guard';
import { getTestCase } from '../../../../core/testcases/loader';
import { currentTcId } from '../../../../core/utils/tc';
import { activeEnvKey } from '../../../../core/environment/paths';
import { odooRecipes, type OdooRpc } from '../../factory';
import { SalesApi } from './api';
import { SaleOrderPage } from './pages/sale-order.page';

/** Chính sách ghi đã được người dùng xác nhận (scripts/run-tests.ts truyền qua QA_POLICY sau khi kiểm tra chữ ký). */
function policyFromEnv(): { environment?: string; write?: string; maxRecordsPerRun?: number } {
  try {
    return JSON.parse(process.env.QA_POLICY || '{}');
  } catch {
    return {};
  }
}

/** Fixture Playwright của module Sales: API riêng + Page Object + Test Data Factory. Test Sales import `test` từ file này. */
export const test = base.extend<{ api: SalesApi; saleOrderPage: SaleOrderPage; factory: DataFactory<OdooRpc> }>({
  api: async ({ page }, use) => {
    const api = new SalesApi(page.request);
    await use(api);
    await api.trackCreatedChildren(); // đăng ký bản ghi phát sinh vào Test Data Registry, kể cả khi test lỗi
  },
  saleOrderPage: async ({ page }, use) => use(new SaleOrderPage(page)),
  /**
   * Test Data Factory của test case hiện tại. Mọi lần tạo/sửa đi qua cổng ghi: giấy phép (môi trường, host, module, lần chạy) VÀ chính sách ghi
   * đã xác nhận của đúng môi trường. Bản ghi được đăng ký vào registry với Run ID, Requirement ID, Test Case ID ngay khi tạo.
   */
  factory: async ({ api, environment }, use, testInfo) => {
    const tcId = currentTcId();
    const def = getTestCase(tcId);
    const policy = policyFromEnv();
    const scope: FactoryScope = {
      application: 'odoo',
      module: 'sales',
      environment: environment?.key ?? activeEnvKey() ?? '',
      runId: getRunId(),
      requirementId: def.requirementId!,
      testCaseId: tcId,
    };
    const writeProblems = () => {
      const decl = accessOfCached(tcId);
      if (decl.declared && decl.access === 'READ') throw new Error(`Test case ${tcId} khai báo READ trong automation/*.automation.json nhưng dùng Test Data Factory (ghi dữ liệu).`);
      const problems = grantProblems({
        allowWrite: dotenv.allowWriteTests,
        grant: readGrant(),
        host: environment?.host,
        environment: environment?.key,
        environmentKind: environment?.kind,
        environmentLabel: environment?.label,
        module: testInfo.project.name,
        runId: getRunId(),
      });
      if (policy.write !== 'framework-data') problems.push('chưa có chính sách ghi đã xác nhận (QA_POLICY) cho lần chạy này');
      if (policy.environment !== environment?.key) problems.push(`chính sách ghi cho môi trường "${policy.environment ?? 'không rõ'}", đang chạy trên "${environment?.key ?? 'không rõ'}"`);
      return problems;
    };
    await use(new DataFactory<OdooRpc>({ rpc: api, recipes: odooRecipes, scope, writeProblems, maxRecordsPerRun: policy.maxRecordsPerRun ?? 200 }));
  },
});

export { expect, FactoryError };
