import { evaluate } from '../approval/approval';
import { auditAttempt } from '../approval/web';
import { confirmPolicy, describePolicy, effectivePolicy, policyCheck, productionReason, type EffectivePolicy } from '../policy/policy';
import type { Requirement, TestCaseDef } from '../testcases/schema';
import { listEnvironmentKeys, loadEnvironmentsFile, resolveEnvironment, type EnvKind, type ResolvedEnvironment } from './config';
import { confirmExecution, confirmPhrase, confirmationProblem, readState, selectEnvironment } from './state';

/**
 * Giao diện Web chọn môi trường + xác nhận chính sách ghi (logic thuần, không mở cổng mạng; xem server.ts).
 * Backend GỌI LẠI đúng các hàm của lệnh terminal (selectEnvironment, confirmExecution, confirmPolicy) nên giữ nguyên chữ ký HMAC,
 * ràng buộc hash phê duyệt/host, thời hạn và production-không-bao-giờ-ghi. Giao diện chỉ là một kênh nhập (channel = 'web-env').
 * Hai xác nhận là HAI hành động riêng, mỗi hành động một hộp thoại hệ điều hành riêng; xác nhận môi trường không suy ra chính sách ghi.
 * Không bao giờ đưa mật khẩu, tên đăng nhập, token hay giá trị biến .env ra giao diện: chỉ tên vai trò và trạng thái đã/chưa cấu hình.
 */
export const ENV_CHANNEL = 'web-env';

