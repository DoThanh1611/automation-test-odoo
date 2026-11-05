import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Requirement } from './schema';

/**
 * Khoá nội dung BR/AC gốc: băm businessRequirement + businessRules + acceptanceCriteria (KHÔNG gồm notes).
 * Mọi ghi chú làm rõ nghiệp vụ phải đi vào `notes`; test FW sẽ lỗi nếu BR/AC gốc bị sửa mà không cập nhật khoá có chủ đích.
 */
export const requirementHash = (r: Requirement): string =>
  crypto.createHash('sha256').update(JSON.stringify({ b: r.businessRules, a: r.acceptanceCriteria, br: r.businessRequirement })).digest('hex');

export const sha256 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

/** Bản nguồn requirement do CÔNG CỤ sao chép nguyên byte (không qua Claude) và băm lúc nhập. */
export interface SourceInfo {
  /** Đường dẫn bản sao nguồn, tương đối so với thư mục gốc dự án. */
  file: string;
  sha256: string;
  bytes: number;
  lines: number;
  /** file = người dùng đưa đường dẫn file (công cụ sao chép nguyên byte); paste = văn bản dán được ghi vào requirements/_inbox (độ khớp với bản dán gốc phụ thuộc người ghi file). */
  kind: 'file' | 'paste';
}

export interface LockFile {
  id: string;
  sha256: string;
  lockedAt: string;
  source?: SourceInfo;
}

export const lockFileFor = (reqFile: string) => reqFile.replace(/\.json$/, '.lock');
export const sourceFileFor = (reqFile: string) => reqFile.replace(/\.json$/, '.source.md');

export function writeLock(reqFile: string, source?: SourceInfo) {
  const r = JSON.parse(fs.readFileSync(reqFile, 'utf8')) as Requirement;
  const lock: LockFile = { id: r.id, sha256: requirementHash(r), lockedAt: new Date().toISOString(), ...(source ? { source } : {}) };
  fs.writeFileSync(lockFileFor(reqFile), JSON.stringify(lock, null, 2) + '\n');
}

export function readLock(reqFile: string): LockFile | undefined {
  const f = lockFileFor(reqFile);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as LockFile) : undefined;
}

export function listRequirementFiles(dir = 'requirements'): string[] {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listRequirementFiles(path.join(dir, e.name)) : e.name.endsWith('.json') ? [path.join(dir, e.name)] : [],
  );
}
