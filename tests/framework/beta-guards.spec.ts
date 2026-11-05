import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { aggregate } from '../../core/reporters/aggregate';
import { renderHtml } from '../../core/reporters/render-html';
import { buildSummaryMarkdown } from '../../core/reporters/summary';
import { compareReport } from '../../core/reporters/verify';
import type { RunFile } from '../../core/reporters/types';
import { computeCoverage } from '../../core/testcases/coverage';
import { defHash } from '../../core/testcases/hash';
import { verifyRequirement } from '../../core/testcases/integrity';
import { sha256 } from '../../core/testcases/lock';
import type { Requirement, TestCaseDef } from '../../core/testcases/schema';

// Framework tests cho 3 chốt chặn trước bản Beta: AC nhiều trường hợp, nguyên văn requirement bằng công cụ, đồng bộ JSON/HTML/tổng kết.
// KHÔNG kết nối Odoo, KHÔNG ghi dữ liệu nghiệp vụ; mọi file tạo trong thư mục tạm của hệ điều hành.

const mkReq = (acText: string): Requirement => ({
  id: 'REQ-T', title: 'T', application: 'odoo', module: 'x', businessRequirement: 'b',
  businessRules: [{ id: 'BR-01', text: 'a' }], acceptanceCriteria: [{ id: 'AC-01', text: acText }],
});
const mkDef = (id: string, over: Partial<TestCaseDef> = {}): TestCaseDef => ({
  id, title: `Tiêu đề ${id}`, requirementRefs: ['BR-01', 'AC-01'], description: '', preconditions: [], testData: {}, steps: ['bước'],
  expectedResult: `kết quả ${id}`, verification: 'UI', automated: false, requirementId: 'REQ-T', application: 'odoo', module: 'x', ...over,
});

test.describe('AC nhiều trường hợp độc lập phải có test case riêng (BETA-1)', () => {
  const multi = 'Lần lượt để thiếu từng thông tin bắt buộc rồi tạo hóa đơn: hệ thống chặn.';
  test('AC có "lần lượt/từng" chỉ có 1 test case bị báo lỗi truy vết', () => {
    const c = computeCoverage([mkReq(multi)], [mkDef('TC-1')])[0];
    expect(c.errors.join('|')).toMatch(/AC-01 liệt kê nhiều trường hợp độc lập/);
  });
  test('tách thành nhiều test case (mỗi trường hợp một TC-ID) thì đạt', () => {
    const c = computeCoverage([mkReq(multi)], [mkDef('TC-1'), mkDef('TC-2'), mkDef('TC-3')])[0];
    expect(c.errors).toEqual([]);
    expect(c.items.find((i) => i.id === 'AC-01')!.testCases).toEqual(['TC-1', 'TC-2', 'TC-3']);
  });
  test('thực sự chỉ một trường hợp: cần singleCaseReason, không được bỏ qua âm thầm', () => {
    const ok = computeCoverage([mkReq(multi)], [mkDef('TC-1', { singleCaseReason: '"từng" chỉ nói phạm vi, chỉ có một kịch bản' })])[0];
    expect(ok.errors).toEqual([]);
    const blank = computeCoverage([mkReq(multi)], [mkDef('TC-1', { singleCaseReason: '  ' })])[0];
    expect(blank.errors).toHaveLength(1);
  });
  test('AC bình thường chỉ có 1 test case không bị báo lỗi', () => {
    expect(computeCoverage([mkReq('Thấy nút Duyệt.')], [mkDef('TC-1')])[0].errors).toEqual([]);
  });
});

