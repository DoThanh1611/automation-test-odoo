import { loadRegistry, recordKey } from './registry';
import { AUTOTEST_REF_PATTERN } from './autotest';
import { productionReason } from '../policy/policy';

/**
 * Write guard DÙNG CHUNG cho mọi ứng dụng/module. Không biết gì về Odoo, Sales hay model cụ thể:
 * module khai báo OwnershipRule cho từng model mà nó được phép tạo/ghi.
 *
 * Hai lớp bảo vệ độc lập:
 *  1. GIẤY PHÉP GHI theo (môi trường, module, lần chạy): chỉ cấp bằng lệnh có chủ đích (npm run test:write).
 *  2. SỞ HỮU bản ghi: chỉ ghi lên bản ghi do CHÍNH lần chạy này tạo; dữ liệu nghiệp vụ có sẵn không bao giờ qua được.
 */

export interface WriteGrant {
  /** Host của môi trường được phép ghi, ví dụ staging.example.com. */
  host: string;
  /** Khoá môi trường được phép ghi (ví dụ STAGING_A). Quyền ghi của môi trường này không dùng được cho môi trường khác dù cùng host. */
  environment?: string;
  /** Khoá module được phép ghi, ví dụ odoo-sales. */
  module: string;
  /** Lần chạy được phép ghi. */
  runId: string;
}

export interface GrantContext {
  allowWrite: boolean;
  grant?: WriteGrant;
  host: string | undefined;
  /** Khoá môi trường đang chạy (QA_ENV). */
  environment?: string;
  /** Loại/nhãn môi trường để chặn production kể cả khi cấu hình sai. */
  environmentKind?: string;
  environmentLabel?: string;
  module: string;
  runId: string;
}

/** Đọc giấy phép từ biến môi trường QA_WRITE_GRANT (do scripts/run-tests.ts đặt sau khi người dùng xác nhận). */
export function readGrant(raw: string | undefined = process.env.QA_WRITE_GRANT): WriteGrant | undefined {
  if (!raw) return undefined;
  try {
    const g = JSON.parse(raw) as Partial<WriteGrant>;
    return g.host && g.module && g.runId ? { host: g.host, module: g.module, runId: g.runId, environment: g.environment } : undefined;
  } catch {
    return undefined;
  }
}

/** Danh sách lý do KHÔNG được ghi (rỗng = được phép). Thuần hàm. */
export function grantProblems(ctx: GrantContext): string[] {
  const out: string[] = [];
  const prod = ctx.host && ctx.environment ? productionReason({ key: ctx.environment, host: ctx.host, kind: (ctx.environmentKind ?? 'staging') as never, label: ctx.environmentLabel ?? '' }) : undefined;
  if (prod) out.push(`môi trường production không cho phép ghi (${prod})`);
  if (!ctx.allowWrite) out.push('ALLOW_WRITE_TESTS != true');
  if (!ctx.grant) {
    out.push('chưa có giấy phép ghi theo môi trường/module/lần chạy (dùng: npm run test:write -- --module=<app>-<module>)');
    return out;
  }
  if (ctx.grant.environment !== ctx.environment) out.push(`giấy phép cho môi trường "${ctx.grant.environment ?? 'không ghi rõ'}", đang chạy trên môi trường "${ctx.environment ?? 'không rõ'}"`);
  if (ctx.grant.host !== ctx.host) out.push(`giấy phép cho môi trường "${ctx.grant.host}", đang chạy trên "${ctx.host ?? 'không rõ'}"`);
  if (ctx.grant.module !== ctx.module) out.push(`giấy phép cho module "${ctx.grant.module}", test thuộc module "${ctx.module}"`);
  if (ctx.grant.runId !== ctx.runId) out.push(`giấy phép cho lần chạy "${ctx.grant.runId}", lần chạy hiện tại là "${ctx.runId}"`);
  return out;
}

/** Quy tắc nhận biết "bản ghi do automation tạo" cho 1 model: trường chứa tham chiếu AUTOTEST và trường người tạo. */
export interface OwnershipRule {
  model: string;
  /** Trường văn bản tự do dùng để gắn nhãn AUTOTEST (do module khai báo). */
  refField: string;
  /** Trường người tạo (many2one trả về [id, tên]). */
  creatorField: string;
}

/** Tiền tố lý do BLOCKED khi test ghi chưa được cấp quyền (chế độ chỉ đọc). Dùng để gộp kết quả: xem core/reporters/aggregate.ts. */
export const WRITE_NOT_GRANTED_PREFIX = 'Chưa có quyền ghi dữ liệu';

/** Cách đọc bản ghi và người dùng hiện tại từ hệ thống đích (Odoo, MISA...). */
export interface RecordReader {
  readFields(model: string, id: number, fields: string[]): Promise<Record<string, unknown> | undefined>;
  currentUserId(): Promise<number>;
}

/** Giấy phép ghi cho một bản ghi cụ thể. Chỉ issueWriteToken() tạo ra nó. */
export interface SafeWriteToken {
  readonly kind: 'SafeWriteToken';
  readonly application: string;
  readonly module: string;
  readonly model: string;
  readonly id: number;
}

export interface IssueOptions {
  application: string;
  /** Khoá module đầy đủ, ví dụ odoo-sales. */
  module: string;
  rules: OwnershipRule[];
  reader: RecordReader;
  /** Các bản ghi do tiến trình này tạo, khoá dạng "model|id". */
  created: ReadonlySet<string>;
  grant: GrantContext;
  model: string;
  id: number;
}

/** Cấp giấy phép ghi hoặc ném lỗi "Từ chối ghi: ...". */
export async function issueWriteToken(o: IssueOptions): Promise<SafeWriteToken> {
  const problems = grantProblems(o.grant);
  if (problems.length) throw new Error(`Từ chối ghi: ${problems.join('; ')}`);
  const rule = o.rules.find((r) => r.model === o.model);
  if (!rule) throw new Error(`Từ chối ghi: module ${o.module} chưa khai báo quy tắc sở hữu cho model "${o.model}"`);
  if (!o.created.has(`${o.model}|${o.id}`)) throw new Error(`Từ chối ghi: ${o.model}#${o.id} không do lần chạy này tạo`);
  const reg = loadRegistry().find((r) => recordKey(r) === `${o.application}|${o.model}|${o.id}`);
  if (!reg || reg.origin !== 'AUTOMATION' || reg.runId !== o.grant.runId) {
    throw new Error(`Từ chối ghi: ${o.model}#${o.id} không có trong Test Data Registry của lần chạy ${o.grant.runId}`);
  }
  const rec = await o.reader.readFields(o.model, o.id, [rule.refField, rule.creatorField]);
  const m = AUTOTEST_REF_PATTERN.exec(String(rec?.[rule.refField] || ''));
  if (!m || m[1] !== o.grant.runId) {
    throw new Error(`Từ chối ghi: tham chiếu của ${o.model}#${o.id} không đúng mẫu AUTOTEST của lần chạy ${o.grant.runId}`);
  }
  const creator = rec?.[rule.creatorField] as [number, string] | undefined;
  if (!creator || creator[0] !== (await o.reader.currentUserId())) {
    throw new Error(`Từ chối ghi: ${o.model}#${o.id} được tạo bởi người dùng khác (${creator?.[1] ?? 'không rõ'})`);
  }
  return { kind: 'SafeWriteToken', application: o.application, module: o.module, model: o.model, id: o.id };
}
