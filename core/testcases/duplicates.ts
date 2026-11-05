import type { Requirement } from './schema';

/** Chuẩn hoá để so sánh: chữ thường, bỏ dấu câu, gộp khoảng trắng. KHÔNG dùng để sửa nội dung lưu. */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export interface SimilarRequirement {
  id: string;
  reason: string;
  /** true = trùng mã requirement: KHÔNG được vượt qua bằng bất kỳ cờ nào. */
  hard?: boolean;
}

/**
 * Phát hiện requirement có thể trùng với requirement đã có (cùng ID, cùng tiêu đề, hoặc phần lớn BR/AC giống nhau).
 * Chỉ CẢNH BÁO để người dùng quyết định; không bao giờ tự gộp hay sửa requirement.
 */
export function findSimilarRequirements(
  candidate: { id: string; title: string; businessRules: { text: string }[]; acceptanceCriteria: { text: string }[] },
  existing: Requirement[],
): SimilarRequirement[] {
  const items = [...candidate.businessRules, ...candidate.acceptanceCriteria].map((x) => norm(x.text)).filter(Boolean);
  const out: SimilarRequirement[] = [];
  for (const r of existing) {
    if (r.id === candidate.id) {
      out.push({ id: r.id, reason: 'trùng mã requirement', hard: true });
      continue;
    }
    if (norm(r.title) && norm(r.title) === norm(candidate.title)) {
      out.push({ id: r.id, reason: 'trùng tiêu đề' });
      continue;
    }
    const have = new Set([...r.businessRules, ...r.acceptanceCriteria].map((x) => norm(x.text)));
    const shared = items.filter((t) => have.has(t)).length;
    if (items.length && shared / items.length >= 0.5) out.push({ id: r.id, reason: `${shared}/${items.length} BR/AC giống nguyên văn` });
  }
  return out;
}
