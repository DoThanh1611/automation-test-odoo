import fs from 'node:fs';
import path from 'node:path';
import type { TestCaseDef } from '../testcases/schema';

/**
 * Metadata THỰC THI của test case (quyền ghi, vai trò, chiến lược dữ liệu, cleanup).
 *
 * Nằm TÁCH RIÊNG nội dung test case: file `automation/<app>-<module>/<REQ>.automation.json`, không thuộc `testcases/` và không nằm trong
 * defHash hay snapshot phê duyệt. Vì vậy bổ sung/sửa metadata khi viết Page Object hoặc automation spec KHÔNG làm mất hiệu lực phê duyệt.
 *
 * Mặc định AN TOÀN: test case chưa khai báo (hoặc khai báo sai) được coi là GHI, nên bị chặn nếu chưa có giấy phép + chính sách ghi.
 */
export type AccessMode = 'READ' | 'WRITE';
/** NONE: không cần dữ liệu. EXISTING_READONLY: chỉ đọc dữ liệu có sẵn. FACTORY: tạo bằng Test Data Factory (có registry).
 *  SELF_CREATED: test tự tạo qua helper, gắn nhãn AUTOTEST và đăng ký registry. EXISTING_WRITE: sửa dữ liệu/cấu hình có sẵn (cần khôi phục thủ công). */
export type DataStrategy = 'NONE' | 'EXISTING_READONLY' | 'FACTORY' | 'SELF_CREATED' | 'EXISTING_WRITE';
/** NONE: không có gì để dọn. REGISTRY: dọn theo kế hoạch cleanup từ registry (dry-run, người dùng xác nhận). MANUAL: người dùng tự khôi phục. */
export type CleanupPolicy = 'NONE' | 'REGISTRY' | 'MANUAL';

export interface AutomationMeta {
  access: AccessMode;
  /** Vai trò dùng khi chạy (khóa role trong config ứng dụng). Bỏ trống = vai trò mặc định của ứng dụng. */
  role?: string;
  dataStrategy: DataStrategy;
  cleanup: CleanupPolicy;
  /** Ghi chú ngắn cho người đọc (không dùng để quyết định). */
  note?: string;
}

export interface AutomationFile {
  requirementId: string;
  testCases: Record<string, AutomationMeta>;
}

export const AUTOMATION_DIR = 'automation';
const ACCESS: AccessMode[] = ['READ', 'WRITE'];
const STRATEGIES: DataStrategy[] = ['NONE', 'EXISTING_READONLY', 'FACTORY', 'SELF_CREATED', 'EXISTING_WRITE'];
const CLEANUPS: CleanupPolicy[] = ['NONE', 'REGISTRY', 'MANUAL'];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.automation.json') ? [p] : [];
  });
}

/** Đọc mọi file metadata. File hỏng bị bỏ qua (test case thuộc file đó trở về mặc định GHI) nhưng được trả về trong `problems`. */
export function loadAutomation(root = process.cwd()): { files: AutomationFile[]; problems: string[] } {
  const files: AutomationFile[] = [];
  const problems: string[] = [];
  for (const f of walk(path.join(root, AUTOMATION_DIR))) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as AutomationFile;
      if (!j || typeof j.requirementId !== 'string' || typeof j.testCases !== 'object' || !j.testCases) throw new Error('thiếu requirementId/testCases');
      files.push(j);
    } catch (e) {
      problems.push(`${path.relative(root, f)}: ${(e as Error).message}`);
    }
  }
  return { files, problems };
}

/** Kiểm tra một khai báo. Trả về danh sách lỗi (rỗng = hợp lệ). Khai báo không hợp lệ KHÔNG được coi là READ. */
export function metaProblems(m: Partial<AutomationMeta> | undefined): string[] {
  if (!m || typeof m !== 'object') return ['không có khai báo'];
  const p: string[] = [];
  if (!ACCESS.includes(m.access as AccessMode)) p.push(`access phải là ${ACCESS.join('/')}`);
  if (!STRATEGIES.includes(m.dataStrategy as DataStrategy)) p.push(`dataStrategy phải là ${STRATEGIES.join('/')}`);
  if (!CLEANUPS.includes(m.cleanup as CleanupPolicy)) p.push(`cleanup phải là ${CLEANUPS.join('/')}`);
  if (p.length) return p;
  if (m.access === 'READ') {
    if (m.dataStrategy !== 'NONE' && m.dataStrategy !== 'EXISTING_READONLY') p.push('test READ chỉ được dùng dataStrategy NONE hoặc EXISTING_READONLY');
    if (m.cleanup !== 'NONE') p.push('test READ không có gì để dọn: cleanup phải là NONE');
  } else {
    if (m.dataStrategy === 'NONE') p.push('test WRITE phải khai báo dataStrategy (FACTORY, SELF_CREATED hoặc EXISTING_WRITE)');
    if (m.cleanup === 'NONE') p.push('test WRITE phải khai báo cleanup (REGISTRY hoặc MANUAL)');
  }
  return p;
}

export interface AccessDecision {
  access: AccessMode;
  /** false = chưa khai báo hợp lệ, quyền ghi được SUY RA MẶC ĐỊNH (GHI). */
  declared: boolean;
  meta?: AutomationMeta;
  problems: string[];
}

/** Quyền thực thi của một test case. Thiếu hoặc không hợp lệ => GHI (chặn mặc định). */
export function accessOf(tcId: string, files: AutomationFile[]): AccessDecision {
  const meta = files.map((f) => f.testCases[tcId]).find(Boolean);
  if (!meta) return { access: 'WRITE', declared: false, problems: ['chưa khai báo metadata thực thi (mặc định coi là GHI)'] };
  const problems = metaProblems(meta);
  if (problems.length) return { access: 'WRITE', declared: false, meta, problems };
  return { access: meta.access, declared: true, meta, problems: [] };
}

/** Kiểm tra toàn bộ: id không tồn tại trong test case, khai báo sai. Dùng cho framework test và kiểm tra trước khi phát hành. */
export function validateAutomation(files: AutomationFile[], defs: TestCaseDef[]): string[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: string[] = [];
  for (const f of files) {
    for (const [id, m] of Object.entries(f.testCases)) {
      const d = byId.get(id);
      if (!d) out.push(`${f.requirementId}/${id}: test case không tồn tại`);
      else if (d.requirementId !== f.requirementId) out.push(`${f.requirementId}/${id}: thuộc requirement ${d.requirementId}`);
      for (const p of metaProblems(m)) out.push(`${f.requirementId}/${id}: ${p}`);
    }
  }
  return out;
}

let cache: { root: string; files: AutomationFile[] } | undefined;
/** Quyền thực thi của test case hiện tại (có cache theo tiến trình; framework test dùng loadAutomation/accessOf trực tiếp). */
export function accessOfCached(tcId: string, root = process.cwd()): AccessDecision {
  if (!cache || cache.root !== root) cache = { root, files: loadAutomation(root).files };
  return accessOf(tcId, cache.files);
}