export interface EnvWebContext {
  root: string;
  app: string;
  requirement: Requirement;
  defs: TestCaseDef[];
  /** Mô tả vai trò theo ứng dụng (ví dụ "Kế toán"); core không biết ứng dụng nên được truyền vào. */
  roleDescription?: (role: string) => string | undefined;
  source?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface RoleCard {
  role: string;
  description: string;
  /** Đã có đủ biến tài khoản trong .env (chỉ true/false, không có giá trị). */
  configured: boolean;
  /** TÊN biến .env còn thiếu của vai trò (không bao giờ có giá trị). */
  missingVars?: string[];
}

export interface EnvCard {
  key: string;
  label: string;
  kind: EnvKind;
  application: string;
  host?: string;
  expectedVersion?: string;
  roles: RoleCard[];
  /** Dùng được: cấu hình đủ để giải ra URL/phiên bản/tài khoản. false => chỉ hiện tên biến còn thiếu, không chọn được. */
  usable: boolean;
  problems: string[];
  selected: boolean;
  exec: { valid: boolean; detail: string; by?: string; at?: string };
  write: {
    /** Được phép xác nhận ghi trên môi trường này (chính sách hiệu lực khác none và không phải production). */
    eligible: boolean;
    scope: EffectivePolicy['write'];
    autoCleanup: boolean;
    reasons: string[];
    valid: boolean;
    detail: string;
    expiresAt?: string;
    by?: string;
  };
}

const ckey = (env: string, req: string) => `${env}|${req}`;

export function approvalHashOf(ctx: EnvWebContext): string | undefined {
  const ev = evaluate(ctx.root, ctx.requirement, ctx.defs);
  return ev.ok ? ev.record?.approval?.hash : undefined;
}

export function buildEnvCards(ctx: EnvWebContext): EnvCard[] {
  const source = ctx.source ?? process.env;
  const now = ctx.now?.() ?? Date.now();
  const file = loadEnvironmentsFile(ctx.app);
  const state = readState(ctx.root);
  const hash = approvalHashOf(ctx);
  return listEnvironmentKeys(ctx.app).map((key) => {
    const def = file!.environments[key];
    const r = resolveEnvironment(ctx.app, key, source);
    const roles: RoleCard[] = Object.entries(def.roles ?? {}).map(([role, ref]) => ({
      role,
      description: ctx.roleDescription?.(role) ?? role,
      configured: Boolean(source[ref.userVar]) && Boolean(source[ref.passVar]),
      missingVars: [ref.userVar, ref.passVar].filter((v) => !source[v]),
    }));
    const base = { key, label: def.label, kind: def.kind, application: ctx.app, roles, selected: state.selected?.environment === key && state.selected.application === ctx.app };
    if (!r.ok) {
      return { ...base, usable: false, problems: r.problems, exec: { valid: false, detail: 'Cấu hình chưa đủ' }, write: { eligible: false, scope: 'none', autoCleanup: false, reasons: ['Cấu hình môi trường chưa đủ.'], valid: false, detail: 'Cấu hình chưa đủ' } } satisfies EnvCard;
    }
    const env = r.env;
    const execProblem = hash ? confirmationProblem(ctx.root, env, ctx.requirement.id, hash, now) : 'Requirement chưa có phê duyệt hợp lệ.';
    const execConf = state.confirmations[ckey(key, ctx.requirement.id)];
    const eff = effectivePolicy(env, source);
    const pol = hash ? policyCheck(ctx.root, env, ctx.requirement.id, hash, now, source) : undefined;
    const eligible = eff.write !== 'none';
    return {
      ...base,
      host: env.host,
      expectedVersion: env.expectedVersion,
      usable: true,
      problems: [],
      exec: execProblem
        ? { valid: false, detail: execConf ? `Cần xác nhận lại: ${execProblem.split(' Người dùng')[0].split(' Cần xác nhận lại')[0]}` : 'Chưa xác nhận' }
        : { valid: true, detail: `Đã xác nhận bởi ${execConf?.by}`, by: execConf?.by, at: execConf?.at },
      write: {
        eligible,
        scope: eff.write,
        autoCleanup: eff.autoCleanup,
        reasons: eff.reasons,
        valid: Boolean(pol?.ok),
        detail: !eligible ? 'Môi trường chỉ đọc (không có quyền ghi tự động)' : pol?.ok ? `Đã xác nhận bởi ${pol.confirmation?.by}` : 'Chưa xác nhận',
        expiresAt: pol?.ok ? pol.confirmation?.expiresAt : undefined,
        by: pol?.ok ? pol.confirmation?.by : undefined,
      },
    } satisfies EnvCard;
  });
}

export interface SessionStatus {
  approvalOk: boolean;
  approvalReason: string;
  selected?: string;
  envValid: boolean;
  envDetail: string;
  policyEligible: boolean;
  policyValid: boolean;
  /** Mọi thứ cần cho lần chạy đã có: có thể tiếp tục Giai đoạn 2, không hỏi lại. */
  satisfied: boolean;
}

/** Trạng thái dùng lại: môi trường đang chọn đã được xác nhận hợp lệ (và chính sách ghi nếu cần)? Hết hạn/đổi cấu hình => không còn hợp lệ. */
export function sessionStatus(ctx: EnvWebContext, needWrite = false): SessionStatus {
  const ev = evaluate(ctx.root, ctx.requirement, ctx.defs);
  const sel = readState(ctx.root).selected;
  const out: SessionStatus = { approvalOk: ev.ok, approvalReason: ev.reason, selected: sel?.environment, envValid: false, envDetail: 'Chưa chọn môi trường', policyEligible: false, policyValid: false, satisfied: false };
  if (!ev.ok || !ev.record?.approval) return out;
  if (!sel || sel.application !== ctx.app) return out;
  const card = buildEnvCards(ctx).find((c) => c.key === sel.environment);
  if (!card || !card.usable) return { ...out, envDetail: `Môi trường đã chọn ${sel.environment} không còn hợp lệ` };
  out.envValid = card.exec.valid;
  out.envDetail = card.exec.detail;
  out.policyEligible = card.write.eligible;
  out.policyValid = card.write.valid;
  out.satisfied = out.envValid && (!needWrite || !out.policyEligible || out.policyValid);
  return out;
}

export interface EnvDecisionRequest {
  action?: string;
  environment?: string;
  by?: string;
}

export interface EnvDecisionResult {
  ok: boolean;
  status: number;
  message: string;
}

export interface EnvHumanConfirmInfo {
  kind: 'ENV' | 'POLICY';
  requirementId: string;
  environment: string;
  label: string;
  envKind: EnvKind;
  host: string;
  by: string;
  roles: string[];
  /** Với POLICY: các dòng mô tả chính sách sẽ được cấp. */
  policyLines: string[];
}

/** Xác nhận có người thật trước màn hình (hộp thoại hệ điều hành). Mặc định từ chối. Mỗi hành động một hộp thoại riêng. */
export type EnvHumanConfirm = (info: EnvHumanConfirmInfo) => Promise<boolean>;

/**
 * Xử lý một hành động. Thứ tự: hành động hợp lệ → phê duyệt hợp lệ → môi trường tồn tại và dùng được → tên người xác nhận →
 * (POLICY) môi trường là môi trường đang chọn và được phép ghi → xác nhận của người thật → ghi bằng đúng hàm của lệnh terminal.
 * Không bao giờ ném lỗi ra ngoài; mọi lần thử (kể cả bị từ chối) vào nhật ký approvals/<REQ>/web-audit.jsonl.
 */
export async function processEnvDecision(ctx: EnvWebContext, req: EnvDecisionRequest, confirm: EnvHumanConfirm): Promise<EnvDecisionResult> {
  const source = ctx.source ?? process.env;
  const audit = (entry: Record<string, unknown>) => auditAttempt(ctx.root, ctx.requirement.id, { channel: ENV_CHANNEL, action: req.action, environment: req.environment, by: req.by, ...entry });
  const refuse = (status: number, message: string): EnvDecisionResult => {
    audit({ outcome: 'REFUSED', reason: message });
    return { ok: false, status, message };
  };
  if (req.action !== 'CONFIRM_ENV' && req.action !== 'CONFIRM_POLICY') return refuse(400, 'Hành động không hợp lệ (cần CONFIRM_ENV hoặc CONFIRM_POLICY).');
  const ev = evaluate(ctx.root, ctx.requirement, ctx.defs);
  if (!ev.ok || !ev.record?.approval) return refuse(409, `${ctx.requirement.id} chưa có phê duyệt hợp lệ (${ev.state}): ${ev.reason} Phê duyệt phải xong trước khi xác nhận môi trường.`);
  const approvalHash = ev.record.approval.hash;
  const key = req.environment ?? '';
  if (!listEnvironmentKeys(ctx.app).includes(key)) return refuse(400, `Môi trường "${key}" không có trong environments/${ctx.app}.json.`);
  const r = resolveEnvironment(ctx.app, key, source);
  if (!r.ok) return refuse(422, `Môi trường ${key} chưa dùng được: ${r.problems.join('; ')}`);
  const env: ResolvedEnvironment = r.env;
  const by = (req.by ?? '').trim();
  if (!by) return refuse(400, 'Phải nhập tên người xác nhận.');
  const roles = Object.keys(env.roles);

  try {
    if (req.action === 'CONFIRM_ENV') {
      const human = await confirm({ kind: 'ENV', requirementId: ctx.requirement.id, environment: env.key, label: env.label, envKind: env.kind, host: env.host, by, roles, policyLines: [] });
      if (!human) return refuse(403, 'Chưa có xác nhận của người dùng trên hộp thoại hệ điều hành (bị từ chối, hết thời gian hoặc không hỗ trợ). Dùng lệnh terminal dự phòng: npm run qa:env -- select/confirm.');
      const sel = selectEnvironment(ctx.root, ctx.app, env.key, source);
      confirmExecution(ctx.root, { env, requirementId: ctx.requirement.id, approvalHash, by, typed: confirmPhrase(env) });
      audit({ outcome: 'ENV_CONFIRMED', by, host: env.host, approvalHash: approvalHash.slice(0, 12) });
      return {
        ok: true,
        status: 200,
        message: `Đã chọn và xác nhận môi trường ${env.key} (${env.host}) cho ${ctx.requirement.id}, hiệu lực 24 giờ.${sel.changed ? ` Đã đổi từ ${sel.previous}: trình duyệt Playwright MCP đang mở phải được đóng và dùng phiên mới.` : ''} Xác nhận này KHÔNG cấp quyền ghi dữ liệu.`,
      };
    }
    // CONFIRM_POLICY
    const selected = readState(ctx.root).selected;
    if (!selected || selected.application !== ctx.app || selected.environment !== env.key) return refuse(409, `Môi trường ${env.key} chưa được chọn. Chọn và xác nhận môi trường trước (hành động riêng), rồi mới xác nhận chính sách ghi.`);
    const eff = effectivePolicy(env, source);
    if (eff.write === 'none') return refuse(403, `Môi trường ${env.key} không được cấp quyền ghi tự động${productionReason(env, source) ? ' (production)' : ''}. ${eff.reasons.join(' ')}`);
    const human = await confirm({ kind: 'POLICY', requirementId: ctx.requirement.id, environment: env.key, label: env.label, envKind: env.kind, host: env.host, by, roles, policyLines: describePolicy(env, eff) });
    if (!human) return refuse(403, 'Chưa có xác nhận của người dùng trên hộp thoại hệ điều hành (bị từ chối, hết thời gian hoặc không hỗ trợ). Dùng lệnh terminal dự phòng: npm run qa:policy -- confirm.');
    // Dùng đúng cụm của lệnh terminal; người thật đã xác nhận qua hộp thoại riêng.
    const typed = `ALLOW-WRITE ${env.key} ${env.host} ${eff.hash.slice(0, 12)}`;
    const c = confirmPolicy(ctx.root, { env, requirementId: ctx.requirement.id, approvalHash, by, typed }, source);
    audit({ outcome: 'POLICY_CONFIRMED', by, host: env.host, sessionId: c.sessionId, expiresAt: c.expiresAt });
    return { ok: true, status: 200, message: `Đã xác nhận chính sách ghi của ${env.key} cho ${ctx.requirement.id}: phiên ${c.sessionId}, hiệu lực tới ${new Date(c.expiresAt).toLocaleString('vi-VN')}. Chỉ áp dụng cho dữ liệu do framework tạo (trong registry).` };
  } catch (e) {
    return refuse(500, `Lỗi khi ghi xác nhận: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function stateJson(ctx: EnvWebContext) {
  const hash = approvalHashOf(ctx);
  return { requirementId: ctx.requirement.id, approvalHash: hash, cards: buildEnvCards(ctx), status: sessionStatus(ctx, true) };
}

export function renderEnvPage({ nonce, ctx }: { nonce: string; ctx: EnvWebContext }): string {
  const r = ctx.requirement;
  const ev = evaluate(ctx.root, r, ctx.defs);
  const cards = buildEnvCards(ctx);
  const ok = ev.ok;
  const cardHtml = cards.map((c) => {
    const rolesHtml = c.roles.map((x) => `<li data-role="${esc(x.role)}">${esc(x.description)} <code>${esc(x.role)}</code> — ${x.configured ? '<span class="ok">đã cấu hình</span>' : '<span class="bad">chưa cấu hình</span>'}</li>`).join('');
    const disabled = !ok || !c.usable;
    return `<label class="card${c.selected ? ' sel' : ''}${c.usable ? '' : ' off'}" data-env="${esc(c.key)}">
<input type="radio" name="env" value="${esc(c.key)}" ${disabled ? 'disabled' : ''} ${c.selected && c.usable ? 'checked' : ''}>
<div class="hd"><b>${esc(c.key)}</b> <span class="kind ${esc(c.kind)}">${esc(c.kind)}</span> <span class="mut">${esc(c.label)}</span></div>
<table class="kv"><tr><th>Ứng dụng</th><td>${esc(c.application)}</td></tr><tr><th>Host</th><td>${c.host ? `<code>${esc(c.host)}</code>` : '<i>chưa cấu hình</i>'}</td></tr>${c.expectedVersion ? `<tr><th>Phiên bản kỳ vọng</th><td>${esc(c.expectedVersion)}</td></tr>` : ''}</table>
<div class="mut">Vai trò tài khoản:</div><ul class="roles">${rolesHtml || '<li><i>(không có)</i></li>'}</ul>
${c.usable ? '' : `<p class="bad">Chưa dùng được: ${esc(c.problems.join('; '))}</p>`}
<p class="st"><span class="chip ${c.exec.valid ? 'okc' : 'wc'}" data-exec="${c.exec.valid ? 'valid' : 'none'}">Môi trường: ${esc(c.exec.detail)}</span> <span class="chip ${c.write.valid ? 'okc' : c.write.eligible ? 'wc' : 'xc'}" data-write="${c.write.valid ? 'valid' : c.write.eligible ? 'none' : 'readonly'}">Ghi dữ liệu: ${esc(c.write.detail)}</span></p>
</label>`;
  }).join('');

  const reasonBanner = ok ? '' : `<div class="banner show" role="alert"><b>Chưa thể xác nhận môi trường:</b> ${esc(ev.state)} — ${esc(ev.reason)} Cần APPROVE test case trước.</div>`;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chọn môi trường ${esc(r.id)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666;--bd:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--wait:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9aa4af;--bd:#30363d;--ok:#3fb950;--bad:#f85149;--wait:#d29922}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}.wrap{max-width:1000px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:24px 0 6px}.mut{color:var(--mut)}code{font:12px ui-monospace,monospace;background:rgba(127,127,127,.15);padding:1px 5px;border-radius:4px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}.card{display:block;border:1px solid var(--bd);border-radius:8px;padding:10px 12px;cursor:pointer;position:relative}.card.sel{border-color:var(--ok)}.card.off{opacity:.6;cursor:not-allowed}
.card:has(input:checked){outline:2px solid var(--ok)}.card input{position:absolute;right:10px;top:10px}.hd{font-size:15px;padding-right:24px}
.kind{font-size:12px;border:1px solid var(--bd);border-radius:10px;padding:0 8px}.kind.production{color:var(--bad);border-color:var(--bad)}.kind.staging,.kind.test{color:var(--ok)}.kind.uat{color:var(--wait)}
.kv th{text-align:left;color:var(--mut);padding-right:10px;font-weight:400}ul.roles{margin:2px 0 6px;padding-left:18px}.ok{color:var(--ok)}.bad{color:var(--bad)}
.chip{display:inline-block;font-size:12px;border:1px solid var(--bd);border-radius:10px;padding:0 8px;margin:2px 4px 0 0}.chip.okc{color:var(--ok);border-color:var(--ok)}.chip.wc{color:var(--wait);border-color:var(--wait)}.chip.xc{color:var(--mut)}
label.f{display:block;font-weight:600;margin:10px 0}input[type=text]{display:block;width:100%;max-width:360px;box-sizing:border-box;padding:6px;margin-top:4px;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:4px}
button{padding:9px 18px;border-radius:6px;border:1px solid var(--bd);font:inherit;font-weight:600;cursor:pointer;background:var(--bg);color:var(--fg)}button.go{background:var(--ok);color:#fff;border-color:var(--ok)}button.w{background:var(--wait);color:#fff;border-color:var(--wait)}button:disabled{opacity:.5;cursor:not-allowed}
section.box{border:1px solid var(--bd);border-radius:8px;padding:4px 14px 14px;margin-top:14px}.note{color:var(--mut);font-size:13px}.msg{font-weight:600;min-height:1.4em}.msg.err{color:var(--bad)}.msg.ok{color:var(--ok)}
.banner{display:none;background:rgba(207,34,46,.15);border:1px solid var(--bad);padding:8px 12px;border-radius:6px;margin:10px 0}.banner.show{display:block}
</style></head><body><div class="wrap" data-nonce="${esc(nonce)}" data-approved="${ok ? '1' : ''}">
<h1>Chọn môi trường kiểm thử: <span id="reqid">${esc(r.id)}</span></h1><p class="mut">${esc(r.title)} · ${esc(ctx.app)} · phê duyệt: ${esc(ev.state)}</p>
${reasonBanner}
<div id="stale" class="banner" role="alert">Cấu hình hoặc phê duyệt đã đổi. Tải lại trang để xem trạng thái mới nhất.</div>
<h2>1. Chọn và xác nhận môi trường</h2>
<div class="cards" id="cards">${cardHtml}</div>
<section class="box"><label class="f">Tên người xác nhận (bắt buộc)<input type="text" id="by" maxlength="80" autocomplete="off"></label>
<button type="button" id="confirm-env" class="go" ${ok ? '' : 'disabled'}>Xác nhận môi trường</button>
<p class="note">Sau khi bấm, một <b>hộp thoại trên màn hình máy này</b> sẽ hỏi lại; bạn phải bấm "Yes". Xác nhận chỉ cho phép <b>thực thi chỉ đọc</b> trên đúng môi trường và host này, hiệu lực 24 giờ, mất hiệu lực nếu phê duyệt hoặc cấu hình đổi. Nó KHÔNG cho phép ghi dữ liệu.</p>
<p class="msg" id="msg-env" role="status"></p></section>
<h2>2. Chính sách ghi dữ liệu <small class="mut">(không bắt buộc, xác nhận riêng)</small></h2>
<section class="box" id="policy-box"><p>Chỉ cần khi kiểm thử phải <b>tạo dữ liệu test</b>. Sau khi xác nhận, framework tự tạo, sửa và cleanup <b>dữ liệu do chính nó tạo</b> (nằm trong registry) trên môi trường đã chọn, không hỏi từng thao tác. Không đụng dữ liệu có sẵn, không xóa cứng, không cleanup chứng từ ràng buộc kế toán. Môi trường production hoặc chưa khai báo quyền ghi không dùng được.</p>
<div id="policy-lines" class="note"></div>
<button type="button" id="confirm-policy" class="w" disabled>Xác nhận chính sách ghi dữ liệu</button>
<p class="note">Hộp thoại hệ điều hành <b>riêng</b> sẽ hiện ra cho bước này; nó độc lập với xác nhận môi trường. Hiệu lực 8 giờ.</p>
<p class="msg" id="msg-policy" role="status"></p></section>
<p class="mut">Phương án dự phòng (terminal): <code>npm run qa:env -- select/confirm</code>, <code>npm run qa:policy -- confirm</code>. Không cần dùng trong luồng thông thường.</p></div>
<script>
(()=>{const $=s=>document.querySelector(s),nonce=document.querySelector('.wrap').dataset.nonce,base=location.pathname.replace(/\\/$/,'');
const chosen=()=>{const r=document.querySelector('input[name=env]:checked');return r?r.value:''};
function lock(on){for(const id of ['#confirm-env','#confirm-policy'])$(id).disabled=on||$(id).dataset.off==='1'}
async function send(action,msgEl,btn){const environment=chosen(),by=$('#by').value;if(!environment){msgEl.className='msg err';msgEl.textContent='Hãy chọn một môi trường.';return}
 msgEl.className='msg';msgEl.textContent='Đang chờ bạn xác nhận ở hộp thoại trên màn hình...';btn.disabled=true;
 try{const r=await fetch(base+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,nonce,environment,by})});const j=await r.json();
  msgEl.className='msg '+(j.ok?'ok':'err');msgEl.textContent=j.message;if(j.ok)setTimeout(()=>location.reload(),1500);else btn.disabled=false}
 catch(e){msgEl.className='msg err';msgEl.textContent='Không gửi được: '+e;btn.disabled=false}}
$('#confirm-env').onclick=()=>send('CONFIRM_ENV',$('#msg-env'),$('#confirm-env'));
$('#confirm-policy').onclick=()=>send('CONFIRM_POLICY',$('#msg-policy'),$('#confirm-policy'));
let cards=[];
function refresh(){const c=cards.find(x=>x.key===chosen());const b=$('#confirm-policy'),approved=document.querySelector('.wrap').dataset.approved==='1';
 const can=!!(approved&&c&&c.usable&&c.selected&&c.exec.valid&&c.write.eligible&&!c.write.valid);b.dataset.off=can?'':'1';b.disabled=!can;
 $('#confirm-env').dataset.off=(approved&&c&&c.usable)?'':'1';$('#confirm-env').disabled=!(approved&&c&&c.usable);
 $('#policy-lines').textContent=!c?'Chọn một môi trường để xem chính sách.':!c.write.eligible?'Môi trường này chỉ đọc: '+c.write.reasons.join(' '):c.write.valid?'Đã xác nhận (hiệu lực tới '+new Date(c.write.expiresAt).toLocaleString('vi-VN')+').':!c.selected||!c.exec.valid?'Cần chọn và xác nhận môi trường này ở bước 1 trước.':'Chưa xác nhận. Tự động cleanup: '+(c.write.autoCleanup?'BẬT':'TẮT')+'.'}
async function load(){try{const j=await (await fetch(base+'/state')).json();cards=j.cards;refresh()}catch{}}
document.querySelectorAll('input[name=env]').forEach(i=>i.addEventListener('change',refresh));load();
let sig='';setInterval(async()=>{try{const j=await (await fetch(base+'/state')).json();const s=JSON.stringify([j.approvalHash,j.cards.map(c=>[c.key,c.usable,c.exec.valid,c.write.valid,c.selected])]);if(sig&&s!==sig)$('#stale').classList.add('show');sig=s;cards=j.cards}catch{}},3000)})();
</script></body></html>`;
}
