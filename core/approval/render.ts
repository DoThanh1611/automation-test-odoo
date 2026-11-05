import type { Requirement, TestCaseDef } from '../testcases/schema';

interface Meta { version: number; hash: string; status?: string }

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const list = (items: string[], numbered = false) => (items.length ? items.map((x, i) => `${numbered ? `${i + 1}.` : '-'} ${x}`).join('\n') : '_(không có)_');

/** Markdown dễ đọc cho MỘT module của bộ test case, để người dùng review trước khi duyệt. Chỉ trình bày lại, không đổi nội dung test case. */
export function renderTestCasesMarkdown(req: Requirement, moduleKey: string, defs: TestCaseDef[], meta: Meta): string {
  const L: string[] = [];
  L.push(`# Test case: ${req.id} — module ${moduleKey}`, '');
  L.push(`**Requirement:** ${req.title}  `);
  L.push(`**Phiên bản bộ test case:** v${meta.version}  `);
  L.push(`**Hash (sha256):** \`${meta.hash}\`  `);
  L.push(`**Trạng thái:** ${meta.status ?? 'PENDING_APPROVAL'} (chờ người dùng duyệt)  `);
  L.push(`**Số test case trong module này:** ${defs.length}`, '');
  L.push('| ID | Tên test case | Truy vết BR/AC | Kiểm tra qua | Ghi chú |', '|---|---|---|---|---|');
  for (const d of defs) L.push(`| ${d.id} | ${cell(d.title)} | ${d.requirementRefs.join(', ')} | ${d.verification} | ${d.needsClarification ? 'Cần làm rõ nghiệp vụ' : ''} |`);
  L.push('');
  for (const d of defs) {
    L.push(`## ${d.id} — ${d.title}`, '');
    L.push(`- **Truy vết:** ${d.requirementRefs.join(', ')}`);
    L.push(`- **Kiểm tra qua:** ${d.verification}`);
    if (d.description) L.push(`- **Mô tả:** ${d.description}`);
    L.push('', '**Điều kiện tiên quyết**', '', list(d.preconditions), '');
    if (Object.keys(d.testData).length) L.push('**Dữ liệu kiểm thử**', '', '```json', JSON.stringify(d.testData, null, 2), '```', '');
    L.push('**Các bước**', '', list(d.steps, true), '');
    L.push(`**Kết quả mong đợi:** ${d.expectedResult}`, '');
    if (d.needsClarification) L.push(`> **Cần làm rõ (NEEDS CLARIFICATION):** ${d.needsClarification}`, '');
    if (d.singleCaseReason) L.push(`> Ghi chú: chỉ một kịch bản — ${d.singleCaseReason}`, '');
  }
  L.push('---', '', `Chỉ người dùng mới được duyệt: xem \`REVIEW.md\` cùng thư mục để biết cách APPROVE / REVISE / REJECT cho v${meta.version}.`, '');
  return L.join('\n');
}

/** Trang tổng quan phiên bản: ma trận phủ BR/AC và hướng dẫn duyệt. */
export function renderReviewIndex(req: Requirement, defs: TestCaseDef[], modules: string[], meta: Meta): string {
  const L: string[] = [];
  const short = meta.hash.slice(0, 12);
  L.push(`# Duyệt bộ test case ${req.id} — v${meta.version}`, '');
  L.push(`**Requirement:** ${req.title}  `, `**Tổng số test case:** ${defs.length} (${modules.length} module)  `, `**Hash (sha256):** \`${meta.hash}\``, '');
  L.push('## File để review', '', ...modules.map((m) => `- \`${m}.testcases.md\` (${defs.filter((d) => `${d.application ?? '-'}-${d.module ?? '-'}` === m).length} test case)`), '');
  L.push('## Phủ BR/AC', '', '| Mã | Nội dung | Test case |', '|---|---|---|');
  for (const item of [...req.businessRules.map((x) => ({ ...x, k: 'BR' })), ...req.acceptanceCriteria.map((x) => ({ ...x, k: 'AC' }))]) {
    const tcs = defs.filter((d) => d.requirementRefs.includes(item.id)).map((d) => d.id);
    L.push(`| ${item.id} | ${cell(item.text)} | ${tcs.join(', ') || '**CHƯA CÓ**'} |`);
  }
  L.push('', '## Cách quyết định', '',
    'Trong terminal của bạn (APPROVE cần bàn phím thật, Claude không thể tự duyệt thay):', '',
    '```bash',
    `npm run qa:approval -- approve --requirement=${req.id} --version=${meta.version} --hash=${meta.hash}`,
    `npm run qa:approval -- revise  --requirement=${req.id} --by="Tên bạn" --comment="Cần sửa gì"`,
    `npm run qa:approval -- reject  --requirement=${req.id} --by="Tên bạn" --comment="Lý do từ chối"`,
    '```', '',
    `APPROVE chỉ có hiệu lực cho đúng v${meta.version} (hash \`${short}…\`). Sửa bất kỳ test case nào sau đó sẽ tự hủy phê duyệt. APPROVE không cấp quyền ghi dữ liệu lên staging; quyền ghi xin riêng (\`npm run test:write\`).`, '');
  return L.join('\n');
}
