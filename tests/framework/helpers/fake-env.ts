import fs from 'node:fs';
import path from 'node:path';
import type { EnvKind, EnvironmentsFile } from '../../../core/environment/config';

/**
 * Môi trường GIẢ LẬP cho framework test: cấu hình environments/<app>.json + biến môi trường giả (FAKE_<ENV>_...).
 * Không bao giờ chứa URL/tài khoản thật. URL trỏ tới máy chủ giả trên 127.0.0.1 (xem mock-odoo.ts) hoặc tên miền example.com.
 */
export interface FakeEnvSpec {
  url?: string;
  version?: string;
  db?: string;
  kind?: EnvKind;
  roles: Record<string, { user?: string; pass?: string }>;
}

const up = (s: string) => s.toUpperCase();

export function fakeEnvironments(specs: Record<string, FakeEnvSpec>, app = 'odoo') {
  const vars: Record<string, string> = {};
  const config: EnvironmentsFile = { application: app, environments: {} };
  for (const [key, spec] of Object.entries(specs)) {
    const p = `FAKE_${key}`;
    if (spec.url) vars[`${p}_URL`] = spec.url;
    if (spec.version) vars[`${p}_VERSION`] = spec.version;
    if (spec.db) vars[`${p}_DB`] = spec.db;
    const roles: EnvironmentsFile['environments'][string]['roles'] = {};
    for (const [role, c] of Object.entries(spec.roles)) {
      roles[role] = { userVar: `${p}_${up(role)}_USER`, passVar: `${p}_${up(role)}_PASS` };
      if (c.user) vars[`${p}_${up(role)}_USER`] = c.user;
      if (c.pass) vars[`${p}_${up(role)}_PASS`] = c.pass;
    }
    config.environments[key] = { label: `Giả lập ${key}`, kind: spec.kind ?? 'staging', urlVar: `${p}_URL`, dbVar: `${p}_DB`, expectedVersionVar: `${p}_VERSION`, roles };
  }
  return { config, vars };
}

/** Ghi environments/<app>.json vào `dir` và đặt biến giả vào process.env. Trả về hàm khôi phục. */
export function installFakeEnvironments(dir: string, specs: Record<string, FakeEnvSpec>, app = 'odoo') {
  const { config, vars } = fakeEnvironments(specs, app);
  const envDir = path.join(dir, 'environments');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, `${app}.json`), JSON.stringify(config, null, 2));
  const saved: Record<string, string | undefined> = { QA_ENVIRONMENTS_DIR: process.env.QA_ENVIRONMENTS_DIR };
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  process.env.QA_ENVIRONMENTS_DIR = envDir;
  Object.assign(process.env, vars);
  return {
    envDir,
    vars,
    config,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
