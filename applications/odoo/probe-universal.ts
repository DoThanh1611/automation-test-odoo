import { reuseDecision, type AdapterManifest, type EnvProfile } from '../../core/adapters/manifest';
import type { OdooRpc } from './factory';
import { currentFingerprints, environmentProfile } from './introspect';
import type { ProbeFinding } from './probe';

/**
 * Thăm dò CHỈ ĐỌC không phụ thuộc module: phiên bản, edition, và tình trạng của TỪNG adapter đã có (dùng lại được / cần kiểm chứng lại /
 * môi trường thiếu module). Thiếu module là THIẾU ĐIỀU KIỆN MÔI TRƯỜNG (test liên quan BLOCKED), không phải lỗi nghiệp vụ và không chặn cả lần chạy.
 * Quyền truy cập được kiểm tra theo các model mà adapter khai báo, không theo danh sách cố định.
 */
export interface UniversalProbe {
  profile: EnvProfile;
  findings: ProbeFinding[];
  blockers: number;
  adapters: { module: string; status: 'REUSE' | 'REVERIFY' | 'UNAVAILABLE'; reasons: string[] }[];
}

export async function runUniversalProbe(rpc: OdooRpc, o: { expectedVersion?: string; actualVersion?: string; adapters: AdapterManifest[] }): Promise<UniversalProbe> {
  const findings: ProbeFinding[] = [];
  const add = (f: ProbeFinding) => findings.push(f);
  const version = o.actualVersion ?? '';
  const profile = await environmentProfile(rpc, version);

  if (!o.actualVersion) add({ area: 'version', ok: false, severity: 'blocker', detail: 'không đọc được phiên bản Odoo thực tế' });
  else if (o.expectedVersion && !o.actualVersion.startsWith(o.expectedVersion)) add({ area: 'version', ok: false, severity: 'blocker', detail: `phiên bản thực tế ${o.actualVersion} không khớp kỳ vọng ${o.expectedVersion}` });
  else add({ area: 'version', ok: true, severity: 'info', detail: `Odoo ${o.actualVersion}${o.expectedVersion ? ` (khớp kỳ vọng ${o.expectedVersion})` : ''}` });
  add({ area: 'feature', ok: profile.edition !== 'unknown', severity: profile.edition === 'unknown' ? 'warning' : 'info', detail: profile.modulesKnown === false ? 'không đọc được danh sách module đã cài (edition chưa xác định)' : `edition ${profile.edition}, ${profile.installedModules.length} module đã cài` });

  const adapters: UniversalProbe['adapters'] = [];
  for (const a of o.adapters) {
    const fp = await currentFingerprints(rpc, a.models.map((m) => m.model));
    const d = reuseDecision(a, profile, fp);
    adapters.push({ module: a.module, status: d.status, reasons: d.reasons });
    add({
      area: 'feature', ok: d.status === 'REUSE', severity: d.status === 'REUSE' ? 'info' : 'warning',
      detail: d.status === 'REUSE' ? `adapter ${a.module}: dùng lại được` : d.status === 'UNAVAILABLE' ? `adapter ${a.module}: thiếu điều kiện môi trường (${d.reasons.join('; ')}) ⇒ test liên quan BLOCKED` : `adapter ${a.module}: cần kiểm chứng lại (${d.reasons.join('; ')})`,
    });
    if (d.status === 'UNAVAILABLE') continue;
    for (const m of a.models) {
      const denied: string[] = [];
      for (const op of ['read', 'create', 'write']) {
        try {
          if (!(await rpc.call<boolean>(m.model, 'check_access_rights', [op], { raise_exception: false }))) denied.push(op);
        } catch {
          denied.push(`${op}?`);
        }
      }
      add(denied.length ? { area: 'access', ok: false, severity: 'warning', detail: `${m.model}: tài khoản thiếu quyền ${denied.join(', ')} (test cần quyền này sẽ BLOCKED)` } : { area: 'access', ok: true, severity: 'info', detail: `${m.model}: đủ quyền read/create/write` });
    }
  }
  return { profile, findings, blockers: findings.filter((f) => !f.ok && f.severity === 'blocker').length, adapters };
}
