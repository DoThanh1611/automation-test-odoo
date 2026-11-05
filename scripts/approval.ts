import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import '../core/config/env'; // nạp .env: hook cần biết URL/host của môi trường đã chọn để so khớp URL và chính sách
import { approve, evaluateAndSync, listRecords, readRecord, reject, revise, submit, versionDir } from '../core/approval/approval';
import { beginExecution, endExecution, executionProblem } from '../core/approval/gate';
import { mcpEnvironment, urlProblem } from '../core/environment/state';
import { auditMcpWrite, mcpWriteIntent, mcpWriteProblem } from '../core/policy/mcp';
import { computeCoverage } from '../core/testcases/coverage';
import { verifyRequirement } from '../core/testcases/integrity';
import { loadRequirements, loadTestCases } from '../core/testcases/loader';

// Approval Gate: bộ test case phải được người dùng duyệt trước khi kết nối staging / khám phá UI / chạy automation.
//   npm run qa:approval -- submit  --requirement=REQ-XXX                 # sinh Markdown review, trạng thái PENDING_APPROVAL
//   npm run qa:approval -- status  [--requirement=REQ-XXX]               # trạng thái, hiệu lực, lịch sử
//   npm run qa:approval -- approve --requirement=REQ-XXX --version=N --hash=<sha256>   # CHỈ người dùng, cần bàn phím thật
//   npm run qa:approval -- revise  --requirement=REQ-XXX --by="Tên" --comment="..."
//   npm run qa:approval -- reject  --requirement=REQ-XXX --by="Tên" --comment="..."
//   npm run qa:approval -- begin   --requirement=REQ-XXX                 # mở phiên thực thi (chỉ khi phê duyệt hợp lệ)
//   (Môi trường: npm run qa:env -- select/confirm; hook MCP chỉ cho qua khi môi trường đã chọn và được xác nhận riêng)
//   npm run qa:approval -- end                                           # đóng phiên thực thi
const root = process.cwd();
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n: string) => rest.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const fail = (m: string, code = 1): never => {
  console.error(`Lỗi: ${m}`);
  process.exit(code);
};
const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');
const link = (p: string) => `${rel(p)}  (${path.resolve(p).split(path.sep).join('/')})`;

function context(reqId: string | undefined) {
  if (!reqId) fail('thiếu --requirement=REQ-XXX');
  const requirement = loadRequirements().find((r) => r.id === reqId);
  if (!requirement) return fail(`không có requirement ${reqId}`);
  const defs = loadTestCases().filter((d) => d.requirementId === reqId);
  return { requirement, defs };
}

function printStatus(reqId: string) {
  const { requirement, defs } = context(reqId);
  const ev = evaluateAndSync(root, requirement, defs);
  console.log(`\n${reqId} — ${requirement.title}`);
  console.log(`  Trạng thái: ${ev.state}${ev.ok ? ' (HỢP LỆ, được phép thực thi)' : ' (KHÔNG được thực thi)'}`);
  console.log(`  Lý do     : ${ev.reason}`);
  console.log(`  Test case : ${defs.length} | hash hiện tại ${ev.currentHash}`);
  const rec = ev.record;
  if (rec) {
    console.log(`  Phiên bản : v${rec.version} (hash đã trình duyệt ${rec.hash})`);
    if (rec.approval) console.log(`  Đã duyệt  : v${rec.approval.version} bởi ${rec.approval.by} lúc ${rec.approval.at} (${rec.approval.channel})`);
    console.log('  Lịch sử:');
    for (const h of rec.history) console.log(`    ${h.at}  ${h.action.padEnd(10)} v${h.version}  ${h.by}${h.comment ? `  — ${h.comment}` : ''}  [${h.hash.slice(0, 12)}]`);
    if (rec.status === 'PENDING_APPROVAL' || ev.state === 'PENDING_STALE') {
      const dir = versionDir(root, reqId, rec.version);
      if (fs.existsSync(dir)) {
        console.log('  File để review:');
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) console.log(`    ${link(path.join(dir, f))}`);
      }
    }
  }
  return ev;
}

