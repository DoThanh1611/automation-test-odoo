import fs from 'node:fs';
import path from 'node:path';
import { markerFile } from '../approval/gate';
import type { Requirement } from '../testcases/schema';
import { computeSummary } from './aggregate';
import type { Bug } from './bugs';
import type { Summary, TcResult } from './types';

/**
 * "Requirement đang xử lý": báo cáo mặc định lọc theo requirement này; mọi requirement khác (và các lần chạy trước) là LỊCH SỬ.
 * Số liệu tổng (summary) vẫn là của toàn bộ requirement để không đổi ý nghĩa cũ; focus là phần tách riêng.
 */
export interface FocusInfo {
  requirementId: string;
  title: string;
  summary: Summary;
  bugs: { total: number; open: number };
  /** Nguồn của kết quả: lần chạy gần nhất có chạy requirement này, số test case lấy từ lần đó, từ các lần chạy trước (lịch sử), và chưa từng chạy. */
  provenance: { latestRunId?: string; fromLatestRun: number; fromEarlierRuns: number; neverRun: number };
}

/** Nguồn của focus, theo thứ tự ưu tiên: đối số, QA_FOCUS_REQ, phiên thực thi đang mở. Không có/không tồn tại => undefined. */
export function resolveFocusId(requirements: Requirement[], explicit?: string, root = process.cwd()): string | undefined {
  let id = explicit || process.env.QA_FOCUS_REQ || undefined;
  if (!id) {
    try {
      id = (JSON.parse(fs.readFileSync(markerFile(root), 'utf8')) as { requirementId?: string }).requirementId;
    } catch { /* không có phiên thực thi */ }
  }
  if (!id) {
    // Phiên làm việc /qa-requirement (còn sau khi phiên thực thi đóng): báo cáo vẫn lọc theo requirement vừa xử lý.
    try {
      id = (JSON.parse(fs.readFileSync(path.join(root, '.qa-state', 'workflow.json'), 'utf8')) as { requirementId?: string }).requirementId;
    } catch { /* chưa có phiên làm việc */ }
  }
  return id && requirements.some((r) => r.id === id) ? id : undefined;
}

export function buildFocus(requirementId: string, requirements: Requirement[], results: TcResult[], bugs: Bug[], generatedAt: string): FocusInfo {
  const mine = results.filter((r) => r.def.requirementId === requirementId);
  const myBugs = bugs.filter((b) => b.requirementId === requirementId);
  const latestRunId = mine.map((r) => r.runId).filter((x): x is string => Boolean(x)).sort().pop();
  return {
    requirementId,
    title: requirements.find((r) => r.id === requirementId)?.title ?? requirementId,
    summary: computeSummary(mine, generatedAt),
    bugs: { total: myBugs.length, open: myBugs.filter((b) => b.status === 'OPEN').length },
    provenance: {
      latestRunId,
      fromLatestRun: mine.filter((r) => r.runId && r.runId === latestRunId).length,
      fromEarlierRuns: mine.filter((r) => r.runId && r.runId !== latestRunId).length,
      neverRun: mine.filter((r) => !r.runId).length,
    },
  };
}
