import { AUTOTEST_PREFIX, AUTOTEST_REF_PATTERN } from '../../../../core/testdata/autotest';
import { registerRecord } from '../../../../core/testdata/registry';
import type { OdooClient } from '../../client';

/**
 * Nhận diện SO AUTOTEST (và phiếu thu của chúng) tạo TRƯỚC khi có registry, theo mẫu tham chiếu nghiêm ngặt, rồi đăng ký với origin=BACKFILL.
 * Chỉ ĐỌC Odoo; chỉ ghi file testdata/registry.jsonl cục bộ. Chạy lại an toàn (bỏ qua bản ghi đã đăng ký).
 */
export async function salesBackfill(client: OdooClient) {
  const sos = await client.searchRead<any>('sale.order', [['client_order_ref', '=like', `${AUTOTEST_PREFIX}%`]], ['name', 'client_order_ref', 'create_date']);
  const toIso = (s: string) => new Date(s.replace(' ', 'T') + 'Z').toISOString();
  const skipped: string[] = [];
  let registered = 0;
  for (const so of sos) {
    const m = AUTOTEST_REF_PATTERN.exec(so.client_order_ref ?? '');
    if (!m) {
      skipped.push(`${so.name} "${so.client_order_ref}"`);
      continue;
    }
    const common = { testCaseId: m[2], runId: m[1] ?? 'legacy', application: 'odoo', module: 'sales', origin: 'BACKFILL' as const };
    registerRecord({ ...common, model: 'sale.order', recordId: so.id, reference: so.client_order_ref, createdAt: toIso(so.create_date), note: 'backfill' });
    registered++;
    const pays = await client.searchRead<any>('account.payment', [['moveo_sale_order_id', '=', so.id]], ['name', 'create_date']);
    for (const p of pays) {
      registerRecord({ ...common, model: 'account.payment', recordId: p.id, reference: p.name, parent: `sale.order:${so.id}`, createdAt: toIso(p.create_date), note: 'backfill' });
      registered++;
    }
  }
  return { found: sos.length, registered, skipped };
}
