import fs from 'node:fs';
import path from 'node:path';
import { openOdooClient } from '../applications/odoo/session';
import { listOdooModules } from '../applications/odoo/modules';
import type { OdooModuleDef } from '../applications/odoo/modules/types';
import { AUTOTEST_PREFIX } from '../core/testdata/autotest';
import { checkExecutionGate, confirmPhrase, planId, type PlanItem } from '../core/testdata/cleanup';
import { loadRegistry, type TestDataRecord } from '../core/testdata/registry';
import { pickEnvironment, reportsFor } from './_env';

/**
 * LẬP KẾ HOẠCH dọn dữ liệu AUTOTEST theo từng module. CHỈ ĐỌC: không gọi hàm ghi/huỷ/xoá/đảo bút toán.
 *
 *   npm run cleanup:plan                          # mọi module có dữ liệu trong registry
 *   npm run cleanup:plan -- --module=odoo-sales   # một module
 *   npm run cleanup:plan -- --run=20261102-175937 # một lần chạy
 *   npm run cleanup:plan -- --verified-only       # chỉ bản ghi automation tự đăng ký lúc tạo (bỏ BACKFILL)
 *
 * Loại chứng từ chưa có quy trình huỷ an toàn đã xác minh được hiển thị "CHƯA HỖ TRỢ" và không có bước nào được đề xuất.
 *
 * THỰC THI (chưa triển khai, chỉ có cổng xác nhận):
 *   --execute --module=<key> --plan-id=<mã> --confirm="<câu xác nhận>"  và biến môi trường ALLOW_CLEANUP=true
 * Cổng chặn nếu thiếu bất kỳ điều kiện nào; ngay cả khi qua cổng, chưa có handler nào có execute() nên script dừng.
 */
// Dọn dữ liệu là theo TỪNG môi trường: sổ dữ liệu test, phiên đăng nhập và kế hoạch đều là của môi trường đang chọn.
const envKey = pickEnvironment()!;
const reportsDir = reportsFor(envKey);
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const moduleFilter = arg('module');
const runFilter = arg('run');
const verifiedOnly = flag('verified-only');
const execute = flag('execute');

const all = loadRegistry().filter((r) => r.application === 'odoo');
// Mỗi bản ghi thuộc đúng MỘT module: theo trường module nếu có; bản ghi cũ (chưa có trường này) theo model mà handler của module khai báo.
const owner = (r: TestDataRecord, mods: OdooModuleDef[]) =>
  mods.find((m) => (r.module ? r.module === m.module : m.cleanup.some((h) => h.models.includes(r.model))));

const modules = listOdooModules().filter((m) => !moduleFilter || m.key === moduleFilter);
if (moduleFilter && !modules.length) {
  console.error(`Không có module "${moduleFilter}". Có: ${listOdooModules().map((m) => m.key).join(', ')}`);
  process.exit(1);
}

let candidates = all.filter((r) => owner(r, listOdooModules()));
const orphans = all.filter((r) => !owner(r, listOdooModules()));
if (runFilter) candidates = candidates.filter((r) => r.runId === runFilter);
const excludedUnverified = verifiedOnly ? candidates.filter((r) => r.origin !== 'AUTOMATION') : [];
if (verifiedOnly) candidates = candidates.filter((r) => r.origin === 'AUTOMATION');

const out: any = {
  generatedAt: new Date().toISOString(),
  mode: 'DRY-RUN (chỉ đọc, không thay đổi Odoo)',
  filter: { module: moduleFilter ?? 'tất cả', run: runFilter ?? 'tất cả', verifiedOnly },
  modules: [] as any[],
  recordsWithoutOwner: orphans.map((r) => ({ model: r.model, id: r.recordId, reference: r.reference })),
  excludedUnverified: excludedUnverified.length,
};
let host = '';
for (const mod of modules) {
  const mine = candidates.filter((r) => owner(r, listOdooModules())?.key === mod.key);
  let opened: Awaited<ReturnType<typeof openOdooClient>>;
  try {
    opened = await openOdooClient(mod.key);
  } catch (e) {
    // Registry không có bản ghi nào của module và chưa có phiên đăng nhập: không có gì để lập kế hoạch, không cần kết nối hệ thống.
    if (mine.length) throw e;
    out.modules.push({ key: mod.key, title: mod.title, planId: planId([]), offline: true, note: 'Registry không có bản ghi AUTOTEST của module này và chưa có phiên đăng nhập: bỏ qua đối chiếu với hệ thống.', summary: { records: 0, eligible: 0, blocked: 0, alreadyClean: 0, unsupportedRecords: 0, unregisteredOnOdoo: 0 }, unsupported: [], unregistered: [], items: [] });
    continue;
  }
  const { client, baseURL } = opened;
  host = new URL(baseURL).host;

  const items: PlanItem[] = [];
  const unsupported: { model: string; handler: string; reason: string; count: number }[] = [];
  for (const h of mod.cleanup) {
    const recs = mine.filter((r) => h.models.includes(r.model));
    if (!recs.length) continue;
    items.push(...(await h.plan({ client, records: recs })));
    if (!h.supported) unsupported.push({ model: h.models.join(', '), handler: h.id, reason: h.unsupportedReason ?? '', count: recs.length });
  }
  // Bản ghi mà module không có handler nào cho model của nó: không cleanup (chưa hỗ trợ), không suy diễn từ loại khác.
  for (const r of mine.filter((r) => !mod.cleanup.some((h) => h.models.includes(r.model)))) {
    items.push({ model: r.model, id: r.recordId, reference: r.reference, label: `${r.model}#${r.recordId}`, eligible: false, alreadyClean: false, blockers: [`CHƯA HỖ TRỢ: module ${mod.key} chưa khai báo quy trình cleanup cho model ${r.model}`], steps: [] });
  }

  // Dữ liệu AUTOTEST có trên Odoo nhưng CHƯA có trong registry (không đưa vào kế hoạch).
  const registeredByModel = new Set(all.map((r) => `${r.model}|${r.recordId}`));
  const unregistered: { model: string; id: number; ref: string }[] = [];
  for (const rule of mod.ownership) {
    const rows = await client.searchRead<any>(rule.model, [[rule.refField, '=like', `${AUTOTEST_PREFIX}%`]], ['id', rule.refField]);
    for (const r of rows) if (!registeredByModel.has(`${rule.model}|${r.id}`)) unregistered.push({ model: rule.model, id: r.id, ref: r[rule.refField] });
  }

  const executable = items.filter((i) => i.eligible && !i.alreadyClean && i.steps.length);
  out.modules.push({
    key: mod.key,
    title: mod.title,
    planId: planId(items),
    summary: {
      records: items.length,
      eligible: executable.length,
      blocked: items.filter((i) => !i.eligible).length,
      alreadyClean: items.filter((i) => i.alreadyClean).length,
      unsupportedRecords: unsupported.reduce((n, u) => n + u.count, 0),
      unregisteredOnOdoo: unregistered.length,
    },
    unsupported,
    unregistered,
    items,
  });
}
out.environment = host || '(chưa kết nối hệ thống)';

