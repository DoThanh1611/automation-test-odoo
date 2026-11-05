import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from '../approval/approval';
import { markerFile } from '../approval/gate';
import { integrityProblems } from '../approval/web';
import { accessOf, loadAutomation } from '../automation/meta';
import { roleGaps, rolesNeeded, type RoleGap } from '../automation/roles';
import { reviewInfo, type ReviewInfo } from './review';
import { scanSpecs } from '../automation/readiness';
import { loadEnvironmentsFile } from '../environment/config';
import { buildEnvCards, sessionStatus, type EnvWebContext } from '../environment/web';
import { authFileFor, metaFileFor, reportsDirFor } from '../environment/paths';
import type { Requirement, TestCaseDef } from '../testcases/schema';

/**
 * Điều phối quy trình `/qa-requirement`: từ TRẠNG THÁI THỰC TẾ trên đĩa (requirement, test case, phê duyệt có chữ ký, xác nhận môi trường,
 * chính sách ghi, phiên đăng nhập, kết quả thăm dò, spec, kết quả chạy) suy ra BƯỚC TIẾP THEO. Không lưu "tiến độ" riêng để tin:
 * gọi lại sau khi phiên Claude Code bị đóng sẽ tự tiếp tục đúng chỗ, không nhập lại requirement, không duyệt lại khi phê duyệt còn hợp lệ.
 * Hàm này CHỈ ĐỌC (không kết nối mạng, không ghi dữ liệu, không xác nhận thay người dùng). Việc ghi duy nhất là đánh dấu phiên làm việc
 * (.qa-state/workflow.json: requirement đang xử lý + mốc "đã tự động hóa") – không phải một cổng bảo mật.
 */
export type Stage =
  | 'NO_REQUIREMENT' // chưa có requirement: cần người dùng cung cấp
  | 'NEEDS_TESTCASES' // có requirement nhưng thiếu/lỗi test case (phủ BR/AC, nguyên văn)
  | 'READY_TO_SUBMIT' // test case đạt kiểm tra, chưa trình duyệt
  | 'AWAITING_APPROVAL' // chờ người dùng APPROVE/REVISE/REJECT trên giao diện review
  | 'NEEDS_REVISION' // cần sửa test case (REVISE, test case đổi sau khi trình/duyệt)
  | 'REJECTED' // bị từ chối: dừng
  | 'APPROVAL_INVALID' // chữ ký phê duyệt không xác minh được: người dùng duyệt lại
  | 'NEEDS_SETUP' // thiếu cấu hình môi trường/credential trong .env (người dùng điền một lần)
  | 'NEEDS_ENVIRONMENT' // chưa có xác nhận môi trường hợp lệ: mở giao diện web để người dùng chọn và xác nhận
  | 'NEEDS_WRITE_POLICY' // có test cần ghi dữ liệu mà chưa có xác nhận chính sách ghi hợp lệ
  | 'NEEDS_ROLES' // requirement cần vai trò chưa có tài khoản trong .env (chỉ nêu TÊN biến của vai trò cần dùng)
  | 'NEEDS_LOGIN' // chưa có phiên đăng nhập đã xác minh: chạy bước đăng nhập chỉ đọc
  | 'LOGIN_FAILED' // đăng nhập/xác minh lỗi: người dùng sửa tài khoản, KHÔNG tự đổi môi trường
  | 'NEEDS_PROBE' // chưa thăm dò Odoo (chỉ đọc) cho môi trường này
  | 'PROBE_FAILED' // thăm dò phát hiện cấu hình không tương thích
  | 'NEEDS_AUTOMATION' // còn test case chưa có spec: khám phá UI chỉ đọc, tạo Page Object + spec
  | 'READY_TO_RUN' // có spec chưa chạy: chạy
  | 'RUN_COMPLETE'; // đã chạy: dựng/kiểm tra/mở QA Report, cleanup theo chính sách, báo cáo

