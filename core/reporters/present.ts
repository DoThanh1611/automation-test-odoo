import { APPROVAL_BLOCK_PREFIX } from '../approval/approval';
import type { TcStatus } from '../testcases/schema';
import { WRITE_NOT_GRANTED_PREFIX } from '../testdata/write-guard';

/**
 * Lớp trình bày: chuyển dữ liệu gốc của kết quả test thành nội dung dễ đọc cho người dùng nghiệp vụ. CHỈ ảnh hưởng hiển thị:
 * không sửa test case đã duyệt, không sửa dữ liệu gốc (results.json), mọi nội dung gốc vẫn xem được trong mục "Chi tiết kỹ thuật".
 * Không tự suy diễn: thiếu dữ liệu để tóm tắt thì giữ nguyên nội dung đã có (chỉ rút gọn mã máy dài).
 */
const NUMBERING = /^\s*(?:bước\s*)?\d+\s*[.):\-]\s+/i;

/** Các bước đánh số tự nhiên: bỏ số thứ tự có sẵn, mỗi bước một hành động (tách theo dấu chấm phẩy), bỏ bước trống/lặp liên tiếp. Nội dung từng bước giữ nguyên. */
export function presentSteps(steps: string[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    for (const part of s.replace(NUMBERING, '').split(/\s*;\s+/)) {
      const t = part.trim();
      if (t && out[out.length - 1]?.toLowerCase() !== t.toLowerCase()) out.push(t);
    }
  }
  return out;
}

const MAX_LABEL = 34;

/**
 * Thay tên biến/thuật ngữ trong glossary bằng cách gọi ngắn của nó khi HIỂN THỊ Steps/Expected (không sửa test case đã duyệt).
 * Cách gọi ngắn = mệnh đề đầu của diễn giải trong glossary, chỉ dùng khi đủ ngắn; diễn giải dài thì bỏ tên biến, giữ phần còn lại của câu.
 * Diễn giải đầy đủ vẫn có trong "Chi tiết kỹ thuật". Trả về cả danh sách thuật ngữ đã gặp.
 */
export function plainTerms(text: string, glossary: Record<string, string>): { text: string; used: string[] } {
  const keys = Object.keys(glossary).sort((a, b) => b.length - a.length);
  if (!keys.length) return { text, used: [] };
  const re = new RegExp(`(?<![\\w.])(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w])`, 'g');
  const used: string[] = [];
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const key = m[1];
    used.push(key);
    let before = text.slice(last, m.index);
    const label = (glossary[key].split(',')[0] ?? '').replace(/^\s+|\s+$/g, '');
    if (label && label.length <= MAX_LABEL) {
      const words = label.split(/\s+/);
      for (let k = Math.min(words.length, 4); k >= 1; k--) {
        const lead = `${words.slice(0, k).join(' ')} `;
        if (before.toLowerCase().endsWith(lead.toLowerCase())) { before = before.slice(0, before.length - lead.length); break; }
      }
      out += before + label;
    } else {
      out += before.replace(/\s+$/, '');
    }
    last = m.index! + m[0].length;
  }
  return { text: out + text.slice(last), used: [...new Set(used)] };
}

const WORD = /[\p{L}\p{N}]{3,}/gu;

/** Mô tả chỉ lặp lại tiêu đề/bước/Expected (≥ 75% từ đã có ở đó) thì không cần hiện trong thẻ; dữ liệu gốc không bị xóa. */
export function descriptionIsRedundant(description: string, others: string[]): boolean {
  const words = (description.toLowerCase().match(WORD) ?? []);
  if (!words.length) return true;
  const have = new Set(others.flatMap((o) => o.toLowerCase().match(WORD) ?? []));
  return words.filter((w) => have.has(w)).length / words.length >= 0.75;
}

/** Mã máy dài (VIN/serial/số máy do framework sinh) rút gọn khi hiển thị chính; bản đầy đủ vẫn có trong "Chi tiết kỹ thuật". */
export const shortIds = (s: string) => s.replace(/\b(AT|EIN)(\d{8,})\b/g, (_m, p: string, d: string) => `${p}…${d.slice(-4)}`);

