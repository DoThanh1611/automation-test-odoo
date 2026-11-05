import fs from 'node:fs';
import path from 'node:path';
import { evaluate, versionDir, type ApprovalState } from '../approval/approval';
import type { Requirement, TestCaseDef } from '../testcases/schema';

/**
 * Thông tin tài liệu review của requirement đang xử lý, để MỖI lần gọi /qa-requirement người dùng luôn thấy: Requirement ID, phiên bản,
 * trạng thái phê duyệt và liên kết tới REVIEW.md + file test case. CHỈ ĐỌC (không tạo phiên bản, không duyệt thay ai).
 */
export interface ReviewFile {
  label: string;
  /** Đường dẫn tương đối so với thư mục dự án, dấu / (dùng làm liên kết markdown). */
  rel: string;
  abs: string;
}

export interface ReviewInfo {
  requirementId: string;
  title: string;
  state: ApprovalState;
  reason: string;
  /** Phiên bản đang chờ duyệt, hoặc phiên bản đã duyệt khi APPROVED. undefined = chưa trình duyệt. */
  version?: number;
  hash?: string;
  /** Tài liệu của `version`. Rỗng khi chưa trình duyệt. */
  files: ReviewFile[];
  /** true = tài liệu không còn khớp test case hiện tại (đã đổi sau khi trình/duyệt): cần trình phiên bản mới. */
  outdated: boolean;
  /** Việc kế tiếp với người dùng, một dòng. */
  userNote: string;
  /** Mọi phiên bản review đã có (giữ lịch sử). */
  versions: number[];
}

const NOTE: Record<ApprovalState, string> = {
  NOT_SUBMITTED: 'Chưa trình duyệt: Claude sẽ trình duyệt và mở giao diện review để bạn APPROVE/REVISE/REJECT.',
  PENDING_APPROVAL: 'Đang chờ bạn APPROVE / REVISE / REJECT trên giao diện review (hoặc nhắn sửa bằng chat). Chưa kết nối staging, chưa chạy test.',
  PENDING_STALE: 'Test case đã đổi sau khi trình: Claude trình phiên bản review mới và chờ bạn duyệt lại.',
  APPROVED: 'Đã APPROVE hợp lệ: không cần duyệt lại. Có thể xem lại test case đã duyệt qua các liên kết; quy trình tự tiếp tục.',
  INVALIDATED: 'Phê duyệt đã bị hủy vì test case thay đổi: Claude trình phiên bản review mới và chờ bạn duyệt lại.',
  SIGNATURE_INVALID: 'Phê duyệt không xác minh được: bạn duyệt lại trên giao diện review. Không sửa tay file phê duyệt.',
  KEY_MISSING: 'Máy này thiếu khoá xác thực phê duyệt: bạn duyệt lại trên giao diện review.',
  REVISION_REQUESTED: 'Đã có yêu cầu chỉnh sửa: Claude sửa test case theo nhận xét, giữ phiên bản cũ, trình phiên bản mới và chờ bạn duyệt lại.',
  REJECTED: 'Đã bị từ chối: không thực thi. Chỉ làm lại khi bạn yêu cầu rõ và test case đã đổi.',
};

export function reviewInfo(root: string, requirement: Requirement, defs: TestCaseDef[]): ReviewInfo {
  const ev = evaluate(root, requirement, defs);
  const rec = ev.record;
  const version = ev.state === 'APPROVED' ? rec?.approval?.version : rec?.version;
  const files: ReviewFile[] = [];
  if (version !== undefined) {
    const dir = versionDir(root, requirement.id, version);
    if (fs.existsSync(dir)) {
      const names = fs.readdirSync(dir).sort((a, b) => (a === 'REVIEW.md' ? -1 : b === 'REVIEW.md' ? 1 : a.localeCompare(b)));
      for (const n of names) {
        const abs = path.join(dir, n);
        files.push({ label: n === 'REVIEW.md' ? 'REVIEW.md (tổng quan)' : n.endsWith('.testcases.md') ? `${n} (test case)` : n, rel: path.relative(root, abs).split(path.sep).join('/'), abs });
      }
    }
  }
  const versionsRoot = path.join(root, 'approvals', requirement.id);
  const versions = fs.existsSync(versionsRoot)
    ? fs.readdirSync(versionsRoot).map((n) => /^v(\d+)$/.exec(n)?.[1]).filter((x): x is string => Boolean(x)).map(Number).sort((a, b) => a - b)
    : [];
  return {
    requirementId: requirement.id, title: requirement.title, state: ev.state, reason: ev.reason, version, hash: ev.state === 'APPROVED' ? rec?.approval?.hash : rec?.hash,
    files, outdated: ev.state === 'PENDING_STALE' || ev.state === 'INVALIDATED', userNote: NOTE[ev.state], versions,
  };
}

/** Khối văn bản (markdown) hiển thị cho người dùng: ID, phiên bản, trạng thái và liên kết bấm được. */
export function formatReview(r: ReviewInfo): string {
  const lines = [
    `TÀI LIỆU REVIEW TEST CASE — ${r.requirementId}: ${r.title}`,
    `  Trạng thái phê duyệt: ${r.state}${r.version !== undefined ? ` · phiên bản v${r.version}` : ''}${r.hash ? ` · hash ${r.hash.slice(0, 12)}` : ''}`,
    `  ${r.reason}`,
  ];
  if (r.files.length) {
    lines.push(r.outdated ? '  Tài liệu của phiên bản CŨ (test case đã đổi; sẽ có phiên bản mới):' : '  Liên kết:');
    for (const f of r.files) lines.push(`    - [${f.label}](${f.rel})  —  ${f.abs}`);
  }
  if (r.versions.length > 1) lines.push(`  Lịch sử phiên bản đã lưu: ${r.versions.map((v) => `v${v}`).join(', ')} (không bị xóa).`);
  lines.push(`  → ${r.userNote}`);
  return lines.join('\n');
}