export type Owner = 'claude' | 'user' | 'none';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface WorkflowFacts {
  requirementId?: string;
  /** Requirement đã có trong requirements/ ? */
  requirementExists: boolean;
  /** File đang chờ nhập trong requirements/_inbox. */
  inbox: string[];
  testCaseCount: number;
  /** Lỗi phủ BR/AC / nguyên văn (rỗng = đạt). */
  integrity: string[];
  approvalState?: string;
  approvalReason?: string;
  /** undefined = chưa kiểm tra (chưa duyệt). */
  setup?: { usableEnvironments: number; problems: string[]; defaultRoleMissing?: string };
  env?: { selected?: string; envValid: boolean; envDetail: string; policyEligible: boolean; policyValid: boolean };
  needWrite: boolean;
  /** Vai trò mà test case của requirement dùng (theo metadata thực thi) và vai trò chưa cấu hình trong .env. */
  rolesNeeded?: string[];
  roleGaps?: RoleGap[];
  login?: { missing: string[]; failed: { role: string; problem: string }[] };
  probe?: { supported: boolean; done: boolean; failed: boolean };
  automation?: { eligibleWithoutSpec: string[]; marked: boolean; withSpec: string[]; ranWithSpec: string[] };
}

export interface NextStep {
  requirementId?: string;
  stage: Stage;
  owner: Owner;
  summary: string;
  /** Lệnh/việc Claude tự làm tiếp (không hỏi người dùng). */
  actions: string[];
  /** Việc BẮT BUỘC người dùng làm (tối thiểu). */
  userActions: string[];
  checks: Check[];
  /** Trạng thái phê duyệt + liên kết tài liệu review (chỉ khi requirement đã có test case). */
  review?: ReviewInfo;
}

const step = (f: WorkflowFacts, s: Omit<NextStep, 'requirementId' | 'checks'>, checks: Check[]): NextStep => ({ requirementId: f.requirementId, checks, ...s });

