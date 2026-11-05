import fs from 'node:fs';
import path from 'node:path';
import { computeCoverage } from '../testcases/coverage';
import { verifyRequirement } from '../testcases/integrity';
import type { Requirement, TestCaseDef } from '../testcases/schema';
import { approve, evaluateAndSync, reject, revise, versionDir, type ApprovalState, type Evaluation } from './approval';

/**
 * Giao diện Web cho Approval Gate: logic QUYẾT ĐỊNH và trang HTML (thuần, không mở cổng mạng; xem server.ts).
 * Backend dùng đúng các hàm approve/revise/reject của approval.ts nên giữ nguyên HMAC, hash, lịch sử (audit) và tự INVALIDATED.
 * Giao diện chỉ là một kênh nhập (channel = 'web-review'); không có đường nào bỏ qua kiểm tra phiên bản/hash/toàn vẹn.
 */
export const WEB_CHANNEL = 'web-review';
export type Decision = 'APPROVE' | 'REVISE' | 'REJECT';

export interface ReviewContext {
  root: string;
  requirement: Requirement;
  defs: TestCaseDef[];
}

export interface DecisionRequest {
  action?: string;
  version?: number;
  hash?: string;
  by?: string;
  comment?: string;
  /** Cụm người dùng gõ trên giao diện (chỉ APPROVE): `APPROVE <REQ> v<N> <12 ký tự đầu hash>`. */
  phrase?: string;
}

export interface ApproveConfirmation {
  requirementId: string;
  version: number;
  hash: string;
  by: string;
}

/** Xác nhận có người thật trước màn hình (hộp thoại hệ điều hành). Claude gọi API không tự bấm được. Mặc định từ chối nếu không có. */
export type HumanConfirm = (info: ApproveConfirmation) => Promise<boolean>;

export interface DecisionResult {
  ok: boolean;
  /** Mã HTTP gợi ý. */
  status: number;
  message: string;
  state?: ApprovalState;
}

export const approvePhrase = (reqId: string, version: number, hash: string) => `APPROVE ${reqId} v${version} ${hash.slice(0, 12)}`;

/** Lý do KHÔNG được trình/duyệt vì thiếu phủ hoặc sai nguyên văn (giống `submit`). Rỗng = đạt. */
export function integrityProblems(ctx: ReviewContext): string[] {
  const { requirement, defs, root } = ctx;
  const cov = computeCoverage([requirement], defs)[0];
  const file = path.join('requirements', `${requirement.application}-${requirement.module}`, `${requirement.id}.json`);
  const integ = fs.existsSync(path.join(root, file)) ? verifyRequirement(file, root).errors : [`thiếu ${file}`];
  return [...cov.errors, ...cov.uncovered.map((u) => `${u} chưa có test case`), ...integ];
}

