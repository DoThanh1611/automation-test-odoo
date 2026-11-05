/**
 * Phân tích requirement theo cấu trúc người dùng cung cấp:
 *   Path / Business Requirement / Expected Solution / Business Rules (BR-xx) / Acceptance Criteria (AC-xx)
 *
 * NGUYÊN TẮC: chỉ TÁCH phần, tuyệt đối không viết lại, rút gọn, dịch hay "làm đẹp" nội dung. Văn bản của BR/AC được giữ nguyên
 * từng ký tự (chỉ cắt khoảng trắng đầu/cuối dòng). Bất kỳ điều gì không rõ đều thành "problems" để người dùng quyết, không tự suy diễn.
 */
export interface ParsedRequirement {
  title?: string;
  path: string;
  businessRequirement: string;
  expectedSolution: string;
  businessRules: { id: string; text: string }[];
  acceptanceCriteria: { id: string; text: string }[];
  /** Vấn đề làm cho requirement chưa dùng được. Rỗng = hợp lệ. */
  problems: string[];
}

type Section = 'path' | 'businessRequirement' | 'expectedSolution' | 'businessRules' | 'acceptanceCriteria';

// Tên mục (không phân biệt hoa thường, chấp nhận tiếng Anh và tiếng Việt).
const HEADINGS: [Section, RegExp][] = [
  ['path', /^(?:path|đường dẫn)(?:\s*\/\s*(?:path|đường dẫn))?(?:\s+màn hình)?$/i],
  ['businessRequirement', /^(?:business requirements?|yêu cầu nghiệp vụ)$/i],
  ['expectedSolution', /^(?:expected solutions?|giải pháp mong đợi|giải pháp)$/i],
  ['businessRules', /^(?:business rules?|quy tắc nghiệp vụ)$/i],
  ['acceptanceCriteria', /^(?:acceptance criteria|tiêu chí nghiệm thu)$/i],
];

/** Bỏ ký hiệu markdown để NHẬN DIỆN tiêu đề (không dùng để lấy nội dung). */
const plain = (line: string) => line.replace(/[*_`#>]/g, '').trim();

const ITEM = /^[-*•]?\s*\**\s*((?:BR|AC)-\d+)\s*\**\s*[:.)\-–—]\s*(.+)$/;

export function parseRequirement(markdown: string): ParsedRequirement {
  const out: ParsedRequirement = { path: '', businessRequirement: '', expectedSolution: '', businessRules: [], acceptanceCriteria: [], problems: [] };
  // Chú thích HTML (ví dụ trong example/requirements/TEMPLATE.md) là ghi chú cho người đọc, không phải nội dung requirement.
  const lines = markdown.replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  let current: Section | undefined;
  const body: Record<'businessRequirement' | 'expectedSolution', string[]> = { businessRequirement: [], expectedSolution: [] };
  let lastItem: { id: string; text: string } | undefined;
  const found = new Set<Section>();

  for (const raw of lines) {
    const line = raw.trimEnd();
    const p = plain(line);

    // Tiêu đề mục đứng riêng một dòng (có thể kèm dấu hai chấm).
    // Chấp nhận tiêu đề dạng "3. Business Rules (*)": bỏ số thứ tự đầu và dấu (*) cuối (chỉ để nhận diện, không đổi nội dung).
    const headingText = p.replace(/^\d+\s*[.)]\s*/, '').replace(/\(\s*\*?\s*\)\s*:?$/, '').replace(/:$/, '').trim();
    const heading = HEADINGS.find(([, re]) => re.test(headingText));
    if (heading) {
      current = heading[0];
      found.add(current);
      lastItem = undefined;
      continue;
    }
    // "Path: <giá trị>" trên cùng một dòng.
    const pathInline = /^(?:path|đường dẫn)\s*:\s*(.+)$/i.exec(p);
    if (pathInline) {
      out.path = line.replace(/^[\s*_`#>]*(?:path|đường dẫn)\s*[*_`]*\s*:\s*[*_`]*\s*/i, '').replace(/[*_`]+$/, '').trim();
      found.add('path');
      current = undefined;
      continue;
    }
    if (!out.title && !current && p && !found.size) {
      out.title = p; // dòng đầu tiên trước mọi mục
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      lastItem = undefined;
      continue;
    }

    if (current === 'businessRules' || current === 'acceptanceCriteria') {
      const m = ITEM.exec(trimmed);
      if (m) {
        const kind = m[1].startsWith('BR') ? 'businessRules' : 'acceptanceCriteria';
        if (kind !== current) out.problems.push(`${m[1]} nằm trong mục "${current === 'businessRules' ? 'Business Rules' : 'Acceptance Criteria'}" nhưng có tiền tố ${m[1].slice(0, 2)}`);
        const item = { id: m[1], text: m[2].trim() };
        (kind === 'businessRules' ? out.businessRules : out.acceptanceCriteria).push(item);
        lastItem = item;
      } else if (lastItem) {
        lastItem.text += ` ${trimmed}`; // dòng nối tiếp của mục trước
      } else {
        out.problems.push(`Dòng không phải BR/AC trong mục ${current === 'businessRules' ? 'Business Rules' : 'Acceptance Criteria'}: "${trimmed.slice(0, 60)}"`);
      }
      continue;
    }
    if (current === 'path') {
      out.path = out.path ? `${out.path} ${trimmed}` : trimmed;
      continue;
    }
    if (current === 'businessRequirement' || current === 'expectedSolution') {
      if (ITEM.test(trimmed)) out.problems.push(`${ITEM.exec(trimmed)![1]} nằm ngoài mục Business Rules/Acceptance Criteria`);
      body[current].push(trimmed);
    }
  }

  out.businessRequirement = body.businessRequirement.join('\n').trim();
  out.expectedSolution = body.expectedSolution.join('\n').trim();

  const need: [Section, string][] = [['path', 'Path'], ['businessRequirement', 'Business Requirement'], ['expectedSolution', 'Expected Solution'], ['businessRules', 'Business Rules'], ['acceptanceCriteria', 'Acceptance Criteria']];
  for (const [s, label] of need) if (!found.has(s)) out.problems.push(`Thiếu mục "${label}"`);
  if (found.has('path') && !out.path) out.problems.push('Mục Path rỗng');
  if (found.has('businessRequirement') && !out.businessRequirement) out.problems.push('Mục Business Requirement rỗng');
  if (found.has('businessRules') && !out.businessRules.length) out.problems.push('Mục Business Rules không có BR nào (mỗi dòng dạng "BR-01: ...")');
  if (found.has('acceptanceCriteria') && !out.acceptanceCriteria.length) out.problems.push('Mục Acceptance Criteria không có AC nào (mỗi dòng dạng "AC-01: ...")');
  for (const list of [out.businessRules, out.acceptanceCriteria]) {
    const ids = new Set<string>();
    for (const i of list) {
      if (ids.has(i.id)) out.problems.push(`Trùng mã ${i.id}`);
      ids.add(i.id);
      if (!i.text) out.problems.push(`${i.id} không có nội dung`);
    }
  }
  return out;
}
