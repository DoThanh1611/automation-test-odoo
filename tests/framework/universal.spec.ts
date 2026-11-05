import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { OdooClient } from '../../applications/odoo/client';
import { adapterCleanupHandlers, mergeHandlers } from '../../applications/odoo/generic-cleanup';
import { UnresolvedData, modelKind, planForModel, prepareGeneric } from '../../applications/odoo/generic';
import { currentFingerprints, deriveAdapter, deriveModelAdapter, environmentProfile, formButtons, modelMeta } from '../../applications/odoo/introspect';
import { runUniversalProbe } from '../../applications/odoo/probe-universal';
import { adapterFile, loadAdapters, manifestProblems, reuseDecision, saveAdapter, type AdapterManifest } from '../../core/adapters/manifest';
import type { AutomationFile } from '../../core/automation/meta';
import { blockedByRole, roleGaps, rolesNeeded } from '../../core/automation/roles';
import { effectivePolicy } from '../../core/policy/policy';
import { DataFactory, FactoryError } from '../../core/testdata/factory';
import { runCleanup } from '../../core/testdata/cleanup-engine';
import { loadRegistry } from '../../core/testdata/registry';
import type { TestCaseDef } from '../../core/testcases/schema';
import { decideNext, type WorkflowFacts } from '../../core/workflow/next';
import { FakeOdoo, char, m2o, sel, type FakeModelDef } from './helpers/fake-odoo';

// Framework tests cho khả năng thích ứng mọi module Odoo (UV-*). Toàn bộ chạy trên Odoo GIẢ điều khiển bằng lược đồ + thư mục tạm:
// không kết nối staging. "Module tùy chỉnh" ở đây là x_fleet (không có trong bất kỳ danh sách nào của framework).

