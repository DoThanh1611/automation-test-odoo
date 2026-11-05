import type { OdooRpc } from '../../../applications/odoo/factory';
import { PROBE_FIELDS } from '../../../applications/odoo/probe';

/**
 * ORM Odoo GIẢ trong bộ nhớ cho framework test (không phải Odoo thật, không mạng). Mô phỏng vừa đủ để kiểm chứng LOGIC của
 * Test Data Factory và cleanup: tạo/ghi/xoá, SO xác nhận sinh phiếu giao, phiếu thu, serial, ràng buộc đối soát/hoàn tất.
 * Không chứng minh ngữ nghĩa Odoo thật.
 */
type Row = Record<string, any>;

export class FakeOrm implements OdooRpc {
  readonly tables = new Map<string, Row[]>();
  readonly calls: { model: string; method: string; ids?: number[]; args: unknown[] }[] = [];
  private seq: number;
  uid = 7;
  /** Lược đồ trường cho fields_get (mặc định: đủ mọi trường framework cần + trường ngưỡng thanh toán). Xoá phần tử để giả lập thiếu trường. */
  schema: Record<string, Record<string, { string: string; type: string }>> = Object.fromEntries(
    Object.entries(PROBE_FIELDS).map(([m, spec]) => [m, Object.fromEntries([...spec.required, ...(spec.optional ?? []), ...(m === 'sale.order' ? ['moveo_payment_threshold'] : [])].map((f) => [f, { string: f === 'moveo_payment_threshold' ? 'Ngưỡng thanh toán (%)' : f, type: 'char' }]))]),
  );
  /** Quyền bị từ chối, dạng "model.op". */
  denied = new Set<string>();
  /** Tiêm lỗi: trả về thông báo lỗi để làm bước đó thất bại. */
  failOn?: (model: string, method: string, ids: number[]) => string | undefined;

  /** `start`: số ID khởi đầu (mỗi ORM giả một dải riêng để registry dùng chung trong test không trùng khoá). */
  constructor(start = 100) {
    this.seq = start;
    this.table('res.company').push({ id: 1, name: 'Công ty giả', fiscalyear_lock_date: false, tax_lock_date: false, sale_lock_date: false, hard_lock_date: false });
    this.table('account.journal').push({ id: 1, name: 'Sổ giả', restrict_mode_hash_table: false });
  }

  table(model: string): Row[] {
    if (!this.tables.has(model)) this.tables.set(model, []);
    return this.tables.get(model)!;
  }

  /** Thêm sẵn dữ liệu nghiệp vụ "có sẵn" (không do framework tạo) để chứng minh nó không bị đụng tới. */
  seed(model: string, row: Row): Row {
    const r = { id: ++this.seq, active: true, create_uid: [1, 'Người dùng khác'], ...row };
    this.table(model).push(r);
    return r;
  }

  find(model: string, id: number): Row | undefined {
    return this.table(model).find((r) => r.id === id);
  }

  snapshot(): string {
    return JSON.stringify([...this.tables.entries()].map(([k, v]) => [k, v]));
  }

  private match(row: Row, domain: unknown[]): boolean {
    return domain.every((c) => {
      const [f, op, v] = c as [string, string, any];
      const x = row[f];
      const xv = Array.isArray(x) && f.endsWith('_id') ? x[0] : x;
      if (op === '=') return xv === v;
      if (op === '!=') return xv !== v;
      if (op === 'in') return (v as unknown[]).includes(xv);
      if (op === '=like') return String(xv ?? '').startsWith(String(v).replace(/%$/, ''));
      return false;
    });
  }

  async searchRead<T = any>(model: string, domain: unknown[], _fields: string[], extra: Record<string, unknown> = {}): Promise<T[]> {
    const ctx = (extra.context ?? {}) as { active_test?: boolean };
    let rows = this.table(model).filter((r) => this.match(r, domain) && (ctx.active_test === false || r.active !== false));
    if (typeof extra.limit === 'number') rows = rows.slice(0, extra.limit);
    return rows.map((r) => ({ ...r })) as T[];
  }

  async count(model: string, domain: unknown[] = []): Promise<number> {
    return (this.tables.get(model) ?? []).filter((r) => this.match(r, domain)).length; // đọc không được tạo bảng
  }

