import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approve, submit } from '../../../core/approval/approval';
import { beginExecution } from '../../../core/approval/gate';
import { writeLock } from '../../../core/testcases/lock';
import type { Requirement, TestCaseDef } from '../../../core/testcases/schema';

/** Thư mục làm việc tạm đã có requirement + test case được APPROVE và phiên thực thi mở (toàn dữ liệu giả). */
export const wsReq: Requirement = {
  id: 'REQ-E-001', title: 'Requirement thử nhiều môi trường', application: 'odoo', module: 'sales', businessRequirement: 'b',
  businessRules: [{ id: 'BR-01', text: 'a' }], acceptanceCriteria: [{ id: 'AC-01', text: 'c' }],
};

export const wsDefs = (): TestCaseDef[] =>
  ['TC-E-001', 'TC-E-002'].map((id) => ({
    id, title: `Tiêu đề ${id}`, requirementRefs: ['BR-01', 'AC-01'], description: 'mô tả', preconditions: ['điều kiện'], testData: { k: 1 }, steps: ['bước 1', 'bước 2'],
    expectedResult: `kết quả ${id}`, verification: 'UI', automated: false, requirementId: wsReq.id, application: 'odoo', module: 'sales',
  }));

export function makeApprovedWorkspace() {
  return makeWorkspace('approved');
}

/** Thư mục làm việc tạm: 'pending' = đã trình duyệt (chờ duyệt); 'approved' = đã APPROVE + mở phiên thực thi. */
export function makeWorkspace(stage: 'pending' | 'approved') {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-env-ws-'));
  fs.mkdirSync(path.join(ws, 'requirements', 'odoo-sales'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'testcases', 'odoo-sales'), { recursive: true });
  const reqFile = path.join(ws, 'requirements', 'odoo-sales', `${wsReq.id}.json`);
  fs.writeFileSync(reqFile, JSON.stringify(wsReq));
  writeLock(reqFile);
  const defs = wsDefs();
  fs.writeFileSync(path.join(ws, 'testcases', 'odoo-sales', `${wsReq.id}.testcases.json`), JSON.stringify({ requirementId: wsReq.id, testCases: defs.map(({ requirementId, application, module, ...d }) => d) }));
  const keyFile = path.join(ws, 'k.key');
  const prev = process.env.QA_APPROVAL_KEY_FILE;
  process.env.QA_APPROVAL_KEY_FILE = keyFile;
  let hash = '';
  try {
    const s = submit(ws, wsReq, defs);
    if (stage === 'approved') {
      approve(ws, wsReq, defs, { version: 1, hash: s.record.hash, by: 'A' });
      beginExecution(ws, wsReq, defs);
    }
    hash = s.record.hash;
  } finally {
    if (prev === undefined) delete process.env.QA_APPROVAL_KEY_FILE;
    else process.env.QA_APPROVAL_KEY_FILE = prev;
  }
  return { ws, keyFile, hash, req: wsReq, defs, env: { ...process.env, QA_APPROVAL_KEY_FILE: keyFile, CLAUDE_PROJECT_DIR: ws } as NodeJS.ProcessEnv };
}
