import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requirementHash } from '../testcases/lock';
import type { Requirement, TestCaseDef } from '../testcases/schema';
import { renderReviewIndex, renderTestCasesMarkdown } from './render';

/**
 * Approval Gate: bộ test case của MỘT requirement (mọi module) phải được người dùng duyệt trước khi kết nối staging,
 * khám phá UI, viết automation hay chạy test. Trạng thái nằm ở approvals/<REQ-ID>.json, bản chụp từng phiên bản ở approvals/<REQ-ID>/v<N>/.
 *
 * - Phê duyệt gắn với (phiên bản, hash nội dung test case). Sửa test case sau khi duyệt => hash đổi => phê duyệt tự mất hiệu lực.
 * - Bản ghi phê duyệt có chữ ký HMAC bằng khoá nằm NGOÀI dự án (thư mục người dùng), nên sửa tay file JSON không tạo được phê duyệt hợp lệ.
 * - REVISE/REJECT không xoá gì: mọi phiên bản cũ và lịch sử được giữ nguyên.
 */
export const APPROVAL_BLOCK_PREFIX = 'Chưa được phê duyệt';

export type ApprovalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'INVALIDATED' | 'REVISION_REQUESTED' | 'REJECTED';
export type ApprovalAction = 'SUBMIT' | 'APPROVE' | 'REVISE' | 'REJECT' | 'INVALIDATE';

export interface ApprovalEvent {
  at: string;
  action: ApprovalAction;
  by: string;
  version: number;
  hash: string;
  testCaseCount: number;
  comment?: string;
  channel?: string;
}

export interface ApprovalRecord {
  requirementId: string;
  status: ApprovalStatus;
  /** Phiên bản đang chờ/đã xét gần nhất. */
  version: number;
  /** Hash bộ test case của phiên bản `version`. */
  hash: string;
  approval?: { version: number; hash: string; by: string; at: string; channel: string; signature: string };
  history: ApprovalEvent[];
}

export type ApprovalState =
  | 'NOT_SUBMITTED'
  | 'PENDING_APPROVAL'
  | 'PENDING_STALE'
  | 'APPROVED'
  | 'INVALIDATED'
  | 'SIGNATURE_INVALID'
  | 'KEY_MISSING'
  | 'REVISION_REQUESTED'
  | 'REJECTED';

export interface Evaluation {
  state: ApprovalState;
  /** true chỉ khi phê duyệt hợp lệ với ĐÚNG bộ test case hiện tại. */
  ok: boolean;
  reason: string;
  currentHash: string;
  record?: ApprovalRecord;
}

/** Hash nội dung kiểm thử của cả bộ test case + khoá requirement. Không gồm `automated` (đổi khi viết script sau duyệt) và glossary. */
export function testSetHash(defs: TestCaseDef[], requirement: Requirement): string {
  const canon = [...defs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => ({
      id: d.id, title: d.title, requirementRefs: d.requirementRefs, description: d.description, preconditions: d.preconditions,
      testData: d.testData, steps: d.steps, expectedResult: d.expectedResult, verification: d.verification,
      needsClarification: d.needsClarification ?? null, singleCaseReason: d.singleCaseReason ?? null, application: d.application ?? null, module: d.module ?? null,
    }));
  return crypto.createHash('sha256').update(JSON.stringify({ requirement: requirementHash(requirement), testCases: canon })).digest('hex');
}

export const approvalsDir = (root: string) => path.join(root, 'approvals');
export const recordFile = (root: string, reqId: string) => path.join(approvalsDir(root), `${reqId}.json`);
export const versionDir = (root: string, reqId: string, version: number) => path.join(approvalsDir(root), reqId, `v${version}`);

export function readRecord(root: string, reqId: string): ApprovalRecord | undefined {
  const f = recordFile(root, reqId);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) as ApprovalRecord) : undefined;
}
function writeRecord(root: string, rec: ApprovalRecord) {
  fs.mkdirSync(approvalsDir(root), { recursive: true });
  fs.writeFileSync(recordFile(root, rec.requirementId), JSON.stringify(rec, null, 2) + '\n');
}

// ---- Chữ ký (khoá nằm ngoài dự án) ----
export const keyFile = () => process.env.QA_APPROVAL_KEY_FILE || path.join(os.homedir(), '.qa-framework', 'approval.key');
function getKey(create: boolean): Buffer | undefined {
  const f = keyFile();
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  if (!create) return undefined;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  return k;
}
const sign = (key: Buffer, reqId: string, a: { version: number; hash: string; by: string; at: string }) =>
  crypto.createHmac('sha256', key).update(`${reqId}|${a.version}|${a.hash}|${a.by}|${a.at}`).digest('hex');

/** Ký/xác minh văn bản bằng cùng khoá ngoài dự án (dùng cho xác nhận môi trường). undefined = không có khoá trên máy này. */
export function signText(text: string, create = false): string | undefined {
  const key = getKey(create);
  return key ? crypto.createHmac('sha256', key).update(text).digest('hex') : undefined;
}
export function verifyText(text: string, signature: string | undefined): boolean {
  const expected = signText(text, false);
  return Boolean(expected && signature && expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)));
}

