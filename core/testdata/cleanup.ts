import crypto from 'node:crypto';
import type { TestDataRecord } from './registry';

/**
 * Khung lập kế hoạch cleanup DÙNG CHUNG. Mỗi module khai báo CleanupHandler cho từng loại chứng từ nó tạo ra.
 * Nguyên tắc:
 *  - KHÔNG BAO GIỜ mặc định áp dụng quy trình của loại chứng từ này cho loại khác (ví dụ quy trình hủy SO cho PO).
 *  - Loại chưa biết cách cleanup an toàn => supported=false (hiển thị "CHƯA HỖ TRỢ"), không có bước nào được đề xuất.
 *  - Lập kế hoạch luôn là DRY-RUN chỉ đọc. Thực thi cần cổng xác nhận riêng (checkExecutionGate) và handler có execute().
 */
export interface PlanStep {
  op: string;
  why: string;
  /** Tham số bổ sung sau [id] (ví dụ [{ active: false }] cho write). */
  args?: unknown[];
  kwargs?: Record<string, unknown>;
}

export interface PlanItem {
  model: string;
  id: number;
  reference: string;
  label: string;
  eligible: boolean;
  alreadyClean: boolean;
  blockers: string[];
  steps: PlanStep[];
  /** Thông tin bổ sung hiển thị trong kế hoạch (trạng thái, số tiền...). */
  meta?: Record<string, unknown>;
}

export interface PlanContext<C> {
  client: C;
  records: TestDataRecord[];
}

export interface CleanupHandler<C = unknown> {
  id: string;
  /** Các model mà handler này chịu trách nhiệm. */
  models: string[];
  supported: boolean;
  /** Bắt buộc khi supported=false: vì sao chưa hỗ trợ. */
  unsupportedReason?: string;
  /** Chỉ đọc: trả về kế hoạch cho các bản ghi thuộc models của handler. */
  plan(ctx: PlanContext<C>): Promise<PlanItem[]>;
  /** KHÔNG có handler nào triển khai hàm này ở thời điểm hiện tại. Chỉ viết sau khi người dùng xác nhận quy trình cụ thể. */
  execute?(ctx: PlanContext<C>, items: PlanItem[]): Promise<void>;
}

/** Handler cho loại chứng từ chưa có quy trình cleanup an toàn đã xác minh. */
export function unsupportedHandler(id: string, models: string[], reason: string): CleanupHandler<unknown> {
  return {
    id,
    models,
    supported: false,
    unsupportedReason: reason,
    async plan({ records }) {
      return records
        .filter((r) => models.includes(r.model))
        .map((r) => ({
          model: r.model, id: r.recordId, reference: r.reference, label: `${r.model}#${r.recordId}`,
          eligible: false, alreadyClean: false, blockers: [`CHƯA HỖ TRỢ: ${reason}`], steps: [],
        }));
    },
  };
}

/** Mã định danh kế hoạch: băm danh sách (model, id, các bước). Đổi bất kỳ bước/bản ghi nào => mã đổi. */
export function planId(items: PlanItem[]): string {
  const canonical = items
    .map((i) => `${i.model}#${i.id}:${i.eligible ? 'Y' : 'N'}:${i.steps.map((s) => s.op).join('>')}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export const confirmPhrase = (moduleKey: string, host: string, count: number) => `XÁC NHẬN HỦY ${count} BẢN GHI ${moduleKey} TRÊN ${host}`;

export interface GateInput {
  moduleKey: string | undefined;
  host: string;
  currentPlanId: string;
  executableCount: number;
  givenPlanId?: string;
  givenPhrase?: string;
  allowCleanupEnv: boolean;
}

/** Cổng xác nhận thực thi. Trả về danh sách lý do KHÔNG được thực thi (rỗng = qua cổng). Thuần hàm. */
export function checkExecutionGate(g: GateInput): string[] {
  const out: string[] = [];
  if (!g.moduleKey) out.push('phải chỉ định rõ một module (--module=<app>-<module>); không dọn nhiều module cùng lúc');
  if (!g.allowCleanupEnv) out.push('ALLOW_CLEANUP != true');
  if (g.executableCount === 0) out.push('kế hoạch không có bản ghi nào đủ điều kiện và được hỗ trợ');
  if (!g.givenPlanId || g.givenPlanId !== g.currentPlanId) out.push(`mã kế hoạch (--plan-id) không khớp kế hoạch hiện tại (${g.currentPlanId}): kế hoạch đã đổi hoặc chưa xem lại`);
  if (g.moduleKey && g.givenPhrase !== confirmPhrase(g.moduleKey, g.host, g.executableCount)) {
    out.push(`câu xác nhận (--confirm) không đúng. Cần gõ chính xác: "${confirmPhrase(g.moduleKey, g.host, g.executableCount)}"`);
  }
  return out;
}