/** Ghi nhật ký MỌI lần thử (kể cả bị từ chối) vào approvals/<REQ>/web-audit.jsonl (chỉ ghi thêm). */
export function auditAttempt(root: string, reqId: string, entry: Record<string, unknown>) {
  try {
    const dir = path.join(root, 'approvals', reqId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'web-audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), channel: WEB_CHANNEL, ...entry }) + '\n');
  } catch { /* nhật ký phụ không được làm hỏng quyết định */ }
}

/**
 * Xử lý một quyết định. Kiểm tra theo thứ tự: trạng thái hiện tại (đồng bộ INVALIDATED), phiên bản, hash, toàn vẹn, thông tin bắt buộc;
 * APPROVE còn cần cụm xác nhận gõ đúng và xác nhận của người thật. Không bao giờ ném lỗi ra ngoài.
 */
export async function processDecision(ctx: ReviewContext, req: DecisionRequest, confirm: HumanConfirm): Promise<DecisionResult> {
  const { root, requirement, defs } = ctx;
  const refuse = (status: number, message: string, ev?: Evaluation): DecisionResult => {
    auditAttempt(root, requirement.id, { action: req.action, version: req.version, outcome: 'REFUSED', reason: message, by: req.by });
    return { ok: false, status, message, state: ev?.state };
  };
  const action = req.action as Decision;
  if (!['APPROVE', 'REVISE', 'REJECT'].includes(action)) return refuse(400, 'Hành động không hợp lệ (cần APPROVE, REVISE hoặc REJECT).');

  const ev = evaluateAndSync(root, requirement, defs);
  const rec = ev.record;
  if (!rec) return refuse(409, 'Bộ test case chưa được trình duyệt.', ev);
  if (ev.state !== 'PENDING_APPROVAL') return refuse(409, `Không thể quyết định: trạng thái hiện tại là ${ev.state}. ${ev.reason}`, ev);
  if (req.version !== rec.version) return refuse(409, `Phiên bản trên màn hình (v${req.version ?? '?'}) không phải phiên bản đang chờ (v${rec.version}). Tải lại trang.`, ev);
  if (req.hash !== rec.hash || ev.currentHash !== rec.hash) return refuse(409, 'Hash không khớp phiên bản đang chờ hoặc test case đã thay đổi. Tải lại trang; có thể cần trình duyệt lại.', ev);
  const by = (req.by ?? '').trim();
  const comment = (req.comment ?? '').trim();
  if (!by) return refuse(400, 'Phải nhập tên người quyết định.', ev);

  try {
    if (action === 'APPROVE') {
      const problems = integrityProblems(ctx);
      if (problems.length) return refuse(422, `Không APPROVE được vì lỗi toàn vẹn/phủ: ${problems.join('; ')}`, ev);
      if ((req.phrase ?? '').trim() !== approvePhrase(requirement.id, rec.version, rec.hash)) return refuse(400, 'Cụm xác nhận APPROVE không khớp.', ev);
      const human = await confirm({ requirementId: requirement.id, version: rec.version, hash: rec.hash, by });
      if (!human) return refuse(403, 'Chưa có xác nhận của người dùng trên hộp thoại hệ điều hành (bị từ chối, hết thời gian hoặc không hỗ trợ). Dùng lệnh terminal dự phòng: npm run qa:approval -- approve ...', ev);
      const after = approve(root, requirement, defs, { version: rec.version, hash: rec.hash, by, channel: WEB_CHANNEL });
      auditAttempt(root, requirement.id, { action, version: rec.version, outcome: 'APPROVED', by });
      return { ok: true, status: 200, message: `Đã APPROVE ${requirement.id} v${rec.version} bởi ${by}. APPROVE không cấp quyền chọn môi trường hay quyền ghi.`, state: evaluateAndSync(root, requirement, defs).state ?? after.status as ApprovalState };
    }
    if (!comment) return refuse(400, `${action} phải kèm nhận xét/lý do.`, ev);
    (action === 'REVISE' ? revise : reject)(root, requirement.id, by, comment, WEB_CHANNEL);
    auditAttempt(root, requirement.id, { action, version: rec.version, outcome: action === 'REVISE' ? 'REVISION_REQUESTED' : 'REJECTED', by });
    return { ok: true, status: 200, message: action === 'REVISE' ? `Đã ghi yêu cầu chỉnh sửa v${rec.version}. Claude sẽ sửa test case rồi trình duyệt phiên bản mới.` : `Đã từ chối v${rec.version}. Bộ test case không được thực thi.`, state: evaluateAndSync(root, requirement, defs).state };
  } catch (e) {
    return refuse(500, `Lỗi khi ghi quyết định: ${(e as Error).message}`, ev);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const list = (a: string[], ol = false) => (a.length ? `<${ol ? 'ol' : 'ul'}>${a.map((x) => `<li>${esc(x)}</li>`).join('')}</${ol ? 'ol' : 'ul'}>` : '<i>(không có)</i>');
const BADGE: Record<string, string> = { PENDING_APPROVAL: 'wait', APPROVED: 'ok', PENDING_STALE: 'bad', INVALIDATED: 'bad', REVISION_REQUESTED: 'wait', REJECTED: 'bad', NOT_SUBMITTED: 'bad', SIGNATURE_INVALID: 'bad', KEY_MISSING: 'bad' };

export interface PageModel {
  nonce: string;
  ctx: ReviewContext;
  ev: Evaluation;
}

/** Trạng thái rút gọn (JSON) cho trang tự làm mới. */
export function stateJson(ctx: ReviewContext) {
  const ev = evaluateAndSync(ctx.root, ctx.requirement, ctx.defs);
  return { requirementId: ctx.requirement.id, state: ev.state, ok: ev.ok, reason: ev.reason, version: ev.record?.version, hash: ev.record?.hash, currentHash: ev.currentHash, testCases: ctx.defs.length };
}

export function renderReviewPage({ nonce, ctx, ev }: PageModel): string {
  const { requirement: r, defs } = ctx;
  const rec = ev.record;
  const cov = computeCoverage([r], defs)[0];
  const modules = [...new Set(defs.map((d) => `${d.application ?? '-'}-${d.module ?? '-'}`))].sort();
  const problems = integrityProblems(ctx);
  const pending = ev.state === 'PENDING_APPROVAL';
  const phrase = rec ? approvePhrase(r.id, rec.version, rec.hash) : '';
  const hist = (rec?.history ?? []).map((h) => `<tr><td>${esc(new Date(h.at).toLocaleString('vi-VN'))}</td><td>${esc(h.action)}</td><td>v${h.version}</td><td>${esc(h.by)}</td><td>${esc(h.channel ?? '')}</td><td>${esc(h.comment ?? '')}</td></tr>`).join('');
  const covRows = cov.items.map((i) => `<tr class="${i.testCases.length ? '' : 'miss'}"><td>${esc(i.id)}</td><td>${esc(i.text)}</td><td>${i.testCases.length ? i.testCases.map(esc).join(', ') : '<b>CHƯA CÓ</b>'}</td></tr>`).join('');
  const mods = modules.map((m) => {
    const mine = defs.filter((d) => `${d.application ?? '-'}-${d.module ?? '-'}` === m).sort((a, b) => a.id.localeCompare(b.id));
    return `<section class="mod" data-module="${esc(m)}"><h3>Module ${esc(m)} <small>${mine.length} test case</small></h3>${mine.map((d) => `<details class="tc" data-tc="${esc(d.id)}"><summary><b>${esc(d.id)}</b> — ${esc(d.title)} <em>${esc(d.requirementRefs.join(', '))}</em> <em>${esc(d.verification)}</em>${d.needsClarification ? ' <em class="nc">Cần làm rõ</em>' : ''}</summary>
<p>${esc(d.description)}</p><h4>Điều kiện tiên quyết</h4>${list(d.preconditions)}${Object.keys(d.testData ?? {}).length ? `<h4>Dữ liệu kiểm thử</h4><pre>${esc(JSON.stringify(d.testData, null, 2))}</pre>` : ''}<h4>Các bước</h4>${list(d.steps, true)}<h4>Kết quả mong đợi</h4><p>${esc(d.expectedResult)}</p>${d.needsClarification ? `<p class="nc">Cần làm rõ: ${esc(d.needsClarification)}</p>` : ''}</details>`).join('')}</section>`;
  }).join('');

  const form = pending && rec && !problems.length ? `<form id="decision" autocomplete="off">
<h2>Quyết định của bạn</h2>
<label>Tên người quyết định (bắt buộc)<input id="by" required maxlength="80"></label>
<label>Nhận xét / lý do (bắt buộc với REVISE và REJECT)<textarea id="comment" rows="3" maxlength="4000"></textarea></label>
<div class="apv"><label>Để APPROVE, gõ đúng cụm: <code>${esc(phrase)}</code><input id="phrase" spellcheck="false"></label>
<p class="note">Sau khi bấm APPROVE, một <b>hộp thoại trên màn hình máy này</b> sẽ hỏi lại; bạn phải bấm "Yes/Duyệt" ở đó. APPROVE chỉ cho phép dùng bộ test case này, KHÔNG chọn môi trường và KHÔNG cấp quyền ghi dữ liệu.</p></div>
<div class="btns"><button type="button" id="approve" class="a">APPROVE</button><button type="button" id="revise" class="r">REVISE (yêu cầu sửa)</button><button type="button" id="reject" class="x">REJECT (từ chối)</button></div>
<p id="msg" role="status"></p></form>` : `<section class="locked"><h2>Không thể quyết định lúc này</h2><p>${problems.length ? `Lỗi toàn vẹn/phủ: ${esc(problems.join('; '))}` : esc(ev.reason)}</p>${ev.state === 'APPROVED' ? '<p>Đã duyệt. Quay lại Claude để tiếp tục Giai đoạn 2 (chọn và xác nhận môi trường).</p>' : ''}</section>`;

  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review &amp; Approval ${esc(r.id)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666;--bd:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--wait:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9aa4af;--bd:#30363d;--ok:#3fb950;--bad:#f85149;--wait:#d29922}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:22px 0 6px}h3{font-size:15px}h4{margin:10px 0 2px;font-size:13px}.mut{color:var(--mut)}
code,pre{font:12px ui-monospace,monospace;background:rgba(127,127,127,.15);padding:2px 5px;border-radius:4px;word-break:break-all}pre{padding:8px;overflow:auto}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-weight:600;border:1px solid currentColor}.badge.ok{color:var(--ok)}.badge.bad{color:var(--bad)}.badge.wait{color:var(--wait)}
table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--bd);padding:4px 8px;text-align:left;vertical-align:top}tr.miss td{background:rgba(207,34,46,.15)}
details.tc{border:1px solid var(--bd);border-radius:6px;margin:6px 0;padding:6px 10px}summary{cursor:pointer}em{font-style:normal;font-size:12px;border:1px solid var(--bd);border-radius:10px;padding:0 6px;margin-left:4px}em.nc,p.nc{color:var(--wait)}
form label{display:block;margin:8px 0;font-weight:600}input,textarea{display:block;width:100%;box-sizing:border-box;padding:6px;margin-top:4px;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:4px}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}button{padding:8px 16px;border-radius:6px;border:1px solid var(--bd);font:inherit;font-weight:600;cursor:pointer;background:var(--bg);color:var(--fg)}
button.a{background:var(--ok);color:#fff}button.r{border-color:var(--wait);color:var(--wait)}button.x{border-color:var(--bad);color:var(--bad)}button:disabled{opacity:.5;cursor:not-allowed}
.note{color:var(--mut);font-size:13px}#msg{font-weight:600}#msg.err{color:var(--bad)}#msg.ok{color:var(--ok)}.locked,.apv{border:1px dashed var(--bd);border-radius:6px;padding:4px 12px;margin-top:10px}.banner{display:none;background:rgba(207,34,46,.15);border:1px solid var(--bad);padding:8px 12px;border-radius:6px;margin:10px 0}.banner.show{display:block}
</style></head><body><div class="wrap" data-nonce="${esc(nonce)}">
<h1>Review &amp; Approval: <span id="reqid">${esc(r.id)}</span></h1><p class="mut">${esc(r.title)} · ${esc(r.application)}/${esc(r.module)}</p>
<div id="stale" class="banner" role="alert">Trạng thái đã đổi (test case thay đổi hoặc đã có quyết định). Tải lại trang để xem phiên bản mới nhất.</div>
<table class="meta"><tr><th>Requirement ID</th><td>${esc(r.id)}</td><th>Phiên bản</th><td id="version" data-version="${rec?.version ?? ''}">${rec ? `v${rec.version}` : '—'}</td></tr>
<tr><th>Hash (sha256)</th><td colspan="3"><code id="hash" data-hash="${esc(rec?.hash ?? '')}">${esc(rec?.hash ?? '(chưa trình duyệt)')}</code></td></tr>
<tr><th>Trạng thái</th><td><span class="badge ${BADGE[ev.state] ?? 'bad'}" id="state">${esc(ev.state)}</span></td><th>Số test case</th><td>${defs.length} (${modules.length} module)</td></tr>
<tr><th>Lý do/ghi chú</th><td colspan="3">${esc(ev.reason)}</td></tr></table>
${problems.length ? `<div class="banner show" role="alert"><b>Lỗi toàn vẹn/phủ:</b> ${esc(problems.join('; '))}</div>` : ''}
<h2>Phủ BR/AC <small class="mut">${cov.items.length - cov.uncovered.length}/${cov.items.length} đã có test case</small></h2><table id="coverage"><tr><th>Mã</th><th>Nội dung</th><th>Test case</th></tr>${covRows}</table>
<h2>Test case theo module</h2>${mods}
<h2>Lịch sử phê duyệt (audit)</h2><table id="history"><tr><th>Thời gian</th><th>Hành động</th><th>Phiên bản</th><th>Người</th><th>Kênh</th><th>Nhận xét</th></tr>${hist || '<tr><td colspan="6"><i>Chưa có</i></td></tr>'}</table>
${form}
<p class="mut">Phiên bản review đầy đủ: ${rec ? esc(path.relative(ctx.root, versionDir(ctx.root, r.id, rec.version)).split(path.sep).join('/')) : '—'}. Phương án dự phòng: <code>npm run qa:approval -- approve --requirement=${esc(r.id)} --version=${rec?.version ?? 'N'} --hash=&lt;sha256&gt;</code></p></div>
<script>
(()=>{const $=s=>document.querySelector(s),nonce=document.querySelector('.wrap').dataset.nonce,ver=Number($('#version').dataset.version)||undefined,hash=$('#hash').dataset.hash,msg=$('#msg');
async function send(action){if(!msg)return;msg.className='';msg.textContent=action==='APPROVE'?'Đang chờ bạn xác nhận ở hộp thoại trên màn hình...':'Đang gửi...';document.querySelectorAll('#decision button').forEach(b=>b.disabled=true);
 try{const r=await fetch(location.pathname.replace(/\\/$/,'')+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,nonce,version:ver,hash,by:$('#by').value,comment:$('#comment').value,phrase:$('#phrase')?$('#phrase').value:''})});
  const j=await r.json();msg.className=j.ok?'ok':'err';msg.textContent=j.message;if(!j.ok)document.querySelectorAll('#decision button').forEach(b=>b.disabled=false);else setTimeout(()=>location.reload(),1200)}
 catch(e){msg.className='err';msg.textContent='Không gửi được: '+e;document.querySelectorAll('#decision button').forEach(b=>b.disabled=false)}}
for(const [id,a] of [['approve','APPROVE'],['revise','REVISE'],['reject','REJECT']]){const b=$('#'+id);if(b)b.onclick=()=>send(a)}
setInterval(async()=>{try{const j=await (await fetch(location.pathname.replace(/\\/$/,'')+'/state')).json();if(j.state!==$('#state').textContent||(j.hash&&j.hash!==hash))$('#stale').classList.add('show')}catch{}},3000)})();
</script></body></html>`;
}
