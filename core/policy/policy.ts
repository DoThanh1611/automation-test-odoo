import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signText, verifyText } from '../approval/approval';
import { loadEnvironmentsFile, type ResolvedEnvironment } from '../environment/config';

/**
 * Chính sách quyền thao tác theo MÔI TRƯỜNG. Mục tiêu: staging là môi trường chuyên dụng cho kiểm thử, nên sau khi người dùng xác nhận
 * MỘT LẦN chính sách của môi trường (cho một phiên chạy), framework được tự động tạo, sửa và cleanup DỮ LIỆU DO CHÍNH NÓ TẠO
 * (nằm trong registry) mà không hỏi từng thao tác. Phạm vi KHÔNG bao giờ mở rộng tới dữ liệu nghiệp vụ có sẵn.
 *
 * Ba tầng độc lập (không tầng nào suy ra tầng kia): (1) phê duyệt test case, (2) xác nhận môi trường thực thi, (3) xác nhận chính sách ghi này.
 * Production luôn bị ép 'none' ở MỌI điểm kiểm tra, kể cả khi cấu hình sai (xem productionReason).
 */
export type WriteScope = 'none' | 'framework-data';

export interface EffectivePolicy {
  write: WriteScope;
  autoCleanup: boolean;
  failureRetentionHours: number;
  maxRecordsPerRun: number;
  /** Băm nội dung chính sách + môi trường + host: đổi bất kỳ thứ gì thì xác nhận cũ mất hiệu lực. */
  hash: string;
  /** Lý do chính sách bị hạ xuống (ví dụ production). */
  reasons: string[];
}

export const DEFAULT_RETENTION_HOURS = 48;
export const DEFAULT_MAX_RECORDS = 200;
export const SESSION_MS = 8 * 3600 * 1000;

const PRODUCTION_WORD = /(^|[^a-z0-9])(prod|production|live)([^a-z0-9]|$)/i;

/**
 * Lý do coi môi trường là production (undefined = không có dấu hiệu). Kiểm tra CẢ ba nguồn để cấu hình sai (gõ nhầm kind) vẫn bị chặn:
 * loại khai báo, tên/khoá môi trường, host; cộng danh sách cấm tự khai QA_PRODUCTION_HOSTS (phân tách bằng dấu phẩy, trong .env).
 */
export function productionReason(env: Pick<ResolvedEnvironment, 'key' | 'host' | 'kind' | 'label'>, source: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.kind === 'production') return 'môi trường được khai báo kind=production';
  if (PRODUCTION_WORD.test(env.key)) return `tên môi trường "${env.key}" có dấu hiệu production`;
  if (PRODUCTION_WORD.test(env.host)) return 'host có dấu hiệu production';
  if (PRODUCTION_WORD.test(env.label ?? '')) return 'nhãn môi trường có dấu hiệu production';
  const deny = (source.QA_PRODUCTION_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (deny.includes(env.host.toLowerCase())) return 'host nằm trong QA_PRODUCTION_HOSTS';
  return undefined;
}

export function effectivePolicy(env: Pick<ResolvedEnvironment, 'key' | 'host' | 'kind' | 'label' | 'policy'>, source: NodeJS.ProcessEnv = process.env): EffectivePolicy {
  const decl = env.policy ?? {};
  const reasons: string[] = [];
  let write: WriteScope = decl.write === 'framework-data' ? 'framework-data' : 'none';
  const prod = productionReason(env, source);
  if (prod) {
    if (write !== 'none') reasons.push(`Production không cho phép quyền ghi tự động (${prod}): ép về none.`);
    write = 'none';
  }
  if (!decl.write || decl.write === 'none') reasons.push('Môi trường chưa khai báo quyền ghi (policy.write) nên chỉ đọc.');
  let autoCleanup = write !== 'none' && decl.autoCleanup === true;
  if (autoCleanup && (source.AUTO_CLEANUP ?? '').toLowerCase() === 'false') {
    autoCleanup = false;
    reasons.push('AUTO_CLEANUP=false trong .env: tắt cleanup tự động (không bao giờ bật được từ .env).');
  }
  const retention = decl.failureRetentionHours ?? DEFAULT_RETENTION_HOURS;
  const max = decl.maxRecordsPerRun ?? DEFAULT_MAX_RECORDS;
  const core = { env: env.key, host: env.host, write, autoCleanup, retention, max };
  return {
    write, autoCleanup, failureRetentionHours: retention, maxRecordsPerRun: max, reasons,
    hash: crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex'),
  };
}

