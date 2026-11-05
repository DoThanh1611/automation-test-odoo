import type { CleanupHandler, PlanItem } from '../../core/testdata/cleanup';
import { AUTOTEST_PREFIX } from '../../core/testdata/autotest';
import type { OdooClient } from './client';
import { salesCleanup } from './modules/sales/cleanup';

/**
 * Cleanup cho dữ liệu do Test Data Factory tạo (ngoài SO/phiếu thu đã có handler ở module Sales). CHỈ lập kế hoạch (chỉ đọc);
 * engine (core/testdata/cleanup-engine.ts) mới thực thi và chỉ trên bản ghi có trong registry với owner FRAMEWORK.
 *  - Khách hàng, sản phẩm: lưu trữ (active=false), không xoá. Chỉ khi tên mang tiền tố AUTOTEST, do tài khoản automation tạo và chưa phát sinh nghiệp vụ không hoàn tác được.
 *  - Serial (stock.lot): xoá CHỈ khi chưa phát sinh dịch chuyển kho đã hoàn tất; đã dùng => chặn.
 *  - Phiếu kho (stock.picking): huỷ khi chưa hoàn tất và có bằng chứng sở hữu trên Odoo; đã hoàn tất (ảnh hưởng tồn kho/kế toán) => chặn, cần đảo thủ công.
 * Ghi chú: các bước ORM chưa được kiểm chứng trên Odoo thật; bước lỗi sẽ cho CLEANUP_BLOCKED kèm nguyên nhân, không làm hỏng kết quả test.
 */
const missing = (model: string, id: number, reference: string): PlanItem => ({
  model, id, reference, label: `${model}#${id}`, eligible: true, alreadyClean: true, blockers: [], steps: [], meta: { note: 'không còn tồn tại trên hệ thống' },
});

const archiveHandler: CleanupHandler<OdooClient> = {
  id: 'factory-master-data',
  models: ['res.partner', 'product.product'],
  supported: true,
  async plan({ client, records }) {
    const uid = await client.currentUserId();
    const items: PlanItem[] = [];
    for (const model of ['res.partner', 'product.product']) {
      const recs = records.filter((r) => r.model === model);
      if (!recs.length) continue;
      const rows = await client.searchRead<any>(model, [['id', 'in', recs.map((r) => r.recordId)]], ['name', 'active', 'create_uid'], { context: { active_test: false } });
      for (const r of recs) {
        const row = rows.find((x) => x.id === r.recordId);
        if (!row) {
          items.push(missing(model, r.recordId, r.reference));
          continue;
        }
        const blockers: string[] = [];
        if (!String(row.name ?? '').startsWith(AUTOTEST_PREFIX)) blockers.push(`tên "${row.name}" không mang tiền tố ${AUTOTEST_PREFIX}`);
        if (uid && row.create_uid?.[0] !== uid) blockers.push(`được tạo bởi người dùng khác (${row.create_uid?.[1]})`);
        // Đã phát sinh nghiệp vụ không hoàn tác được thì không archive, kể cả khi chứng từ đó nằm ngoài registry.
        const [usedModel, usedDomain, usedWhy] = model === 'product.product'
          ? ['stock.move.line', [['product_id', '=', r.recordId], ['state', '=', 'done']], 'dịch chuyển kho hoàn tất']
          : ['account.move', [['partner_id', '=', r.recordId], ['state', '=', 'posted']], 'chứng từ kế toán đã ghi sổ'];
        const used = await client.count(usedModel as string, usedDomain as unknown[]);
        if (used) blockers.push(`đã phát sinh ${used} ${usedWhy}`);
        items.push({
          model, id: r.recordId, reference: r.reference, label: row.name, eligible: !blockers.length, alreadyClean: row.active === false, blockers,
          steps: blockers.length || row.active === false ? [] : [{ op: `${model}.write`, why: 'Lưu trữ (archive) bản ghi test, không xoá', args: [{ active: false }] }],
        });
      }
    }
    return items;
  },
};

