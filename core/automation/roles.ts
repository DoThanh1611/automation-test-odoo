import { accessOf, type AutomationFile } from './meta';
import type { TestCaseDef } from '../testcases/schema';

/**
 * Tài khoản theo NHU CẦU: chỉ những vai trò mà test case của requirement đang chạy thực sự dùng (metadata thực thi `role`, nếu bỏ trống
 * thì vai trò mặc định) mới được kiểm tra. Vai trò không liên quan không bao giờ bị đòi. Thiếu vai trò ⇒ chỉ các test dùng vai trò đó BLOCKED;
 * test độc lập vẫn chạy. Không tự nâng quyền, không thay bằng Admin, không tự đổi vai trò.
 */
export interface RoleNeed {
  role: string;
  testCases: string[];
}

export interface RoleGap extends RoleNeed {
  /** TÊN biến .env cần bổ sung (không có giá trị). */
  vars: string[];
}

/** Vai trò cần cho từng test case của requirement. */
export function rolesNeeded(defs: TestCaseDef[], files: AutomationFile[], defaultRole: string): RoleNeed[] {
  const byRole = new Map<string, string[]>();
  for (const d of defs) {
    const role = accessOf(d.id, files).meta?.role || defaultRole;
    byRole.set(role, [...(byRole.get(role) ?? []), d.id]);
  }
  return [...byRole.entries()].map(([role, testCases]) => ({ role, testCases })).sort((a, b) => a.role.localeCompare(b.role));
}

/**
 * Vai trò cần mà môi trường chưa cấu hình. `cards` là các vai trò của môi trường đã chọn ({ role, configured, missingVars }).
 * Vai trò không khai báo cho môi trường ⇒ gap với vars rỗng (cần khai báo trong environments/<app>.json).
 */
export function roleGaps(needs: RoleNeed[], cards: { role: string; configured: boolean; missingVars?: string[] }[]): RoleGap[] {
  return needs.flatMap((n) => {
    const c = cards.find((x) => x.role === n.role);
    if (c?.configured) return [];
    return [{ ...n, vars: c?.missingVars ?? [] }];
  });
}

/** Test case bị BLOCKED vì thiếu vai trò. */
export const blockedByRole = (gaps: RoleGap[]): Map<string, string> =>
  new Map(gaps.flatMap((g) => g.testCases.map((id): [string, string] => [id, g.vars.length ? `thiếu tài khoản vai trò "${g.role}": ${g.vars.join(', ')}` : `vai trò "${g.role}" chưa khai báo cho môi trường này`])));
