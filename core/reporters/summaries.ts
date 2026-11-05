import fs from 'node:fs';
import path from 'node:path';
import type { TcStatus } from '../testcases/schema';

/**
 * Tóm tắt Actual CHO KẾT QUẢ LỊCH SỬ chưa có recordSummary: file reports/<ENV>/summaries/<runId>.json, đi KÈM (không sửa) results.json của lần chạy.
 * Mỗi câu phải khai báo căn cứ (dữ liệu gốc/evidence đã đối chiếu). Chỉ được dùng khi trạng thái VÀ hash định nghĩa test case của lần chạy khớp
 * đúng với kết quả đang hiển thị; test case đổi sau đó hoặc kết quả khác ⇒ bỏ qua (quay về nội dung gốc), không bao giờ áp sai kết quả.
 * Ưu tiên: tóm tắt do chính test ghi (recordSummary) > tệp này > nội dung gốc rút gọn.
 */
export interface HistoricalSummary {
  /** Trạng thái của kết quả mà câu tóm tắt mô tả. */
  status: TcStatus;
  /** Hash định nghĩa test case của lần chạy (xem core/testcases/hash.ts). */
  defHash: string;
  summary: string;
  /** Những gì đã đối chiếu để viết câu này (bắt buộc, không rỗng). */
  basis: string[];
}

export interface SummaryFile {
  runId: string;
  authoredAt: string;
  authoredBy: string;
  entries: Record<string, HistoricalSummary>;
}

export const summariesDir = (reportsDir: string) => path.join(reportsDir, 'summaries');

/** Đọc mọi tệp tóm tắt lịch sử. Tệp hỏng hoặc thiếu căn cứ bị bỏ qua (kèm cảnh báo trong `problems`). */
export function loadSummaries(reportsDir: string): { files: Record<string, SummaryFile>; problems: string[] } {
  const files: Record<string, SummaryFile> = {};
  const problems: string[] = [];
  const dir = summariesDir(reportsDir);
  if (!fs.existsSync(dir)) return { files, problems };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SummaryFile;
      if (!j.runId || typeof j.entries !== 'object') throw new Error('thiếu runId/entries');
      for (const [tc, e] of Object.entries(j.entries)) {
        if (!e.summary?.trim() || !e.defHash || !e.status || !Array.isArray(e.basis) || !e.basis.length) throw new Error(`${tc}: thiếu summary/status/defHash/basis`);
      }
      files[j.runId] = j;
    } catch (e) {
      problems.push(`${f}: ${(e as Error).message}`);
    }
  }
  return { files, problems };
}

/** Tóm tắt lịch sử áp dụng được cho kết quả này không (đúng lần chạy, test case, trạng thái, hash)? */
export function historicalSummaryFor(files: Record<string, SummaryFile>, runId: string, tcId: string, status: TcStatus, defHash: string): HistoricalSummary | undefined {
  const e = files[runId]?.entries[tcId];
  return e && e.status === status && e.defHash === defHash ? e : undefined;
}
