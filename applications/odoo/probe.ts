/**
 * Thăm dò Odoo CHỈ ĐỌC trước khi dùng Test Data Factory/cleanup trên môi trường thật: phiên bản, tài khoản, quyền truy cập từng model,
 * và các trường mà công thức Factory + handler cleanup + test sử dụng (tồn tại, kiểu). Chỉ gọi fields_get / check_access_rights /
 * search_read: không tạo, không ghi, không gọi action_*. Thuần logic (nhận rpc), kiểm thử được bằng ORM giả.
 */
export interface ProbeRpc {
  call<T = any>(model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>): Promise<T>;
}

/** Trường mà framework dùng, theo model. Thiếu trường `required` nghĩa là công thức/cleanup sẽ lỗi trên môi trường này. */
export const PROBE_FIELDS: Record<string, { required: string[]; optional?: string[] }> = {
  'res.partner': { required: ['name', 'comment', 'active', 'create_uid'] },
  'product.product': { required: ['name', 'default_code', 'list_price', 'type', 'description', 'active'], optional: ['is_storable', 'tracking'] },
  'stock.lot': { required: ['name', 'product_id', 'company_id', 'note'] },
  'sale.order': { required: ['partner_id', 'client_order_ref', 'origin', 'order_line', 'state', 'picking_ids', 'invoice_ids', 'locked', 'create_uid', 'company_id', 'amount_total'], optional: ['moveo_payment_status', 'moveo_amount_due'] },
  'sale.order.line': { required: ['product_id', 'product_uom_qty', 'price_unit', 'tax_ids'] },
  'stock.picking': { required: ['name', 'state', 'sale_id'] },
  'stock.move.line': { required: ['lot_id', 'quantity', 'picking_id', 'state'] },
  'account.payment': { required: ['payment_type', 'partner_type', 'partner_id', 'amount', 'state', 'move_id', 'journal_id', 'company_id'], optional: ['memo', 'moveo_sale_order_id', 'is_sent', 'is_reconciled', 'reconciled_invoice_ids'] },
};

/** Quyền cần cho từng model: Factory tạo/ghi, cleanup ghi/xoá (serial). */
export const PROBE_ACCESS: Record<string, string[]> = {
  'res.partner': ['read', 'create', 'write'],
  'product.product': ['read', 'create', 'write'],
  'stock.lot': ['read', 'create', 'unlink'],
  'sale.order': ['read', 'create', 'write'],
  'stock.picking': ['read', 'write'],
  'account.payment': ['read', 'create', 'write'],
};

export interface ProbeFinding {
  area: 'version' | 'orm' | 'fields' | 'access' | 'feature';
  ok: boolean;
  /** blocker = Factory/cleanup chắc chắn lỗi nếu không sửa; warning = có thể ảnh hưởng. */
  severity: 'blocker' | 'warning' | 'info';
  detail: string;
}

export interface ProbeResult {
  findings: ProbeFinding[];
  blockers: number;
  /** Các trường nghi là ngưỡng thanh toán trên sale.order (để test dùng đúng tên trường thật). */
  thresholdFields: { name: string; string: string; type: string }[];
  /** Các trường tuỳ chọn có/không có, để công thức chọn nhánh phù hợp. */
  optionalPresent: Record<string, string[]>;
}

export async function runProbe(rpc: ProbeRpc, o: { expectedVersion?: string; actualVersion?: string }): Promise<ProbeResult> {
  const findings: ProbeFinding[] = [];
  const add = (f: ProbeFinding) => findings.push(f);

  // Phiên bản
  if (!o.actualVersion) add({ area: 'version', ok: false, severity: 'blocker', detail: 'không đọc được phiên bản Odoo thực tế' });
  else if (o.expectedVersion && !o.actualVersion.startsWith(o.expectedVersion)) add({ area: 'version', ok: false, severity: 'blocker', detail: `phiên bản thực tế ${o.actualVersion} không khớp kỳ vọng ${o.expectedVersion}` });
  else add({ area: 'version', ok: true, severity: 'info', detail: `Odoo ${o.actualVersion}${o.expectedVersion ? ` (khớp kỳ vọng ${o.expectedVersion})` : ''}` });

  // API ORM + trường
  const optionalPresent: Record<string, string[]> = {};
  let thresholdFields: ProbeResult['thresholdFields'] = [];
  for (const [model, spec] of Object.entries(PROBE_FIELDS)) {
    let fields: Record<string, { string?: string; type?: string }>;
    try {
      fields = await rpc.call(model, 'fields_get', [], { attributes: ['string', 'type'] });
    } catch (e) {
      add({ area: 'orm', ok: false, severity: 'blocker', detail: `${model}.fields_get lỗi: ${(e as Error).message.slice(0, 160)} (model không tồn tại hoặc không có quyền đọc)` });
      continue;
    }
    const missing = spec.required.filter((f) => !fields[f]);
    add(missing.length
      ? { area: 'fields', ok: false, severity: 'blocker', detail: `${model} thiếu trường: ${missing.join(', ')}` }
      : { area: 'fields', ok: true, severity: 'info', detail: `${model}: đủ ${spec.required.length} trường bắt buộc` });
    if (spec.optional) {
      optionalPresent[model] = spec.optional.filter((f) => fields[f]);
      const absent = spec.optional.filter((f) => !fields[f]);
      if (absent.length) add({ area: 'fields', ok: false, severity: 'warning', detail: `${model} không có trường tuỳ chọn: ${absent.join(', ')} (công thức/cleanup phải bỏ qua phần dùng trường này)` });
    }
    if (model === 'sale.order') {
      thresholdFields = Object.entries(fields)
        .filter(([k, v]) => /threshold|nguong|ngưỡng/i.test(`${k} ${v.string ?? ''}`))
        .map(([name, v]) => ({ name, string: v.string ?? '', type: v.type ?? '' }));
      add(thresholdFields.length
        ? { area: 'feature', ok: true, severity: 'info', detail: `trường ngưỡng thanh toán trên sale.order: ${thresholdFields.map((f) => `${f.name} (${f.string}, ${f.type})`).join('; ')}` }
        : { area: 'feature', ok: false, severity: 'blocker', detail: 'không tìm thấy trường ngưỡng thanh toán trên sale.order (REQ-SO-INV-001 chưa được cài trên môi trường này?)' });
    }
  }

  // Quyền truy cập của tài khoản đang đăng nhập (không ghi gì)
  for (const [model, ops] of Object.entries(PROBE_ACCESS)) {
    const denied: string[] = [];
    for (const op of ops) {
      try {
        const ok = await rpc.call<boolean>(model, 'check_access_rights', [op], { raise_exception: false });
        if (!ok) denied.push(op);
      } catch (e) {
        denied.push(`${op} (không kiểm tra được: ${(e as Error).message.slice(0, 80)})`);
      }
    }
    add(denied.length
      ? { area: 'access', ok: false, severity: 'blocker', detail: `${model}: tài khoản thiếu quyền ${denied.join(', ')}` }
      : { area: 'access', ok: true, severity: 'info', detail: `${model}: đủ quyền ${ops.join('/')}` });
  }

  return { findings, blockers: findings.filter((f) => !f.ok && f.severity === 'blocker').length, thresholdFields, optionalPresent };
}
