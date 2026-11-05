import type { DataPlan, Handle, Recipe } from '../../core/testdata/factory';

/**
 * Công thức Test Data Factory cho Odoo: khách hàng, sản phẩm, serial, SO, phiếu giao (DO), thanh toán.
 * Mọi bản ghi mang tên/tham chiếu AUTOTEST và thẻ `QA env=… run=… req=… tc=…` trong trường văn bản của nó.
 * LƯU Ý: các lệnh ORM dưới đây theo API Odoo 18 nhưng CHƯA được kiểm chứng trên Odoo thật (chỉ trên ORM giả lập trong framework test).
 * Lần chạy đầu trên staging thật nên dùng một test case và xem kết quả; lỗi tạo dữ liệu được báo rõ, dữ liệu đã tạo vẫn nằm trong registry để cleanup.
 */
export interface OdooRpc {
  call<T = any>(model: string, method: string, args?: unknown[], kwargs?: Record<string, unknown>): Promise<T>;
  searchRead<T = any>(model: string, domain: unknown[], fields: string[], extra?: Record<string, unknown>): Promise<T[]>;
}

type R = Recipe<OdooRpc, any>;

const need = (deps: Record<string, Handle>, name: string, kind: string): Handle => {
  const d = deps[name] ?? Object.values(deps).find((x) => x.kind === kind);
  if (!d) throw new Error(`Công thức cần phụ thuộc "${name}" (${kind})`);
  return d;
};

const partner: R = {
  kind: 'partner',
  model: 'res.partner',
  async create(ctx, p) {
    const id = await ctx.rpc.call<number>('res.partner', 'create', [{ name: `${ctx.reference} Khách hàng ${ctx.seq}`, comment: ctx.tag, ...(p?.vals ?? {}) }]);
    return { id };
  },
};

const product: R = {
  kind: 'product',
  model: 'product.product',
  async create(ctx, p) {
    const tracked = p?.tracking === 'serial' || p?.tracking === 'lot';
    const vals = {
      name: `${ctx.reference} Sản phẩm ${ctx.seq}`,
      default_code: `AT-${ctx.scope.runId}-${ctx.seq}`,
      list_price: p?.price ?? 1000,
      type: 'consu',
      is_storable: p?.storable ?? tracked,
      tracking: tracked ? p.tracking : 'none',
      description: ctx.tag,
      ...(p?.vals ?? {}),
    };
    return { id: await ctx.rpc.call<number>('product.product', 'create', [vals]) };
  },
};

const serial: R = {
  kind: 'serial',
  model: 'stock.lot',
  async create(ctx, p, deps) {
    const prod = need(deps, 'product', 'product');
    const [company] = await ctx.rpc.searchRead<{ id: number }>('res.company', [], ['id'], { limit: 1 });
    const name = p?.name ?? `AT${ctx.scope.runId.replace('-', '')}-${ctx.seq}`;
    const id = await ctx.rpc.call<number>('stock.lot', 'create', [{ name, product_id: prod.id, company_id: company?.id, note: ctx.tag }]);
    return { id, reference: name };
  },
};

const saleOrder: R = {
  kind: 'sale.order',
  model: 'sale.order',
  async create(ctx, p, deps) {
    const customer = need(deps, 'partner', 'partner');
    const prod = need(deps, 'product', 'product');
    const lines = (p?.lines as { qty?: number; price?: number }[] | undefined) ?? [{ qty: p?.qty ?? 1, price: p?.amount ?? 1000 }];
    const id = await ctx.rpc.call<number>('sale.order', 'create', [{
      partner_id: customer.id,
      client_order_ref: ctx.reference,
      origin: ctx.tag,
      order_line: lines.map((l) => [0, 0, { product_id: prod.id, product_uom_qty: l.qty ?? 1, price_unit: l.price ?? 1000, tax_ids: [[6, 0, []]] }]),
    }]);
    return { id };
  },
  async finalize(ctx, rec, p) {
    if (p?.confirm !== false) await ctx.rpc.call('sale.order', 'action_confirm', [[rec.id]]);
  },
  async children(ctx, rec) {
    const picks = await ctx.rpc.searchRead<{ id: number; name: string }>('stock.picking', [['sale_id', '=', rec.id]], ['name']);
    return picks.map((p) => ({ model: 'stock.picking', id: p.id, reference: p.name }));
  },
  async update(ctx, rec, vals) {
    await ctx.rpc.call('sale.order', 'write', [[rec.id], vals]);
  },
};

