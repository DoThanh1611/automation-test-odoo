import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { accessOf, loadAutomation, metaProblems, validateAutomation, type AutomationFile } from '../../core/automation/meta';
import { loadTestCases } from '../../core/testcases/loader';
import { defHash } from '../../core/testcases/hash';

// Metadata thực thi (READ/WRITE, role, chiến lược dữ liệu, cleanup) tách khỏi nội dung test case đã duyệt.
const ok = { access: 'READ', dataStrategy: 'EXISTING_READONLY', cleanup: 'NONE' } as const;
const wr = { access: 'WRITE', dataStrategy: 'FACTORY', cleanup: 'REGISTRY' } as const;
const file = (tcs: AutomationFile['testCases']): AutomationFile[] => [{ requirementId: 'REQ-X', testCases: tcs }];

test.describe('AM-1 Metadata thực thi: mặc định chặn ghi', () => {
  test('chưa khai báo hoặc khai báo sai ⇒ coi là GHI; chỉ khai báo hợp lệ mới cho READ', () => {
    expect(accessOf('TC-1', [])).toMatchObject({ access: 'WRITE', declared: false });
    expect(accessOf('TC-1', file({ 'TC-1': ok }))).toMatchObject({ access: 'READ', declared: true });
    expect(accessOf('TC-1', file({ 'TC-1': wr }))).toMatchObject({ access: 'WRITE', declared: true });
    for (const bad of [
      { access: 'READ', dataStrategy: 'FACTORY', cleanup: 'NONE' }, // READ nhưng tạo dữ liệu
      { access: 'READ', dataStrategy: 'NONE', cleanup: 'REGISTRY' }, // READ nhưng có cleanup
      { access: 'read', dataStrategy: 'NONE', cleanup: 'NONE' }, // sai giá trị
      { access: 'READ' }, // thiếu trường
    ]) {
      const d = accessOf('TC-1', file({ 'TC-1': bad as never }));
      expect(d.access, JSON.stringify(bad)).toBe('WRITE');
      expect(d.declared).toBe(false);
      expect(d.problems.length).toBeGreaterThan(0);
    }
  });

  test('test WRITE bắt buộc nêu chiến lược dữ liệu và cleanup', () => {
    expect(metaProblems({ access: 'WRITE', dataStrategy: 'NONE', cleanup: 'REGISTRY' }).join()).toMatch(/dataStrategy/);
    expect(metaProblems({ access: 'WRITE', dataStrategy: 'FACTORY', cleanup: 'NONE' }).join()).toMatch(/cleanup/);
    expect(metaProblems({ access: 'WRITE', role: 'accountant', dataStrategy: 'EXISTING_WRITE', cleanup: 'MANUAL' })).toEqual([]);
  });

  test('loadAutomation: file hỏng không làm sập, chỉ báo lỗi (test case thuộc file đó về mặc định GHI)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-am-'));
    try {
      fs.mkdirSync(path.join(dir, 'automation', 'odoo-sales'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'automation', 'odoo-sales', 'REQ-BAD.automation.json'), '{ không phải json');
      fs.writeFileSync(path.join(dir, 'automation', 'odoo-sales', 'REQ-X.automation.json'), JSON.stringify({ requirementId: 'REQ-X', testCases: { 'TC-1': ok } }));
      const r = loadAutomation(dir);
      expect(r.files).toHaveLength(1);
      expect(r.problems).toHaveLength(1);
      expect(accessOf('TC-BAD', r.files).access).toBe('WRITE');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validateAutomation: bắt test case không tồn tại và khai báo sai requirement', () => {
    const defs = [{ id: 'TC-1', requirementId: 'REQ-X' }, { id: 'TC-2', requirementId: 'REQ-Y' }] as never[];
    const errs = validateAutomation(file({ 'TC-1': ok, 'TC-2': ok, 'TC-9': ok }), defs);
    expect(errs.join('\n')).toMatch(/TC-9: test case không tồn tại/);
    expect(errs.join('\n')).toMatch(/TC-2: thuộc requirement REQ-Y/);
    expect(errs).toHaveLength(2);
  });
});

test.describe('AM-2 Tách khỏi nội dung đã duyệt', () => {
  test('metadata không nằm trong testcases/ nên không ảnh hưởng hash nội dung và phê duyệt', () => {
    const defs = loadTestCases();
    test.skip(!defs.length, 'repo mẫu không có test case');
    const before = defs.map(defHash);
    expect(fs.existsSync('automation') ? fs.readdirSync('automation').length : 0).toBeGreaterThanOrEqual(0);
    // loadTestCases chỉ đọc testcases/: file automation/*.automation.json không bao giờ lẫn vào định nghĩa test case.
    expect(defs.every((d) => !('access' in d) && !('dataStrategy' in d))).toBe(true);
    expect(loadTestCases().map(defHash)).toEqual(before);
  });

  test('metadata của repo hợp lệ và đồng bộ với test case; test gọi writeGuard/factory phải khai báo WRITE, test READ không được gọi', () => {
    const { files, problems } = loadAutomation();
    expect(problems).toEqual([]);
    test.skip(!files.length, 'repo mẫu không có metadata nghiệp vụ');
    expect(validateAutomation(files, loadTestCases())).toEqual([]);

    // Quét tĩnh các spec: mỗi test(...tcMeta('TC-X')...) và thân của nó.
    const dir = path.join('tests');
    const specs: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? (e.name === 'framework' || e.name === 'setup' ? undefined : walk(path.join(d, e.name))) : e.name.endsWith('.spec.ts') ? specs.push(path.join(d, e.name)) : undefined));
    walk(dir);
    const violations: string[] = [];
    for (const f of specs) {
      const src = fs.readFileSync(f, 'utf8');
      const parts = src.split(/\n\s*test\(title\(/).slice(1);
      for (const body of parts) {
        const id = /tcMeta\('([^']+)'\)/.exec(body)?.[1];
        if (!id) continue;
        const writes = /\bwriteGuard\(\)|\bfactory\.(build|create|update|set)/.test(body.split(/\n\s*test\(title\(/)[0]);
        const d = accessOf(id, files);
        if (!d.declared) violations.push(`${id}: có automation nhưng chưa khai báo metadata thực thi`);
        else if (writes && d.access !== 'WRITE') violations.push(`${id}: gọi thao tác ghi nhưng khai báo READ`);
      }
    }
    expect(violations).toEqual([]);
  });
});