  async currentUserId() {
    return this.uid;
  }

  async call<T = any>(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    const ids = method === 'create' ? [] : ((args[0] as number[]) ?? []);
    this.calls.push({ model, method, ids, args });
    if (method === 'fields_get') {
      if (!this.schema[model]) throw new Error(`Object ${model} doesn't exist`);
      return this.schema[model] as T;
    }
    if (method === 'check_access_rights') return !this.denied.has(`${model}.${args[0]}`) as T;
    const err = this.failOn?.(model, method, ids);
    if (err) throw new Error(`Odoo RPC ${model}.${method}: ${err}`);
    void kwargs;
    const rec = (id: number) => this.find(model, id) ?? (() => { throw new Error(`${model}#${id} không tồn tại`); })();
    if (method === 'create') return this.create(model, args[0] as Row) as T;
    if (method === 'write') {
      for (const id of ids) Object.assign(rec(id), args[1] as Row);
      return true as T;
    }
    if (method === 'unlink') {
      this.tables.set(model, this.table(model).filter((r) => !ids.includes(r.id)));
      return true as T;
    }
    for (const id of ids) this.action(model, method, rec(id));
    return true as T;
  }

  private create(model: string, vals: Row): number {
    const id = ++this.seq;
    const base: Row = { id, active: true, create_uid: [this.uid, 'Tài khoản automation'] };
    if (model === 'sale.order') {
      Object.assign(base, { name: `S${id}`, state: 'draft', locked: false, invoice_ids: [], picking_ids: [], company_id: [1, 'C'], moveo_payment_status: 'unpaid', amount_total: 0, ...vals });
      const total = ((vals.order_line as any[]) ?? []).reduce((s, l) => s + (l[2]?.price_unit ?? 0) * (l[2]?.product_uom_qty ?? 1), 0);
      base.amount_total = total;
      base.partner_id = [vals.partner_id, 'P'];
      base.lines = ((vals.order_line as any[]) ?? []).map((l) => l[2]);
    } else if (model === 'account.payment') {
      Object.assign(base, { name: `PAY/${id}`, state: 'draft', is_sent: false, is_reconciled: false, reconciled_invoice_ids: [], date: '2026-11-04', move_id: [id + 5000, 'M'], journal_id: [1, 'J'], company_id: [1, 'C'], ...vals });
      base.moveo_sale_order_id = vals.moveo_sale_order_id ? [vals.moveo_sale_order_id, 'S'] : false;
    } else if (model === 'stock.picking') {
      Object.assign(base, { name: `WH/OUT/${id}`, state: 'assigned', ...vals });
    } else {
      Object.assign(base, vals);
    }
    this.table(model).push(base);
    return id;
  }

  private action(model: string, method: string, r: Row) {
    if (model === 'sale.order') {
      if (method === 'action_confirm') {
        r.state = 'sale';
        if (r.lines?.length) {
          const pid = this.create('stock.picking', { sale_id: r.id, origin: r.name });
          r.picking_ids = [...r.picking_ids, pid];
          this.table('stock.move.line').push({ id: ++this.seq, picking_id: pid, lot_id: false, state: 'assigned' });
        }
      } else if (method === 'action_cancel') {
        r.state = 'cancel';
        for (const pid of r.picking_ids as number[]) {
          const p = this.find('stock.picking', pid);
          if (p && p.state !== 'done') p.state = 'cancel';
        }
      } else if (method === 'action_unlock') r.locked = false;
      else throw new Error(`sale.order.${method} chưa được giả lập`);
    } else if (model === 'account.payment') {
      if (method === 'action_post') r.state = 'in_process';
      else if (method === 'action_draft') r.state = 'draft';
      else if (method === 'action_cancel') r.state = 'canceled';
      else throw new Error(`account.payment.${method} chưa được giả lập`);
    } else if (model === 'stock.picking') {
      if (method === 'action_cancel') r.state = 'cancel';
      else if (method === 'button_validate') {
        r.state = 'done';
        for (const l of this.table('stock.move.line').filter((x) => x.picking_id === r.id)) l.state = 'done';
      } else throw new Error(`stock.picking.${method} chưa được giả lập`);
    } else throw new Error(`${model}.${method} chưa được giả lập`);
  }
}
