import type { APIRequestContext } from '@playwright/test';
import { getRunId } from '../../../../core/config/run';
import { activeEnvironment } from '../../../../core/environment/active';
import { DataFactory, type Handle } from '../../../../core/testdata/factory';
import { currentTcId, recordData } from '../../../../core/utils/tc';
import { OdooClient, type ChildRecord, type CreatedRecord } from '../../client';
import { odooRecipes } from '../../factory';
import { resolveWizard } from '../../generic';
import { inventoryModule } from './module';
import { receiptRecipe, transferRecipe, type TransferParams } from './recipes';

export interface ReceiptRec {
  pickingId: number;
  name: string;
  productId: number;
  moveId: number;
  lineId: number;
  lotName: string;
}

/** API của module Inventory: phiếu nhập kho serial + Số máy (EIN). Mọi ghi dữ liệu qua Test Data Factory / bản ghi do chính lần chạy này tạo. */
export class InventoryApi extends OdooClient {
  private seq = 0;

  constructor(request: APIRequestContext) {
    super(request, inventoryModule);
  }

  /** Mã duy nhất theo lần chạy (serial, số máy): không bao giờ trùng dữ liệu có sẵn. */
  uniq(prefix: string): string {
    return `${prefix}${getRunId().replace('-', '')}${++this.seq}${Math.floor(Math.random() * 1000)}`;
  }

  private factory(): DataFactory<OdooClient> {
    const env = activeEnvironment('odoo');
    return new DataFactory<OdooClient>({
      rpc: this, recipes: [...(odooRecipes as never[]), receiptRecipe as never, transferRecipe as never], writeProblems: () => this.writeBlockers(), maxRecordsPerRun: 200,
      scope: { application: 'odoo', module: 'inventory', environment: env!.key, runId: getRunId(), requirementId: 'REQ-INV-001', testCaseId: currentTcId() },
    });
  }

  private own(h: Handle) {
    this.created.push({ model: h.model, id: h.id, tcId: currentTcId(), reference: h.reference });
  }

  /**
   * Tạo phiếu nhập kho (sản phẩm serial mới) đã Xác nhận, kèm MỘT dòng hoạt động chi tiết với lot_name (VIN/serial) và, nếu có, Số máy.
   * `validate` = hoàn tất phiếu (ảnh hưởng tồn kho: lot được tạo; cleanup sẽ CLEANUP_BLOCKED theo ràng buộc kho).
   */
  async createReceipt(o: { engine?: string; validate?: boolean } = {}): Promise<ReceiptRec> {
    const blockers = this.writeBlockers();
    if (blockers.length) throw new Error(`Từ chối tạo dữ liệu: ${blockers.join('; ')}`);
    const h = await this.factory().build({
      product: { kind: 'product', params: { tracking: 'serial', price: 1000 } },
      receipt: { kind: 'receipt', requires: ['product'], params: { qty: 1 } },
    });
    this.own(h.product);
    this.own(h.receipt);
    const [pick] = await this.searchRead<any>('stock.picking', [['id', '=', h.receipt.id]], ['name', 'move_ids', 'location_id', 'location_dest_id']);
    const [move] = await this.searchRead<any>('stock.move', [['id', '=', pick.move_ids[0]]], ['product_uom', 'location_id', 'location_dest_id']);
    const lotName = this.uniq('AT');
    // Odoo tự sinh dòng hoạt động chi tiết khi xác nhận phiếu nhập: dùng dòng đó (tạo thêm sẽ nhân đôi số lượng).
    const existing = await this.searchRead<{ id: number }>('stock.move.line', [['picking_id', '=', h.receipt.id]], ['id'], { order: 'id' });
    const vals = { lot_name: lotName, quantity: 1, ...(o.engine ? { engine_number: o.engine } : {}) };
    let lineId: number;
    if (existing.length === 1) {
      lineId = existing[0].id;
      await this.call('stock.move.line', 'write', [[lineId], vals]);
    } else if (existing.length === 0) {
      lineId = await this.call<number>('stock.move.line', 'create', [{
        ...vals, picking_id: h.receipt.id, move_id: move.id, product_id: h.product.id, product_uom_id: move.product_uom[0],
        location_id: move.location_id[0], location_dest_id: move.location_dest_id[0],
      }]);
    } else {
      throw new Error(`Phiếu ${pick.name} có ${existing.length} dòng hoạt động chi tiết sau khi xác nhận; mong đợi 1`);
    }
    if (o.validate) await this.validate(h.receipt.id);
    recordData({ 'Phiếu nhập kho test': pick.name, 'VIN (serial)': lotName, 'Số máy': o.engine ?? '(chưa nhập)', 'trạng thái': o.validate ? 'đã hoàn tất' : 'đã xác nhận' });
    return { pickingId: h.receipt.id, name: pick.name, productId: h.product.id, moveId: move.id, lineId, lotName };
  }