// ---- THỰC THI: chỉ có cổng xác nhận ----
if (execute) {
  const m = out.modules.length === 1 && moduleFilter ? out.modules[0] : undefined;
  const count = m ? m.items.filter((i: PlanItem) => i.eligible && !i.alreadyClean && i.steps.length).length : 0;
  const problems = checkExecutionGate({
    moduleKey: moduleFilter,
    host,
    currentPlanId: m?.planId ?? '',
    executableCount: count,
    givenPlanId: arg('plan-id'),
    givenPhrase: arg('confirm'),
    allowCleanupEnv: process.env.ALLOW_CLEANUP === 'true',
  });
  if (problems.length) {
    console.error('CỔNG XÁC NHẬN CHẶN thực thi cleanup:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  console.error(`Đã qua cổng xác nhận (${confirmPhrase(moduleFilter!, host, count)}) nhưng KHÔNG có handler nào triển khai execute(): dừng, không thay đổi gì.`);
  process.exit(2);
}

fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(path.join(reportsDir, 'cleanup-plan.json'), JSON.stringify(out, null, 2));

const md: string[] = [
  '# Kế hoạch dọn dữ liệu AUTOTEST (DRY-RUN)', '',
  `Môi trường: ${host} · Tạo lúc ${out.generatedAt} · Bộ lọc: module=${out.filter.module}, run=${out.filter.run}, verifiedOnly=${verifiedOnly}`, '',
  '**Chưa thay đổi gì trên Odoo.** Chỉ thực thi sau khi có xác nhận cụ thể qua cổng xác nhận riêng (xem FRAMEWORK.md).', '',
];
for (const m of out.modules) {
  md.push(`## Module ${m.key} — ${m.title}`, '', `Mã kế hoạch: \`${m.planId}\``, '', '| Hạng mục | Số lượng |', '|---|---|',
    ...Object.entries(m.summary).map(([k, v]) => `| ${k} | ${v} |`), '');
  for (const u of m.unsupported) md.push(`> **CHƯA HỖ TRỢ** (${u.model}, ${u.count} bản ghi): ${u.reason}`, '');
  md.push('| Chứng từ | Bản ghi | Trạng thái | Đủ điều kiện | Vướng mắc / Bước |', '|---|---|---|---|---|',
    ...m.items.map((i: PlanItem) => `| ${i.model} | ${i.label} | ${(i.meta?.state as string) ?? '-'} | ${i.alreadyClean ? 'đã huỷ' : i.eligible ? 'có' : 'KHÔNG'} | ${i.blockers.join('; ') || i.steps.map((s) => s.op.split('.').pop()).join(' → ') || '-'} |`), '');
  if (m.unregistered.length) md.push('Có trên Odoo nhưng CHƯA trong registry (không đưa vào kế hoạch):', ...m.unregistered.map((u: any) => `- ${u.model}#${u.id}: ${u.ref}`), '');
}
if (out.recordsWithoutOwner.length) md.push('## Bản ghi trong registry không thuộc module nào', ...out.recordsWithoutOwner.map((r: any) => `- ${r.model}#${r.id}: ${r.reference}`));
fs.writeFileSync(path.join(reportsDir, 'cleanup-plan.md'), md.join('\n') + '\n');

console.log(`Môi trường: ${host} | DRY-RUN, không thay đổi Odoo`);
for (const m of out.modules) {
  const s = m.summary;
  console.log(`[${m.key}] bản ghi ${s.records}: đủ điều kiện ${s.eligible}, vướng ${s.blocked}, đã huỷ ${s.alreadyClean}, CHƯA HỖ TRỢ ${s.unsupportedRecords}, ngoài registry ${s.unregisteredOnOdoo} | mã kế hoạch ${m.planId}`);
}
if (excludedUnverified.length) console.log(`Bỏ vì chưa xác minh (BACKFILL): ${excludedUnverified.length}`);
if (out.recordsWithoutOwner.length) console.log(`Bản ghi không thuộc module nào: ${out.recordsWithoutOwner.length}`);
console.log('Chi tiết: reports/cleanup-plan.json và reports/cleanup-plan.md');
