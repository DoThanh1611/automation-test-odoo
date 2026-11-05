import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { getApp, listApps } from '../applications';
import { evaluate } from '../core/approval/approval';
import { env as dotenv } from '../core/config/env';
import { ambiguousTargets, environmentsFile, listEnvironmentKeys, loadEnvironmentsFile, resolveEnvironment, validateEnvironmentsFile, type ResolvedEnvironment } from '../core/environment/config';
import { registryPathFor } from '../core/environment/paths';
import { clearSelection, confirmExecution, confirmPhrase, confirmationProblem, readState, revokeConfirmation, selectEnvironment } from '../core/environment/state';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';

// Quản lý nhiều môi trường kiểm thử cho cùng một ứng dụng. KHÔNG kết nối mạng, KHÔNG đăng nhập, KHÔNG ghi dữ liệu ứng dụng.
//   npm run qa:env -- list    [--app=odoo]                          # các môi trường, host, biến còn thiếu (chỉ tên biến)
//   npm run qa:env -- check   [--app=odoo]                          # kiểm tra cấu hình + .env (thoát mã 1 nếu cấu hình sai)
//   npm run qa:env -- select  --env=STAGING_A [--app=odoo]          # CHỌN môi trường làm việc (chưa xác nhận, chưa kết nối)
//   npm run qa:env -- confirm --env=STAGING_A --requirement=REQ-ID  # NGƯỜI DÙNG xác nhận cho phép thực thi trên môi trường này (cần bàn phím)
//   npm run qa:env -- status                                         # môi trường đang chọn, xác nhận, nơi lưu kết quả/phiên
//   npm run qa:env -- revoke  --env=STAGING_A [--requirement=REQ-ID]
//   npm run qa:env -- clear                                          # bỏ chọn môi trường
//   npm run qa:env -- adopt-legacy --env=STAGING_A                   # SAO CHÉP (không di chuyển) sổ dữ liệu test cũ vào môi trường này (cần bàn phím)
const root = process.cwd();
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n: string) => rest.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const fail = (m: string, code = 1): never => {
  console.error(`Lỗi: ${m}`);
  process.exit(code);
};

function pickApp(): string {
  const a = arg('app') ?? (dotenv.app || undefined);
  if (a) return listApps().includes(a) ? a : fail(`ứng dụng "${a}" chưa đăng ký (có: ${listApps().join(', ')})`);
  return listApps().length === 1 ? listApps()[0] : fail(`chỉ định --app=<${listApps().join('|')}>`);
}

const resolveOrFail = (app: string, key: string | undefined): ResolvedEnvironment => {
  if (!key) return fail('thiếu --env=<TÊN> (xem: npm run qa:env -- list)');
  const r = resolveEnvironment(app, key);
  return r.ok ? r.env : fail(r.problems.join('; '));
};

function describe(app: string) {
  const file = loadEnvironmentsFile(app);
  if (!file) return fail(`chưa có file ${path.relative(root, environmentsFile(app))}`);
  const resolved: ResolvedEnvironment[] = [];
  console.log(`Ứng dụng ${app} — ${Object.keys(file.environments).length} môi trường (${path.relative(root, environmentsFile(app))}):`);
  for (const key of listEnvironmentKeys(app)) {
    const def = file.environments[key];
    const r = resolveEnvironment(app, key);
    if (!r.ok) {
      console.log(`  ${key.padEnd(12)} ${def.kind.padEnd(10)} KHÔNG DÙNG ĐƯỢC: ${r.problems.join('; ')}`);
      continue;
    }
    resolved.push(r.env);
    const roles = Object.values(r.env.roles).map((x) => `${x.role}:${x.missing.length ? `thiếu ${x.missing.join(',')}` : 'đủ'}`).join(' · ');
    const ver = r.env.expectedVersion ? `phiên bản kỳ vọng ${r.env.expectedVersion}` : `thiếu ${def.expectedVersionVar}`;
    console.log(`  ${key.padEnd(12)} ${def.kind.padEnd(10)} ${r.env.host}${r.env.db ? ` (db ${r.env.db})` : ''} · ${ver} · ${roles}`);
  }
  return { file, resolved };
}