  /**
   * Phiếu xuất (giao hàng) hoặc điều chuyển nội bộ cho CÙNG serial của `receipt` (receipt phải đã hoàn tất để serial có tồn).
   * Chỉ trả về khi phiếu đã giữ đúng serial đó (nếu không, ném lỗi thay vì chạy trên dữ liệu sai).
   */
  async createTransfer(receipt: ReceiptRec, code: 'outgoing' | 'internal'): Promise<{ pickingId: number; name: string }> {
    const blockers = this.writeBlockers();
    if (blockers.length) throw new Error(`Từ chối tạo dữ liệu: ${blockers.join('; ')}`);
    const [rp] = await this.searchRead<{ picking_type_id: [number, string] }>('stock.picking', [['id', '=', receipt.pickingId]], ['picking_type_id']);
    const typeName = rp.picking_type_id[1].split(':')[0].trim(); // "Đông Hoà - Xe máy điện"
    const productHandle: Handle = { key: `product.product:${receipt.productId}`, kind: 'product', model: 'product.product', id: receipt.productId, reference: '', dependsOn: [] };
    const h = await this.factory().create('transfer', { code, typeName } satisfies TransferParams, { product: productHandle });
    this.own(h);
    const [p] = await this.searchRead<{ name: string; state: string }>('stock.picking', [['id', '=', h.id]], ['name', 'state']);
    const lines = await this.searchRead<{ lot_id: [number, string] | false }>('stock.move.line', [['picking_id', '=', h.id]], ['lot_id']);
    const lot = await this.lotOfLine(receipt.lineId);
    if (!lot || !lines.some((l) => l.lot_id && l.lot_id[0] === lot.id)) {
      throw new Error(`Phiếu ${p.name} (${p.state}) chưa giữ đúng serial ${receipt.lotName}: không có tồn hoặc giữ chỗ thất bại`);
    }
    recordData({ [code === 'outgoing' ? 'Phiếu xuất kho test' : 'Phiếu điều chuyển test']: p.name, 'VIN (serial)': receipt.lotName, 'trạng thái': p.state });
    return { pickingId: h.id, name: p.name };
  }

  /** Hoàn tất phiếu (Kiểm tra/Validate) kể cả wizard xác nhận. Chỉ phiếu do lần chạy này tạo. */
  async validate(pickingId: number) {
    await this.assertSafeToWrite('stock.picking', pickingId);
    await resolveWizard(this, await this.call('stock.picking', 'button_validate', [[pickingId]]));
  }

  async engineOf(lineId: number): Promise<string | false> {
    const [l] = await this.searchRead<{ engine_number: string | false }>('stock.move.line', [['id', '=', lineId]], ['engine_number']);
    return l?.engine_number ?? false;
  }

  /** Đặt Số máy bằng API (chỉ để dựng tiền điều kiện trên dòng của phiếu do lần chạy này tạo). */
  async setEngine(pickingId: number, lineId: number, engine: string) {
    await this.assertSafeToWrite('stock.picking', pickingId);
    await this.call('stock.move.line', 'write', [[lineId], { engine_number: engine }]);
  }

  async lotOfLine(lineId: number): Promise<{ id: number; name: string } | undefined> {
    const [l] = await this.searchRead<{ lot_id: [number, string] | false }>('stock.move.line', [['id', '=', lineId]], ['lot_id']);
    return l?.lot_id ? { id: l.lot_id[0], name: l.lot_id[1] } : undefined;
  }

  async stateOf(pickingId: number): Promise<string> {
    const [p] = await this.searchRead<{ state: string }>('stock.picking', [['id', '=', pickingId]], ['state']);
    return p.state;
  }

  /** Lot (VIN/serial) phát sinh khi hoàn tất phiếu nhập là bản ghi con của phiếu: đăng ký registry để cleanup biết và báo CLEANUP_BLOCKED khi đã ảnh hưởng tồn kho. */
  protected async discoverChildren(c: CreatedRecord): Promise<ChildRecord[]> {
    if (c.model !== 'stock.picking') return [];
    const lines = await this.searchRead<{ lot_id: [number, string] | false }>('stock.move.line', [['picking_id', '=', c.id]], ['lot_id']);
    return lines.filter((l) => l.lot_id).map((l) => ({ model: 'stock.lot', id: (l.lot_id as [number, string])[0], reference: (l.lot_id as [number, string])[1], parent: `stock.picking:${c.id}` }));
  }
}
