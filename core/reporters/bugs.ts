import { defHash } from '../testcases/hash';
import type { TestCaseDef } from '../testcases/schema';
import type { Evidence, RoleInfo, RunFile } from './types';

/**
 * Bug Report tự sinh từ MỌI test FAIL trong toàn bộ lịch sử các lần chạy.
 * Đây là BÁO CÁO PHÁT HIỆN, không phải kết luận: người dùng/QA quyết định có phải bug thật hay không.
 * Phân loại sơ bộ chỉ nhằm tránh nhầm lỗi hạ tầng (mạng, trình duyệt) thành lỗi sản phẩm.
 */
export type BugCategory = 'SUSPECTED_PRODUCT' | 'SUSPECTED_INFRASTRUCTURE';

export interface Bug {
  /** Ổn định theo (lần chạy, test case): BUG-<runId>-<testCaseId>. */
  bugId: string;
  relatedTestCase: string;
  title: string;
  requirementRefs: string[];
  requirementId?: string;
  application?: string;
  module?: string;
  category: BugCategory;
  categoryLabel: string;
  /** OPEN: lần chạy gần nhất của test case vẫn là lỗi này. SUPERSEDED: đã có lần chạy sau (hoặc định nghĩa test case đã đổi). */
  status: 'OPEN' | 'SUPERSEDED';
  /** Lần chạy phát hiện và thời điểm phát hiện. */
  runId: string;
  detectedAt: string;
  /** Có ít nhất video/ảnh/trace đi kèm hay không (lỗi nghiệp vụ có bằng chứng). */
  hasEvidence: boolean;
  /** REPRODUCED: cùng test case (cùng định nghĩa) lỗi ở ≥ 2 lần chạy. NOT_REPRODUCED: lần chạy sau của test case đã PASS. UNVERIFIED: chưa chạy lại. */
  verification: 'REPRODUCED' | 'NOT_REPRODUCED' | 'UNVERIFIED';
  stepsToReproduce: string[];
  failedStep?: string;
  expectedResult: string;
  actualResult: string;
  errorMessage: string;
  evidence: Evidence;
  environment: { key?: string; host?: string; application?: string; module?: string; role?: RoleInfo; writesEnabled?: boolean; runId: string; executedAt: string };
}

const INFRA = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|net::ERR_|Target (?:page|closed)|browser has been closed|apiRequestContext\.\w+: (?:read|connect|socket)|Navigation timeout/i;

export const classifyError = (message: string): BugCategory => (INFRA.test(message) ? 'SUSPECTED_INFRASTRUCTURE' : 'SUSPECTED_PRODUCT');

export const VERIFICATION_LABEL: Record<Bug['verification'], string> = {
  REPRODUCED: 'Đã kiểm chứng lại: lỗi tái hiện ở nhiều lần chạy',
  NOT_REPRODUCED: 'Không tái hiện: lần chạy sau của test case đã PASS (cần QA xem xét, có thể là lỗi không ổn định hoặc đã được sửa)',
  UNVERIFIED: 'Chưa kiểm chứng lại (framework không tự chạy lại test để tránh tạo dữ liệu trùng)',
};

export const CATEGORY_LABEL: Record<BugCategory, string> = {
  SUSPECTED_PRODUCT: 'Lỗi nghiệp vụ nghi ngờ (kết quả thực tế khác mong đợi; QA cần xác nhận)',
  SUSPECTED_INFRASTRUCTURE: 'Nghi lỗi hạ tầng/mạng (cần chạy lại để xác nhận, chưa phải bug)',
};

export function buildBugs(defs: TestCaseDef[], runs: RunFile[]): Bug[] {
  const ordered = [...runs].sort((a, b) => a.runId.localeCompare(b.runId));
  const bugs: Bug[] = [];
  for (const run of ordered) {
    for (const e of run.entries) {
      if (e.status !== 'FAIL' || !e.error) continue;
      const def = defs.find((d) => d.id === e.tcId);
      if (!def) continue; // test case đã bị xoá khỏi định nghĩa: không còn ngữ cảnh để lập bug
      const latest = ordered.flatMap((r) => r.entries.filter((x) => x.tcId === e.tcId).map((x) => ({ r, x }))).at(-1)!;
      const isLatest = latest.r.runId === run.runId && latest.x.status === 'FAIL' && latest.x.defHash === defHash(def);
      const cat = classifyError(e.error.message);
      const sameDef = ordered.flatMap((r) => r.entries.filter((x) => x.tcId === e.tcId && x.defHash === defHash(def)).map((x) => ({ r, x })));
      const failRuns = sameDef.filter((s) => s.x.status === 'FAIL').length;
      const laterPass = sameDef.some((s) => s.r.runId > run.runId && s.x.status === 'PASS');
      const verification: Bug['verification'] = failRuns >= 2 ? 'REPRODUCED' : laterPass ? 'NOT_REPRODUCED' : 'UNVERIFIED';
      const p = (f?: string) => (f ? `runs/${run.runId}/${f}` : undefined);
      let host: string | undefined;
      try { host = run.baseURL ? new URL(run.baseURL).host : undefined; } catch { /* baseURL không hợp lệ */ }
      bugs.push({
        bugId: run.environment ? `BUG-${run.environment}-${run.runId}-${e.tcId}` : `BUG-${run.runId}-${e.tcId}`,
        relatedTestCase: e.tcId,
        title: `[${e.tcId}] ${def.title}`,
        requirementRefs: def.requirementRefs,
        requirementId: def.requirementId,
        application: def.application,
        module: def.module,
        category: cat,
        categoryLabel: CATEGORY_LABEL[cat],
        status: isLatest ? 'OPEN' : 'SUPERSEDED',
        runId: run.runId,
        detectedAt: run.finishedAt,
        hasEvidence: Boolean(e.evidence.video || e.evidence.trace || e.evidence.screenshots.length),
        verification,
        stepsToReproduce: def.steps,
        failedStep: e.error.failedStep,
        expectedResult: def.expectedResult,
        actualResult: e.actual,
        errorMessage: e.error.message,
        evidence: { video: p(e.evidence.video), screenshots: e.evidence.screenshots.map((s) => p(s)!), trace: p(e.evidence.trace) },
        environment: { key: run.environment, host, application: def.application, module: def.module, role: e.role, writesEnabled: run.writesEnabled, runId: run.runId, executedAt: run.finishedAt },
      });
    }
  }
  return bugs;
}
