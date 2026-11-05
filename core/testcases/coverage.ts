import type { Requirement, TestCaseDef } from './schema';

/**
 * Độ phủ BR/AC theo TỪNG requirement (mã BR-01/AC-01 chỉ có nghĩa trong phạm vi requirement chứa nó,
 * vì requirement nào cũng đánh số từ 01). Thuần hàm, không đọc file.
 */
export interface CoverageItem {
  id: string;
  kind: 'BR' | 'AC';
  text: string;
  testCases: string[];
}

export interface RequirementCoverage {
  requirementId: string;
  title: string;
  application: string;
  module: string;
  items: CoverageItem[];
  /** Mã BR/AC chưa có test case nào. */
  uncovered: string[];
  testCaseCount: number;
  /** Lỗi truy vết: tham chiếu BR/AC không tồn tại trong requirement của test case, requirement không tồn tại, trùng ID. */
  errors: string[];
}

const MULTI_CASE = /lần lượt|từng|mỗi/i;

export function computeCoverage(requirements: Requirement[], testCases: TestCaseDef[]): RequirementCoverage[] {
  const seen = new Set<string>();
  const dupErrors: string[] = [];
  const seenReq = new Set<string>();
  for (const r of requirements) {
    if (seenReq.has(r.id)) dupErrors.push(`Trùng ID requirement ${r.id} (mỗi requirement phải có mã duy nhất toàn cục, kể cả khi ở module khác)`);
    seenReq.add(r.id);
  }
  for (const tc of testCases) {
    if (seen.has(tc.id)) dupErrors.push(`Trùng ID test case ${tc.id}`);
    seen.add(tc.id);
  }
  const result = requirements.map((r): RequirementCoverage => {
    const mine = testCases.filter((t) => t.requirementId === r.id);
    const items: CoverageItem[] = [
      ...r.businessRules.map((x) => ({ id: x.id, kind: 'BR' as const, text: x.text, testCases: [] as string[] })),
      ...r.acceptanceCriteria.map((x) => ({ id: x.id, kind: 'AC' as const, text: x.text, testCases: [] as string[] })),
    ];
    const errors: string[] = [];
    for (const tc of mine) {
      if (!tc.requirementRefs.length) errors.push(`${tc.id} không có requirementRefs`);
      for (const ref of tc.requirementRefs) {
        const item = items.find((i) => i.id === ref);
        if (item) item.testCases.push(tc.id);
        else errors.push(`${tc.id} tham chiếu ${ref} không tồn tại trong ${r.id}`);
      }
    }
    // AC liệt kê nhiều trường hợp độc lập ("lần lượt", "từng", "mỗi") phải có từ 2 test case trở lên, mỗi trường hợp một TC-ID riêng
    // (có thể sinh từ một vòng lặp tham số hóa trong spec, miễn là mỗi trường hợp mang tcMeta('TC-...') riêng để truy vết và có kết quả riêng).
    for (const item of items) {
      if (item.kind !== 'AC' || item.testCases.length !== 1 || !MULTI_CASE.test(item.text)) continue;
      const only = mine.find((t) => t.id === item.testCases[0]);
      if (only?.singleCaseReason?.trim()) continue;
      errors.push(`${item.id} liệt kê nhiều trường hợp độc lập (có "lần lượt/từng/mỗi") nhưng chỉ có 1 test case (${only?.id}). Tách mỗi trường hợp thành một test case riêng (có thể tham số hóa trong spec nhưng mỗi trường hợp một TC-ID), hoặc nếu thực sự chỉ là một trường hợp thì ghi singleCaseReason.`);
    }
    return {
      requirementId: r.id, title: r.title, application: r.application, module: r.module, items,
      uncovered: items.filter((i) => !i.testCases.length).map((i) => i.id),
      testCaseCount: mine.length, errors,
    };
  });
  const known = new Set(requirements.map((r) => r.id));
  const orphan = testCases.filter((t) => !t.requirementId || !known.has(t.requirementId)).map((t) => `${t.id} thuộc requirement "${t.requirementId}" không tồn tại`);
  if (dupErrors.length || orphan.length) {
    result.push({ requirementId: '(toàn cục)', title: 'Lỗi chung', application: '', module: '', items: [], uncovered: [], testCaseCount: 0, errors: [...dupErrors, ...orphan] });
  }
  return result;
}
