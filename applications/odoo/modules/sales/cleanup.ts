import type { CleanupHandler, PlanItem } from '../../../../core/testdata/cleanup';
import { AUTOTEST_REF_PATTERN } from '../../../../core/testdata/autotest';
import { loadRegistry, recordKey } from '../../../../core/testdata/registry';
import type { OdooClient } from '../../client';

/**
 * Cleanup của module Sales cho 2 loại chứng từ: SO (sale.order) và phiếu thu (account.payment). CHỈ ĐỌC (lập kế hoạch).
 * Cơ chế huỷ hợp lệ đã xác minh bằng định nghĩa view của Odoo (không xoá cứng chứng từ đã ghi sổ):
 *   Phiếu thu in_process : Reset to Draft (action_draft) -> Cancel (action_cancel). Nút Cancel chỉ hiện ở draft/đã gửi.
 *   SO đã xác nhận       : nếu đã khoá -> Mở khoá (action_unlock) -> Huỷ (action_cancel).
 *   Thứ tự               : phiếu thu trước, SO sau.
 * Quy trình này CHỈ áp dụng cho Sales; module khác không được dùng lại khi chưa tự xác minh.
 */
export const salesCleanup: CleanupHandler<OdooClient> = {
  id: 'sales-order-and-payment',
  models: ['sale.order', 'account.payment'],
  supported: true,

  async plan({ client, records }): Promise<PlanItem[]> {
    const uid = await client.currentUserId();
    const soRecs = records.filter((r) => r.model === 'sale.order');
    const payRecs = records.filter((r) => r.model === 'account.payment');

    const sos = soRecs.length
      ? await client.searchRead<any>('sale.order', [['id', 'in', soRecs.map((r) => r.recordId)]],
          ['name', 'client_order_ref', 'state', 'locked', 'moveo_payment_status', 'amount_total', 'invoice_ids', 'picking_ids', 'create_uid', 'company_id'], { context: { active_test: false } })
      : [];
    const pays = payRecs.length
      ? await client.searchRead<any>('account.payment', [['id', 'in', payRecs.map((r) => r.recordId)]],
          ['name', 'state', 'amount', 'date', 'is_sent', 'is_reconciled', 'reconciled_invoice_ids', 'moveo_sale_order_id', 'move_id', 'journal_id', 'company_id'])
      : [];
    const moveIds = pays.map((p) => p.move_id?.[0]).filter(Boolean);
    const moveLines = moveIds.length
      ? await client.searchRead<any>('account.move.line', [['move_id', 'in', moveIds]], ['move_id', 'reconciled', 'matching_number', 'statement_line_id'])
      : [];
    const journals = pays.length
      ? await client.searchRead<any>('account.journal', [['id', 'in', [...new Set(pays.map((p) => p.journal_id[0]))]]], ['name', 'restrict_mode_hash_table'])
      : [];
    const companyIds = [...new Set([...sos.map((s) => s.company_id[0]), ...pays.map((p) => p.company_id[0])])];
    const companies = companyIds.length
      ? await client.searchRead<any>('res.company', [['id', 'in', companyIds]], ['name', 'fiscalyear_lock_date', 'tax_lock_date', 'sale_lock_date', 'hard_lock_date'])
      : [];
    const pickIds = sos.flatMap((s) => s.picking_ids as number[]);
    const picks = pickIds.length ? await client.searchRead<any>('stock.picking', [['id', 'in', pickIds]], ['name', 'state']) : [];
    const invoiceIds = sos.flatMap((s) => s.invoice_ids);
    const liveInvoices = invoiceIds.length
      ? new Set((await client.searchRead<any>('account.move', [['id', 'in', invoiceIds], ['state', '!=', 'cancel']], ['id'])).map((m) => m.id))
      : new Set<number>();

    const regOf = (model: string, id: number) => loadRegistry().find((r) => recordKey(r) === `odoo|${model}|${id}`);
    const lockBlockers = (p: any) => {
      const c = companies.find((x) => x.id === p.company_id[0]);
      const out: string[] = [];
      for (const k of ['fiscalyear_lock_date', 'tax_lock_date', 'sale_lock_date', 'hard_lock_date']) {
        if (c?.[k] && p.date <= c[k]) out.push(`ngày phiếu thu ${p.date} nằm trong kỳ đã khoá (${k}=${c[k]})`);
      }
      return out;
    };

    // ---- Phiếu thu ----
    const payItems: PlanItem[] = pays.map((p) => {
      const lines = moveLines.filter((l) => l.move_id[0] === p.move_id?.[0]);
      const journal = journals.find((j) => j.id === p.journal_id[0]);
      const blockers: string[] = [];
      if (p.is_reconciled || (p.reconciled_invoice_ids ?? []).length) blockers.push('phiếu thu đã đối soát với hóa đơn');
      if (lines.some((l) => l.reconciled || l.matching_number)) blockers.push('bút toán phiếu thu đã đối soát');
      if (lines.some((l) => l.statement_line_id)) blockers.push('bút toán phiếu thu gắn dòng sao kê');
      if (journal?.restrict_mode_hash_table) blockers.push(`sổ nhật ký "${journal.name}" bật khoá hash: không được Reset to Draft`);
      blockers.push(...lockBlockers(p));
      if (!['draft', 'in_process', 'canceled'].includes(p.state)) blockers.push(`trạng thái "${p.state}" không có đường huỷ đã xác minh`);
      if (p.state === 'in_process' && p.is_sent) blockers.push('phiếu thu đã đánh dấu đã gửi: luồng huỷ khác, chưa xác minh');
      const steps = blockers.length || p.state === 'canceled' ? [] : [
        ...(p.state === 'in_process' ? [{ op: 'account.payment.action_draft', why: 'Reset to Draft: nút Cancel chỉ hiện khi phiếu thu ở trạng thái draft' }] : []),
        { op: 'account.payment.action_cancel', why: 'Huỷ phiếu thu và bút toán (giữ dấu vết kiểm toán, không xoá cứng)' },
      ];
      return {
        model: 'account.payment', id: p.id, reference: p.name, label: p.name,
        eligible: blockers.length === 0, alreadyClean: p.state === 'canceled', blockers, steps,
        meta: { state: p.state, amount: p.amount, date: p.date, journalEntryId: p.move_id?.[0], soId: p.moveo_sale_order_id?.[0], provenance: regOf('account.payment', p.id)?.origin },
      };
    });

    // ---- SO ----
    const soItems: PlanItem[] = sos.map((so) => {
      const myPays = payItems.filter((p) => p.meta?.soId === so.id);
      const allPays = payRecs.filter((r) => r.parent === `sale.order:${so.id}`);
      const blockers: string[] = [];
      if (!AUTOTEST_REF_PATTERN.test(so.client_order_ref ?? '')) blockers.push(`tham chiếu "${so.client_order_ref}" không đúng mẫu AUTOTEST`);
      if (uid && so.create_uid?.[0] !== uid) blockers.push(`SO được tạo bởi người dùng khác (${so.create_uid?.[1]}), không phải tài khoản automation`);
      const liveInv = so.invoice_ids.filter((i: number) => liveInvoices.has(i));
      if (liveInv.length) blockers.push(`có ${liveInv.length} hóa đơn còn hiệu lực`);
      // Phiếu giao: chỉ chấp nhận khi do framework tạo (có trong registry) và chưa hoàn tất; phiếu đã hoàn tất tác động tồn kho/kế toán => chặn.
      for (const pk of picks.filter((x) => (so.picking_ids as number[]).includes(x.id))) {
        if (pk.state === 'done') blockers.push(`phiếu giao ${pk.name} đã hoàn tất (ràng buộc kho/kế toán)`);
        else if (!regOf('stock.picking', pk.id) && pk.state !== 'cancel') blockers.push(`phiếu giao ${pk.name} không do framework tạo`);
      }
      if (!['draft', 'sent', 'sale', 'cancel'].includes(so.state)) blockers.push(`trạng thái SO "${so.state}" không hợp lệ để huỷ`);
      const unplanned = allPays.filter((r) => !myPays.some((p) => p.id === r.recordId));
      if (unplanned.length) blockers.push(`${unplanned.length} phiếu thu của SO không đọc được từ Odoo`);
      for (const p of myPays) if (!p.eligible && !p.alreadyClean) blockers.push(`phiếu thu ${p.reference} chưa đủ điều kiện huỷ`);
      const steps = blockers.length || so.state === 'cancel' ? [] : [
        ...(so.locked ? [{ op: 'sale.order.action_unlock', why: 'SO đang khoá: nút Huỷ bị ẩn cho tới khi mở khoá' }] : []),
        { op: 'sale.order.action_cancel', why: 'Huỷ SO (có thể mở wizard xác nhận). Chỉ làm SAU khi phiếu thu đã huỷ' },
      ];
      const reg = regOf('sale.order', so.id);
      return {
        model: 'sale.order', id: so.id, reference: so.client_order_ref || '', label: so.name,
        eligible: blockers.length === 0, alreadyClean: so.state === 'cancel', blockers, steps,
        meta: { state: so.state, locked: so.locked, paymentStatus: so.moveo_payment_status, total: so.amount_total, payments: myPays.map((p) => p.reference), runId: reg?.runId, testCaseId: reg?.testCaseId, provenance: reg?.origin },
      };
    });

    return [...payItems, ...soItems]; // phiếu thu trước, SO sau
  },
};
