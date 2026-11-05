import fs from 'node:fs';
import path from 'node:path';
import { activeEnvKey, fixturesDirFor } from '../environment/paths';

/**
 * Fixture dữ liệu test được CHỈ ĐỊNH TƯỜNG MINH trong testdata/fixtures/<app>-<module>.json (không chọn "bản ghi mới nhất").
 * Mỗi file gắn với MỘT môi trường (host). Nếu chạy trên môi trường khác, hoặc bản ghi không còn thỏa điều kiện đã khai báo,
 * test bị BLOCKED với lý do rõ ràng thay vì chạy trên dữ liệu không đúng.
 */
export class FixtureError extends Error {}

export interface FixtureFile {
  /** Host của môi trường mà các ID/tên trong file này có hiệu lực, ví dụ staging.example.com. */
  environment: string;
  /** Tuỳ chọn: khoá môi trường (ví dụ STAGING_A). Nếu có, phải khớp môi trường đang chạy (phân biệt hai môi trường cùng host, khác database). */
  environmentKey?: string;
  [key: string]: unknown;
}

/**
 * File fixture: testdata/fixtures/<ENV>/<key>.json (ID bản ghi khác nhau giữa các môi trường). Chưa có file riêng thì chấp nhận file cũ
 * testdata/fixtures/<key>.json, nhưng loadFixtures vẫn từ chối nếu host/environmentKey của file không khớp môi trường đang chạy.
 * QA_FIXTURES_DIR chỉ dùng cho framework test (fixture giả), không dùng khi chạy thật.
 */
export function fixtureFilePath(key: string): string {
  const own = path.join(fixturesDirFor(), `${key}.json`);
  if (fs.existsSync(own) || process.env.QA_FIXTURES_DIR || !activeEnvKey()) return own;
  const legacy = path.resolve('testdata', 'fixtures', `${key}.json`);
  return fs.existsSync(legacy) ? legacy : own;
}

export function loadFixtures<T extends FixtureFile = FixtureFile>(key: string, baseURL: string | undefined): T {
  const file = fixtureFilePath(key);
  if (!fs.existsSync(file)) throw new FixtureError(`Chưa có file fixture ${path.relative(process.cwd(), file)}`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  if (!baseURL) throw new FixtureError('Chưa cấu hình URL môi trường nên không xác định được fixture nào áp dụng');
  const host = new URL(baseURL).host;
  if (data.environment !== host) {
    throw new FixtureError(`Fixture ${key} khai báo cho môi trường "${data.environment}" nhưng đang chạy trên "${host}". Cần tạo fixture riêng cho môi trường này`);
  }
  if (data.environmentKey && data.environmentKey !== activeEnvKey()) {
    throw new FixtureError(`Fixture ${key} khai báo cho môi trường ${data.environmentKey} nhưng đang chạy trên ${activeEnvKey() ?? 'môi trường chưa chọn'}`);
  }
  return data;
}

// ---- Điều kiện chung mà bản ghi ghim phải còn thỏa mỗi lần chạy (phát hiện dữ liệu đã bị người khác đổi) ----
export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn';

export interface Condition {
  field: string;
  op: Op;
  value: unknown;
}

const TEXT: Record<Op, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'thuộc', notIn: 'không thuộc' };

/** Trả về danh sách điều kiện BỊ VI PHẠM (rỗng = còn thỏa). Thuần hàm, không biết gì về model cụ thể. */
export function checkConditions(rec: Record<string, unknown>, conditions: Condition[]): string[] {
  const out: string[] = [];
  for (const c of conditions) {
    const v = rec[c.field];
    const list = Array.isArray(c.value) ? c.value : [c.value];
    const ok =
      c.op === 'eq' ? v === c.value
      : c.op === 'ne' ? v !== c.value
      : c.op === 'gt' ? Number(v) > Number(c.value)
      : c.op === 'gte' ? Number(v) >= Number(c.value)
      : c.op === 'lt' ? Number(v) < Number(c.value)
      : c.op === 'lte' ? Number(v) <= Number(c.value)
      : c.op === 'in' ? list.includes(v)
      : !list.includes(v);
    if (!ok) out.push(`${c.field} = ${JSON.stringify(v)}, cần ${TEXT[c.op]} ${JSON.stringify(c.value)}`);
  }
  return out;
}
