import readline from 'node:readline/promises';
import { getApp, listApps } from '../applications';
import { evaluate } from '../core/approval/approval';
import { env as dotenv } from '../core/config/env';
import { resolveEnvironment, type ResolvedEnvironment } from '../core/environment/config';
import { readState } from '../core/environment/state';
import { confirmPolicy, describePolicy, effectivePolicy, listPolicyConfirmations, policyCheck, policyPhrase, revokePolicy } from '../core/policy/policy';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';

// Chính sách quyền thao tác theo môi trường. KHÔNG kết nối mạng, KHÔNG ghi dữ liệu ứng dụng.
//   npm run qa:policy -- show    [--env=STAGING_A]                            # chính sách hiệu lực (production luôn none)
//   npm run qa:policy -- confirm --env=STAGING_A --requirement=REQ-ID         # NGƯỜI DÙNG xác nhận MỘT lần cho phiên chạy (cần bàn phím)
//   npm run qa:policy -- status                                                # các xác nhận còn hiệu lực
//   npm run qa:policy -- revoke  --env=STAGING_A [--requirement=REQ-ID]
// Sau khi xác nhận, `npm run test:write -- --module=...` tự cấp giấy phép ghi và (nếu AUTO_CLEANUP bật) tự cleanup dữ liệu do framework tạo.
const root = process.cwd();
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n: string) => rest.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const fail = (m: string, code = 1): never => {
  console.error(`Lỗi: ${m}`);
  process.exit(code);
};

function pickEnv(): ResolvedEnvironment {
  const sel = readState(root).selected;
  const key = arg('env') ?? sel?.environment;
  if (!key) return fail('chưa chọn môi trường: dùng --env=<TÊN> hoặc npm run qa:env -- select');
  if (sel && arg('env') && arg('env') !== sel.environment) fail(`--env=${arg('env')} khác môi trường đang chọn (${sel.environment}). Không tự chuyển: npm run qa:env -- select --env=${arg('env')}`, 3);
  const app = sel?.application ?? (dotenv.app && listApps().includes(dotenv.app) ? dotenv.app : listApps()[0]);
  getApp(app);
  const r = resolveEnvironment(app, key);
  return r.ok ? r.env : fail(r.problems.join('; '));
}

async function typed(q: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('Bước này phải do NGƯỜI DÙNG thực hiện trong terminal có bàn phím (Claude/tự động hóa không được tự xác nhận).', 2);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim();
  rl.close();
  return a;
}

async function main() {
  switch (cmd) {
    case 'show': {
      const e = pickEnv();
      const p = effectivePolicy(e);
      console.log(`Chính sách hiệu lực của ${e.key} (${e.kind}): write=${p.write}, autoCleanup=${p.autoCleanup}, giữ test FAIL ${p.failureRetentionHours}h, tối đa ${p.maxRecordsPerRun} bản ghi/lần chạy`);
      for (const r of p.reasons) console.log(`  - ${r}`);
      if (p.write !== 'none') for (const l of describePolicy(e, p)) console.log(l);
      return;
    }
    case 'confirm': {
      const e = pickEnv();
      const reqId = arg('requirement') ?? fail('thiếu --requirement=<REQ-ID>');
      const requirement = loadRequirements().find((r) => r.id === reqId) ?? fail(`không có requirement ${reqId}`);
      const ev = evaluate(root, requirement, loadTestCases().filter((d) => d.requirementId === reqId));
      if (!ev.ok || !ev.record?.approval) return fail(`${reqId} chưa có phê duyệt hợp lệ (${ev.state}). Phê duyệt phải xong trước.`);
      const p = effectivePolicy(e);
      if (p.write === 'none') return fail(`Môi trường ${e.key} không được cấp quyền ghi tự động. ${p.reasons.join(' ')}`, 2);
      console.log(`\nXÁC NHẬN CHÍNH SÁCH GHI cho ${reqId}`);
      for (const l of describePolicy(e, p)) console.log(l);
      console.log('Đây là xác nhận THỨ BA, riêng với phê duyệt test case và xác nhận môi trường. Xác nhận một lần cho phiên chạy; sau đó không hỏi từng thao tác.');
      const by = (arg('by') ?? (await typed('Tên người xác nhận: '))).trim();
      const phrase = policyPhrase(e, p);
      const answer = await typed(`Gõ đúng "${phrase}" để xác nhận (Enter để hủy): `);
      if (answer !== phrase) fail('Cụm xác nhận không khớp. Đã hủy.', 2);
      try {
        const c = confirmPolicy(root, { env: e, requirementId: reqId, approvalHash: ev.record.approval.hash, by, typed: answer });
        console.log(`\nĐã xác nhận chính sách ghi của ${e.key} cho ${reqId}: phiên ${c.sessionId}, hiệu lực tới ${c.expiresAt}.`);
      } catch (err) {
        fail((err as Error).message, 2);
      }
      return;
    }
    case 'status': {
      const list = listPolicyConfirmations(root);
      if (!list.length) console.log('Chưa có xác nhận chính sách nào.');
      for (const c of list) {
        const r = resolveEnvironment(c.application, c.environment);
        const req = loadRequirements().find((q) => q.id === c.requirementId);
        const hash = req ? evaluate(root, req, loadTestCases().filter((d) => d.requirementId === req.id)).record?.approval?.hash : undefined;
        const chk = r.ok && hash ? policyCheck(root, r.env, c.requirementId, hash) : undefined;
        console.log(`  ${c.environment} / ${c.requirementId} — phiên ${c.sessionId}, bởi ${c.by}, hết hạn ${c.expiresAt} — ${chk ? (chk.ok ? 'HỢP LỆ' : `KHÔNG HỢP LỆ: ${chk.problem}`) : 'không đánh giá được'}`);
      }
      return;
    }
    case 'revoke': {
      const key = arg('env') ?? fail('thiếu --env=<TÊN>');
      revokePolicy(root, key, arg('requirement'));
      console.log(`Đã thu hồi xác nhận chính sách của ${key}${arg('requirement') ? ` cho ${arg('requirement')}` : ''}.`);
      return;
    }
    default:
      fail('lệnh: show | confirm | status | revoke', 2);
  }
}

main();