// ---- Đánh giá ----
export function evaluate(root: string, requirement: Requirement, defs: TestCaseDef[]): Evaluation {
  const currentHash = testSetHash(defs, requirement);
  const record = readRecord(root, requirement.id);
  const base = { currentHash, record };
  if (!record) return { ...base, state: 'NOT_SUBMITTED', ok: false, reason: 'Bộ test case chưa được trình duyệt (chưa có approvals/<REQ-ID>.json).' };
  switch (record.status) {
    case 'PENDING_APPROVAL':
      return record.hash === currentHash
        ? { ...base, state: 'PENDING_APPROVAL', ok: false, reason: `Đang chờ phê duyệt phiên bản v${record.version}.` }
        : { ...base, state: 'PENDING_STALE', ok: false, reason: `Test case đã thay đổi sau khi trình duyệt v${record.version}; cần trình duyệt lại (submit).` };
    case 'REVISION_REQUESTED':
      return { ...base, state: 'REVISION_REQUESTED', ok: false, reason: 'Người duyệt yêu cầu chỉnh sửa; cần sửa rồi trình duyệt lại.' };
    case 'REJECTED':
      return { ...base, state: 'REJECTED', ok: false, reason: 'Bộ test case đã bị từ chối; không được thực thi.' };
    case 'INVALIDATED':
      return { ...base, state: 'INVALIDATED', ok: false, reason: 'Phê duyệt đã bị hủy vì test case thay đổi sau khi duyệt; cần duyệt lại.' };
    case 'APPROVED': {
      const a = record.approval;
      if (!a) return { ...base, state: 'SIGNATURE_INVALID', ok: false, reason: 'Bản ghi APPROVED thiếu thông tin phê duyệt.' };
      const key = getKey(false);
      if (!key) return { ...base, state: 'KEY_MISSING', ok: false, reason: `Không có khoá xác thực phê duyệt trên máy này (${keyFile()}); không xác minh được chữ ký. Cần duyệt lại trên máy này.` };
      if (sign(key, record.requirementId, a) !== a.signature) return { ...base, state: 'SIGNATURE_INVALID', ok: false, reason: 'Chữ ký phê duyệt không hợp lệ (bản ghi bị sửa tay hoặc không phải do người duyệt tạo).' };
      if (a.hash !== currentHash) return { ...base, state: 'INVALIDATED', ok: false, reason: `Test case đã thay đổi sau khi duyệt v${a.version}; phê duyệt không còn hiệu lực.` };
      return { ...base, state: 'APPROVED', ok: true, reason: `Đã duyệt v${a.version} bởi ${a.by} lúc ${a.at}.` };
    }
  }
}

/** Như evaluate nhưng GHI NHẬN việc tự động hủy phê duyệt (lịch sử INVALIDATE) khi test case đã đổi sau khi duyệt. */
export function evaluateAndSync(root: string, requirement: Requirement, defs: TestCaseDef[]): Evaluation {
  const ev = evaluate(root, requirement, defs);
  const rec = ev.record;
  if (rec && rec.status === 'APPROVED' && ev.state === 'INVALIDATED') {
    rec.status = 'INVALIDATED';
    rec.history.push({ at: new Date().toISOString(), action: 'INVALIDATE', by: 'system', version: rec.approval?.version ?? rec.version, hash: ev.currentHash, testCaseCount: defs.length, comment: `Test case đổi sau khi duyệt (hash đã duyệt ${rec.approval?.hash.slice(0, 12)}, hash hiện tại ${ev.currentHash.slice(0, 12)}).` });
    writeRecord(root, rec);
    return { ...ev, record: rec };
  }
  return ev;
}

// ---- Hành động ----
export interface SubmitResult {
  record: ApprovalRecord;
  /** false = giữ nguyên phiên bản đang chờ/đã duyệt (gọi lại lệnh không tạo phiên bản trùng). */
  created: boolean;
  files: string[];
}

