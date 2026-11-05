import fs from 'node:fs';
import path from 'node:path';
import { loadRequirements, loadTestCases } from '../testcases/loader';
import { aggregate, loadRuns } from './aggregate';
import { buildBugs } from './bugs';
import { buildFocus, type FocusInfo } from './focus';
import { STATUS_ORDER, statusCount } from './summary';
import type { Summary } from './types';

const pctText = (v: number | null) => (v === null ? 'N/A' : `${v}%`);

/**
 * Đối chiếu ba nơi trình bày kết quả với nhau VÀ với kết quả tính lại độc lập từ reports/runs/*:
 *   qa-results.json  |  qa-report.html (thẻ số liệu + từng dòng test case)  |  qa-summary.md
 * Bất kỳ lệch nào (kể cả báo cáo cũ hơn định nghĩa test case) là lỗi. Không sửa gì, chỉ báo.
 */
export function verifyReportConsistency(reportsDir = 'reports'): { errors: string[]; summary?: Summary } {
  const errors: string[] = [];
  const dir = path.resolve(reportsDir);
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : undefined);

  const defs = loadTestCases();
  const runs = loadRuns(dir);
  const expected = aggregate(defs, runs);

  const jsonRaw = read('qa-results.json');
  const html = read('qa-report.html');
  const md = read('qa-summary.md');
  if (!jsonRaw) errors.push('Thiếu reports/qa-results.json (chạy npm run report:rebuild).');
  if (!html) errors.push('Thiếu reports/qa-report.html (chạy npm run report:rebuild).');
  if (!md) errors.push('Thiếu reports/qa-summary.md (chạy npm run report:rebuild).');
  if (!jsonRaw || !html || !md) return { errors };
  const focusId = (JSON.parse(jsonRaw) as { focus?: { requirementId: string } }).focus?.requirementId;
  const expFocus = focusId ? buildFocus(focusId, loadRequirements(), expected.results, buildBugs(defs, runs), expected.summary.generatedAt) : undefined;
  const res = compareReport(expected.summary, defs.map((d) => d.id), jsonRaw, html, md, expFocus);
  // Bug Report: bugs.json phải khớp số bug trong qa-results.json và tính lại từ lần chạy.
  const bugsRaw = read('bugs.json');
  const jsonBugs = (JSON.parse(jsonRaw) as { bugs?: { total: number; open: number } }).bugs;
  const exp = buildBugs(defs, runs);
  if (!bugsRaw) res.errors.push('Thiếu bugs.json (chạy npm run report:rebuild).');
  else {
    const n = (JSON.parse(bugsRaw) as { bugs: unknown[] }).bugs.length;
    if (n !== exp.length) res.errors.push(`bugs.json có ${n} bug nhưng tính lại từ các lần chạy ra ${exp.length}.`);
    if (jsonBugs && jsonBugs.total !== n) res.errors.push(`qa-results.json báo ${jsonBugs.total} bug nhưng bugs.json có ${n}.`);
  }
  return res;
}

