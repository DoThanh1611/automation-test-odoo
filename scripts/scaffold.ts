import fs from 'node:fs';
import path from 'node:path';

// Tạo khung cho ứng dụng / module mới. Không bao giờ ghi đè file đã có. KHÔNG sinh requirement hay test case mẫu:
// requirement do người dùng cung cấp (npm run req:import) và test case do Claude sinh từ BR/AC.
//   npm run new:app    -- <app>
//   npm run new:module -- <app> <module>
const [kind, a, b] = process.argv.slice(2);
const root = process.cwd();

const fail = (msg: string): never => {
  console.error(`Lỗi: ${msg}`);
  process.exit(1);
};
const write = (file: string, content: string) => {
  const abs = path.join(root, file);
  if (fs.existsSync(abs)) return console.log(`  bỏ qua (đã có): ${file}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  console.log(`  tạo: ${file}`);
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function newApp(app: string) {
  if (!/^[a-z][a-z0-9]*$/.test(app ?? '')) fail('tên ứng dụng chỉ gồm chữ thường/số, không có dấu gạch ngang (ví dụ: misa)');
  const A = app.toUpperCase();
  console.log(`Tạo ứng dụng "${app}":`);
  write(`applications/${app}/config.ts`, `import type { Page } from '@playwright/test';
import type { AppConfig, LoginContext } from '../../core/config/app-config';

export const ${app}Config: AppConfig = {
  name: '${app}',
  // URL và tài khoản KHÔNG nằm ở đây: chúng thuộc từng môi trường (environments/${app}.json chỉ chứa TÊN biến; giá trị nằm trong .env).
  // Mỗi role là một vai trò tài khoản. Thêm role khi có tài khoản tương ứng; thiếu tài khoản thì test BLOCKED.
  roles: {
    user: { description: 'TODO: mô tả vai trò/quyền của tài khoản này' },
  },
  async login(page: Page, _role: string, ctx: LoginContext) {
    await page.goto(\`\${ctx.baseUrl}/\`); // TODO: đổi sang trang đăng nhập thật
    // TODO: điền locator ĐÃ XÁC MINH bằng Playwright MCP trên giao diện thật (dùng ctx.user, ctx.pass). Không đoán selector.
    throw new Error('${app}.login chưa được triển khai');
  },
  // TODO (bắt buộc để xác minh trước khi chạy): inspectSession(page) trả về { privileged, detail, login } và inspectVersion(page) trả về phiên bản ứng dụng.
};
`);
  write(`environments/${app}.json`, JSON.stringify({
    application: app,
    environments: {
      STAGING_A: {
        label: 'Staging A',
        kind: 'staging',
        urlVar: `${A}_STAGING_A_URL`,
        expectedVersionVar: `${A}_STAGING_A_VERSION`,
        roles: { user: { userVar: `${A}_STAGING_A_USER`, passVar: `${A}_STAGING_A_PASS` } },
      },
    },
  }, null, 2) + '\n');
  write(`applications/${app}/pages/.gitkeep`, '');

  const idx = path.join(root, 'applications/index.ts');
  let src = fs.readFileSync(idx, 'utf8');
  if (src.includes(`${app}Config`)) console.log('  đã đăng ký trong applications/index.ts');
  else {
    src = src.replace(/(\nimport [^\n]+\n)(?!import)/, `$1import { ${app}Config } from './${app}/config';\n`);
    src = src.replace(/(const registry[^{]*\{\n)/, `$1  ${app}: ${app}Config,\n`);
    fs.writeFileSync(idx, src);
    console.log('  đăng ký trong applications/index.ts');
  }

  const envEx = path.join(root, '.env.example');
  if (!fs.readFileSync(envEx, 'utf8').includes(`${A}_STAGING_A_URL`)) {
    fs.appendFileSync(envEx, `\n# --- ${cap(app)} (môi trường STAGING_A; thêm môi trường khác trong environments/${app}.json) ---\n${A}_STAGING_A_URL=\n${A}_STAGING_A_VERSION=\n${A}_STAGING_A_USER=\n${A}_STAGING_A_PASS=\n`);
    console.log('  thêm biến vào .env.example');
  }
  console.log(`\nTiếp theo: triển khai login() trong applications/${app}/config.ts, rồi: npm run new:module -- ${app} <module>`);
}

function newModule(app: string, mod: string) {
  if (!/^[a-z][a-z0-9]*$/.test(app ?? '') || !/^[a-z][a-z0-9]*$/.test(mod ?? '')) {
    fail('cú pháp: npm run new:module -- <app> <module> (chữ thường/số, ví dụ: odoo purchase)');
  }
  if (!fs.existsSync(path.join(root, `applications/${app}/config.ts`))) fail(`ứng dụng "${app}" chưa có. Chạy: npm run new:app -- ${app}`);
  const key = `${app}-${mod}`;
  console.log(`Tạo module "${key}":`);

  // Thư mục theo quy ước. Chỉ có README, KHÔNG có requirement/test case/spec mẫu.
  write(`requirements/${key}/README.md`, `# Requirement của ${key}\n\nCung cấp requirement theo cấu trúc Path / Business Requirement / Expected Solution / Business Rules / Acceptance Criteria,\nrồi chạy: \`npm run req:import -- ${app} ${mod} <file.md> --id=REQ-XXX\`.\nBR/AC được lưu NGUYÊN VĂN và khoá lại; mọi làm rõ nghiệp vụ đi vào \`notes\`.\n`);
  write(`testcases/${key}/README.md`, `# Test case của ${key}\n\nTest case được sinh từ BR/AC của requirement (mỗi test case có requirementRefs). Không tự thêm nghiệp vụ.\n`);
  write(`tests/${key}/.gitkeep`, '');

  // Fixture dữ liệu test: ghim tường minh, gắn với MỘT môi trường.
  // Mỗi môi trường có fixture riêng (testdata/fixtures/<ENV>/<key>.json) vì ID bản ghi khác nhau giữa các môi trường; điền host khi ghim bản ghi thật.
  const host = 'TODO-host-moi-truong';
  write(`testdata/fixtures/${key}.json`, JSON.stringify({
    environment: host,
    note: 'Dữ liệu nghiệp vụ có sẵn được GHIM tường minh để test chỉ đọc. Mỗi mục: { "name": "<tên bản ghi>", "purpose": "...", "conditions": [{ "field": "state", "op": "eq", "value": "..." }] }. Không bao giờ dùng bản ghi này để ghi dữ liệu.',
    pinnedOn: new Date().toISOString().slice(0, 10),
  }, null, 2) + '\n');

  if (app !== 'odoo') {
    console.log(`\nỨng dụng ${app} không phải Odoo: tạo client/Page Object riêng trong applications/${app}/ và dùng core/testdata/write-guard cho quyền ghi.`);
    return;
  }

  // ---- Module Odoo: khai báo + API + fixture Playwright + Page Object, mặc định CHỈ ĐỌC ----
  const V = `${mod}Module`;
  const C = cap(mod);
  const dir = `applications/odoo/modules/${mod}`;
  write(`${dir}/module.ts`, `import { unsupportedHandler } from '../../../../core/testdata/cleanup';
import type { OdooModuleDef } from '../types';

/**
 * Khai báo module ${C}. MẶC ĐỊNH CHỈ ĐỌC: ownership rỗng nghĩa là test KHÔNG được tạo/ghi model nào.
 * Khi requirement cần test GHI: khai báo ownership { model, refField (trường chữ tự do để gắn nhãn AUTOTEST), creatorField: 'create_uid' }
 * (xác minh trường bằng fields_get trên môi trường thật), thêm hàm tạo dữ liệu vào api.ts qua trackCreated().
 */
export const ${V}: OdooModuleDef = {
  key: '${key}',
  application: 'odoo',
  module: '${mod}',
  title: '${C}',
  fixturesKey: '${key}',
  ownership: [],
  // Chưa biết cách huỷ an toàn các chứng từ của module này: đánh dấu CHƯA HỖ TRỢ, không mượn quy trình của module khác.
  cleanup: [
    unsupportedHandler('${mod}-default', [], 'Chưa xác minh quy trình huỷ an toàn cho chứng từ của module ${mod}. Khai báo handler riêng khi đã xác minh.'),
  ],
};
`);
  write(`${dir}/api.ts`, `import type { APIRequestContext } from '@playwright/test';
import { OdooClient } from '../../client';
import { ${V} } from './module';

/** API của module ${C}. Mọi logic riêng của module nằm ở đây, không đưa vào lõi dùng chung. */
export class ${C}Api extends OdooClient {
  constructor(request: APIRequestContext) {
    super(request, ${V});
  }
}
`);
  write(`${dir}/fixtures.ts`, `import { test as base, expect } from '../../../../core/fixtures/base';
import { ${C}Api } from './api';

/** Fixture Playwright của module ${C}. Thêm Page Object vào đây khi đã khám phá giao diện bằng Playwright MCP. */
export const test = base.extend<{ api: ${C}Api }>({
  api: async ({ page }, use) => {
    const api = new ${C}Api(page.request);
    await use(api);
    await api.trackCreatedChildren();
  },
});

export { expect };
`);
  write(`${dir}/pages/.gitkeep`, '');

  const idx = path.join(root, 'applications/odoo/modules/index.ts');
  let src = fs.readFileSync(idx, 'utf8');
  if (src.includes(`${V}`)) console.log('  đã đăng ký trong applications/odoo/modules/index.ts');
  else {
    src = src.replace(/^(import [^\n]+\n)/, `import { ${V} } from './${mod}/module';\n$1`);
    src = src.replace(/(export const odooModules[^{]*\{\n)/, `$1  [${V}.key]: ${V},\n`);
    fs.writeFileSync(idx, src);
    console.log('  đăng ký trong applications/odoo/modules/index.ts');
  }

  console.log(`
Tiếp theo (xem FRAMEWORK.md, mục "Cung cấp requirement"):
  1. Cung cấp requirement, rồi: npm run req:import -- ${app} ${mod} <file.md> --id=REQ-XXX
  2. Claude sinh test case từ BR/AC, khám phá giao diện bằng Playwright MCP, viết Page Object và test trong tests/${key}/
  3. Ghim dữ liệu nghiệp vụ cần đọc vào testdata/fixtures/${key}.json
  4. Chạy chỉ đọc: npm test -- --project=${key}
  Project "${key}" tự có trong playwright.config.ts (không cần sửa).`);
}

if (kind === 'app') newApp(a);
else if (kind === 'module') newModule(a, b);
else fail('dùng: npm run new:app -- <app>  hoặc  npm run new:module -- <app> <module>');