/** Thuần hàm: từ dữ kiện suy ra bước tiếp theo. */
export function decideNext(f: WorkflowFacts): NextStep {
  const req = f.requirementId ?? '<REQ-ID>';
  const checks: Check[] = [];
  const ck = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  if (!f.requirementId || !f.requirementExists) {
    ck('Requirement', false, f.requirementId ? `${f.requirementId} chưa được nhập` : 'chưa có requirement đang xử lý');
    if (f.inbox.length) {
      return step(f, {
        stage: 'NO_REQUIREMENT', owner: 'claude',
        summary: `Có ${f.inbox.length} requirement chờ nhập trong requirements/_inbox (${f.inbox.join(', ')}). Nhập bằng req:import rồi sinh test case.`,
        actions: ['Xác định Application/Module từ mục Path của requirement, rồi: npm run req:import -- <app> <module> <file.md> --id=REQ-<MÃ>-<NNN>', 'Sinh test case có liên kết BR/AC, rồi: npm run req:check -- --requirement=<REQ-ID>'],
        userActions: [],
      }, checks);
    }
    return step(f, {
      stage: 'NO_REQUIREMENT', owner: 'user',
      summary: 'Chưa có requirement. Người dùng chỉ cần dán requirement (văn bản) hoặc đưa đường dẫn file .md khi gọi /qa-requirement.',
      actions: [], userActions: ['Dán requirement theo mẫu example/requirements/TEMPLATE.md hoặc đưa đường dẫn file .md'],
    }, checks);
  }
  ck('Requirement', true, `${req} đã nhập`);

  if (f.testCaseCount === 0 || f.integrity.length) {
    ck('Test case', false, f.testCaseCount === 0 ? 'chưa có test case' : f.integrity.join('; '));
    return step(f, {
      stage: 'NEEDS_TESTCASES', owner: 'claude',
      summary: f.testCaseCount === 0 ? `${req} chưa có test case: sinh test case có liên kết BR/AC.` : `Test case của ${req} chưa đạt kiểm tra: ${f.integrity.join('; ')}.`,
      actions: [`Sinh/bổ sung testcases/<app>-<module>/${req}.testcases.json (không sửa BR/AC)`, `npm run req:check -- --requirement=${req}`],
      userActions: [],
    }, checks);
  }
  ck('Test case', true, `${f.testCaseCount} test case, phủ BR/AC đạt`);

  const st = f.approvalState ?? 'NOT_SUBMITTED';
  ck('Phê duyệt', st === 'APPROVED', `${st}${f.approvalReason ? ` — ${f.approvalReason}` : ''}`);
  switch (st) {
    case 'NOT_SUBMITTED':
      return step(f, { stage: 'READY_TO_SUBMIT', owner: 'claude', summary: `Test case của ${req} đạt kiểm tra, chưa trình duyệt: trình duyệt và mở giao diện review.`, actions: [`npm run qa:approval -- submit --requirement=${req}`, `npm run qa:review -- --requirement=${req} (chạy nền, mở trình duyệt, rồi DỪNG chờ người dùng)`], userActions: [] }, checks);
    case 'PENDING_APPROVAL':
      return step(f, { stage: 'AWAITING_APPROVAL', owner: 'user', summary: `${req} đang chờ APPROVE/REVISE/REJECT. Mở lại giao diện review (nếu chưa mở) rồi dừng; không nhập lại requirement.`, actions: [`npm run qa:review -- --requirement=${req} (chạy nền, mở trình duyệt)`], userActions: ['Xem test case trên giao diện review và bấm APPROVE, REVISE hoặc REJECT'] }, checks);
    case 'PENDING_STALE':
    case 'INVALIDATED':
    case 'REVISION_REQUESTED':
      return step(f, { stage: 'NEEDS_REVISION', owner: 'claude', summary: `${req}: ${st}. Sửa test case theo nhận xét (nếu có), kiểm tra và trình duyệt phiên bản mới.`, actions: [`Đọc nhận xét trong approvals/${req}/ (nếu REVISE) và sửa test case`, `npm run req:check -- --requirement=${req}`, `npm run qa:approval -- submit --requirement=${req}`, `npm run qa:review -- --requirement=${req} (chạy nền) rồi DỪNG`], userActions: [] }, checks);
    case 'REJECTED':
      return step(f, { stage: 'REJECTED', owner: 'user', summary: `${req} đã bị từ chối: không thực thi. Chỉ làm lại khi người dùng yêu cầu rõ và test case đã đổi.`, actions: [], userActions: ['Quyết định có làm lại hay không'] }, checks);
    case 'APPROVED':
      break;
    default:
      return step(f, { stage: 'APPROVAL_INVALID', owner: 'user', summary: `Phê duyệt của ${req} không xác minh được (${st}). Không sửa file; người dùng duyệt lại.`, actions: [], userActions: [`Duyệt lại ${req} trên giao diện review (npm run qa:review -- --requirement=${req})`] }, checks);
  }

  // ---- Giai đoạn 2 ----
  const setup = f.setup;
  if (!setup || setup.usableEnvironments === 0 || setup.defaultRoleMissing) {
    const detail = !setup || setup.usableEnvironments === 0 ? `chưa có môi trường nào đủ cấu hình (${(setup?.problems ?? []).join('; ') || 'thiếu environments/<app>.json'})` : `thiếu tài khoản cho vai trò mặc định: ${setup.defaultRoleMissing}`;
    ck('Cấu hình môi trường', false, detail);
    return step(f, {
      stage: 'NEEDS_SETUP', owner: 'user',
      summary: `Thiếu cấu hình môi trường/credential trong .env: ${detail}.`,
      actions: ['npm run setup (kiểm tra và liệt kê TÊN biến còn thiếu, không in giá trị)'],
      userActions: ['Điền các biến còn thiếu vào .env một lần (xem .env.example); không đưa mật khẩu vào chat'],
    }, checks);
  }
  ck('Cấu hình môi trường', true, `${setup.usableEnvironments} môi trường dùng được`);

  const env = f.env;
  if (!env || !env.envValid) {
    ck('Môi trường', false, env?.envDetail ?? 'chưa chọn');
    return step(f, {
      stage: 'NEEDS_ENVIRONMENT', owner: 'user',
      summary: `Chưa có xác nhận môi trường hợp lệ cho ${req} (${env?.envDetail ?? 'chưa chọn'}). Mở giao diện web để người dùng chọn và xác nhận; xong thì tự tiếp tục.`,
      actions: [`npm run qa:env-web -- --requirement=${req}${f.needWrite ? ' --need-write' : ''} (chạy nền, mở trình duyệt, chờ thông báo hoàn tất)`],
      userActions: ['Chọn môi trường và bấm "Xác nhận môi trường" trên giao diện web'],
    }, checks);
  }
  ck('Môi trường', true, `${env.selected} đã xác nhận, còn hiệu lực`);

  if (f.needWrite) {
    if (!env.policyEligible) ck('Chính sách ghi', true, `${env.selected} chỉ đọc: test cần ghi dữ liệu sẽ BLOCKED (không dừng quy trình)`);
    else if (!env.policyValid) {
      ck('Chính sách ghi', false, 'có test case cần tạo dữ liệu, chưa xác nhận chính sách ghi');
      return step(f, {
        stage: 'NEEDS_WRITE_POLICY', owner: 'user',
        summary: `Có test case cần tạo dữ liệu mà chính sách ghi của ${env.selected} chưa được xác nhận. Mở giao diện web (nút xác nhận chính sách ghi riêng).`,
        actions: [`npm run qa:env-web -- --requirement=${req} --need-write (chạy nền, chờ thông báo hoàn tất)`],
        userActions: ['Bấm "Xác nhận chính sách ghi dữ liệu" trên giao diện web (nút riêng, độc lập với xác nhận môi trường)'],
      }, checks);
    } else ck('Chính sách ghi', true, 'đã xác nhận, còn hiệu lực');
  }

  // Tài khoản theo nhu cầu: chỉ vai trò test case dùng. Thiếu hết ⇒ dừng xin bổ sung; thiếu một phần ⇒ chỉ test dùng vai trò đó BLOCKED.
  const gaps = f.roleGaps ?? [];
  const needed = f.rolesNeeded ?? [];
  if (gaps.length && gaps.length >= needed.length) {
    const vars = [...new Set(gaps.flatMap((g) => g.vars))];
    ck('Tài khoản theo vai trò', false, gaps.map((g) => `${g.role}: ${g.vars.join(', ') || 'chưa khai báo trong environments'}`).join('; '));
    return step(f, {
      stage: 'NEEDS_ROLES', owner: 'user',
      summary: `Chưa có tài khoản cho vai trò mà ${req} cần (${gaps.map((g) => g.role).join(', ')}). Biến .env còn thiếu: ${vars.join(', ') || '(vai trò chưa khai báo trong environments/<app>.json)'}. Không khai báo tài khoản không liên quan; xong thì chạy lại, framework tự kiểm tra và tiếp tục.`,
      actions: [], userActions: [`Bổ sung vào .env: ${vars.join(', ') || 'khai báo vai trò trong environments'} (không dán mật khẩu vào chat)`],
    }, checks);
  }
  if (gaps.length) ck('Tài khoản theo vai trò', true, `thiếu một phần: ${gaps.map((g) => `${g.role} (${g.testCases.join(', ')})`).join('; ')} sẽ BLOCKED, các test còn lại vẫn chạy`);
  else if (needed.length) ck('Tài khoản theo vai trò', true, `đủ cho ${needed.join(', ')}`);

  const login = f.login;
  if (login?.failed.length) {
    ck('Đăng nhập', false, login.failed.map((x) => `${x.role}: ${x.problem}`).join('; '));
    return step(f, {
      stage: 'LOGIN_FAILED', owner: 'user',
      summary: `Đăng nhập/xác minh lỗi trên ${env.selected}: ${login.failed.map((x) => `${x.role} — ${x.problem}`).join('; ')}. Không tự đổi môi trường hay tài khoản; test dùng vai trò này sẽ BLOCKED.`,
      actions: [], userActions: [`Kiểm tra tài khoản/URL/phiên bản của ${env.selected} trong .env rồi gọi lại /qa-requirement ${req}`],
    }, checks);
  }
  if (login?.missing.length) {
    ck('Đăng nhập', false, `chưa có phiên đã xác minh cho: ${login.missing.join(', ')}`);
    return step(f, {
      stage: 'NEEDS_LOGIN', owner: 'claude',
      summary: `Chưa có phiên đăng nhập đã xác minh cho: ${login.missing.join(', ')}. Chạy bước đăng nhập chỉ đọc (xác minh URL, tài khoản, phân quyền, phiên bản).`,
      actions: [`npm test -- --requirement=${req} (chỉ đọc; tạo phiên đăng nhập và báo cáo)`], userActions: [],
    }, checks);
  }
  ck('Đăng nhập', true, 'phiên đã xác minh cho các vai trò');

  if (f.probe?.supported) {
    if (f.probe.failed) {
      ck('Thăm dò', false, 'phát hiện cấu hình không tương thích');
      return step(f, { stage: 'PROBE_FAILED', owner: 'user', summary: `Thăm dò chỉ đọc phát hiện cấu hình không tương thích trên ${env.selected}; xem reports/${env.selected}/probe/. Báo lỗi cụ thể, không chạy tiếp.`, actions: [], userActions: ['Xử lý các điểm không tương thích hoặc xác nhận cách làm tiếp'] }, checks);
    }
    if (!f.probe.done) {
      ck('Thăm dò', false, 'chưa thăm dò môi trường này');
      return step(f, { stage: 'NEEDS_PROBE', owner: 'claude', summary: 'Chưa thăm dò chỉ đọc (phiên bản, model, trường, quyền) cho môi trường này.', actions: ['npm run odoo:probe'], userActions: [] }, checks);
    }
    ck('Thăm dò', true, 'đã thăm dò, không có vấn đề chặn');
  }

  const a = f.automation;
  if (a && a.eligibleWithoutSpec.length && !a.marked) {
    ck('Automation', false, `${a.eligibleWithoutSpec.length} test case chưa có spec`);
    return step(f, {
      stage: 'NEEDS_AUTOMATION', owner: 'claude',
      summary: `${a.eligibleWithoutSpec.length} test case chưa có spec (${a.eligibleWithoutSpec.slice(0, 5).join(', ')}${a.eligibleWithoutSpec.length > 5 ? '…' : ''}). Khám phá giao diện chỉ đọc bằng Playwright MCP, xác minh locator, tạo Page Object + spec; test cần dữ liệu dùng Test Data Factory. Xong thì đánh dấu.`,
      actions: ['Khám phá UI bằng mcp__playwright__* (hook chỉ cho phép khi đủ cổng)', 'Tạo Page Object + spec (locator chỉ lấy từ giao diện thật)', `npm run qa:next -- --requirement=${req} --mark=automation-done`], userActions: [],
    }, checks);
  }
  ck('Automation', true, a ? `${a.withSpec.length} test case có spec` : 'không có thông tin');

  const unrun = a?.withSpec.filter((id) => !a.ranWithSpec.includes(id)) ?? [];
  if (unrun.length) {
    ck('Chạy', false, `${unrun.length} test case có spec chưa chạy`);
    return step(f, {
      stage: 'READY_TO_RUN', owner: 'claude',
      summary: `${unrun.length} test case đã có spec nhưng chưa chạy (${unrun.slice(0, 5).join(', ')}${unrun.length > 5 ? '…' : ''}). Chạy theo requirement, rồi dựng/kiểm tra/mở QA Report và cleanup theo chính sách.`,
      actions: [f.needWrite && env.policyValid ? `npm run test:write -- --requirement=${req} --module=<app>-<module> (cleanup tự động theo chính sách; thêm --no-auto-cleanup cho lần đầu)` : `npm test -- --requirement=${req}`, `npm run qa:finish -- --requirement=${req}`],
      userActions: [],
    }, checks);
  }
  ck('Chạy', true, 'mọi test case có spec đã được chạy');
  return step(f, {
    stage: 'RUN_COMPLETE', owner: 'claude',
    summary: `${req}: đã chạy các test case đủ điều kiện. Dựng, đối chiếu và mở QA Report (lọc theo requirement), cleanup theo chính sách rồi báo cáo kết quả cùng các việc người dùng còn phải làm.`,
    actions: [`npm run qa:finish -- --requirement=${req}`, 'Cleanup dữ liệu framework tạo theo chính sách (npm run cleanup:run -- --run=<RunID>); lỗi cleanup không đổi kết quả test'],
    userActions: [],
  }, checks);
}