// ---- Xác nhận chính sách (một lần cho môi trường + phiên chạy) ----
export interface PolicyConfirmation {
  environment: string;
  application: string;
  host: string;
  requirementId: string;
  approvalHash: string;
  policyHash: string;
  sessionId: string;
  by: string;
  at: string;
  expiresAt: string;
  signature: string;
}

interface PolicyState {
  confirmations: Record<string, PolicyConfirmation>;
}

export const policyFile = (root: string) => path.join(root, '.qa-state', 'policy.json');
const ckey = (env: string, req: string) => `${env}|${req}`;
const payload = (c: Omit<PolicyConfirmation, 'signature'>) => ['policy', c.environment, c.application, c.host, c.requirementId, c.approvalHash, c.policyHash, c.sessionId, c.by, c.at, c.expiresAt].join('|');

function readState(root: string): PolicyState {
  try {
    const s = JSON.parse(fs.readFileSync(policyFile(root), 'utf8')) as PolicyState;
    return { confirmations: s.confirmations ?? {} };
  } catch {
    return { confirmations: {} };
  }
}

function writeState(root: string, s: PolicyState) {
  fs.mkdirSync(path.dirname(policyFile(root)), { recursive: true });
  fs.writeFileSync(policyFile(root), JSON.stringify(s, null, 2) + '\n');
}

export const policyPhrase = (env: Pick<ResolvedEnvironment, 'key' | 'host'>, policy: Pick<EffectivePolicy, 'hash'>) => `ALLOW-WRITE ${env.key} ${env.host} ${policy.hash.slice(0, 12)}`;

export function describePolicy(env: Pick<ResolvedEnvironment, 'key' | 'host'>, p: EffectivePolicy): string[] {
  return [
    `Môi trường ${env.key} (${env.host})`,
    `- Được TỰ ĐỘNG tạo, sửa và cleanup dữ liệu DO FRAMEWORK TẠO (có trong registry, gắn Environment/Run/Requirement/Test Case ID), tối đa ${p.maxRecordsPerRun} bản ghi mỗi lần chạy.`,
    '- KHÔNG đụng dữ liệu nghiệp vụ có sẵn, không xoá cứng, không cleanup chứng từ bị ràng buộc kế toán (đối soát, khoá sổ, đã hoá đơn/giao hàng...).',
    `- Cleanup tự động sau khi đã có QA Report + Bug Report + evidence: ${p.autoCleanup ? 'BẬT' : 'TẮT'}. Test FAIL: giữ dữ liệu ${p.failureRetentionHours} giờ để điều tra.`,
    `- Hiệu lực ${SESSION_MS / 3600000} giờ hoặc tới khi thu hồi/đổi chính sách/đổi phê duyệt/đổi host.`,
  ];
}

export interface ConfirmPolicyInput {
  env: ResolvedEnvironment;
  requirementId: string;
  approvalHash: string;
  by: string;
  /** Cụm người dùng đã gõ. */
  typed: string;
  now?: number;
}

/** Ghi xác nhận chính sách. Từ chối: production/không khai báo ghi, cụm không khớp, thiếu tên. */
export function confirmPolicy(root: string, i: ConfirmPolicyInput, source: NodeJS.ProcessEnv = process.env): PolicyConfirmation {
  const eff = effectivePolicy(i.env, source);
  if (eff.write === 'none') throw new Error(`Môi trường ${i.env.key} không được cấp quyền ghi tự động: ${eff.reasons.join(' ')}`);
  if (i.typed !== policyPhrase(i.env, eff)) throw new Error('Cụm xác nhận chính sách không khớp.');
  if (!i.by.trim()) throw new Error('Phải ghi tên người xác nhận.');
  const now = i.now ?? Date.now();
  const base = {
    environment: i.env.key, application: i.env.application, host: i.env.host, requirementId: i.requirementId, approvalHash: i.approvalHash,
    policyHash: eff.hash, sessionId: crypto.randomBytes(8).toString('hex'), by: i.by.trim(), at: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_MS).toISOString(),
  };
  const conf: PolicyConfirmation = { ...base, signature: signText(payload(base), true)! };
  const s = readState(root);
  s.confirmations[ckey(i.env.key, i.requirementId)] = conf;
  writeState(root, s);
  return conf;
}

