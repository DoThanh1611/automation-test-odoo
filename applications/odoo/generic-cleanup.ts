import type { AdapterManifest, AdapterModel } from '../../core/adapters/manifest';
import { unsupportedHandler, type CleanupHandler, type PlanItem } from '../../core/testdata/cleanup';
import type { OdooClient } from './client';

/**
 * Cleanup adapter sinh từ adapter khai báo: mỗi model của adapter có một handler theo `cleanup.kind`.
 * CHỈ lập kế hoạch (chỉ đọc); engine (core/testdata/cleanup-engine.ts) thực thi và chỉ trên bản ghi có trong registry với owner FRAMEWORK.
 * Nguyên tắc: chứng từ đã ở trạng thái cuối (done/posted/closed) không bị ép xoá hay huỷ ⇒ blocker ⇒ CLEANUP_BLOCKED; loại chưa xác minh ⇒ unsupported.
 */
const missing = (model: string, id: number, reference: string): PlanItem => ({
  model, id, reference, label: `${model}#${id}`, eligible: true, alreadyClean: true, blockers: [], steps: [], meta: { note: 'không còn tồn tại trên hệ thống' },
});

function handlerFor(a: AdapterManifest, am: AdapterModel): CleanupHandler<OdooClient> {
  const id = `adapter-${a.module}-${am.model}`;
  if (am.cleanup.kind === 'unsupported') return unsupportedHandler(id, [am.model], am.cleanup.reason ?? 'chưa xác minh') as CleanupHandler<OdooClient>;
  return {
    id,
    models: [am.model],
    supported: true,
    async plan({ client, records }) {
      const uid = await client.currentUserId();
      const fields = ['id', 'create_uid', 'active', ...(am.stateField ? [am.stateField] : []), ...(am.refField ? [am.refField] : []), ...(am.tagField ? [am.tagField] : [])];
      const rows = await client.searchRead<any>(am.model, [['id', 'in', records.map((r) => r.recordId)]], [...new Set(fields)], { context: { active_test: false } });
      return records.map((r): PlanItem => {
        const row = rows.find((x) => x.id === r.recordId);
        if (!row) return missing(am.model, r.recordId, r.reference);
        const blockers: string[] = [];
        const state = am.stateField ? String(row[am.stateField]) : undefined;
        if (uid && row.create_uid?.[0] !== uid) blockers.push(`được tạo bởi người dùng khác (${row.create_uid?.[1]})`);
        const labelled = [am.refField, am.tagField].filter(Boolean).map((f) => String(row[f as string] ?? ''));
        if (labelled.length && !labelled.some((v) => v.includes('AUTOTEST') || v.includes('QA env='))) blockers.push('không mang nhãn AUTOTEST/thẻ QA của framework');
        const alreadyClean = (state !== undefined && (am.cleanStates ?? []).includes(state)) || (am.cleanup.kind === 'archive' && row.active === false);
        if (!alreadyClean && state !== undefined && (am.finalStates ?? []).includes(state)) blockers.push(`đã ở trạng thái cuối "${state}": ràng buộc kho/kế toán, không ép huỷ hay xoá`);
        let steps: PlanItem['steps'] = [];
        if (!blockers.length && !alreadyClean) {
          if (am.cleanup.kind === 'cancel') steps = (am.cleanup.steps ?? []).map((m) => ({ op: `${am.model}.${m}`, why: 'Huỷ chứng từ test chưa hoàn tất (giữ dấu vết, không xoá cứng)' }));
          else if (am.cleanup.kind === 'archive') steps = [{ op: `${am.model}.write`, why: 'Lưu trữ bản ghi test, không xoá', args: [{ active: false }] }];
          else if (am.cleanup.kind === 'unlink') steps = [{ op: `${am.model}.unlink`, why: 'Xoá bản ghi test không phải chứng từ' }];
        }
        return { model: am.model, id: r.recordId, reference: r.reference, label: `${am.model}#${r.recordId}`, eligible: !blockers.length, alreadyClean, blockers, steps, meta: { state } };
      });
    },
  };
}

/** Handler cleanup cho mọi model của các adapter. Model đã có handler chuyên biệt (curated) ở nơi khác sẽ được ưu tiên bởi bên ghép. */
export function adapterCleanupHandlers(adapters: AdapterManifest[]): CleanupHandler<OdooClient>[] {
  return adapters.flatMap((a) => a.models.map((m) => handlerFor(a, m)));
}

/** Ghép handler: handler chuyên biệt thắng; adapter bổ sung cho model chưa có handler hỗ trợ. */
export function mergeHandlers(specific: CleanupHandler<OdooClient>[], fromAdapters: CleanupHandler<OdooClient>[]): CleanupHandler<OdooClient>[] {
  const covered = new Set(specific.filter((h) => h.supported).flatMap((h) => h.models));
  return [...specific, ...fromAdapters.filter((h) => !h.models.some((m) => covered.has(m)))];
}