const RUN = '20261105-120000';
let tmp: string;
let prevReg: string | undefined;
test.beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-uv-'));
  prevReg = process.env.QA_REGISTRY_FILE;
  process.env.QA_REGISTRY_FILE = path.join(tmp, 'registry.jsonl');
});
test.afterEach(() => {
  if (prevReg === undefined) delete process.env.QA_REGISTRY_FILE;
  else process.env.QA_REGISTRY_FILE = prevReg;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fleetModels = (): Record<string, FakeModelDef> => ({
  'res.company': { fields: { name: char({ required: true }) } },
  'res.partner': { fields: { name: char({ required: true }), comment: { type: 'text' }, active: { type: 'boolean' } } },
  // Chứng từ tùy chỉnh có quy trình: draft -> confirmed, huỷ được.
  'x_fleet.trip': {
    fields: { name: char({ required: true }), partner_id: m2o('res.partner', { required: true }), company_id: m2o('res.company', { required: true }), origin: char(), note: { type: 'text' }, state: sel('draft', 'confirmed', 'done', 'cancel') },
    buttons: ['action_confirm', 'action_cancel'],
    actions: { action_confirm: { from: ['draft'], to: 'confirmed' }, action_cancel: { to: 'cancel' } },
  },
  // Phiếu có nút xác nhận mở wizard (kiểu phiếu kho).
  'x_fleet.pick': {
    fields: { name: char({ required: true }), origin: char(), state: sel('draft', 'done', 'cancel') },
    buttons: ['button_validate', 'action_cancel'],
    actions: { button_validate: { from: ['draft'], wizard: 'x_fleet.pick.wiz' }, action_cancel: { to: 'cancel' } },
  },
  'x_fleet.pick.wiz': { fields: {}, processes: { model: 'x_fleet.pick', to: 'done' } },
  // Không có trường active, không có state, không có nút huỷ: chưa biết cách dọn an toàn.
  'x_fleet.log': { fields: { name: char({ required: true }), note: { type: 'text' } } },
  // Bắt buộc one2many: không tự dựng được.
  'x_fleet.order': { fields: { name: char({ required: true }), line_ids: { type: 'one2many', relation: 'x_fleet.line', required: true } } },
  // Vòng phụ thuộc.
  'x_a': { fields: { name: char({ required: true }), b_id: m2o('x_b', { required: true }) } },
  'x_b': { fields: { name: char({ required: true }), a_id: m2o('x_a', { required: true }) } },
});

const odoo = (over: Partial<ConstructorParameters<typeof FakeOdoo>[0]> = {}) => {
  const o = new FakeOdoo({ version: '18.0', modules: ['base', 'web', 'x_fleet'], models: fleetModels(), ...over });
  o.seed('res.company', { name: 'Công ty giả' });
  return o;
};

const scope = (tc = 'TC-U-001') => ({ application: 'odoo', module: 'fleet', environment: 'ENV_A', runId: RUN, requirementId: 'REQ-U-001', testCaseId: tc });
const policy = () => effectivePolicy({ application: 'odoo', key: 'ENV_A', label: 'A', kind: 'staging', baseUrl: 'https://a.example.com', origin: 'https://a.example.com', host: 'a.example.com', roles: {}, policy: { write: 'framework-data', autoCleanup: true, failureRetentionHours: 48, maxRecordsPerRun: 200 } } as never);

/** Khám phá + adapter + factory cho các model chỉ định, y như quy trình thật (không viết tay công thức nào). */
async function setup(orm: FakeOdoo, models: string[], opts: { curate?: (a: AdapterManifest) => void; problems?: () => string[]; tc?: string } = {}) {
  const profile = await environmentProfile(orm, '18.0');
  const d = await deriveAdapter(orm, { module: 'fleet', models, requiresModules: ['x_fleet'], profile });
  expect(d.missing).toEqual([]);
  const adapter = d.adapter!;
  opts.curate?.(adapter);
  const { resolveRecipe, metas } = await prepareGeneric({ rpc: orm, adapters: [adapter] }, models);
  const factory = new DataFactory({ rpc: orm, recipes: [], resolveRecipe, scope: scope(opts.tc), writeProblems: opts.problems ?? (() => []), maxRecordsPerRun: 200 });
  return { adapter, factory, metas };
}

// ---------------------------------------------------------------------------------------------------------------------
test.describe('UV-1 Khám phá môi trường: phiên bản, edition, module — không hardcode', () => {
  test('Community, Enterprise và tài khoản không đọc được danh sách module', async () => {
    expect(await environmentProfile(odoo(), '18.0')).toMatchObject({ edition: 'community', modulesKnown: true });
    expect(await environmentProfile(odoo({ modules: ['base', 'web_enterprise', 'x_fleet'] }), '18.0+e')).toMatchObject({ edition: 'enterprise', version: '18.0+e' });
    const blind = await environmentProfile(odoo({ denyModuleList: true }), '17.0');
    expect(blind).toMatchObject({ edition: 'unknown', modulesKnown: false, installedModules: [] });
  });

  test('model tùy chỉnh được đọc cấu trúc và nút trên form; model không tồn tại ⇒ undefined (thiếu điều kiện môi trường)', async () => {
    const orm = odoo();
    expect((await modelMeta(orm, 'x_fleet.trip'))?.partner_id).toMatchObject({ type: 'many2one', required: true });
    expect(await formButtons(orm, 'x_fleet.trip')).toEqual(['action_confirm', 'action_cancel']);
    expect(await modelMeta(orm, 'khong.co')).toBeUndefined();
  });

  test('chỉ đọc: khám phá không gọi bất kỳ phương thức ghi hay action nào', async () => {
    const orm = odoo();
    const profile = await environmentProfile(orm, '18.0');
    await deriveAdapter(orm, { module: 'fleet', models: ['x_fleet.trip', 'x_fleet.pick', 'x_fleet.log'], requiresModules: ['x_fleet'], profile });
    const used = new Set(orm.calls.map((c) => c.method));
    for (const bad of ['create', 'write', 'unlink', 'action_confirm', 'action_cancel', 'button_validate']) expect(used.has(bad), bad).toBe(false);
  });
});

test.describe('UV-2 Sinh adapter cho module chưa từng được hỗ trợ', () => {
  test('module tùy chỉnh: nhãn AUTOTEST/thẻ QA, các bước nghiệp vụ có thật trên form, cách dọn theo nút huỷ', async () => {
    const orm = odoo();
    const trip = deriveModelAdapter('x_fleet.trip', (await modelMeta(orm, 'x_fleet.trip'))!, await formButtons(orm, 'x_fleet.trip'));
    expect(trip).toMatchObject({ refField: 'origin', tagField: 'note', stateField: 'state', finalStates: ['done'], cleanStates: ['cancel'] });
    expect(trip.transitions).toMatchObject({ confirm: { method: 'action_confirm' }, cancel: { method: 'action_cancel', to: 'cancel' } });
    expect(trip.transitions).not.toHaveProperty('post'); // không có nút ⇒ không bịa bước
    expect(trip.cleanup).toEqual({ kind: 'cancel', steps: ['action_cancel'] });
    const log = deriveModelAdapter('x_fleet.log', (await modelMeta(orm, 'x_fleet.log'))!, []);
    expect(log.cleanup.kind).toBe('unsupported'); // không đoán cách dọn
    expect(log.cleanup.reason).toMatch(/chưa được xác minh/);
    const partner = deriveModelAdapter('res.partner', (await modelMeta(orm, 'res.partner'))!, []);
    expect(partner.cleanup).toEqual({ kind: 'archive' });
  });

  test('thiếu model (module chưa cài) ⇒ không tạo adapter, trả về danh sách thiếu', async () => {
    const orm = odoo();
    const profile = await environmentProfile(orm, '18.0');
    const r = await deriveAdapter(orm, { module: 'fleet', models: ['x_fleet.trip', 'x_khong_co'], requiresModules: ['x_fleet'], profile });
    expect(r.adapter).toBeUndefined();
    expect(r.missing).toEqual(['x_khong_co']);
  });

  test('lưu/đọc adapter; file hỏng hoặc sai cấu trúc được báo và không được tin', async () => {
    const orm = odoo();
    const { adapter } = await setup(orm, ['x_fleet.trip']);
    const file = saveAdapter(tmp, adapter);
    expect(file).toBe(adapterFile(tmp, 'odoo', 'fleet'));
    expect(loadAdapters(tmp, 'odoo')).toMatchObject({ problems: [], adapters: [{ module: 'fleet', origin: 'derived' }] });
    fs.writeFileSync(path.join(path.dirname(file), 'hong.adapter.json'), '{ không phải json');
    fs.writeFileSync(path.join(path.dirname(file), 'sai.adapter.json'), JSON.stringify({ schema: 1, application: 'odoo', module: 'sai', requiresModules: [], verifiedOn: { version: '18.0' }, models: [{ model: 'm', fieldsFingerprint: 'x', cleanup: { kind: 'cancel' } }] }));
    const r = loadAdapters(tmp, 'odoo');
    expect(r.adapters.map((a) => a.module)).toEqual(['fleet']);
    expect(r.problems.join(' ')).toMatch(/hong\.adapter\.json/);
    expect(r.problems.join(' ')).toMatch(/sai\.adapter\.json.*steps/);
    expect(manifestProblems({ ...adapter, models: [] }).join()).toMatch(/ít nhất một model/);
    expect(() => saveAdapter(tmp, { ...adapter, models: [] })).toThrow(/không hợp lệ/);
  });
});

test.describe('UV-3 Tái sử dụng adapter và kiểm chứng lại khi môi trường đổi', () => {
  const base = async () => (await setup(odoo(), ['x_fleet.trip'])).adapter;
  const envOf = (over: Partial<Parameters<typeof reuseDecision>[1]> = {}) => ({ version: '18.0', edition: 'community' as const, installedModules: ['base', 'x_fleet'], modulesKnown: true, ...over });

  test('REUSE khi phiên bản/edition/cấu trúc không đổi', async () => {
    const a = await base();
    const fp = await currentFingerprints(odoo(), ['x_fleet.trip']);
    expect(reuseDecision(a, envOf(), fp)).toEqual({ status: 'REUSE', reasons: [] });
    expect(reuseDecision(a, envOf({ version: '18.2' }), fp).status).toBe('REUSE'); // cùng phiên bản chính
  });

  test('REVERIFY khi đổi phiên bản chính, edition hoặc cấu trúc trường; không tin mù quáng', async () => {
    const a = await base();
    const fp = await currentFingerprints(odoo(), ['x_fleet.trip']);
    expect(reuseDecision(a, envOf({ version: '19.0' }), fp)).toMatchObject({ status: 'REVERIFY', reasons: [expect.stringMatching(/18\.0.*19\.0/)] });
    expect(reuseDecision(a, envOf({ edition: 'enterprise' }), fp).reasons.join()).toMatch(/edition community.*enterprise/);
    const changed = odoo();
    changed.o.models['x_fleet.trip'].fields.extra = char({ required: true });
    const d = reuseDecision(a, envOf(), await currentFingerprints(changed, ['x_fleet.trip']));
    expect(d.status).toBe('REVERIFY');
    expect(d.reasons.join()).toMatch(/x_fleet\.trip.*đã đổi/);
  });

  test('module chưa cài ⇒ UNAVAILABLE (thiếu điều kiện môi trường, khác lỗi nghiệp vụ); không đọc được danh sách module ⇒ REVERIFY, không bịa', async () => {
    const a = await base();
    const none = reuseDecision(a, envOf({ installedModules: ['base'] }));
    expect(none.status).toBe('UNAVAILABLE');
    expect(none.reasons.join()).toMatch(/chưa cài module: x_fleet/);
    const blind = reuseDecision(a, envOf({ installedModules: [], modulesKnown: false, edition: 'unknown' }));
    expect(blind.status).toBe('REVERIFY');
    expect(blind.reasons.join()).toMatch(/không đọc được danh sách module/);
  });
});

test.describe('UV-4 Test Data Factory tự thích ứng', () => {
  test('tự dựng phụ thuộc: tạo đối tác mới, chọn công ty cấu hình, gắn nhãn AUTOTEST và thẻ QA, đăng ký registry đủ bốn ID với owner FRAMEWORK', async () => {
    const orm = odoo();
    const seeded = orm.seed('res.partner', { name: `AUTOTEST ${RUN} TC-U-001 Khách hàng 1` }); // trùng tên: vẫn KHÔNG được dùng lại
    const { factory, metas } = await setup(orm, ['x_fleet.trip']);
    const h = await factory.build(planForModel(metas, 'x_fleet.trip'));
    const trip = orm.find('x_fleet.trip', h.main.id)!;
    const partner = orm.find('res.partner', h['main.partner_id'].id)!;
    expect(partner.id).not.toBe(seeded.id);
    expect(trip.partner_id).toBe(partner.id);
    expect(trip.company_id).toBe(orm.table('res.company')[0].id);
    expect(trip.origin).toBe(`AUTOTEST ${RUN} TC-U-001`);
    expect(trip.note).toMatch(/QA env=ENV_A run=20261105-120000 req=REQ-U-001 tc=TC-U-001/);
    expect(orm.table('res.company')).toHaveLength(1); // dữ liệu cấu hình chỉ được chọn, không tạo
    const reg = loadRegistry().filter((r) => r.runId === RUN);
    expect(reg.map((r) => r.model).sort()).toEqual(['res.partner', 'x_fleet.trip']);
    for (const r of reg) expect(r).toMatchObject({ owner: 'FRAMEWORK', origin: 'AUTOMATION', environment: 'ENV_A', requirementId: 'REQ-U-001', testCaseId: 'TC-U-001', application: 'odoo' });
    expect(reg.find((r) => r.model === 'x_fleet.trip')!.dependsOn).toEqual([`res.partner:${partner.id}`]);
  });

  test('Confirm: bước nghiệp vụ lấy từ adapter và được kiểm tra trạng thái sau bước', async () => {
    const orm = odoo();
    const { factory, metas } = await setup(orm, ['x_fleet.trip'], { curate: (a) => { a.models[0].transitions!.confirm.to = 'confirmed'; } });
    const h = await factory.build(planForModel(metas, 'x_fleet.trip', { steps: ['confirm'] }));
    expect(orm.find('x_fleet.trip', h.main.id)!.state).toBe('confirmed');
  });

  test('bước adapter không khai báo (không có nút trên form) ⇒ UnresolvedData, không đoán tên phương thức; bản ghi đã tạo vẫn ở registry', async () => {
    const orm = odoo();
    const { factory, metas } = await setup(orm, ['x_fleet.trip']);
    await expect(factory.build(planForModel(metas, 'x_fleet.trip', { steps: ['post'] }))).rejects.toThrow(UnresolvedData);
    expect(loadRegistry().some((r) => r.model === 'x_fleet.trip')).toBe(true);
  });

  test('bước sai trạng thái đích bị phát hiện (Done phải thật sự đạt Done)', async () => {
    const orm = odoo();
    const { factory, metas } = await setup(orm, ['x_fleet.trip'], { curate: (a) => { a.models[0].transitions!.confirm.to = 'done'; } });
    await expect(factory.build(planForModel(metas, 'x_fleet.trip', { steps: ['confirm'] }))).rejects.toThrow(/không đưa .* tới "done"/);
  });

  test('nút mở wizard (kiểu xác nhận phiếu kho): wizard được xử lý bằng phương thức chuẩn và phiếu tới Done', async () => {
    const orm = odoo();
    const { factory, metas } = await setup(orm, ['x_fleet.pick'], { curate: (a) => { a.models[0].transitions!.validate.to = 'done'; } });
    const h = await factory.build(planForModel(metas, 'x_fleet.pick', { steps: ['validate'] }));
    expect(orm.find('x_fleet.pick', h.main.id)!.state).toBe('done');
    expect(loadRegistry().map((r) => r.model)).toEqual(['x_fleet.pick']); // wizard tạm không phải dữ liệu test
  });

  test('không tự dựng được dữ liệu hợp lệ (one2many bắt buộc / vòng phụ thuộc) ⇒ UnresolvedData và không ghi gì', async () => {
    const orm = odoo();
    const { factory, metas } = await setup(orm, ['x_fleet.order', 'x_a']);
    await expect(factory.build(planForModel(metas, 'x_fleet.order'))).rejects.toThrow(/line_ids.*one2many/);
    expect(orm.table('x_fleet.order')).toHaveLength(0);
    expect(() => planForModel(metas, 'x_a')).toThrow(/quan hệ vòng/);
  });

  test('model không tồn tại trên môi trường ⇒ UnresolvedData (thiếu điều kiện môi trường)', async () => {
    await expect(prepareGeneric({ rpc: odoo(), adapters: [] }, ['x_khong_co'])).rejects.toThrow(/không tồn tại hoặc không đọc được/);
  });

  test('cổng ghi: chính sách không cho ghi ⇒ không tạo gì; kind lạ không có công thức ⇒ lỗi rõ', async () => {
    const orm = odoo();
    const { factory, metas } = await setup(orm, ['x_fleet.trip'], { problems: () => ['môi trường chỉ đọc'] });
    await expect(factory.build(planForModel(metas, 'x_fleet.trip'))).rejects.toThrow(FactoryError);
    expect(orm.table('x_fleet.trip')).toHaveLength(0);
    expect(orm.table('res.partner')).toHaveLength(0);
    const ok = await setup(orm, ['x_fleet.trip']);
    await expect(ok.factory.create(modelKind('x_chua_nap'))).rejects.toThrow(/Chưa có công thức/);
  });
});

test.describe('UV-5 Cleanup adapter: thành công, bị chặn, giữ lại', () => {
  const handlers = (a: AdapterManifest) => mergeHandlers([], adapterCleanupHandlers([a]));
  const clean = (orm: FakeOdoo, a: AdapterManifest, o: Record<string, unknown> = {}) =>
    runCleanup({ client: orm as unknown as OdooClient, handlers: handlers(a), records: loadRegistry(), environment: 'ENV_A', policy: policy(), runId: RUN, ...o } as Parameters<typeof runCleanup>[0]);

  test('dọn theo thứ tự phụ thuộc (chứng từ trước, đối tác sau); huỷ/lưu trữ chứ không xoá; dữ liệu ngoài registry không bị đụng', async () => {
    const orm = odoo();
    const business = orm.seed('res.partner', { name: 'Khách hàng thật' });
    const { adapter, factory, metas } = await setup(orm, ['x_fleet.trip', 'res.partner']);
    const h = await factory.build(planForModel(metas, 'x_fleet.trip', { steps: [] }));
    const before = orm.calls.length;
    const r = await clean(orm, adapter);
    expect(r.counts).toMatchObject({ CLEANED: 2, CLEANUP_BLOCKED: 0 });
    const ops = orm.calls.slice(before).filter((c) => !['search_read', 'search_count'].includes(c.method)).map((c) => `${c.model}.${c.method}`);
    expect(ops.indexOf('x_fleet.trip.action_cancel')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('x_fleet.trip.action_cancel')).toBeLessThan(ops.indexOf('res.partner.write'));
    expect(ops.some((o) => o.endsWith('.unlink'))).toBe(false);
    expect(orm.find('x_fleet.trip', h.main.id)!.state).toBe('cancel');
    expect(orm.find('res.partner', h['main.partner_id'].id)!.active).toBe(false);
    expect(orm.find('res.partner', business.id)!.active).toBe(true);
  });

  test('chứng từ đã ở trạng thái cuối (Done) ⇒ CLEANUP_BLOCKED, không ép huỷ; kết quả test không đổi', async () => {
    const orm = odoo();
    const { adapter, factory, metas } = await setup(orm, ['x_fleet.trip']);
    const h = await factory.build(planForModel(metas, 'x_fleet.trip'));
    orm.find('x_fleet.trip', h.main.id)!.state = 'done';
    const r = await clean(orm, adapter);
    const out = r.outcomes.find((o) => o.model === 'x_fleet.trip')!;
    expect(out.status).toBe('CLEANUP_BLOCKED');
    expect(out.reason).toMatch(/trạng thái cuối "done"/);
    expect(orm.find('x_fleet.trip', h.main.id)!.state).toBe('done');
    expect(orm.calls.some((c) => c.method === 'action_cancel')).toBe(false);
  });

  test('loại chưa xác minh cách dọn ⇒ CLEANUP_BLOCKED "CHƯA HỖ TRỢ"', async () => {
    const orm = odoo();
    const { adapter, factory } = await setup(orm, ['x_fleet.log']);
    await factory.create(modelKind('x_fleet.log'));
    const r = await clean(orm, adapter);
    expect(r.outcomes[0]).toMatchObject({ model: 'x_fleet.log', status: 'CLEANUP_BLOCKED' });
    expect(r.outcomes[0].reason).toMatch(/CHƯA HỖ TRỢ/);
  });

  test('test FAIL ⇒ RETAINED để điều tra; sau thời hạn giữ mới dọn', async () => {
    const orm = odoo();
    const { adapter, factory, metas } = await setup(orm, ['x_fleet.trip'], { tc: 'TC-U-007' });
    const h = await factory.build(planForModel(metas, 'x_fleet.trip'));
    const r = await clean(orm, adapter, { failedTestCases: new Set(['TC-U-007']) });
    expect(r.counts.RETAINED).toBeGreaterThan(0);
    expect(orm.find('x_fleet.trip', h.main.id)!.state).toBe('draft');
  });

  test('bản ghi không mang nhãn framework hoặc do người khác tạo ⇒ không dọn dù có trong registry', async () => {
    const orm = odoo();
    const { adapter, factory, metas } = await setup(orm, ['x_fleet.trip']);
    const h = await factory.build(planForModel(metas, 'x_fleet.trip'));
    orm.find('x_fleet.trip', h.main.id)!.create_uid = [99, 'Người khác'];
    const out = (await clean(orm, adapter)).outcomes.find((o) => o.model === 'x_fleet.trip')!;
    expect(out.status).toBe('CLEANUP_BLOCKED');
    expect(out.reason).toMatch(/người dùng khác/);
  });

  test('handler chuyên biệt (curated) luôn thắng adapter tự sinh', async () => {
    const orm = odoo();
    const { adapter } = await setup(orm, ['x_fleet.trip']);
    const curated = { id: 'curated-trip', models: ['x_fleet.trip'], supported: true, plan: async () => [] };
    const merged = mergeHandlers([curated as never], adapterCleanupHandlers([adapter]));
    expect(merged.filter((h) => h.models.includes('x_fleet.trip')).map((h) => h.id)).toEqual(['curated-trip']);
  });
});

test.describe('UV-6 Tài khoản theo nhu cầu', () => {
  const def = (id: string) => ({ id, requirementId: 'REQ-R-001' }) as TestCaseDef;
  const files: AutomationFile[] = [{ requirementId: 'REQ-R-001', testCases: {
    'TC-1': { access: 'READ', dataStrategy: 'NONE', cleanup: 'NONE' },
    'TC-2': { access: 'READ', dataStrategy: 'NONE', cleanup: 'NONE', role: 'approver' },
    'TC-3': { access: 'READ', dataStrategy: 'NONE', cleanup: 'NONE', role: 'approver' },
  } }];
  const cards = (over: Record<string, { configured: boolean; missingVars?: string[] }> = {}) => [
    { role: 'accountant', configured: true, missingVars: [] }, { role: 'approver', configured: false, missingVars: ['ODOO_A_APPROVER_USER', 'ODOO_A_APPROVER_PASS'] },
    { role: 'unrelated', configured: false, missingVars: ['ODOO_A_UNRELATED_USER'] },
  ].map((c) => ({ ...c, ...(over[c.role] ?? {}) }));

  test('chỉ vai trò test case dùng; vai trò không liên quan không bao giờ bị đòi; chỉ nêu TÊN biến', () => {
    const needs = rolesNeeded([def('TC-1'), def('TC-2'), def('TC-3')], files, 'accountant');
    expect(needs).toEqual([{ role: 'accountant', testCases: ['TC-1'] }, { role: 'approver', testCases: ['TC-2', 'TC-3'] }]);
    const gaps = roleGaps(needs, cards());
    expect(gaps).toEqual([{ role: 'approver', testCases: ['TC-2', 'TC-3'], vars: ['ODOO_A_APPROVER_USER', 'ODOO_A_APPROVER_PASS'] }]);
    expect(JSON.stringify(gaps)).not.toMatch(/UNRELATED/);
    expect([...blockedByRole(gaps)]).toEqual([['TC-2', expect.stringMatching(/approver.*ODOO_A_APPROVER_USER/)], ['TC-3', expect.stringMatching(/approver/)]]);
  });

  test('thiếu một phần: chỉ test dùng vai trò đó BLOCKED, quy trình vẫn tiếp tục; thiếu hết ⇒ dừng xin đúng biến; bổ sung xong tự đi tiếp', () => {
    const needs = rolesNeeded([def('TC-1'), def('TC-2')], files, 'accountant');
    const facts = (over: Partial<WorkflowFacts>): WorkflowFacts => ({
      requirementId: 'REQ-R-001', requirementExists: true, inbox: [], testCaseCount: 2, integrity: [], approvalState: 'APPROVED', needWrite: false,
      setup: { usableEnvironments: 1, problems: [] }, env: { selected: 'ENV_A', envValid: true, envDetail: 'ok', policyEligible: true, policyValid: true },
      login: { missing: [], failed: [] }, probe: { supported: false, done: false, failed: false },
      automation: { eligibleWithoutSpec: [], marked: false, withSpec: ['TC-1', 'TC-2'], ranWithSpec: [] },
      rolesNeeded: needs.map((n) => n.role), roleGaps: roleGaps(needs, cards()), ...over,
    });
    const partial = decideNext(facts({}));
    expect(partial.stage).toBe('READY_TO_RUN');
    expect(partial.checks.find((c) => c.name === 'Tài khoản theo vai trò')?.detail).toMatch(/approver \(TC-2\) sẽ BLOCKED.*còn lại vẫn chạy/);
    const allMissing = decideNext(facts({ rolesNeeded: ['approver'], roleGaps: roleGaps([{ role: 'approver', testCases: ['TC-2'] }], cards()) }));
    expect(allMissing).toMatchObject({ stage: 'NEEDS_ROLES', owner: 'user' });
    expect(allMissing.summary).toMatch(/ODOO_A_APPROVER_USER, ODOO_A_APPROVER_PASS/);
    expect(allMissing.summary + allMissing.userActions.join()).not.toMatch(/UNRELATED|accountant/);
    const after = decideNext(facts({ rolesNeeded: ['approver'], roleGaps: roleGaps([{ role: 'approver', testCases: ['TC-2'] }], cards({ approver: { configured: true } })) }));
    expect(after.stage).toBe('READY_TO_RUN');
  });
});

test.describe('UV-7 Thăm dò không phụ thuộc module', () => {
  test('báo trạng thái từng adapter; thiếu module không phải blocker toàn cục; sai phiên bản là blocker', async () => {
    const orm = odoo();
    const { adapter } = await setup(orm, ['x_fleet.trip']);
    const ok = await runUniversalProbe(orm, { actualVersion: '18.0', expectedVersion: '18.0', adapters: [adapter] });
    expect(ok.blockers).toBe(0);
    expect(ok.adapters).toEqual([{ module: 'fleet', status: 'REUSE', reasons: [] }]);
    expect(ok.findings.some((f) => f.area === 'access' && f.ok)).toBe(true);

    const noModule = await runUniversalProbe(odoo({ modules: ['base'] }), { actualVersion: '18.0', adapters: [adapter] });
    expect(noModule.adapters[0].status).toBe('UNAVAILABLE');
    expect(noModule.blockers).toBe(0);
    expect(noModule.findings.map((f) => f.detail).join()).toMatch(/thiếu điều kiện môi trường.*BLOCKED/);

    const wrong = await runUniversalProbe(odoo(), { actualVersion: '17.0', expectedVersion: '18.0', adapters: [adapter] });
    expect(wrong.blockers).toBe(1);
    expect(wrong.adapters[0].status).toBe('REVERIFY');
  });

  test('thiếu quyền ghi là cảnh báo cho test liên quan (BLOCKED), không chặn cả lần chạy', async () => {
    const orm = odoo();
    const { adapter } = await setup(orm, ['x_fleet.trip']);
    orm.denied.add('x_fleet.trip.create');
    const r = await runUniversalProbe(orm, { actualVersion: '18.0', adapters: [adapter] });
    expect(r.blockers).toBe(0);
    expect(r.findings.find((f) => f.area === 'access' && !f.ok)?.detail).toMatch(/x_fleet\.trip.*create.*BLOCKED/);
  });
});

test.describe('UV-8 Đầu-cuối module tùy chỉnh chưa có Factory/Page Object/spec (Odoo giả)', () => {
  test('khám phá → lưu adapter → yêu cầu sau tái sử dụng (không sinh lại) → tạo dữ liệu + Confirm → cleanup; không dùng dữ liệu có sẵn', async () => {
    // Requirement 1: chưa có adapter.
    const orm = odoo();
    const business = orm.seed('x_fleet.trip', { name: 'Chuyến thật', state: 'confirmed', origin: 'KH-001' });
    expect(loadAdapters(tmp, 'odoo').adapters).toHaveLength(0);
    const first = await setup(orm, ['x_fleet.trip', 'res.partner'], { curate: (a) => { a.models[0].transitions!.confirm.to = 'confirmed'; } });
    saveAdapter(tmp, first.adapter);
    const h1 = await first.factory.build(planForModel(first.metas, 'x_fleet.trip', { steps: ['confirm'] }));
    expect(orm.find('x_fleet.trip', h1.main.id)!.state).toBe('confirmed');

    // Requirement 2: adapter đã có ⇒ dùng lại; môi trường không đổi ⇒ REUSE, file adapter không bị ghi đè.
    const stored = loadAdapters(tmp, 'odoo').adapters;
    const bytes = fs.readFileSync(adapterFile(tmp, 'odoo', 'fleet'), 'utf8');
    const profile = await environmentProfile(orm, '18.0');
    expect(reuseDecision(stored[0], profile, await currentFingerprints(orm, ['x_fleet.trip', 'res.partner'])).status).toBe('REUSE');
    const { resolveRecipe, metas } = await prepareGeneric({ rpc: orm, adapters: stored }, ['x_fleet.trip']);
    const f2 = new DataFactory({ rpc: orm, recipes: [], resolveRecipe, scope: { ...scope('TC-U-002') }, writeProblems: () => [], maxRecordsPerRun: 200 });
    const h2 = await f2.build(planForModel(metas, 'x_fleet.trip', { steps: ['confirm'] }));
    expect(orm.find('x_fleet.trip', h2.main.id)!.state).toBe('confirmed');
    expect(fs.readFileSync(adapterFile(tmp, 'odoo', 'fleet'), 'utf8')).toBe(bytes);

    // Cleanup bằng adapter đã lưu: chỉ hai bộ dữ liệu framework; chứng từ thật giữ nguyên.
    const r = await runCleanup({ client: orm as unknown as OdooClient, handlers: adapterCleanupHandlers(stored), records: loadRegistry(), environment: 'ENV_A', policy: policy(), runId: RUN } as Parameters<typeof runCleanup>[0]);
    expect(r.counts).toMatchObject({ CLEANED: 4, CLEANUP_BLOCKED: 0 });
    expect(orm.find('x_fleet.trip', h1.main.id)!.state).toBe('cancel');
    expect(orm.find('x_fleet.trip', h2.main.id)!.state).toBe('cancel');
    expect(orm.find('x_fleet.trip', business.id)!.state).toBe('confirmed');
    expect(h1.main.id).not.toBe(business.id);
  });
});
