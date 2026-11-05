import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { runProbe } from '../../applications/odoo/probe';
import { confirmExecution, confirmPhrase, selectEnvironment } from '../../core/environment/state';
import { resolveEnvironment, type EnvironmentsFile } from '../../core/environment/config';
import { mcpWriteIntent } from '../../core/policy/mcp';
import { confirmPolicy, effectivePolicy, policyPhrase } from '../../core/policy/policy';
import { installFakeEnvironments } from './helpers/fake-env';
import { FakeOrm } from './helpers/fake-orm';
import { makeApprovedWorkspace, wsReq } from './helpers/workspace';

// Framework tests chuẩn bị cho lần kiểm chứng thực tế đầu tiên (FIRST-*): thăm dò Odoo chỉ đọc, chính sách ghi áp dụng cả cho
// thao tác Playwright MCP, tắt cleanup tự động cho một lần chạy. Dữ liệu giả; không kết nối staging.

const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const acct = { user: 'ke.toan@example.com', pass: 'Mk#fake-A-111' };
const cleanups: (() => void)[] = [];
const prevKey = process.env.QA_APPROVAL_KEY_FILE;
test.afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  if (prevKey === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
  else process.env.QA_APPROVAL_KEY_FILE = prevKey;
});

test.describe('FIRST-1 Thăm dò Odoo chỉ đọc (phiên bản, ORM, trường, quyền)', () => {
  test('môi trường đúng: không có vấn đề chặn; tìm thấy trường ngưỡng thanh toán; chỉ gọi fields_get/check_access_rights', async () => {
    const orm = new FakeOrm();
    const r = await runProbe(orm, { expectedVersion: '18.0', actualVersion: '18.0+e' });
    expect(r.blockers).toBe(0);
    expect(r.thresholdFields.map((f) => f.name)).toEqual(['moveo_payment_threshold']);
    expect(r.findings.find((f) => f.area === 'version')!.detail).toMatch(/Odoo 18\.0\+e/);
    expect(new Set(orm.calls.map((c) => c.method))).toEqual(new Set(['fields_get', 'check_access_rights']));
    expect(orm.tables.get('sale.order') ?? []).toHaveLength(0); // không tạo gì
  });

  test('phát hiện từng loại lỗi trước khi chạy: sai phiên bản, thiếu trường, thiếu model, thiếu quyền, không có tính năng ngưỡng', async () => {
    const orm = new FakeOrm();
    delete orm.schema['stock.picking'].sale_id;
    delete orm.schema['stock.lot'];
    delete orm.schema['product.product'].tracking;
    delete orm.schema['sale.order'].moveo_payment_threshold;
    orm.denied.add('stock.lot.unlink').add('account.payment.create');
    const r = await runProbe(orm, { expectedVersion: '18.0', actualVersion: '17.0' });
    const text = r.findings.filter((f) => !f.ok).map((f) => `${f.severity}:${f.detail}`).join('\n');
    expect(text).toMatch(/blocker:phiên bản thực tế 17\.0 không khớp kỳ vọng 18\.0/);
    expect(text).toMatch(/blocker:stock\.picking thiếu trường: sale_id/);
    expect(text).toMatch(/blocker:stock\.lot\.fields_get lỗi/);
    expect(text).toMatch(/warning:product\.product không có trường tuỳ chọn: tracking/);
    expect(text).toMatch(/blocker:stock\.lot: tài khoản thiếu quyền unlink/);
    expect(text).toMatch(/blocker:account\.payment: tài khoản thiếu quyền create/);
    expect(text).toMatch(/blocker:không tìm thấy trường ngưỡng thanh toán/);
    expect(r.blockers).toBeGreaterThanOrEqual(6);
    expect((await runProbe(new FakeOrm(), { actualVersion: undefined })).findings[0]).toMatchObject({ ok: false, severity: 'blocker' });
  });

  test('CLI odoo:probe chỉ gọi phương thức đọc và nằm trong package.json', () => {
    const src = fs.readFileSync(path.join('scripts', 'odoo-probe.ts'), 'utf8');
    expect(src).not.toMatch(/'(create|write|unlink|action_\w+|button_\w+)'/);
    expect(JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts['odoo:probe']).toBe('tsx scripts/odoo-probe.ts');
    const probe = fs.readFileSync(path.join('applications', 'odoo', 'probe.ts'), 'utf8');
    expect(probe.match(/rpc\.call[^(]*\(\s*[^,]+,\s*'(\w+)'/g)!.every((m) => /fields_get|check_access_rights/.test(m))).toBe(true);
  });
});

test.describe('FIRST-2 Chính sách ghi áp dụng cho cả thao tác qua Playwright MCP', () => {
  test('mcpWriteIntent: công cụ đọc luôn qua; nhãn ghi, phím Lưu, mã tự do ghi/RPC ghi bị coi là ý định ghi; RPC đọc thì không', () => {
    const t = (tool: string, input: unknown = {}) => mcpWriteIntent(`mcp__playwright__browser_${tool}`, input);
    for (const read of ['navigate', 'snapshot', 'take_screenshot', 'hover', 'wait_for', 'tabs', 'console_messages', 'network_requests']) expect(t(read, { url: 'https://a.example.com' }), read).toBeUndefined();
    for (const label of ['Lưu', 'Save', 'Xác nhận', 'Confirm', 'Tạo hóa đơn', 'Hủy', 'Xóa', 'Validate', 'Thanh toán', 'Import serial']) expect(t('click', { element: `Nút ${label}`, ref: 'e1' }), label).toBeTruthy();
    for (const label of ['Bán hàng', 'Đơn hàng', 'Menu chính', 'Tab Chi tiết']) expect(t('click', { element: label, ref: 'e1' }), label).toBeUndefined();
    expect(t('press_key', { key: 'Control+S' })).toMatch(/phím tắt Lưu/);
    expect(t('press_key', { key: 'ArrowDown' })).toBeUndefined();
    expect(t('type', { element: 'ô tìm kiếm', text: 'S0001', submit: true })).toMatch(/submit/);
    expect(t('fill_form', { fields: [{ name: 'Ghi chú', type: 'textbox', value: 'x' }] })).toBeUndefined();
    expect(t('file_upload', { paths: ['x'] })).toBeTruthy();
    expect(t('run_code_unsafe', { code: "async (page) => { const r = await page.request.post('/web/dataset/call_kw/sale.order/search_read', {}); }" })).toBeUndefined();
    expect(t('run_code_unsafe', { code: "await page.request.post('/web/dataset/call_kw/sale.order/action_confirm', {})" })).toMatch(/RPC không phải đọc \(action_confirm\)/);
    expect(t('run_code_unsafe', { code: "await page.request.post('/web/dataset/call_kw/sale.order/create', {})" })).toMatch(/create/);
    expect(t('run_code_unsafe', { code: "await page.getByRole('button', { name: 'Lưu' }).click()" })).toMatch(/thao tác giao diện/);
    expect(t('evaluate', { function: "() => document.title" })).toBeUndefined();
    expect(t('handle_dialog', { accept: true })).toBeTruthy();
    expect(t('handle_dialog', { accept: false })).toBeUndefined();
  });

  function workspace(envs: Record<string, { url: string; kind?: 'production' }>) {
    const w = makeApprovedWorkspace();
    cleanups.push(() => fs.rmSync(w.ws, { recursive: true, force: true }));
    process.env.QA_APPROVAL_KEY_FILE = w.keyFile;
    const f = installFakeEnvironments(w.ws, Object.fromEntries(Object.entries(envs).map(([k, v]) => [k, { url: v.url, version: '18.0', kind: v.kind, roles: { accountant: acct } }])));
    cleanups.push(f.restore);
    const cfg = structuredClone(f.config) as EnvironmentsFile;
    for (const k of Object.keys(cfg.environments)) cfg.environments[k].policy = { write: 'framework-data', autoCleanup: true };
    fs.writeFileSync(path.join(f.envDir, 'odoo.json'), JSON.stringify(cfg));
    const env = { ...w.env, ...f.vars, QA_ENVIRONMENTS_DIR: f.envDir } as NodeJS.ProcessEnv;
    const hook = (tool: string, toolInput: unknown) =>
      spawnSync(process.execPath, [tsx, path.join(process.cwd(), 'scripts', 'approval.ts'), 'hook'], { cwd: w.ws, env, input: JSON.stringify({ tool_name: `mcp__playwright__browser_${tool}`, tool_input: toolInput }), encoding: 'utf8' });
    const resolved = (k: string) => {
      const r = resolveEnvironment('odoo', k);
      if (!r.ok) throw new Error(r.problems.join());
      return r.env;
    };
    const confirmExec = (k: string) => {
      selectEnvironment(w.ws, 'odoo', k);
      const e = resolved(k);
      confirmExecution(w.ws, { env: e, requirementId: wsReq.id, approvalHash: w.hash, by: 'N', typed: confirmPhrase(e) });
    };
    return { ...w, hook, resolved, confirmExec };
  }

  test('hook MCP: đọc luôn qua; ghi bị chặn khi chưa xác nhận chính sách; được qua (có nhật ký) sau khi người dùng xác nhận; RPC ghi cũng vậy', () => {
    const w = workspace({ ENV_A: { url: 'https://a.example.com' } });
    w.confirmExec('ENV_A');
    expect(w.hook('navigate', { url: 'https://a.example.com/odoo' }).status).toBe(0);
    expect(w.hook('snapshot', {}).status).toBe(0);
    expect(w.hook('click', { element: 'Menu Bán hàng', ref: 'e2' }).status).toBe(0);
    const blocked = w.hook('click', { element: 'Nút Lưu', ref: 'e9' });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/WRITE POLICY GATE: chặn mcp__playwright__browser_click vì có ý định ghi dữ liệu/);
    expect(blocked.stderr).toMatch(/Chính sách ghi của ENV_A chưa được xác nhận.*qa:policy -- confirm --env=ENV_A/s);
    const rpcWrite = "await page.request.post('/web/dataset/call_kw/sale.order/action_confirm', {})";
    expect(w.hook('run_code_unsafe', { code: rpcWrite }).status).toBe(2);
    expect(w.hook('run_code_unsafe', { code: "await page.request.post('/web/dataset/call_kw/sale.order/search_read', {})" }).status).toBe(0);
    expect(fs.existsSync(path.join(w.ws, '.qa-state', 'mcp-writes.jsonl'))).toBe(false);

    // Người dùng xác nhận chính sách (ở đây mô phỏng bằng hàm lõi, đúng như lệnh qa:policy confirm làm).
    const e = w.resolved('ENV_A');
    confirmPolicy(w.ws, { env: e, requirementId: wsReq.id, approvalHash: w.hash, by: 'Chị Thanh', typed: policyPhrase(e, effectivePolicy(e)) });
    expect(w.hook('click', { element: 'Nút Lưu', ref: 'e9' }).status).toBe(0);
    expect(w.hook('run_code_unsafe', { code: rpcWrite }).status).toBe(0);
    const audit = fs.readFileSync(path.join(w.ws, '.qa-state', 'mcp-writes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ environment: 'ENV_A', requirementId: wsReq.id, tool: 'mcp__playwright__browser_click' });
    expect(audit[0].sessionId).toMatch(/^[0-9a-f]{16}$/);
    // URL lạ vẫn bị chặn dù đã có chính sách (các cổng không thay thế nhau).
    expect(w.hook('navigate', { url: 'https://khac.example.com' }).status).toBe(2);
  });

  test('hook MCP: production (kể cả khai báo sai) không bao giờ ghi được qua MCP dù đã xác nhận môi trường; chính sách của môi trường khác không dùng chéo', () => {
    const w = workspace({ ENV_A: { url: 'https://a.example.com' }, PROD_X: { url: 'https://erp.example.com' } });
    const a = w.resolved('ENV_A');
    confirmPolicy(w.ws, { env: a, requirementId: wsReq.id, approvalHash: w.hash, by: 'N', typed: policyPhrase(a, effectivePolicy(a)) });
    w.confirmExec('PROD_X'); // đã chọn + xác nhận thực thi production-looking
    expect(w.hook('snapshot', {}).status).toBe(0); // đọc thì được
    const r = w.hook('click', { element: 'Xác nhận', ref: 'e1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/PROD_X bị coi là production.*không có quyền ghi qua Playwright MCP/);
    w.confirmExec('ENV_A');
    expect(w.hook('click', { element: 'Xác nhận', ref: 'e1' }).status).toBe(0); // ENV_A có chính sách
    const b = workspace({ ENV_A: { url: 'https://a.example.com' }, ENV_B: { url: 'https://b.example.com' } });
    const ea = b.resolved('ENV_A');
    confirmPolicy(b.ws, { env: ea, requirementId: wsReq.id, approvalHash: b.hash, by: 'N', typed: policyPhrase(ea, effectivePolicy(ea)) });
    b.confirmExec('ENV_B');
    expect(b.hook('click', { element: 'Lưu', ref: 'e1' }).status).toBe(2); // chính sách của ENV_A không áp cho ENV_B
  });

  test('--no-auto-cleanup chỉ có thể TẮT cleanup cho lần chạy; /qa-requirement ghi rõ luật ghi qua MCP', () => {
    const rt = fs.readFileSync(path.join('scripts', 'run-tests.ts'), 'utf8');
    expect(rt).toContain("argv.includes('--no-auto-cleanup')");
    expect(rt).toContain('checks[0].policy.autoCleanup && !noAutoCleanup');
    expect(rt).not.toMatch(/autoCleanup = true/);
    const cmd = fs.readFileSync(path.join('.claude', 'commands', 'qa-requirement.md'), 'utf8');
    expect(cmd).toContain('WRITE POLICY GATE');
    expect(cmd).toContain('odoo:probe');
  });
});