export function revokePolicy(root: string, envKey: string, requirementId?: string) {
  const s = readState(root);
  for (const k of Object.keys(s.confirmations)) {
    const c = s.confirmations[k];
    if (c.environment === envKey && (!requirementId || c.requirementId === requirementId)) delete s.confirmations[k];
  }
  writeState(root, s);
}

export const listPolicyConfirmations = (root: string) => Object.values(readState(root).confirmations);

function implicitByApproval(app: string): boolean {
  try {
    return loadEnvironmentsFile(app)?.confirmation === 'approval';
  } catch {
    return false;
  }
}

export interface PolicyCheck {
  ok: boolean;
  problem?: string;
  policy: EffectivePolicy;
  confirmation?: PolicyConfirmation;
}

/** Kiểm tra xác nhận chính sách cho (môi trường, requirement). Luôn tính lại chính sách hiệu lực nên production không bao giờ qua được. */
export function policyCheck(root: string, env: ResolvedEnvironment, requirementId: string, approvalHash: string, now = Date.now(), source: NodeJS.ProcessEnv = process.env): PolicyCheck {
  const policy = effectivePolicy(env, source);
  const how = `npm run qa:policy -- confirm --env=${env.key} --requirement=${requirementId}`;
  const fail = (problem: string): PolicyCheck => ({ ok: false, problem, policy });
  if (policy.write === 'none') return fail(`Môi trường ${env.key} không có quyền ghi tự động. ${policy.reasons.join(' ')}`);
  // Chế độ approval: APPROVE là xác nhận duy nhất; quyền ghi theo `policy` khai báo của môi trường (production đã bị ép none ở trên).
  if (approvalHash && implicitByApproval(env.application)) {
    const at = new Date(now).toISOString();
    const confirmation: PolicyConfirmation = {
      environment: env.key, application: env.application, host: env.host, requirementId, approvalHash, policyHash: policy.hash,
      sessionId: 'theo-phe-duyet', by: 'APPROVE test case', at, expiresAt: new Date(now + SESSION_MS).toISOString(), signature: '',
    };
    return { ok: true, policy, confirmation };
  }
  const c = readState(root).confirmations[ckey(env.key, requirementId)];
  if (!c) return fail(`Chính sách ghi của ${env.key} chưa được xác nhận cho ${requirementId}. Người dùng chạy trong terminal của mình: ${how}`);
  if (c.environment !== env.key || c.application !== env.application) return fail(`Xác nhận chính sách không thuộc môi trường ${env.key}.`);
  const { signature, ...rest } = c;
  if (!verifyText(payload(rest), signature)) return fail(`Xác nhận chính sách của ${env.key} không xác minh được chữ ký. Cần xác nhận lại: ${how}`);
  if (c.host !== env.host) return fail(`Xác nhận chính sách cho host "${c.host}" nhưng .env hiện trỏ tới "${env.host}". Cần xác nhận lại: ${how}`);
  if (c.policyHash !== policy.hash) return fail(`Chính sách của ${env.key} đã đổi so với lúc xác nhận. Cần xác nhận lại: ${how}`);
  if (c.approvalHash !== approvalHash) return fail(`Phê duyệt của ${requirementId} đã đổi so với lúc xác nhận chính sách ${env.key}. Cần xác nhận lại: ${how}`);
  if (now > Date.parse(c.expiresAt)) return fail(`Phiên chính sách của ${env.key} đã hết hạn (${c.expiresAt}). Cần xác nhận lại: ${how}`);
  return { ok: true, policy, confirmation: c };
}
