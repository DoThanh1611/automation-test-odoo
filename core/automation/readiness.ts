import fs from 'node:fs';
import path from 'node:path';
import { accessOf, type AutomationFile } from './meta';
import type { TestCaseDef } from '../testcases/schema';

/**
 * Kiểm tra sẵn sàng cho Giai đoạn 2 (offline, KHÔNG kết nối mạng, KHÔNG đăng nhập) và phân loại DỰ KIẾN từng test case:
 *  - ELIGIBLE: có automation spec chỉ đọc và đủ điều kiện chạy.
 *  - BLOCKED: thiếu môi trường đã xác nhận / tài khoản của vai trò / dữ liệu ghim / hoặc cần quyền ghi riêng.
 *  - NEEDS CLARIFICATION: nghiệp vụ chưa rõ và chưa có spec.
 *  - NOT RUN: chưa có automation spec (cần khám phá giao diện chỉ đọc rồi viết spec).
 * Đây là DỰ BÁO để giảm câu hỏi và để biết có nên chạy hay không; kết quả thật chỉ đến từ lần chạy (không bao giờ PASS/FAIL giả).
 */
export type Classification = 'ELIGIBLE' | 'BLOCKED' | 'NOT RUN' | 'NEEDS CLARIFICATION';

export interface SpecTc {
  file: string;
  /** Vai trò suy ra từ `test.use({ role })` gần nhất phía trên; undefined = vai trò mặc định. */
  role?: string;
  writes: boolean;
  usesFixtures: boolean;
}

export interface ReadinessInput {
  requirementId: string;
  defs: TestCaseDef[];
  approval: { ok: boolean; reason: string };
  /** undefined = chưa chọn môi trường. */
  environment?: { key: string; label: string; kind: string; host: string };
  /** Lý do môi trường chưa dùng được (chưa chọn/chưa xác nhận/không hợp lệ); undefined = đã chọn và xác nhận hợp lệ. */
  environmentProblem?: string;
  /** Biến còn thiếu theo vai trò (tên biến, không giá trị). */
  roleMissing: Record<string, string[]>;
  defaultRole: string;
  /** Phân tích spec theo test case. */
  specs: Map<string, SpecTc>;
  /** Metadata thực thi (automation/*.automation.json). Có truyền vào ⇒ quyền ghi lấy từ đây (chưa khai báo = GHI); không truyền ⇒ chỉ dựa vào phân tích spec. */
  automation?: AutomationFile[];
  /** Module nào đã có file fixture cho môi trường này. */
  fixtureModules: Set<string>;
  /** Chính sách ghi theo môi trường (thông tin; không chặn test chỉ đọc). */
  writePolicy?: { ok: boolean; detail: string };
}

export interface TcReadiness {
  tcId: string;
  title: string;
  module: string;
  classification: Classification;
  reason: string;
}

export interface Readiness {
  requirementId: string;
  environment?: string;
  /** Được phép kết nối Playwright MCP/staging ngay (phê duyệt + môi trường đã xác nhận). */
  canConnect: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  testCases: TcReadiness[];
  counts: Record<Classification, number>;
  runnable: number;
  /** Danh sách câu hỏi gom một lần cho người dùng (rỗng = không cần hỏi gì). */
  questions: string[];
  nextSteps: string[];
}

const moduleKey = (d: TestCaseDef) => `${d.application ?? '-'}-${d.module ?? '-'}`;