export function submit(root: string, requirement: Requirement, defs: TestCaseDef[], by = 'claude'): SubmitResult {
  if (!defs.length) throw new Error('Chưa có test case nào để trình duyệt.');
  const hash = testSetHash(defs, requirement);
  let rec = readRecord(root, requirement.id);
  const filesOf = (v: number) => (fs.existsSync(versionDir(root, requirement.id, v)) ? fs.readdirSync(versionDir(root, requirement.id, v)).map((f) => path.join(versionDir(root, requirement.id, v), f)) : []);

  if (rec && rec.hash === hash) {
    if (rec.status === 'PENDING_APPROVAL' || rec.status === 'APPROVED') return { record: rec, created: false, files: filesOf(rec.version) };
    if (rec.status === 'REJECTED') throw new Error(`Phiên bản v${rec.version} đã bị từ chối. Chỉ trình duyệt lại sau khi test case thay đổi (hoặc người dùng yêu cầu).`);
    if (rec.status === 'REVISION_REQUESTED') throw new Error(`Người duyệt yêu cầu chỉnh sửa v${rec.version} nhưng test case chưa thay đổi. Sửa test case theo nhận xét rồi trình duyệt lại.`);
  }
  const now = new Date().toISOString();
  if (rec && rec.status === 'APPROVED') {
    rec.history.push({ at: now, action: 'INVALIDATE', by: 'system', version: rec.approval?.version ?? rec.version, hash, testCaseCount: defs.length, comment: 'Test case đổi sau khi duyệt; hủy phê duyệt để duyệt lại.' });
  }
  const version = (rec?.version ?? 0) + 1;
  rec = {
    requirementId: requirement.id, status: 'PENDING_APPROVAL', version, hash,
    approval: undefined,
    history: [...(rec?.history ?? []), { at: now, action: 'SUBMIT', by, version, hash, testCaseCount: defs.length }],
  };
  const dir = versionDir(root, requirement.id, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'testcases.snapshot.json'), JSON.stringify({ requirementId: requirement.id, version, hash, createdAt: now, testCases: defs }, null, 2) + '\n');
  const modules = [...new Set(defs.map((d) => `${d.application ?? '-'}-${d.module ?? '-'}`))].sort();
  const files: string[] = [];
  for (const key of modules) {
    const mine = defs.filter((d) => `${d.application ?? '-'}-${d.module ?? '-'}` === key).sort((a, b) => a.id.localeCompare(b.id));
    const f = path.join(dir, `${key}.testcases.md`);
    fs.writeFileSync(f, renderTestCasesMarkdown(requirement, key, mine, { version, hash, status: 'PENDING_APPROVAL' }));
    files.push(f);
  }
  const index = path.join(dir, 'REVIEW.md');
  fs.writeFileSync(index, renderReviewIndex(requirement, defs, modules, { version, hash }));
  files.unshift(index);
  writeRecord(root, rec);
  return { record: rec, created: true, files: [...files, path.join(dir, 'testcases.snapshot.json')] };
}

export interface ApproveInput { version: number; hash: string; by: string; channel?: string }

export function approve(root: string, requirement: Requirement, defs: TestCaseDef[], input: ApproveInput): ApprovalRecord {
  const rec = readRecord(root, requirement.id);
  if (!rec) throw new Error('Chưa trình duyệt (submit) nên không thể APPROVE.');
  if (rec.status !== 'PENDING_APPROVAL') throw new Error(`Trạng thái hiện tại là ${rec.status}, chỉ APPROVE được khi PENDING_APPROVAL.`);
  if (!input.by.trim()) throw new Error('Phải ghi tên người duyệt.');
  if (input.version !== rec.version) throw new Error(`APPROVE v${input.version} nhưng phiên bản đang chờ là v${rec.version}.`);
  if (input.hash !== rec.hash) throw new Error('Hash APPROVE không khớp phiên bản đang chờ duyệt.');
  const current = testSetHash(defs, requirement);
  if (current !== rec.hash) throw new Error('Test case đã thay đổi sau khi trình duyệt; phải submit lại để duyệt phiên bản mới.');
  const key = getKey(true)!;
  const at = new Date().toISOString();
  const approval = { version: rec.version, hash: rec.hash, by: input.by.trim(), at, channel: input.channel ?? 'interactive' };
  rec.approval = { ...approval, signature: sign(key, rec.requirementId, approval) };
  rec.status = 'APPROVED';
  rec.history.push({ at, action: 'APPROVE', by: approval.by, version: rec.version, hash: rec.hash, testCaseCount: defs.length, channel: approval.channel });
  writeRecord(root, rec);
  return rec;
}

function restrict(root: string, requirementId: string, action: 'REVISE' | 'REJECT', by: string, comment: string, channel: string): ApprovalRecord {
  const rec = readRecord(root, requirementId);
  if (!rec) throw new Error('Chưa trình duyệt nên không có gì để ' + action + '.');
  if (rec.status !== 'PENDING_APPROVAL' && rec.status !== 'APPROVED') throw new Error(`Trạng thái hiện tại là ${rec.status}; ${action} chỉ áp dụng khi PENDING_APPROVAL hoặc APPROVED.`);
  if (!by.trim()) throw new Error('Phải ghi tên người thực hiện.');
  if (!comment.trim()) throw new Error(`${action} phải kèm nhận xét/lý do.`);
  const at = new Date().toISOString();
  rec.status = action === 'REVISE' ? 'REVISION_REQUESTED' : 'REJECTED';
  rec.approval = undefined;
  rec.history.push({ at, action, by: by.trim(), version: rec.version, hash: rec.hash, testCaseCount: 0, comment: comment.trim(), channel });
  writeRecord(root, rec);
  return rec;
}
export const revise = (root: string, requirementId: string, by: string, comment: string, channel = 'interactive') => restrict(root, requirementId, 'REVISE', by, comment, channel);
export const reject = (root: string, requirementId: string, by: string, comment: string, channel = 'interactive') => restrict(root, requirementId, 'REJECT', by, comment, channel);

export function listRecords(root: string): ApprovalRecord[] {
  const dir = approvalsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ApprovalRecord);
}
