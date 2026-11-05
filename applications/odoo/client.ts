import type { APIRequestContext } from '@playwright/test';
import { env } from '../../core/config/env';
import { activeBaseUrl, activeEnvironment } from '../../core/environment/active';
import { getRunId } from '../../core/config/run';
import { FixtureError, checkConditions, loadFixtures, type Condition, type FixtureFile } from '../../core/testdata/fixtures';
import { loadRegistry, recordKey, registerRecord } from '../../core/testdata/registry';
import { grantProblems, issueWriteToken, readGrant, type RecordReader, type SafeWriteToken } from '../../core/testdata/write-guard';
import { currentTcId, recordData } from '../../core/utils/tc';
import type { OdooModuleDef } from './modules/types';

/** Bản ghi do client này tạo, chờ đăng ký các bản ghi phát sinh (con) khi teardown. */
export interface CreatedRecord {
  model: string;
  id: number;
  tcId: string;
  reference: string;
}

/** Bản ghi con phát sinh từ bản ghi test (ví dụ phiếu thu của một SO). */
export interface ChildRecord {
  model: string;
  id: number;
  reference: string;
  parent: string;
}

/**
 * Client JSON-RPC của Odoo DÙNG CHUNG cho mọi module. Không biết gì về model cụ thể: module truyền khai báo của nó vào.
 * Dùng chung phiên đăng nhập của browser context (page.request).
 */
export class OdooClient implements RecordReader {
  protected created: CreatedRecord[] = [];
  private uid?: number;

  constructor(protected request: APIRequestContext, readonly mod?: OdooModuleDef) {}

  async call<T = any>(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    const res = await this.request.post(`/web/dataset/call_kw/${model}/${method}`, {
      data: { jsonrpc: '2.0', method: 'call', params: { model, method, args, kwargs } },
    });
    const body = await res.json();
    if (body.error) throw new Error(`Odoo RPC ${model}.${method}: ${body.error.data?.message ?? body.error.message}`);
    return body.result as T;
  }

