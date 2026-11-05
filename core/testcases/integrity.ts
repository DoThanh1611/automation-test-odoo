import fs from 'node:fs';
import path from 'node:path';
import { parseRequirement } from './req-parser';
import { listRequirementFiles, readLock, requirementHash, sha256 } from './lock';
import type { Requirement } from './schema';

export interface IntegrityResult {
  requirementId: string;
  file: string;
  errors: string[];
  warnings: string[];
  /** Nguồn đã được kiểm tra đối chiếu (hash + đọc lại và so từng ký tự). */
  sourceVerified: boolean;
  sourceKind?: 'file' | 'paste';
  sourceSha256?: string;
}

/**
 * Kiểm tra requirement gốc còn NGUYÊN VĂN, hoàn toàn bằng công cụ (không tin vào việc Claude tự sao chép):
 *  1. BR/AC trong JSON khớp hash của file khoá (.lock).
 *  2. Bản nguồn (.source.md, sao chép nguyên byte lúc nhập) khớp sha256 đã ghi trong khoá.
 *  3. Phân tích lại bản nguồn bằng bộ phân tích của framework rồi so TỪNG KÝ TỰ với JSON (Path, Business Requirement, Expected Solution, từng BR/AC).
 * Requirement nhập trước khi có cơ chế bản nguồn chỉ có kiểm tra (1) và được báo là "chưa có bản nguồn".
 */
export function verifyRequirement(reqFile: string, root = process.cwd()): IntegrityResult {
  const abs = path.resolve(root, reqFile);
  const r = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')) as Requirement;
  const res: IntegrityResult = { requirementId: r.id, file: reqFile, errors: [], warnings: [], sourceVerified: false };
  const lock = readLock(abs);
  if (!lock) {
    res.errors.push('Thiếu file khoá (.lock): BR/AC chưa được khoá.');
    return res;
  }
  if (lock.sha256 !== requirementHash(r)) res.errors.push('BR/AC trong JSON KHÁC với bản đã khoá (.lock): nội dung gốc đã bị sửa.');
  if (!lock.source) {
    res.warnings.push('Chưa có bản nguồn nguyên byte (requirement nhập trước khi có cơ chế này): chỉ kiểm tra được hash BR/AC.');
    return res;
  }
  res.sourceKind = lock.source.kind;
  res.sourceSha256 = lock.source.sha256;
  const srcAbs = path.resolve(root, lock.source.file);
  if (!fs.existsSync(srcAbs)) {
    res.warnings.push(`Không còn bản nguồn ${lock.source.file} trên máy này (chỉ còn hash ${lock.source.sha256.slice(0, 12)}…).`);
    return res;
  }
  const buf = fs.readFileSync(srcAbs);
  if (sha256(buf) !== lock.source.sha256) {
    res.errors.push(`Bản nguồn ${lock.source.file} KHÁC sha256 đã ghi lúc nhập (file nguồn bị sửa sau khi nhập).`);
    return res;
  }
  const p = parseRequirement(buf.toString('utf8'));
  if (p.problems.length) res.errors.push(`Bản nguồn không còn phân tích được: ${p.problems.join('; ')}`);
  const same = (label: string, a: string | undefined, b: string | undefined) => {
    if ((a ?? '') !== (b ?? '')) res.errors.push(`${label} trong JSON KHÁC bản nguồn.`);
  };
  same('Path', r.path, p.path);
  same('Business Requirement', r.businessRequirement, p.businessRequirement);
  same('Expected Solution', r.expectedSolution, p.expectedSolution);
  for (const [kind, jsonList, srcList] of [['BR', r.businessRules, p.businessRules], ['AC', r.acceptanceCriteria, p.acceptanceCriteria]] as const) {
    if (jsonList.length !== srcList.length) res.errors.push(`Số ${kind} khác bản nguồn (JSON ${jsonList.length}, nguồn ${srcList.length}).`);
    for (const s of srcList) {
      const j = jsonList.find((x) => x.id === s.id);
      if (!j) res.errors.push(`${s.id} có trong bản nguồn nhưng thiếu trong JSON.`);
      else if (j.text !== s.text) res.errors.push(`${s.id} trong JSON KHÁC bản nguồn từng ký tự.`);
    }
  }
  res.sourceVerified = res.errors.length === 0;
  return res;
}

export const verifyAllRequirements = (root = process.cwd()): IntegrityResult[] =>
  listRequirementFiles(path.join(root, 'requirements')).map((f) => verifyRequirement(f, root));