export function buildReadiness(i: ReadinessInput): Readiness {
  const checks: Readiness['checks'] = [];
  checks.push({ name: 'Phê duyệt test case', ok: i.approval.ok, detail: i.approval.reason });
  checks.push({
    name: 'Môi trường đã chọn và xác nhận',
    ok: !i.environmentProblem && Boolean(i.environment),
    detail: i.environmentProblem ?? `${i.environment?.key} (${i.environment?.label}, ${i.environment?.kind}) — ${i.environment?.host}`,
  });
  if (i.writePolicy) checks.push({ name: 'Chính sách ghi (tự tạo/cleanup dữ liệu test)', ok: i.writePolicy.ok, detail: i.writePolicy.detail });
  const usedRoles = new Set([...i.specs.values()].map((s) => s.role ?? i.defaultRole));
  if (!usedRoles.size) usedRoles.add(i.defaultRole);
  for (const role of [...usedRoles].sort()) {
    const missing = i.roleMissing[role] ?? [`(vai trò ${role} không khai báo cho môi trường này)`];
    checks.push({ name: `Tài khoản vai trò ${role}`, ok: !missing.length, detail: missing.length ? `thiếu biến: ${missing.join(', ')}` : 'đủ biến tài khoản trong .env' });
  }
  const modules = [...new Set(i.defs.map(moduleKey))].sort();
  for (const m of modules) {
    const has = [...i.specs.values()].length > 0;
    checks.push({ name: `Dữ liệu ghim ${m}`, ok: i.fixtureModules.has(m), detail: i.fixtureModules.has(m) ? 'có file fixture của môi trường' : has ? 'chưa có fixture riêng cho môi trường này (test cần bản ghi ghim sẽ BLOCKED)' : 'chưa có fixture (chưa cần nếu chưa có spec)' });
  }

  const testCases: TcReadiness[] = i.defs.map((d) => {
    const base = { tcId: d.id, title: d.title, module: moduleKey(d) };
    const spec = i.specs.get(d.id);
    const role = spec?.role ?? i.defaultRole;
    const rc = (classification: Classification, reason: string): TcReadiness => ({ ...base, classification, reason });
    if (!i.approval.ok) return rc('NOT RUN', `Chưa được phê duyệt hợp lệ: ${i.approval.reason}`);
    if (!spec) {
      return d.needsClarification
        ? rc('NEEDS CLARIFICATION', `Nghiệp vụ chưa rõ và chưa có automation spec: ${d.needsClarification}`)
        : rc('NOT RUN', 'Chưa có automation spec: cần khám phá giao diện (chỉ đọc) và viết spec sau khi môi trường được xác nhận.');
    }
    const decl = i.automation ? accessOf(d.id, i.automation) : undefined;
    if (decl && decl.access === 'WRITE' && !spec.writes) {
      return rc('BLOCKED', decl.declared
        ? 'Test ghi dữ liệu theo metadata thực thi: cần quyền ghi riêng (npm run test:write) trên môi trường đã xác nhận; chế độ chỉ đọc sẽ BLOCKED.'
        : `Test ghi dữ liệu: chưa khai báo metadata thực thi hợp lệ (automation/*.automation.json) nên mặc định coi là GHI và bị chặn (${decl.problems.join('; ')}).`);
    }
    if (spec.writes) return rc('BLOCKED', 'Test ghi dữ liệu: cần quyền ghi riêng (npm run test:write) trên môi trường đã xác nhận; chế độ chỉ đọc sẽ BLOCKED.');
    if (i.environmentProblem || !i.environment) return rc('BLOCKED', `Môi trường chưa sẵn sàng: ${i.environmentProblem ?? 'chưa chọn môi trường'}`);
    const missing = i.roleMissing[role] ?? [];
    if (missing.length) return rc('BLOCKED', `Thiếu tài khoản vai trò "${role}" trên ${i.environment.key}: ${missing.join(', ')}`);
    if (spec.usesFixtures && !i.fixtureModules.has(moduleKey(d))) return rc('BLOCKED', `Cần bản ghi ghim nhưng ${i.environment.key} chưa có fixture cho ${moduleKey(d)} (testdata/fixtures/${i.environment.key}/).`);
    return rc('ELIGIBLE', d.needsClarification ? 'Đủ điều kiện chạy chỉ đọc; phần chưa rõ sẽ được ghi NEEDS CLARIFICATION khi chạy.' : 'Đủ điều kiện chạy chỉ đọc.');
  });

  const counts: Record<Classification, number> = { ELIGIBLE: 0, BLOCKED: 0, 'NOT RUN': 0, 'NEEDS CLARIFICATION': 0 };
  for (const t of testCases) counts[t.classification]++;
  const canConnect = i.approval.ok && !i.environmentProblem && Boolean(i.environment);

  // Gom MỘT danh sách câu hỏi (không hỏi những gì tự xác minh được).
  const questions: string[] = [];
  if (!i.approval.ok) questions.push(`Phê duyệt ${i.requirementId} chưa hợp lệ (${i.approval.reason}): người dùng duyệt trên giao diện web hoặc terminal.`);
  else if (i.environmentProblem) questions.push(`Môi trường: ${i.environmentProblem}`);
  for (const [role, miss] of Object.entries(i.roleMissing)) {
    if (miss.length && usedRoles.has(role)) questions.push(`Điền vào .env tài khoản vai trò "${role}": ${miss.join(', ')} (chỉ người dùng được điền).`);
  }
  for (const m of modules) {
    if (!i.fixtureModules.has(m) && testCases.some((t) => t.module === m && t.reason.includes('bản ghi ghim'))) questions.push(`Chỉ định bản ghi cần ghim cho ${m} (SO/DO...). Claude có thể ĐỀ XUẤT ứng viên bằng truy vấn chỉ đọc, nhưng người dùng quyết định.`);
  }
  for (const t of testCases) if (t.classification === 'NEEDS CLARIFICATION') questions.push(`${t.tcId}: ${t.reason}`);
  const writes = testCases.filter((t) => t.reason.startsWith('Test ghi dữ liệu')).map((t) => t.tcId);
  if (writes.length) {
    questions.push(i.writePolicy?.ok
      ? `Chính sách ghi đã xác nhận: ${writes.join(', ')} chạy được bằng npm run test:write (dữ liệu tự tạo, tự cleanup theo chính sách); không cần hỏi thêm.`
      : `Chính sách ghi cho ${writes.join(', ')}: nếu người dùng muốn chạy, họ tự gõ npm run qa:policy -- confirm --env=<TÊN> --requirement=${i.requirementId} (xác nhận MỘT lần; production không bao giờ có).`);
  }

  const nextSteps: string[] = [];
  if (!canConnect) nextSteps.push('KHÔNG kết nối Playwright MCP/staging. Gom câu hỏi ở trên hỏi người dùng MỘT lần, rồi chạy lại qa:ready.');
  else if (counts['NOT RUN'] > 0) nextSteps.push('Kết nối Playwright MCP (chỉ đọc), khám phá giao diện, viết Page Object + spec cho các test chưa có automation.');
  if (canConnect && i.defs.length && !counts.ELIGIBLE && !counts['NOT RUN']) nextSteps.push('Không có test nào chạy được: không chạy Playwright; vẫn chạy npm run qa:finish để dựng và đối chiếu báo cáo.');
  if (canConnect && counts.ELIGIBLE) nextSteps.push('Chạy các test đủ điều kiện: npm test -- --project=<app>-<module>, rồi npm run qa:finish.');
  if (!nextSteps.length) nextSteps.push('Chạy npm run qa:finish để dựng báo cáo.');

  return { requirementId: i.requirementId, environment: i.environment?.key, canConnect, checks, testCases, counts, runnable: counts.ELIGIBLE, questions, nextSteps };
}