  /** Gọi RPC nhưng trả lỗi của server (nếu có) thay vì ném, để test khẳng định server TỪ CHỐI. */
  async tryCall(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}) {
    const res = await this.request.post(`/web/dataset/call_kw/${model}/${method}`, {
      data: { jsonrpc: '2.0', method: 'call', params: { model, method, args, kwargs } },
    });
    const body = await res.json();
    return body.error
      ? { ok: false as const, errorName: String(body.error.data?.name ?? ''), message: String(body.error.data?.message ?? body.error.message) }
      : { ok: true as const, result: body.result };
  }

  searchRead<T = any>(model: string, domain: unknown[], fields: string[], extra: Record<string, unknown> = {}) {
    return this.call<T[]>(model, 'search_read', [domain], { fields, ...extra });
  }

  count(model: string, domain: unknown[] = []) {
    return this.call<number>(model, 'search_count', [domain]);
  }

  // ---- RecordReader (cho write guard) ----
  async readFields(model: string, id: number, fields: string[]) {
    const [rec] = await this.searchRead<Record<string, unknown>>(model, [['id', '=', id]], fields);
    return rec;
  }

  /** ID người dùng của phiên đang dùng. */
  async currentUserId(): Promise<number> {
    if (this.uid === undefined) {
      const res = await this.request.post('/web/session/get_session_info', { data: { jsonrpc: '2.0', method: 'call', params: {} } });
      this.uid = (await res.json()).result?.uid as number;
    }
    return this.uid;
  }

  // ---- Fixture tường minh, chỉ để ĐỌC ----
  /**
   * Lấy bản ghi nghiệp vụ được GHIM trong testdata/fixtures/<module>.json (mục `section`, khoá `key`), chỉ để ĐỌC.
   * Kiểm tra lại điều kiện mỗi lần; bản ghi không còn thỏa hoặc môi trường không khớp thì ném FixtureError.
   * `conditions` lấy từ spec.conditions; module có thể truyền thêm điều kiện đã dịch từ định dạng riêng.
   */
  async fixtureRecord<T extends object>(o: {
    section: string;
    key: string;
    fields: string[];
    model: string;
    nameField?: string;
    extraConditions?: (spec: any) => Condition[];
    describe?: (rec: T) => Record<string, unknown>;
  }): Promise<T> {
    if (!this.mod) throw new FixtureError('OdooClient chưa gắn module nên không đọc được fixture');
    const fx = loadFixtures<FixtureFile & Record<string, any>>(this.mod.fixturesKey, activeBaseUrl('odoo'));
    const spec = (fx[o.section] as Record<string, any> | undefined)?.[o.key];
    if (!spec) throw new FixtureError(`Fixture "${o.key}" chưa được khai báo ở mục "${o.section}" trong testdata/fixtures/${this.mod.fixturesKey}.json`);
    const nameField = o.nameField ?? 'name';
    const found = await this.searchRead<T>(o.model, [[nameField, '=', spec.name]], o.fields, { limit: 2 });
    if (found.length !== 1) throw new FixtureError(`Fixture "${o.key}" (${o.model} ${spec.name}): tìm thấy ${found.length} bản ghi, cần đúng 1`);
    const conditions = [...((spec.conditions as Condition[] | undefined) ?? []), ...(o.extraConditions?.(spec) ?? [])];
    const bad = checkConditions(found[0] as Record<string, unknown>, conditions);
    if (bad.length) {
      throw new FixtureError(`Fixture "${o.key}" (${o.model} ${spec.name}) không còn thỏa điều kiện đã khai báo, có thể đã bị người dùng khác thay đổi: ${bad.join('; ')}`);
    }
    recordData({ ...(o.describe?.(found[0]) ?? { [`${o.model} cố định (fixture ${o.key})`]: spec.name }), 'chế độ': 'CHỈ ĐỌC' });
    return found[0];
  }

  // ---- Ghi dữ liệu có kiểm soát ----
  /** Ghi nhận bản ghi do automation vừa tạo: đăng ký registry NGAY và nhớ để cấp giấy phép ghi. */
  protected trackCreated(model: string, id: number, reference: string): CreatedRecord {
    const rec: CreatedRecord = { model, id, tcId: currentTcId(), reference };
    registerRecord({ testCaseId: rec.tcId, application: 'odoo', module: this.mod?.module, model, recordId: id, reference, owner: 'FRAMEWORK' });
    this.created.push(rec);
    return rec;
  }

  /** Module ghi đè để cho biết bản ghi con phát sinh (ví dụ phiếu thu của SO). Mặc định không có. */
  protected async discoverChildren(_created: CreatedRecord): Promise<ChildRecord[]> {
    return [];
  }

  /** Đăng ký các bản ghi con phát sinh từ dữ liệu test. Gọi ở teardown fixture; không bao giờ ném lỗi. */
  async trackCreatedChildren() {
    for (const c of this.created) {
      try {
        for (const child of await this.discoverChildren(c)) {
          registerRecord({ testCaseId: c.tcId, application: 'odoo', module: this.mod?.module, model: child.model, recordId: child.id, reference: child.reference, parent: child.parent, dependsOn: [child.parent], owner: 'FRAMEWORK' });
        }
      } catch (e) {
        console.warn(`Không đăng ký được bản ghi con của ${c.model}#${c.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Điều kiện giấy phép ghi hiện tại (môi trường, module, lần chạy). */
  private grantContext() {
    const e = activeEnvironment('odoo');
    return { allowWrite: env.allowWriteTests, grant: readGrant(), host: e?.host, environment: e?.key, environmentKind: e?.kind, environmentLabel: e?.label, module: this.mod?.key ?? '', runId: getRunId() };
  }

  /**
   * Cấp giấy phép ghi cho một bản ghi. Ba lớp kiểm tra (xem core/testdata/write-guard.ts):
   * giấy phép theo môi trường/module/lần chạy, quy tắc sở hữu của module, và bản ghi do chính lần chạy này tạo.
   */
  async assertSafeToWrite(model: string, id: number): Promise<SafeWriteToken> {
    if (!this.mod) throw new Error('Từ chối ghi: client chưa gắn module');
    return issueWriteToken({
      application: 'odoo',
      module: this.mod.key,
      rules: this.mod.ownership,
      reader: this,
      created: new Set(this.created.map((c) => `${c.model}|${c.id}`)),
      grant: this.grantContext(),
      model,
      id,
    });
  }

  /** Lý do KHÔNG được ghi trong ngữ cảnh hiện tại (rỗng = có giấy phép). Dùng cho fixture writeGuard. */
  writeBlockers(): string[] {
    return grantProblems(this.grantContext());
  }

  registryHas(model: string, id: number) {
    return loadRegistry().some((r) => recordKey(r) === `odoo|${model}|${id}`);
  }
}