/** Phần so sánh thuần (không đọc file) để test được: `exp` = số liệu tính lại độc lập, các chuỗi là nội dung ba nơi trình bày. */
export function compareReport(exp: Summary, defIds: string[], jsonRaw: string, html: string, md: string, expFocus?: FocusInfo): { errors: string[]; summary?: Summary } {
  const errors: string[] = [];
  const json = JSON.parse(jsonRaw) as { summary: Summary; testCases: { def: { id: string }; status: string }[] };
  const js = json.summary;
  const fields: (keyof Summary)[] = ['total', 'passed', 'failed', 'blocked', 'needsClarification', 'notRun', 'executed', 'executionPassRate', 'overallPassCoverage'];
  for (const f of fields) {
    if (js[f] !== exp[f]) errors.push(`JSON.${f} = ${js[f]} nhưng tính lại từ reports/runs và testcases/ ra ${exp[f]} (báo cáo cũ hơn dữ liệu? chạy npm run report:rebuild).`);
  }
  const ids = new Set(json.testCases.map((t) => t.def.id));
  for (const id of defIds) if (!ids.has(id)) errors.push(`JSON thiếu test case ${id}.`);
  for (const st of STATUS_ORDER) {
    const n = json.testCases.filter((t) => t.status === st).length;
    if (n !== statusCount(js, st)) errors.push(`JSON: số dòng ${st} (${n}) khác summary (${statusCount(js, st)}).`);
  }

  // HTML. Có requirement đang xử lý (focus): HTML CHỈ chứa requirement đó (một requirement — một báo cáo) nên đối chiếu với số liệu focus;
  // không có focus: HTML là báo cáo toàn bộ, đối chiếu với số liệu tổng.
  const focusJson = (JSON.parse(jsonRaw) as { focus?: FocusInfo }).focus;
  if (focusJson) {
    const fs_ = focusJson.summary;
    const otherReq = [...html.matchAll(/<article class="tc[^"]*"[^>]*data-req="([^"]*)"/g)].map((m) => m[1]).filter((r) => r !== focusJson.requirementId);
    if (otherReq.length) errors.push(`HTML chứa test case của requirement khác (${[...new Set(otherReq)].join(', ')}); báo cáo chỉ được chứa ${focusJson.requirementId}.`);
    for (const st of STATUS_ORDER) {
      const rows = (html.match(new RegExp(`<article class="tc[^"]*"[^>]*data-status="${st}"`, 'g')) ?? []).length;
      if (rows !== statusCount(fs_, st)) errors.push(`HTML: số dòng test case ${st} = ${rows} nhưng JSON.focus = ${statusCount(fs_, st)}.`);
    }
    const rate = /data-focus="RATE">([^<]+)</.exec(html)?.[1];
    if (rate !== pctText(fs_.executionPassRate)) errors.push(`HTML: Execution Pass Rate của requirement đang xử lý = ${rate ?? 'không thấy'} nhưng JSON.focus = ${pctText(fs_.executionPassRate)}.`);
  } else {
    const card = (filter: string) => new RegExp(`data-filter="${filter}"[\\s\\S]*?<b>(\\d+)</b>`).exec(html)?.[1];
    const allCard = card('ALL');
    if (allCard === undefined || Number(allCard) !== js.total) errors.push(`HTML: thẻ "Tất cả" = ${allCard ?? 'không thấy'} nhưng JSON total = ${js.total}.`);
    for (const st of STATUS_ORDER) {
      const c = card(st);
      if (c === undefined || Number(c) !== statusCount(js, st)) errors.push(`HTML: thẻ ${st} = ${c ?? 'không thấy'} nhưng JSON = ${statusCount(js, st)}.`);
      const rows = (html.match(new RegExp(`<article class="tc[^"]*"[^>]*data-status="${st}"`, 'g')) ?? []).length;
      if (rows !== statusCount(js, st)) errors.push(`HTML: số dòng test case ${st} = ${rows} nhưng JSON = ${statusCount(js, st)}.`);
    }
    const execCard = /<b>([^<]+)<\/b><span>Execution Pass Rate/.exec(html)?.[1];
    const covCard = /<b>([^<]+)<\/b><span>Overall Pass Coverage/.exec(html)?.[1];
    if (execCard !== pctText(js.executionPassRate)) errors.push(`HTML: Execution Pass Rate = ${execCard ?? 'không thấy'} nhưng JSON = ${pctText(js.executionPassRate)}.`);
    if (covCard !== pctText(js.overallPassCoverage)) errors.push(`HTML: Overall Pass Coverage = ${covCard ?? 'không thấy'} nhưng JSON = ${pctText(js.overallPassCoverage)}.`);
  }

  // Tổng kết bằng chữ.
  const mdVal = (label: string) => new RegExp(`^\\| ${label.replace(/[()+]/g, '\\$&')} \\| ([^|]+) \\|$`, 'm').exec(md)?.[1]?.trim();
  if (mdVal('Tổng test case') !== String(js.total)) errors.push(`qa-summary.md: Tổng test case = ${mdVal('Tổng test case') ?? 'không thấy'} nhưng JSON = ${js.total}.`);
  for (const st of STATUS_ORDER) {
    if (mdVal(st) !== String(statusCount(js, st))) errors.push(`qa-summary.md: ${st} = ${mdVal(st) ?? 'không thấy'} nhưng JSON = ${statusCount(js, st)}.`);
  }
  if (mdVal('Execution Pass Rate') !== pctText(js.executionPassRate)) errors.push(`qa-summary.md: Execution Pass Rate = ${mdVal('Execution Pass Rate') ?? 'không thấy'} nhưng JSON = ${pctText(js.executionPassRate)}.`);
  if (mdVal('Overall Pass Coverage') !== pctText(js.overallPassCoverage)) errors.push(`qa-summary.md: Overall Pass Coverage = ${mdVal('Overall Pass Coverage') ?? 'không thấy'} nhưng JSON = ${pctText(js.overallPassCoverage)}.`);

  if (expFocus) {
    const jf = (JSON.parse(jsonRaw) as { focus?: FocusInfo }).focus;
    if (!jf || jf.requirementId !== expFocus.requirementId) errors.push(`JSON.focus không phải ${expFocus.requirementId}.`);
    else {
      for (const f of fields) if (jf.summary[f] !== expFocus.summary[f]) errors.push(`JSON.focus.${f} = ${jf.summary[f]} nhưng tính lại cho ${expFocus.requirementId} ra ${expFocus.summary[f]}.`);
      if (jf.bugs.total !== expFocus.bugs.total || jf.bugs.open !== expFocus.bugs.open) errors.push(`JSON.focus.bugs = ${jf.bugs.open}/${jf.bugs.total} nhưng tính lại ra ${expFocus.bugs.open}/${expFocus.bugs.total}.`);
      const pe = expFocus.provenance;
      if (!jf.provenance || jf.provenance.latestRunId !== pe.latestRunId || jf.provenance.fromLatestRun !== pe.fromLatestRun || jf.provenance.fromEarlierRuns !== pe.fromEarlierRuns || jf.provenance.neverRun !== pe.neverRun) errors.push(`JSON.focus.provenance không khớp tính lại (${JSON.stringify(jf.provenance)} so với ${JSON.stringify(pe)}).`);
      const hv = (st: string) => new RegExp(`data-focus="${st}">(\\d+)<`).exec(html)?.[1];
      if (Number(hv('TOTAL')) !== jf.summary.total) errors.push(`HTML: số test case của requirement đang xử lý = ${hv('TOTAL') ?? 'không thấy'} nhưng JSON.focus = ${jf.summary.total}.`);
      for (const st of STATUS_ORDER) if (Number(hv(st)) !== statusCount(jf.summary, st)) errors.push(`HTML: ${st} của requirement đang xử lý = ${hv(st) ?? 'không thấy'} nhưng JSON.focus = ${statusCount(jf.summary, st)}.`);
      const mv = (label: string) => new RegExp(`^\\| ${label.replace(/[()+]/g, '\\$&')} \\[focus\\] \\| ([^|]+) \\|$`, 'm').exec(md)?.[1]?.trim();
      if (mv('Tổng test case') !== String(jf.summary.total)) errors.push(`qa-summary.md: Tổng test case [focus] = ${mv('Tổng test case') ?? 'không thấy'} nhưng JSON.focus = ${jf.summary.total}.`);
      for (const st of STATUS_ORDER) if (mv(st) !== String(statusCount(jf.summary, st))) errors.push(`qa-summary.md: ${st} [focus] = ${mv(st) ?? 'không thấy'} nhưng JSON.focus = ${statusCount(jf.summary, st)}.`);
    }
  }
  return { errors, summary: js };
}
