import fs from 'node:fs';
import type { OdooClient } from './client';

/** Chụp và so sánh danh sách trường (kèm module định nghĩa) của các model, dùng chung cho mọi module Odoo. */
export interface FieldInfo {
  name: string;
  type: string;
  modules: string;
  relation: string | false;
}

/** Đọc danh sách trường hiện tại từ metadata của Odoo (chỉ đọc). */
export async function readFieldSnapshot(client: OdooClient, models: readonly string[]): Promise<Record<string, FieldInfo[]>> {
  const out: Record<string, FieldInfo[]> = {};
  for (const model of models) {
    const rows = await client.searchRead<any>('ir.model.fields', [['model', '=', model]], ['name', 'ttype', 'modules', 'relation'], { order: 'name' });
    out[model] = rows.map((r) => ({ name: r.name, type: r.ttype, modules: r.modules, relation: r.relation }));
  }
  return out;
}

export interface BaselineDiff {
  baselineCapturedAt: string;
  added: string[];
  removed: string[];
  changed: string[];
}

/** So sánh với baseline đã lưu trong `file`. undefined nếu chưa có baseline. */
export function diffAgainstBaseline(current: Record<string, FieldInfo[]>, file: string): BaselineDiff | undefined {
  if (!fs.existsSync(file)) return undefined;
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const diff: BaselineDiff = { baselineCapturedAt: base.capturedAt, added: [], removed: [], changed: [] };
  for (const model of Object.keys(current)) {
    const b = new Map<string, FieldInfo>((base.models[model] ?? []).map((f: FieldInfo) => [f.name, f]));
    const c = new Map<string, FieldInfo>(current[model].map((f) => [f.name, f]));
    for (const [n, f] of c) {
      if (!b.has(n)) diff.added.push(`${model}.${n}`);
      else if (b.get(n)!.type !== f.type || b.get(n)!.modules !== f.modules) diff.changed.push(`${model}.${n}`);
    }
    for (const n of b.keys()) if (!c.has(n)) diff.removed.push(`${model}.${n}`);
  }
  return diff;
}
