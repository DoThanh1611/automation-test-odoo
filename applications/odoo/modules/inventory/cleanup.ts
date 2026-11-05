import type { CleanupHandler, PlanItem } from '../../../../core/testdata/cleanup';
import type { OdooClient } from '../../client';

/**
 * Cleanup phiếu kho (stock.picking) của module Inventory. CHỈ lập kế hoạch (chỉ đọc); engine thực thi và chỉ trên bản ghi registry owner FRAMEWORK.
 * Cơ chế đã thấy trên form phiếu kho (nút "Hủy" = action_cancel): phiếu CHƯA hoàn tất ⇒ action_cancel. Phiếu đã hoàn tất (done) làm thay đổi
 * tồn kho/serial ⇒ chặn (CLEANUP_BLOCKED), không ép xoá hay đảo kho. Phiếu đã hủy ⇒ coi như đã dọn.
 */
export const inventoryPickingCleanup: CleanupHandler<OdooClient> = {
  id: 'inventory-picking',
  models: ['stock.picking'],
  supported: true,
  async plan({ client, records }) {
    const uid = await client.currentUserId();
    const rows = await client.searchRead<any>('stock.picking', [['id', 'in', records.map((r) => r.recordId)]], ['name', 'state', 'origin', 'create_uid']);
    return records.map((r): PlanItem => {
      const row = rows.find((x) => x.id === r.recordId);
      if (!row) return { model: 'stock.picking', id: r.recordId, reference: r.reference, label: `stock.picking#${r.recordId}`, eligible: true, alreadyClean: true, blockers: [], steps: [], meta: { note: 'không còn tồn tại trên hệ thống' } };
      const blockers: string[] = [];
      if (!String(row.origin ?? '').startsWith('AUTOTEST')) blockers.push(`tham chiếu "${row.origin}" không mang nhãn AUTOTEST`);
      if (uid && row.create_uid?.[0] !== uid) blockers.push(`được tạo bởi người dùng khác (${row.create_uid?.[1]})`);
      if (row.state === 'done') blockers.push(`phiếu ${row.name} đã hoàn tất: ảnh hưởng tồn kho/serial, cần đảo thủ công`);
      return {
        model: 'stock.picking', id: r.recordId, reference: row.name, label: row.name, eligible: !blockers.length, alreadyClean: row.state === 'cancel', blockers,
        steps: blockers.length || row.state === 'cancel' ? [] : [{ op: 'stock.picking.action_cancel', why: 'Huỷ phiếu kho test chưa hoàn tất' }],
        meta: { state: row.state },
      };
    });
  },
};