async function main() {
  switch (cmd) {
    case 'submit': {
      const { requirement, defs } = context(arg('requirement'));
      const cov = computeCoverage([requirement], defs)[0];
      const integrity = verifyRequirement(path.join('requirements', `${requirement.application}-${requirement.module}`, `${requirement.id}.json`), root);
      const problems = [...cov.errors, ...cov.uncovered.map((u) => `${u} chưa có test case`), ...integrity.errors];
      if (!defs.length) problems.push('chưa có test case nào');
      if (problems.length) {
        console.error('CHƯA trình duyệt được; sửa các điểm sau rồi chạy lại:');
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
      }
      try {
        const res = submit(root, requirement, defs);
        console.log(res.created ? `Đã trình duyệt ${requirement.id} phiên bản v${res.record.version}: PENDING_APPROVAL.` : `${requirement.id} v${res.record.version} đã ở trạng thái ${res.record.status} với đúng bộ test case hiện tại; không tạo phiên bản mới.`);
        console.log(`Hash: ${res.record.hash}\nSố test case: ${defs.length}`);
        console.log('File để review (mở trực tiếp):');
        for (const f of res.files.filter((x) => x.endsWith('.md'))) console.log(`  ${link(f)}`);
        if (res.record.status === 'PENDING_APPROVAL') {
          console.log(`\nGIAO DIỆN WEB để review và duyệt (chạy nền; mở trình duyệt và in link): npm run qa:review -- --requirement=${requirement.id}`);
          console.log('\nDỪNG: chưa được kết nối staging, gọi Playwright MCP hay chạy automation. Người dùng quyết định (xem REVIEW.md):');
          console.log(`  npm run qa:approval -- approve --requirement=${requirement.id} --version=${res.record.version} --hash=${res.record.hash}`);
        }
      } catch (e) {
        fail((e as Error).message);
      }
      return;
    }
    case 'status': {
      const only = arg('requirement');
      const ids = only ? [only] : [...new Set([...loadRequirements().map((r) => r.id), ...listRecords(root).map((r) => r.requirementId)])];
      if (!ids.length) console.log('Chưa có requirement nào.');
      for (const id of ids) printStatus(id);
      return;
    }
    case 'approve': {
      const { requirement, defs } = context(arg('requirement'));
      const version = Number(arg('version'));
      const hash = arg('hash') ?? '';
      const rec = readRecord(root, requirement.id);
      if (!rec || rec.status !== 'PENDING_APPROVAL') fail(`${requirement.id} không ở trạng thái PENDING_APPROVAL (hiện: ${rec?.status ?? 'chưa trình duyệt'}).`);
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fail('APPROVE phải do NGƯỜI DÙNG thực hiện trong terminal có bàn phím (Claude/tự động hóa không được tự duyệt). Mở terminal của bạn và chạy lại lệnh này.', 2);
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(`\nDUYỆT ${requirement.id} v${version}: ${defs.length} test case, hash ${hash}`);
      console.log(`Đã đọc file review trong ${rel(versionDir(root, requirement.id, rec!.version))}? APPROVE không cấp quyền ghi dữ liệu lên staging.`);
      const by = (arg('by') ?? (await rl.question('Tên người duyệt: '))).trim();
      const phrase = `APPROVE ${requirement.id} v${version} ${hash.slice(0, 12)}`;
      const typed = (await rl.question(`Gõ đúng "${phrase}" để xác nhận (Enter để hủy): `)).trim();
      rl.close();
      if (typed !== phrase) fail('Cụm xác nhận không khớp. Đã hủy, chưa duyệt.', 2);
      try {
        approve(root, requirement, defs, { version, hash, by, channel: 'interactive-terminal' });
        console.log(`\nĐã APPROVE ${requirement.id} v${version} bởi ${by}. Bây giờ có thể mở phiên thực thi: npm run qa:approval -- begin --requirement=${requirement.id}`);
      } catch (e) {
        fail((e as Error).message);
      }
      return;
    }
    case 'revise':
    case 'reject': {
      const id = arg('requirement');
      context(id);
      try {
        const fn = cmd === 'revise' ? revise : reject;
        const rec = fn(root, id!, arg('by') ?? '', arg('comment') ?? '', arg('channel') ?? 'cli');
        console.log(`Đã ghi ${cmd.toUpperCase()} cho ${id} v${rec.version}: ${rec.status}. Mọi phiên bản và test case cũ được giữ nguyên.`);
        console.log(cmd === 'revise' ? 'Sửa test case theo nhận xét rồi chạy lại `submit` để tạo phiên bản mới.' : 'Bộ test case này không được thực thi.');
      } catch (e) {
        fail((e as Error).message);
      }
      return;
    }
    case 'begin': {
      const { requirement, defs } = context(arg('requirement'));
      try {
        const m = beginExecution(root, requirement, defs);
        console.log(`Đã mở phiên thực thi cho ${m.requirementId} (đã duyệt v${m.version}, hash ${m.hash.slice(0, 12)}…). Chưa được kết nối: còn phải CHỌN và XÁC NHẬN môi trường: mở giao diện web (npm run qa:env-web -- --requirement=${m.requirementId}) để người dùng tự bấm xác nhận; dự phòng terminal: npm run qa:env -- select --env=<TÊN> rồi npm run qa:env -- confirm --env=<TÊN> --requirement=${m.requirementId}.`);
        console.log('Thao tác GHI dữ liệu staging vẫn cần xác nhận quyền ghi riêng (npm run test:write), không suy ra từ APPROVE.');
      } catch (e) {
        fail((e as Error).message);
      }
      return;
    }
    case 'end': {
      endExecution(root);
      console.log('Đã đóng phiên thực thi.');
      return;
    }
    case 'hook': {
      // Hook PreToolUse của Claude Code cho mcp__playwright__*: exit 2 = chặn. Mọi lỗi cũng chặn (fail-closed).
      try {
        const input = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '') || '{}') as { tool_name?: string; cwd?: string; tool_input?: unknown };
        if (!input.tool_name?.startsWith('mcp__playwright__')) process.exit(0);
        process.chdir(process.env.CLAUDE_PROJECT_DIR || root);
        const problem = executionProblem(process.cwd(), loadRequirements(), loadTestCases());
        if (problem) {
          console.error(`APPROVAL GATE: chặn ${input.tool_name}. ${problem}`);
          process.exit(2);
        }
        // Môi trường: phải chọn + xác nhận thực thi RIÊNG cho môi trường đó, và mọi URL trong lệnh phải thuộc đúng môi trường đã chọn.
        const target = mcpEnvironment(process.cwd(), loadRequirements(), loadTestCases());
        if (!target.env) {
          console.error(`ENVIRONMENT GATE: chặn ${input.tool_name}. ${target.problem ?? "môi trường không xác định"}`);
          process.exit(2);
        }
        const wrongUrl = urlProblem(input.tool_input, target.env);
        if (wrongUrl) {
          console.error(`ENVIRONMENT GATE: chặn ${input.tool_name}. ${wrongUrl}`);
          process.exit(2);
        }
        // WRITE POLICY GATE: thao tác có Ý ĐỊNH GHI qua MCP cần chính sách ghi đã được người dùng xác nhận (cùng cổng với npm run test:write).
        const intent = mcpWriteIntent(input.tool_name, input.tool_input);
        if (intent) {
          const w = mcpWriteProblem(process.cwd(), target.env, loadRequirements(), loadTestCases());
          if (!w.ok) {
            console.error(`WRITE POLICY GATE: chặn ${input.tool_name} vì có ý định ghi dữ liệu (${intent}). ${w.problem} Việc này cần người dùng tự chạy: npm run qa:policy -- confirm --env=${target.env.key} --requirement=<REQ-ID>.`);
            process.exit(2);
          }
          auditMcpWrite(process.cwd(), { tool: input.tool_name, intent, environment: target.env.key, requirementId: w.requirementId, sessionId: w.sessionId });
        }
        process.exit(0);
      } catch (e) {
        console.error(`APPROVAL GATE: không kiểm tra được phê duyệt (${(e as Error).message}); chặn để an toàn.`);
        process.exit(2);
      }
      return;
    }
    default:
      fail('lệnh: submit | status | approve | revise | reject | begin | end', 2);
  }
}

main();
