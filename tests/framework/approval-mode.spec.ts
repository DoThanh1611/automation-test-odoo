import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { validateEnvironmentsFile, type EnvironmentsFile, type ResolvedEnvironment } from '../../core/environment/config';
import { approvalMode, confirmationProblem, readState } from '../../core/environment/state';
import { effectivePolicy, policyCheck } from '../../core/policy/policy';

// Chế độ "APPROVE là xác nhận duy nhất" (environments/<app>.json: confirmation = approval). Dữ liệu giả, thư mục tạm.

const role = { userVar: 'X_USER', passVar: 'X_PASS' };
const def = (kind: string, label: string) => ({ label, kind, urlVar: 'X_URL', expectedVersionVar: 'X_VER', roles: { accountant: role }, policy: { write: 'framework-data' } });
const file = (over: Partial<EnvironmentsFile> = {}): EnvironmentsFile => ({
  application: 'odoo',
  confirmation: 'approval',
  defaultEnvironment: 'ENV_A',
  environments: { ENV_A: def('staging', 'Staging A'), PROD_X: def('production', 'Thật') } as never,
  ...over,
});
const envOf = (over: Partial<ResolvedEnvironment> = {}): ResolvedEnvironment => ({
  application: 'odoo', key: 'ENV_A', label: 'Staging A', kind: 'staging', baseUrl: 'https://a.example.com', origin: 'https://a.example.com', host: 'a.example.com', roles: {},
  policy: { write: 'framework-data', autoCleanup: true }, ...over,
});

let dir: string;
let prev: string | undefined;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-am-env-'));
  prev = process.env.QA_ENVIRONMENTS_DIR;
  process.env.QA_ENVIRONMENTS_DIR = path.join(dir, 'environments');
  fs.mkdirSync(process.env.QA_ENVIRONMENTS_DIR, { recursive: true });
});
test.afterEach(() => {
  if (prev === undefined) delete process.env.QA_ENVIRONMENTS_DIR;
  else process.env.QA_ENVIRONMENTS_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});
const write = (f: EnvironmentsFile) => fs.writeFileSync(path.join(process.env.QA_ENVIRONMENTS_DIR!, 'odoo.json'), JSON.stringify(f));

test.describe('AP-1 APPROVE là xác nhận duy nhất của người dùng', () => {
  test('chế độ approval: phê duyệt hợp lệ thay cho xác nhận môi trường và chính sách ghi (staging)', () => {
    write(file());
    expect(approvalMode('odoo')).toEqual({ defaultEnvironment: 'ENV_A' });
    expect(confirmationProblem(dir, envOf(), 'REQ-1', 'hash-da-duyet')).toBeUndefined();
    const c = policyCheck(dir, envOf(), 'REQ-1', 'hash-da-duyet');
    expect(c.ok).toBe(true);
    expect(c.confirmation?.by).toBe('APPROVE test case');
    // Môi trường mặc định được dùng khi chưa ai chọn; không ghi gì ra đĩa.
    expect(readState(dir).selected).toMatchObject({ environment: 'ENV_A', application: 'odoo' });
    expect(fs.existsSync(path.join(dir, '.qa-state'))).toBe(false);
  });

  test('chưa có phê duyệt hợp lệ (hash rỗng) thì vẫn bị chặn', () => {
    write(file());
    expect(confirmationProblem(dir, envOf(), 'REQ-1', '')).toMatch(/chưa được xác nhận/);
    expect(policyCheck(dir, envOf(), 'REQ-1', '').ok).toBe(false);
  });

  test('production KHÔNG BAO GIỜ được suy ra: vẫn cần xác nhận riêng và quyền ghi luôn là none', () => {
    write(file());
    const prod = envOf({ key: 'PROD_X', label: 'Thật', kind: 'production', host: 'erp.example.com', policy: { write: 'framework-data', autoCleanup: true } });
    expect(confirmationProblem(dir, prod, 'REQ-1', 'hash-da-duyet')).toMatch(/chưa được xác nhận/);
    const c = policyCheck(dir, prod, 'REQ-1', 'hash-da-duyet');
    expect(c.ok).toBe(false);
    expect(effectivePolicy(prod).write).toBe('none');
  });

  test('môi trường chỉ đọc (policy none) vẫn không được ghi dù ở chế độ approval', () => {
    write(file());
    const ro = envOf({ policy: { write: 'none', autoCleanup: false } });
    expect(policyCheck(dir, ro, 'REQ-1', 'hash-da-duyet').ok).toBe(false);
  });

  test('chế độ mặc định (explicit) giữ nguyên: vẫn cần xác nhận riêng, không có môi trường mặc định', () => {
    write(file({ confirmation: 'explicit', defaultEnvironment: undefined }));
    expect(approvalMode('odoo')).toBeUndefined();
    expect(confirmationProblem(dir, envOf(), 'REQ-1', 'hash-da-duyet')).toMatch(/chưa được xác nhận/);
    expect(policyCheck(dir, envOf(), 'REQ-1', 'hash-da-duyet').ok).toBe(false);
    expect(readState(dir).selected).toBeUndefined();
  });

  test('cấu hình approval thiếu môi trường mặc định hợp lệ bị báo lỗi và không có hiệu lực', () => {
    const bad = file({ defaultEnvironment: 'KHONG_CO' });
    expect(validateEnvironmentsFile(bad).join()).toMatch(/defaultEnvironment/);
    write(bad);
    expect(approvalMode('odoo')).toBeUndefined();
    expect(validateEnvironmentsFile(file({ confirmation: 'x' as never })).join()).toMatch(/confirmation/);
  });
});