test.describe('Nguyên văn requirement do công cụ bảo đảm (BETA-2)', () => {
  const tsx = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const importScript = path.join(process.cwd(), 'scripts', 'req-import.ts');
  const RAW = [
    '[NEW REQUIREMENT] Tiêu đề', 'Path / Đường dẫn màn hình (*)', 'Menu A → B.',
    '1. Business Requirement (*)', 'Yêu cầu x.', '2. Expected Solution (*)', 'Tạo hóa đQơn (%).',
    '3. Business Rules (*)', 'BR-01: Có khoảng trắng thừa .', 'BR-02: b',
    '4. Acceptance Criteria (*)', 'AC-01: c',
  ].join('\r\n') + '\r\n';

  function workspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-req-'));
    for (const d of ['tests/odoo-x', 'requirements/odoo-x', 'testcases/odoo-x', 'requirements/_inbox']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    return dir;
  }
  const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [tsx, importScript, ...args], { cwd, encoding: 'utf8' });

  test('nhập từ file: công cụ sao chép nguyên byte (kể cả CRLF, lỗi chính tả), khoá sha256 và tự đối chiếu', () => {
    const dir = workspace();
    try {
      const src = path.join(dir, 'ban-goc.md');
      fs.writeFileSync(src, RAW);
      const r = run(dir, 'odoo', 'x', src, '--id=REQ-T-001');
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const copy = fs.readFileSync(path.join(dir, 'requirements/odoo-x/REQ-T-001.source.md'));
      expect(sha256(copy)).toBe(sha256(Buffer.from(RAW)));
      expect(copy.equals(Buffer.from(RAW))).toBe(true);
      const lock = JSON.parse(fs.readFileSync(path.join(dir, 'requirements/odoo-x/REQ-T-001.lock'), 'utf8'));
      expect(lock.source.sha256).toBe(sha256(Buffer.from(RAW)));
      expect(lock.source.kind).toBe('file');
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'requirements/odoo-x/REQ-T-001.json'), 'utf8')) as Requirement;
      expect(json.expectedSolution).toBe('Tạo hóa đQơn (%).');
      expect(json.businessRules[0].text).toBe('Có khoảng trắng thừa .');
      expect(verifyRequirement('requirements/odoo-x/REQ-T-001.json', dir)).toMatchObject({ errors: [], sourceVerified: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--expect-sha256 sai thì từ chối và không ghi gì; văn bản dán được đánh dấu kind=paste kèm cảnh báo', () => {
    const dir = workspace();
    try {
      const inbox = path.join(dir, 'requirements/_inbox/dan.md');
      fs.writeFileSync(inbox, RAW);
      const bad = run(dir, 'odoo', 'x', inbox, '--id=REQ-T-002', `--expect-sha256=${'0'.repeat(64)}`);
      expect(bad.status).toBe(1);
      expect(fs.existsSync(path.join(dir, 'requirements/odoo-x/REQ-T-002.json'))).toBe(false);
      const ok = run(dir, 'odoo', 'x', inbox, '--id=REQ-T-002', `--expect-sha256=${sha256(Buffer.from(RAW))}`);
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/LƯU Ý \(văn bản dán\)/);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'requirements/odoo-x/REQ-T-002.lock'), 'utf8')).source.kind).toBe('paste');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('phát hiện sửa BR/AC, sửa bản nguồn, và bản nguồn bị mất (chỉ cảnh báo)', () => {
    const dir = workspace();
    try {
      const src = path.join(dir, 'g.md');
      fs.writeFileSync(src, RAW);
      expect(run(dir, 'odoo', 'x', src, '--id=REQ-T-003').status).toBe(0);
      const jsonPath = path.join(dir, 'requirements/odoo-x/REQ-T-003.json');
      const rel = 'requirements/odoo-x/REQ-T-003.json';
      const original = fs.readFileSync(jsonPath, 'utf8');

      // Claude "sửa chính tả" BR trong JSON
      const edited = JSON.parse(original) as Requirement;
      edited.businessRules[0].text = 'Có khoảng trắng thừa.';
      fs.writeFileSync(jsonPath, JSON.stringify(edited, null, 2));
      expect(verifyRequirement(rel, dir).errors.join('|')).toMatch(/KHÁC với bản đã khoá/);
      fs.writeFileSync(jsonPath, original);
      expect(verifyRequirement(rel, dir).errors).toEqual([]);

      // Sửa bản nguồn sau khi nhập
      const srcCopy = path.join(dir, 'requirements/odoo-x/REQ-T-003.source.md');
      fs.writeFileSync(srcCopy, RAW.replace('hóa đQơn', 'hóa đơn'));
      expect(verifyRequirement(rel, dir).errors.join('|')).toMatch(/KHÁC sha256/);

      // Bản nguồn không còn trên máy: cảnh báo, không lỗi (còn hash BR/AC)
      fs.rmSync(srcCopy);
      const gone = verifyRequirement(rel, dir);
      expect(gone.errors).toEqual([]);
      expect(gone.warnings.join('|')).toMatch(/Không còn bản nguồn/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('định dạng không đọc được thì từ chối, KHÔNG ghi file nào', () => {
    const dir = workspace();
    try {
      const src = path.join(dir, 'h.md');
      fs.writeFileSync(src, 'chỉ là một đoạn văn không có cấu trúc');
      expect(run(dir, 'odoo', 'x', src, '--id=REQ-T-004').status).toBe(1);
      expect(fs.readdirSync(path.join(dir, 'requirements/odoo-x'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('JSON, HTML và tổng kết đồng bộ (BETA-3)', () => {
  const defs = [mkDef('TC-1', { requirementRefs: ['BR-01'] }), mkDef('TC-2', { requirementRefs: ['AC-01'] }), mkDef('TC-3', { requirementRefs: ['AC-01'] })];
  const runs: RunFile[] = [{
    runId: '20261104-000001', startedAt: '2026-11-04T00:00:00Z', finishedAt: '2026-11-04T00:00:05Z',
    entries: [
      { tcId: 'TC-1', defHash: defHash(defs[0]), status: 'PASS', actual: 'ok', durationMs: 1, evidence: { screenshots: [] } },
      { tcId: 'TC-2', defHash: defHash(defs[1]), status: 'BLOCKED', actual: '', reason: 'thiếu tài khoản', durationMs: 1, evidence: { screenshots: [] } },
    ],
  }];
  const { results, summary } = aggregate(defs, runs);
  const req = mkReq('Thấy nút.');
  const html = renderHtml({ summary, results, glossary: {}, requirements: [req], runs: [], bugs: [] });
  const md = buildSummaryMarkdown(summary, results, [req]);
  const json = JSON.stringify({ summary, testCases: results });

  test('số liệu thật: 1 PASS, 1 BLOCKED, 1 NOT RUN; cả ba nơi cùng một con số', () => {
    expect(summary).toMatchObject({ total: 3, passed: 1, blocked: 1, notRun: 1, failed: 0, needsClarification: 0 });
    expect(compareReport(summary, defs.map((d) => d.id), json, html, md).errors).toEqual([]);
    expect(md).toMatch(/\| BLOCKED \| 1 \|/);
    expect(md).toContain('thiếu tài khoản');
  });
  test('phát hiện lệch ở HTML, ở tổng kết, ở JSON và báo cáo cũ hơn dữ liệu', () => {
    const ids = defs.map((d) => d.id);
    const badHtml = html.replace(/(data-filter="PASS"[\s\S]*?<b>)1(<\/b>)/, '$12$2');
    expect(compareReport(summary, ids, json, badHtml, md).errors.join('|')).toMatch(/HTML: thẻ PASS/);
    const badMd = md.replace('| PASS | 1 |', '| PASS | 3 |');
    expect(compareReport(summary, ids, json, html, badMd).errors.join('|')).toMatch(/qa-summary\.md: PASS/);
    const badJson = JSON.stringify({ summary: { ...summary, passed: 2 }, testCases: results });
    expect(compareReport(summary, ids, badJson, html, md).errors.join('|')).toMatch(/JSON\.passed/);
    // Dữ liệu thật đã đổi (thêm 1 PASS) nhưng báo cáo chưa dựng lại
    const fresh = aggregate(defs, [{ ...runs[0], entries: [...runs[0].entries, { tcId: 'TC-3', defHash: defHash(defs[2]), status: 'PASS', actual: 'ok', durationMs: 1, evidence: { screenshots: [] } }] }]).summary;
    expect(compareReport(fresh, ids, json, html, md).errors.join('|')).toMatch(/JSON\.passed = 1 nhưng tính lại/);
  });
});
