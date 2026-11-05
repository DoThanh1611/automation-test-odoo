import fs from 'node:fs';
import type { AppConfig } from '../config/app-config';
import { resolveEnvironment, roleMissing } from '../environment/config';
import { authFileFor, metaFileFor, requireEnvKey } from '../environment/paths';
import { readMeta } from '../environment/session';

/** Phiên đăng nhập luôn gắn với (môi trường, ứng dụng, vai trò): .auth/<ENV>/<app>-<role>.json. Thiếu môi trường là lỗi, không có mặc định. */
export const authFile = (app: string, role: string, envKey?: string) => authFileFor(requireEnvKey(envKey), app, role);
/** Thông tin KHÔNG nhạy cảm về phiên đã xác minh. Ghi bởi project setup-<app>. */
export const metaFile = (app: string, role: string, envKey?: string) => metaFileFor(requireEnvKey(envKey), app, role);

/** Danh sách biến môi trường còn thiếu để đăng nhập vai trò này trên môi trường này (rỗng = đủ). */
export function missingForRole(app: AppConfig, role: string, envKey?: string): string[] {
  if (!app.roles[role]) throw new Error(`Vai trò "${role}" không có trong cấu hình ${app.name}`);
  const r = resolveEnvironment(app.name, requireEnvKey(envKey));
  return r.ok ? roleMissing(r.env, role) : r.problems;
}

export const hasSession = (app: string, role: string, envKey?: string) => fs.existsSync(authFile(app, role, envKey));
export const readSessionMeta = (app: string, role: string, envKey?: string) => readMeta(requireEnvKey(envKey), app, role);