const serialHandler: CleanupHandler<OdooClient> = {
  id: 'factory-serial',
  models: ['stock.lot'],
  supported: true,
  async plan({ client, records }) {
    const uid = await client.currentUserId();
    const rows = await client.searchRead<any>('stock.lot', [['id', 'in', records.map((r) => r.recordId)]], ['name', 'note', 'create_uid']);
    const items: PlanItem[] = [];
    for (const r of records) {
      const row = rows.find((x) => x.id === r.recordId);
      if (!row) {
        items.push(missing('stock.lot', r.recordId, r.reference));
        continue;
      }
      const used = await client.count('stock.move.line', [['lot_id', '=', r.recordId], ['state', '=', 'done']]);
      const blockers: string[] = [];
      if (!String(row.note ?? '').includes('QA env=')) blockers.push('serial không mang thẻ QA của framework');
      if (uid && row.create_uid?.[0] !== uid) blockers.push(`được tạo bởi người dùng khác (${row.create_uid?.[1]})`);
      if (used) blockers.push(`serial đã phát sinh ${used} dịch chuyển kho hoàn tất (ràng buộc kho)`);
      items.push({
        model: 'stock.lot', id: r.recordId, reference: row.name, label: row.name, eligible: !blockers.length, alreadyClean: false, blockers,
        steps: blockers.length ? [] : [{ op: 'stock.lot.unlink', why: 'Xoá serial test chưa dùng (không phải chứng từ)' }],
      });
    }
    return items;
  },
};

const pickingHandler: CleanupHandler<OdooClient> = {
  id: 'factory-delivery',
  models: ['stock.picking'],
  supported: true,
  async plan({ client, records }) {
    const uid = await client.currentUserId();
    const rows = await client.searchRead<any>('stock.picking', [['id', 'in', records.map((r) => r.recordId)]], ['name', 'state', 'origin', 'create_uid']);
    const soKeys = (r: (typeof records)[number]) => [...(r.dependsOn ?? []), ...(r.parent ? [r.parent] : [])].filter((k) => k.startsWith('sale.order:'));
    const soIds = [...new Set(records.flatMap(soKeys))].map((k) => Number(k.slice('sale.order:'.length)));
    const orders = soIds.length ? await client.searchRead<any>('sale.order', [['id', 'in', soIds]], ['name']) : [];
    return records.map((r): PlanItem => {
      const row = rows.find((x) => x.id === r.recordId);
      if (!row) return missing('stock.picking', r.recordId, r.reference);
      const blockers = row.state === 'done' ? [`phiếu giao ${row.name} đã hoàn tất: ảnh hưởng tồn kho/kế toán, cần đảo thủ công`] : [];
      // Bằng chứng sở hữu ngay trên Odoo: nhãn AUTOTEST, hoặc phiếu do chính SO test của framework sinh ra.
      const fromOwnSo = orders.some((o) => soKeys(r).includes(`sale.order:${o.id}`) && o.name === row.origin);
      if (!String(row.origin ?? '').startsWith(AUTOTEST_PREFIX) && !fromOwnSo) blockers.push(`tham chiếu "${row.origin}" không chứng minh phiếu do framework tạo`);
      if (uid && row.create_uid?.[0] !== uid) blockers.push(`được tạo bởi người dùng khác (${row.create_uid?.[1]})`);
      return {
        model: 'stock.picking', id: r.recordId, reference: row.name, label: row.name, eligible: !blockers.length, alreadyClean: row.state === 'cancel', blockers,
        steps: blockers.length || row.state === 'cancel' ? [] : [{ op: 'stock.picking.action_cancel', why: 'Huỷ phiếu giao chưa hoàn tất' }],
        meta: { state: row.state },
      };
    });
  },
};

/** Mọi handler cleanup của Odoo cho dữ liệu framework (gồm handler SO/phiếu thu của Sales). */
export const odooFactoryCleanupHandlers: CleanupHandler<OdooClient>[] = [salesCleanup, archiveHandler, serialHandler, pickingHandler];
