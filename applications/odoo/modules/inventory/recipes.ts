import type { Recipe } from '../../../../core/testdata/factory';
import { UnresolvedData } from '../../generic';
import type { OdooRpc } from '../../factory';

/**
 * Công thức dữ liệu của module Inventory (curated): phiếu nhập kho có sản phẩm theo dõi serial.
 * Kiểu phiếu lấy từ cấu hình (kiểu nhập kho có tạo lot, tên "Phiếu nhập kho"): CHỌN, không tạo. Địa điểm lấy từ mặc định của kiểu phiếu.
 * Sản phẩm serial dùng công thức `product` chung (tự tạo, mang nhãn AUTOTEST). Không dùng sản phẩm/phiếu có sẵn.
 */
export interface ReceiptParams {
  qty?: number;
  confirm?: boolean;
}

export interface TransferParams {
  /** 'outgoing' (phiếu xuất/giao hàng) hoặc 'internal' (điều chuyển nội bộ). */
  code: 'outgoing' | 'internal';
  /** Tên kiểu phiếu của kho cần dùng (khớp kho của phiếu nhập). */
  typeName: string;
}

/**
 * Phiếu xuất / điều chuyển nội bộ cho CÙNG sản phẩm serial vừa nhập (đã có tồn): xác nhận rồi giữ chỗ (action_assign).
 * Điều chuyển nội bộ đi tới một địa điểm nội bộ KHÁC của cùng kho (không điều chuyển vào chính nó).
 */
export const transferRecipe: Recipe<OdooRpc, TransferParams> = {
  kind: 'transfer',
  model: 'stock.picking',
  async create(ctx, p, deps) {
    const product = Object.values(deps).find((d) => d.kind === 'product');
    if (!product) throw new Error('Phiếu xuất/điều chuyển cần sản phẩm (kind product) trong kế hoạch dữ liệu');
    const types = await ctx.rpc.searchRead<{ id: number; display_name: string; default_location_src_id: [number, string] | false; default_location_dest_id: [number, string] | false }>(
      'stock.picking.type', [['code', '=', p.code]], ['display_name', 'default_location_src_id', 'default_location_dest_id'], { order: 'id' });
    const type = types.find((t) => t.display_name.includes(p.typeName));
    if (!type || !type.default_location_src_id || !type.default_location_dest_id) throw new UnresolvedData(`môi trường không có kiểu phiếu "${p.typeName}" (${p.code}) với địa điểm mặc định`);
    const src = type.default_location_src_id[0];
    let dest = type.default_location_dest_id[0];
    if (p.code === 'internal') {
      const [srcLoc] = await ctx.rpc.searchRead<{ warehouse_id: [number, string] | false }>('stock.location', [['id', '=', src]], ['warehouse_id']);
      const others = srcLoc?.warehouse_id
        ? await ctx.rpc.searchRead<{ id: number }>('stock.location', [['usage', '=', 'internal'], ['warehouse_id', '=', srcLoc.warehouse_id[0]], ['id', '!=', src]], ['id'], { order: 'id', limit: 1 })
        : [];
      if (!others.length) throw new UnresolvedData('kho không có địa điểm nội bộ thứ hai để điều chuyển tới');
      dest = others[0].id;
    }
    const [prod] = await ctx.rpc.searchRead<{ uom_id: [number, string] }>('product.product', [['id', '=', product.id]], ['uom_id']);
    const moveFields = await ctx.rpc.call<Record<string, unknown>>('stock.move', 'fields_get', [], { attributes: ['type'] });
    const move: Record<string, unknown> = { product_id: product.id, product_uom_qty: 1, product_uom: prod.uom_id[0], location_id: src, location_dest_id: dest, ...('name' in moveFields ? { name: ctx.reference } : {}) };
    const id = await ctx.rpc.call<number>('stock.picking', 'create', [{ picking_type_id: type.id, origin: ctx.reference, location_id: src, location_dest_id: dest, move_ids: [[0, 0, move]] }]);
    return { id };
  },
  async finalize(ctx, rec) {
    await ctx.rpc.call('stock.picking', 'action_confirm', [[rec.id]]);
    await ctx.rpc.call('stock.picking', 'action_assign', [[rec.id]]);
  },
};

export const receiptRecipe: Recipe<OdooRpc, ReceiptParams> = {
  kind: 'receipt',
  model: 'stock.picking',
  async create(ctx, p, deps) {
    const product = Object.values(deps).find((d) => d.kind === 'product');
    if (!product) throw new Error('Phiếu nhập kho cần sản phẩm (kind product) trong kế hoạch dữ liệu');
    const types = await ctx.rpc.searchRead<{ id: number; display_name: string; default_location_src_id: [number, string] | false; default_location_dest_id: [number, string] | false }>(
      'stock.picking.type', [['code', '=', 'incoming'], ['use_create_lots', '=', true]], ['display_name', 'default_location_src_id', 'default_location_dest_id'], { order: 'id' });
    const type = types.find((t) => /Phiếu nhập kho/.test(t.display_name));
    if (!type || !type.default_location_src_id || !type.default_location_dest_id) {
      throw new UnresolvedData('môi trường không có kiểu phiếu nhập kho (tên "Phiếu nhập kho", tạo lot) với địa điểm mặc định');
    }
    const [prod] = await ctx.rpc.searchRead<{ uom_id: [number, string] }>('product.product', [['id', '=', product.id]], ['uom_id']);
    const moveFields = await ctx.rpc.call<Record<string, unknown>>('stock.move', 'fields_get', [], { attributes: ['type'] });
    const move: Record<string, unknown> = {
      product_id: product.id, product_uom_qty: p?.qty ?? 1, product_uom: prod.uom_id[0],
      location_id: type.default_location_src_id[0], location_dest_id: type.default_location_dest_id[0],
      ...('name' in moveFields ? { name: ctx.reference } : {}),
    };
    const id = await ctx.rpc.call<number>('stock.picking', 'create', [{
      picking_type_id: type.id, origin: ctx.reference, location_id: type.default_location_src_id[0], location_dest_id: type.default_location_dest_id[0],
      move_ids: [[0, 0, move]],
    }]);
    return { id };
  },
  async finalize(ctx, rec, p) {
    if (p?.confirm !== false) await ctx.rpc.call('stock.picking', 'action_confirm', [[rec.id]]);
  },
};