async function typed(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('Bước này phải do NGƯỜI DÙNG thực hiện trong terminal có bàn phím (Claude/tự động hóa không được tự xác nhận). Mở terminal của bạn và chạy lại lệnh.', 2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim();
  rl.close();
  return a;
}

async function main() {
  switch (cmd) {
    case 'list': {
      describe(pickApp());
      return;
    }
    case 'check': {
      const app = pickApp();
      const d = describe(app);
      if (!d) return;
      const problems = [...validateEnvironmentsFile(d.file, Object.keys(getApp(app).roles)), ...ambiguousTargets(d.resolved)];
      for (const p of problems) console.error(`  CẤU HÌNH SAI: ${p}`);
      console.log(problems.length ? `\nKẾT QUẢ: ${problems.length} vấn đề cấu hình.` : '\nKẾT QUẢ: cấu hình hợp lệ (chưa kết nối mạng; chưa xác minh tài khoản/phiên bản; việc đó xảy ra khi chạy, sau khi xác nhận môi trường).');
      process.exitCode = problems.length ? 1 : 0;
      return;
    }
    case 'select': {
      const app = pickApp();
      const e = resolveOrFail(app, arg('env'));
      const r = selectEnvironment(root, app, e.key);
      console.log(`Đã CHỌN môi trường ${e.key} (${e.label}) — ${e.kind} — ${e.host}${e.db ? ` (db ${e.db})` : ''}.`);
      if (r.changed) console.log(`Đã đổi từ ${r.previous}. Phải ĐÓNG trình duyệt Playwright MCP đang mở (browser_close) và dùng phiên trình duyệt MỚI, không dùng lại cookie của môi trường cũ.`);
      console.log('Chưa kết nối gì và chưa được phép thực thi. Bước tiếp theo, NGƯỜI DÙNG tự gõ trong terminal của mình:');
      console.log(`  npm run qa:env -- confirm --env=${e.key} --requirement=<REQ-ID>`);
      console.log(`Phiên MCP cho môi trường này nên chạy với: --isolated --storage-state=.auth/${e.key}/${app}-<role>.json (xem INSTALL.md).`);
      return;
    }
    case 'confirm': {
      const app = pickApp();
      const e = resolveOrFail(app, arg('env'));
      const reqId = arg('requirement') ?? fail('thiếu --requirement=<REQ-ID>');
      const requirement = loadRequirements().find((r) => r.id === reqId) ?? fail(`không có requirement ${reqId}`);
      const ev = evaluate(root, requirement, loadTestCases().filter((d) => d.requirementId === reqId));
      if (!ev.ok || !ev.record?.approval) return fail(`${reqId} chưa có phê duyệt hợp lệ (${ev.state}: ${ev.reason}). Phê duyệt phải xong trước khi xác nhận môi trường.`);
      console.log(`\nXÁC NHẬN THỰC THI ${reqId} trên môi trường ${e.key} (${e.label}, ${e.kind})`);
      console.log(`  URL gốc : ${e.baseUrl}\n  Host    : ${e.host}${e.db ? `\n  Database: ${e.db}` : ''}\n  Phiên bản kỳ vọng: ${e.expectedVersion ?? '(chưa cấu hình)'}`);
      console.log('  Phê duyệt test case được dùng chung nếu nội dung không đổi, nhưng xác nhận này chỉ cho ĐÚNG môi trường trên.');
      console.log('  Đây KHÔNG phải quyền ghi dữ liệu: ghi dữ liệu cần xác nhận riêng (npm run test:write -- --env=... --module=...).');
      if (e.kind === 'production') console.log('  ⚠ MÔI TRƯỜNG PRODUCTION: chỉ chạy kiểm tra chỉ đọc; quyền ghi bị từ chối vĩnh viễn.');
      const by = (arg('by') ?? (await typed('Tên người xác nhận: '))).trim();
      const phrase = confirmPhrase(e);
      const answer = await typed(`Gõ đúng "${phrase}" để xác nhận (Enter để hủy): `);
      if (answer !== phrase) fail('Cụm xác nhận không khớp. Đã hủy.', 2);
      confirmExecution(root, { env: e, requirementId: reqId, approvalHash: ev.record.approval!.hash, by, typed: answer });
      console.log(`\nĐã xác nhận ${e.key} cho ${reqId} (hiệu lực 24 giờ, mất hiệu lực nếu phê duyệt đổi hoặc host trong .env đổi).`);
      console.log(`Chọn môi trường làm việc (nếu chưa): npm run qa:env -- select --env=${e.key}`);
      return;
    }
    case 'status': {
      const s = readState(root);
      console.log(s.selected ? `Môi trường đang chọn: ${s.selected.environment} (${s.selected.application}) từ ${s.selected.at}` : 'Chưa chọn môi trường.');
      const entries = Object.values(s.confirmations);
      if (!entries.length) console.log('Chưa có xác nhận thực thi nào.');
      for (const c of entries) {
        const r = resolveEnvironment(c.application, c.environment);
        const req = loadRequirements().find((q) => q.id === c.requirementId);
        const hash = req ? evaluate(root, req, loadTestCases().filter((d) => d.requirementId === req.id)).record?.approval?.hash : undefined;
        const problem = r.ok && hash ? confirmationProblem(root, r.env, c.requirementId, hash) : 'không đánh giá được (môi trường hoặc phê duyệt không còn hợp lệ)';
        console.log(`  ${c.environment} / ${c.requirementId} — xác nhận bởi ${c.by} lúc ${c.at} — ${problem ? `KHÔNG HỢP LỆ: ${problem}` : 'HỢP LỆ'}`);
      }
      if (s.selected) {
        const k = s.selected.environment;
        console.log(`Nơi lưu riêng của ${k}: .auth/${k}/ · reports/${k}/ · ${path.relative(root, registryPathFor(k))} · testdata/fixtures/${k}/`);
      }
      return;
    }
    case 'revoke': {
      const key = arg('env') ?? fail('thiếu --env=<TÊN>');
      revokeConfirmation(root, key, arg('requirement'));
      console.log(`Đã thu hồi xác nhận thực thi của ${key}${arg('requirement') ? ` cho ${arg('requirement')}` : ''}.`);
      return;
    }
    case 'clear': {
      clearSelection(root);
      console.log('Đã bỏ chọn môi trường. Đóng trình duyệt Playwright MCP đang mở nếu có.');
      return;
    }
    case 'adopt-legacy': {
      const app = pickApp();
      const e = resolveOrFail(app, arg('env'));
      const legacy = path.resolve('testdata', 'registry.jsonl');
      const target = registryPathFor(e.key);
      if (!fs.existsSync(legacy)) fail('không có sổ dữ liệu test cũ (testdata/registry.jsonl) để sao chép.');
      if (fs.existsSync(target)) fail(`${path.relative(root, target)} đã tồn tại; không ghi đè.`);
      console.log(`Sổ cũ testdata/registry.jsonl KHÔNG ghi môi trường. Sao chép nó thành sổ của ${e.key} nghĩa là bạn khẳng định mọi bản ghi trong đó được tạo trên ${e.host}.`);
      console.log('Chỉ SAO CHÉP; file cũ giữ nguyên, không xoá/di chuyển gì.');
      const a = await typed(`Gõ lại đúng host "${e.host}" để xác nhận (Enter để hủy): `);
      if (a !== e.host) fail('Host không khớp. Đã hủy.', 2);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(legacy, target, fs.constants.COPYFILE_EXCL);
      console.log(`Đã sao chép sang ${path.relative(root, target)}.`);
      return;
    }
    default:
      fail('lệnh: list | check | select | confirm | status | revoke | clear | adopt-legacy', 2);
  }
}

main();
