import type { BrowserContext } from '@playwright/test';
import { resolveEnvironment, type ResolvedEnvironment } from './config';
import { activeEnvKey } from './paths';

/** Môi trường của lần chạy hiện tại (QA_ENV do scripts/run-tests.ts đặt sau khi đã chọn + xác nhận). undefined = chưa chọn/không hợp lệ. */
export function activeEnvironment(app: string, source: NodeJS.ProcessEnv = process.env): ResolvedEnvironment | undefined {
  const key = activeEnvKey();
  if (!key) return undefined;
  const r = resolveEnvironment(app, key, source);
  return r.ok ? r.env : undefined;
}

export const activeBaseUrl = (app: string): string | undefined => activeEnvironment(app)?.baseUrl;

export interface NavigationGuard {
  /** Các điều hướng trang chính bị chặn vì sang host khác môi trường. */
  violations: string[];
}

/**
 * Chặn điều hướng trang chính (document) sang host khác môi trường đã chọn: request bị huỷ và ghi lại vi phạm.
 * Không chặn tài nguyên phụ (ảnh, script, CDN) vì chúng không đổi "môi trường đang kiểm thử".
 */
export async function installNavigationGuard(context: BrowserContext, env: Pick<ResolvedEnvironment, 'key' | 'host'>): Promise<NavigationGuard> {
  const guard: NavigationGuard = { violations: [] };
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame().parentFrame() === null) {
      let host = '';
      try {
        host = new URL(req.url()).host;
      } catch { /* host rỗng => coi là khác */ }
      if (host && host !== env.host && !/^(about|data|blob):/.test(req.url())) {
        guard.violations.push(`${req.url().split('?')[0]} (host ${host})`);
        return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  });
  return guard;
}