// ---------------------------------------------------------------------------------------------------------------------
export interface GatherInput {
  root: string;
  requirements: Requirement[];
  defs: TestCaseDef[];
  requirementId?: string;
  /** Vai trò của ứng dụng theo thứ tự; phần tử đầu là vai trò mặc định. */
  roles: (app: string) => string[];
  roleDescription?: (role: string) => string | undefined;
  source?: NodeJS.ProcessEnv;
  now?: () => number;
}

export const workflowFile = (root: string) => path.join(root, '.qa-state', 'workflow.json');
interface WorkflowSession {
  requirementId?: string;
  updatedAt?: string;
  marks?: Record<string, string>;
}

export function readWorkflow(root: string): WorkflowSession {
  try {
    return JSON.parse(fs.readFileSync(workflowFile(root), 'utf8')) as WorkflowSession;
  } catch {
    return {};
  }
}

export function writeWorkflow(root: string, s: WorkflowSession) {
  fs.mkdirSync(path.dirname(workflowFile(root)), { recursive: true });
  fs.writeFileSync(workflowFile(root), JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

/** Đặt requirement đang xử lý (và mốc). Đổi requirement thì xoá mốc của requirement cũ. */
export function markWorkflow(root: string, requirementId: string, mark?: string) {
  const cur = readWorkflow(root);
  const same = cur.requirementId === requirementId;
  writeWorkflow(root, { requirementId, marks: { ...(same ? cur.marks : {}), ...(mark ? { [mark]: new Date().toISOString() } : {}) } });
}

/** Requirement đang xử lý: đối số → phiên làm việc đã lưu → phiên thực thi đang mở. */
export function resolveActiveRequirement(root: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const w = readWorkflow(root).requirementId;
  if (w) return w;
  try {
    return (JSON.parse(fs.readFileSync(markerFile(root), 'utf8')) as { requirementId?: string }).requirementId;
  } catch {
    return undefined;
  }
}

/** Cần quyền ghi khi có test case GHI theo metadata thực thi (automation/*.automation.json). Chưa khai báo = GHI (mặc định chặn). */
const needsWrite = (root: string, defs: TestCaseDef[]) => {
  const files = loadAutomation(root).files;
  return defs.some((d) => accessOf(d.id, files).access === 'WRITE');
};

export function gatherFacts(i: GatherInput): WorkflowFacts {
  const { root } = i;
  const source = i.source ?? process.env;
  const inboxDir = path.join(root, 'requirements', '_inbox');
  const inbox = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir).filter((f) => f.endsWith('.md')) : [];
  const requirementId = resolveActiveRequirement(root, i.requirementId);
  const requirement = i.requirements.find((r) => r.id === requirementId);
  const base: WorkflowFacts = { requirementId, requirementExists: Boolean(requirement), inbox, testCaseCount: 0, integrity: [], needWrite: false };
  if (!requirement) return base;

  const defs = i.defs.filter((d) => d.requirementId === requirement.id);
  const integrity = defs.length ? integrityProblems({ root, requirement, defs }) : [];
  const ev = evaluate(root, requirement, defs);
  const facts: WorkflowFacts = { ...base, testCaseCount: defs.length, integrity, approvalState: ev.state, approvalReason: ev.reason, needWrite: needsWrite(root, defs) };
  if (!defs.length || integrity.length || !ev.ok) return facts;

  const app = requirement.application;
  const ctx: EnvWebContext = { root, app, requirement, defs, roleDescription: i.roleDescription, source, now: i.now };
  const cards = loadEnvironmentsFile(app) ? buildEnvCards(ctx) : [];
  const usable = cards.filter((c) => c.usable);
  const roles = i.roles(app);
  const sess = sessionStatus(ctx, facts.needWrite);
  const selectedCard = cards.find((c) => c.key === sess.selected);
  facts.setup = {
    usableEnvironments: usable.length,
    problems: cards.filter((c) => !c.usable).flatMap((c) => c.problems.map((p) => `${c.key}: ${p}`)),
    // Không đòi vai trò mặc định ở đây: chỉ vai trò mà test case dùng mới được kiểm tra (NEEDS_ROLES, sau khi chọn môi trường).
    defaultRoleMissing: undefined,
  };
  facts.env = { selected: sess.selected, envValid: sess.envValid, envDetail: sess.envDetail, policyEligible: sess.policyEligible, policyValid: sess.policyValid };
  if (!sess.envValid || !sess.selected) return facts;

  const envKey = sess.selected;
  const configured = selectedCard!.roles.filter((r) => r.configured).map((r) => r.role);
  // Chỉ xét vai trò mà test case của requirement THỰC SỰ dùng (không đòi, không đăng nhập vai trò không liên quan).
  const needs = rolesNeeded(defs, loadAutomation(root).files, roles[0] ?? '');
  const gaps = roleGaps(needs, selectedCard!.roles);
  facts.roleGaps = gaps;
  facts.rolesNeeded = needs.map((n) => n.role);
  const needRoles = needs.map((n) => n.role).filter((r) => configured.includes(r));
  const missing: string[] = [];
  const failed: { role: string; problem: string }[] = [];
  for (const role of needRoles) {
    // Đăng nhập/xác minh lỗi: có meta ok=false (phiên không được lưu). Chưa từng đăng nhập: không có meta.
    let meta: { ok?: boolean; problems?: string[] } | undefined;
    try {
      meta = JSON.parse(fs.readFileSync(metaFileFor(envKey, app, role), 'utf8'));
    } catch { /* chưa có hoặc hỏng */ }
    if (meta?.ok === false) failed.push({ role, problem: (meta.problems ?? ['xác minh không đạt']).join('; ') });
    else if (!meta || !fs.existsSync(authFileFor(envKey, app, role))) missing.push(role);
  }
  facts.login = { missing, failed };

  const probeSupported = fs.existsSync(path.join(root, 'applications', app, 'probe.ts'));
  const probeDir = path.join(reportsDirFor(envKey), 'probe');
  let probeDone = false;
  let probeFailed = false;
  if (probeSupported && fs.existsSync(probeDir)) {
    const latest = fs.readdirSync(probeDir).filter((f) => f.endsWith('.json')).sort().pop();
    if (latest) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(probeDir, latest), 'utf8')) as { blockers?: number };
        probeDone = true;
        probeFailed = (p.blockers ?? 0) > 0;
      } catch { /* file hỏng: coi như chưa thăm dò */ }
    }
  }
  facts.probe = { supported: probeSupported, done: probeDone, failed: probeFailed };

  const keys = [...new Set(defs.map((d) => `${d.application ?? '-'}-${d.module ?? '-'}`))];
  const specs = scanSpecs(path.join(root, 'tests'), keys);
  const hasSpec = (id: string) => specs.has(id);
  const ran = new Set<string>();
  const runsDir = path.join(reportsDirFor(envKey), 'runs');
  if (fs.existsSync(runsDir)) {
    for (const r of fs.readdirSync(runsDir)) {
      try {
        const file = path.join(runsDir, r, 'results.json');
        if (!fs.existsSync(file)) continue;
        for (const e of (JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: { tcId: string }[] }).entries) ran.add(e.tcId);
      } catch { /* bỏ qua file hỏng */ }
    }
  }
  const marks = readWorkflow(root).marks ?? {};
  facts.automation = {
    eligibleWithoutSpec: defs.filter((d) => !hasSpec(d.id) && !d.needsClarification).map((d) => d.id),
    marked: Boolean(marks['automation-done']),
    withSpec: defs.filter((d) => hasSpec(d.id)).map((d) => d.id),
    ranWithSpec: defs.filter((d) => hasSpec(d.id) && ran.has(d.id)).map((d) => d.id),
  };
  return facts;
}

export const nextStep = (i: GatherInput): NextStep => {
  const step = decideNext(gatherFacts(i));
  // Luôn kèm thông tin review khi requirement đã nhập và có test case: người dùng mỗi lần gọi đều thấy trạng thái + liên kết tài liệu.
  const requirement = i.requirements.find((r) => r.id === step.requirementId);
  const defs = requirement ? i.defs.filter((d) => d.requirementId === requirement.id) : [];
  return requirement && defs.length ? { ...step, review: reviewInfo(i.root, requirement, defs) } : step;
};

/** Danh sách requirement chưa xong (để gợi ý khi gọi /qa-requirement không kèm requirement mà không có phiên đang dở). */
export function listOpenRequirements(i: Omit<GatherInput, 'requirementId'>): { id: string; stage: Stage }[] {
  return i.requirements.map((r) => ({ id: r.id, stage: nextStep({ ...i, requirementId: r.id }).stage })).filter((x) => x.stage !== 'RUN_COMPLETE' && x.stage !== 'REJECTED');
}