const TECH = /(\b[a-z]+_[a-z_]+\b|\b[a-z]+\.[a-z]+(?:\.[a-z]+)+\b|locator|selector|expect\(|\bassert|\bRPC\b|\bORM\b|\bAPI\b|stack|\bid \d+\b|state=|\bhash\b)/i;

export type BlockedKind = 'ENVIRONMENT' | 'PERMISSION' | 'DATA' | 'APPROVAL' | 'UNKNOWN';

const BLOCKED_LABEL: Record<BlockedKind, string> = {
  ENVIRONMENT: 'Điều kiện môi trường chưa đáp ứng',
  PERMISSION: 'Thiếu quyền hoặc tài khoản vai trò',
  DATA: 'Thiếu dữ liệu kiểm thử',
  APPROVAL: 'Chưa được phê duyệt',
  UNKNOWN: 'Chưa xác định nguyên nhân',
};

/**
 * Nguyên nhân BLOCKED: ưu tiên metadata có cấu trúc do test/fixture ghi (block(reason, kind)); kết quả cũ chưa có thì chỉ dùng các
 * TIỀN TỐ có cấu trúc của framework (chưa phê duyệt / chưa cấp quyền ghi). Không đoán theo từ khóa: không xác định được ⇒ "Chưa xác định".
 */
export function blockedKind(reason = '', kind?: string): { kind: BlockedKind; label: string } {
  const k: BlockedKind = kind && kind in BLOCKED_LABEL ? (kind as BlockedKind)
    : reason.startsWith(WRITE_NOT_GRANTED_PREFIX) ? 'PERMISSION'
      : reason.startsWith(APPROVAL_BLOCK_PREFIX) ? 'APPROVAL'
        : 'UNKNOWN';
  return { kind: k, label: BLOCKED_LABEL[k] };
}

/** Lỗi do automation dừng (timeout/locator/assertion không chú thích): không nói lên hành vi nghiệp vụ. */
export function isAutomationError(message?: string): boolean {
  const first = message?.split(/\r?\n/)[0]?.trim().replace(/^Error:\s*/, '') ?? '';
  return /^expect\(|^Test timeout|^locator\.|^page\./i.test(first);
}

export interface BugTrust {
  errorMessage: string;
  verification: 'REPRODUCED' | 'NOT_REPRODUCED' | 'UNVERIFIED';
  categoryLabel: string;
}

/**
 * Hiển thị trung thực phân loại/kiểm chứng của bug: timeout/locator không phải căn cứ của lỗi nghiệp vụ, nên không được đếm là "tái hiện".
 * Chỉ ảnh hưởng hiển thị; dữ liệu bug giữ nguyên và giá trị gốc vẫn được nêu. Trả về undefined khi dữ liệu gốc đã đúng.
 */
export function presentBugTrust(b: BugTrust, sameTc: BugTrust[]): { category?: string; verification?: string } {
  const automation = isAutomationError(b.errorMessage);
  const business = sameTc.filter((x) => !isAutomationError(x.errorMessage)).length;
  return {
    category: automation ? `Chưa xác định: lần chạy dừng vì timeout/locator của automation, chưa có căn cứ là lỗi nghiệp vụ (dữ liệu gốc ghi: ${b.categoryLabel})` : undefined,
    verification: b.verification !== 'REPRODUCED' || business >= 2 ? undefined
      : automation ? 'Chưa đủ căn cứ: lần chạy này dừng vì timeout/locator, không chứng minh cùng lỗi nghiệp vụ đã tái hiện (dữ liệu gốc ghi: REPRODUCED)'
        : 'Mới xác nhận ở 1 lần chạy có kết luận nghiệp vụ; lần chạy khác dừng vì timeout/locator nên không tính là tái hiện (dữ liệu gốc ghi: REPRODUCED)',
  };
}

/** Thông báo của assertion có chú thích (expect(x, 'điều phải đúng')) + Expected/Received: căn cứ có cấu trúc để nêu khác biệt khi chưa có tóm tắt. */
export function failFromError(message?: string): string | undefined {
  if (!message || isAutomationError(message)) return undefined;
  const lines = message.split(/\r?\n/).map((l) => l.trim());
  const first = lines[0]?.replace(/^Error:\s*/, '') ?? '';
  if (!first) return undefined;
  const val = (label: string) => lines.find((l) => l.startsWith(`${label}:`))?.slice(label.length + 1).trim();
  const fmt = (v?: string) => (v === undefined ? undefined : v === 'false' || v === 'undefined' || v === '""' ? '(trống)' : shortIds(v.replace(/^"|"$/g, '')));
  const exp = fmt(val('Expected'));
  const rec = fmt(val('Received'));
  return `Không đạt: ${first.charAt(0).toUpperCase()}${first.slice(1)}${exp !== undefined && rec !== undefined ? ` (mong đợi: ${exp}; thực tế: ${rec})` : ''}.`;
}

export interface ActualInput {
  actual: string;
  status: TcStatus;
  reason?: string;
  /** Tóm tắt nghiệp vụ do test ghi (recordSummary); ưu tiên nếu có. */
  summary?: string;
  /** Chi tiết kỹ thuật do test ghi (recordTechnical). */
  technical?: string[];
  /** Nguyên nhân BLOCKED có cấu trúc. */
  blockedKind?: string;
  /** RUN = test tự ghi; HISTORICAL = viết lại từ dữ liệu đã lưu (kèm căn cứ). */
  summarySource?: 'RUN' | 'HISTORICAL';
  summaryBasis?: string[];
  error?: { message: string; failedStep?: string };
}

export interface PresentedActual {
  main: string;
  /** Nội dung đưa vào mục thu gọn "Chi tiết kỹ thuật" (không bao giờ mất dữ liệu gốc). */
  details: { title: string; text: string }[];
  /** Nhãn loại chặn (chỉ với BLOCKED). */
  blocked?: { kind: BlockedKind; label: string };
}

export function presentActual(i: ActualInput): PresentedActual {
  const details: PresentedActual['details'] = [];
  let main: string;
  let blocked: PresentedActual['blocked'];

  if (i.status === 'BLOCKED') {
    blocked = blockedKind(i.reason, i.blockedKind);
    main = `${blocked.label}. Test chưa được thực hiện nên chưa có kết luận nghiệp vụ (lý do ở ghi chú bên dưới).`;
  } else if (i.status === 'NEEDS CLARIFICATION') {
    main = `Cần làm rõ nghiệp vụ trước khi kết luận: ${shortIds(i.reason ?? i.actual)}`;
  } else if (i.summary?.trim()) {
    main = i.summary.trim();
  } else if (i.status === 'FAIL' && failFromError(i.error?.message)) {
    main = failFromError(i.error?.message)!;
  } else {
    const segs = i.actual.split(/;\s+|(?<=\.)\s+(?=[A-ZÀ-Ỹ])/).map((x) => x.trim()).filter(Boolean);
    const plain = segs.filter((x) => !TECH.test(x));
    main = shortIds((plain.length ? plain : segs).join('; '));
    if (main.length > 360) main = `${main.slice(0, 357)}…`;
  }

  if (i.summarySource === 'HISTORICAL') details.push({ title: 'Nguồn của câu tóm tắt', text: `Viết lại từ dữ liệu đã lưu của lần chạy (kết quả gốc và evidence không bị sửa). Căn cứ đã đối chiếu:\n${(i.summaryBasis ?? []).map((b) => `- ${b}`).join('\n')}` });
  if (i.actual && i.actual !== main) details.push({ title: 'Ghi nhận đầy đủ khi chạy', text: i.actual });
  for (const t of i.technical ?? []) if (t.trim()) details.push({ title: 'Ghi chú kỹ thuật', text: t });
  if (i.error?.failedStep) details.push({ title: 'Bước kiểm tra bị lỗi', text: i.error.failedStep });
  if (i.error?.message) details.push({ title: 'Thông báo lỗi', text: i.error.message });
  return { main, details, blocked };
}