// ---- Phân tích spec (heuristic tĩnh trên mã nguồn; không chạy spec) ----
const TC_RE = /tcMeta\(\s*['"`](TC-[A-Za-z0-9-]+)['"`]\s*\)/g;
const ROLE_RE = /test\.use\(\s*\{[^}]*\brole\s*:\s*['"`]([A-Za-z0-9_-]+)['"`]/g;
const WRITE_RE = /\bwriteGuard\s*\(|assertSafeToWrite\s*\(|createConfirmedSaleOrder\s*\(|\.confirm\(|\.save\(/;
const FIXTURE_RE = /fixtureOrBlock\s*\(|fixtureRecord\s*\(|loadFixtures\s*\(/;

/** Phân tích văn bản một spec: test case nào, vai trò nào, có ghi dữ liệu không, có dùng fixture không. */
export function analyzeSpec(file: string, text: string): Map<string, SpecTc> {
  const out = new Map<string, SpecTc>();
  const roles = [...text.matchAll(ROLE_RE)].map((m) => ({ at: m.index ?? 0, role: m[1] }));
  const tcs = [...text.matchAll(TC_RE)].map((m) => ({ at: m.index ?? 0, id: m[1] }));
  tcs.forEach((t, n) => {
    const segment = text.slice(t.at, tcs[n + 1]?.at ?? text.length);
    const role = [...roles].reverse().find((r) => r.at < t.at)?.role;
    out.set(t.id, { file, role, writes: WRITE_RE.test(segment), usesFixtures: FIXTURE_RE.test(segment) });
  });
  return out;
}

/** Quét tests/<module-key>/**.spec.ts. */
export function scanSpecs(testsDir: string, keys: string[]): Map<string, SpecTc> {
  const out = new Map<string, SpecTc>();
  const walk = (d: string): string[] =>
    fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.spec.ts') ? [path.join(d, e.name)] : [])) : [];
  for (const k of keys) for (const f of walk(path.join(testsDir, k))) for (const [id, s] of analyzeSpec(f, fs.readFileSync(f, 'utf8'))) out.set(id, s);
  return out;
}