/** DO: không tạo tay; lấy phiếu giao do SO đã xác nhận sinh ra (đăng ký làm bản ghi con của SO). Chỉ validate khi p.validate. */
const delivery: R = {
  kind: 'delivery',
  model: 'stock.picking',
  async create(ctx, _p, deps) {
    const so = need(deps, 'so', 'sale.order');
    const picks = await ctx.rpc.searchRead<{ id: number; name: string }>('stock.picking', [['sale_id', '=', so.id]], ['name']);
    if (!picks.length) throw new Error(`SO ${so.key} chưa sinh phiếu giao (cần sản phẩm lưu kho và SO đã xác nhận)`);
    return { id: picks[0].id, reference: picks[0].name };
  },
  async finalize(ctx, rec, p, deps) {
    if (!p?.validate) return;
    const lot = Object.values(deps).find((d) => d.kind === 'serial');
    if (lot) {
      const lines = await ctx.rpc.searchRead<{ id: number }>('stock.move.line', [['picking_id', '=', rec.id]], ['id']);
      for (const l of lines) await ctx.rpc.call('stock.move.line', 'write', [[l.id], { lot_id: lot.id, quantity: 1 }]);
    }
    await ctx.rpc.call('stock.picking', 'button_validate', [[rec.id]]);
  },
};

const payment: R = {
  kind: 'payment',
  model: 'account.payment',
  async create(ctx, p, deps) {
    const customer = need(deps, 'partner', 'partner');
    const so = deps.so ?? Object.values(deps).find((d) => d.kind === 'sale.order');
    const id = await ctx.rpc.call<number>('account.payment', 'create', [{
      payment_type: 'inbound', partner_type: 'customer', partner_id: customer.id, amount: p?.amount ?? 1000, memo: `${ctx.reference} ${ctx.tag}`,
      ...(so && p?.linkSale !== false ? { moveo_sale_order_id: so.id } : {}),
    }]);
    return { id };
  },
  async finalize(ctx, rec, p) {
    if (p?.post !== false) await ctx.rpc.call('account.payment', 'action_post', [[rec.id]]);
  },
};

export const odooRecipes: R[] = [partner, product, serial, saleOrder, delivery, payment];

/** Kế hoạch mẫu: khách hàng + sản phẩm (tuỳ chọn có serial) + SO xác nhận (+ DO, + thanh toán). Tất cả do framework tạo, không dùng dữ liệu có sẵn. */
export function salesPlan(o: { amount?: number; serial?: boolean; delivery?: boolean; payment?: number | boolean } = {}): DataPlan {
  const plan: DataPlan = {
    partner: { kind: 'partner' },
    product: { kind: 'product', params: { price: o.amount ?? 1000, tracking: o.serial ? 'serial' : 'none' } },
    so: { kind: 'sale.order', requires: ['partner', 'product'], params: { amount: o.amount ?? 1000 } },
  };
  if (o.serial) plan.serial = { kind: 'serial', requires: ['product'] };
  if (o.delivery) plan.delivery = { kind: 'delivery', requires: ['so', ...(o.serial ? ['serial'] : [])] };
  if (o.payment) plan.payment = { kind: 'payment', requires: ['so', 'partner'], params: { amount: typeof o.payment === 'number' ? o.payment : o.amount ?? 1000 } };
  return plan;
}
