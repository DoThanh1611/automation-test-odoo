import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { auditAttempt } from '../approval/web';
import { ENV_CHANNEL, processEnvDecision, renderEnvPage, stateJson, type EnvDecisionRequest, type EnvHumanConfirm, type EnvWebContext } from './web';

/**
 * Máy chủ cục bộ cho giao diện chọn môi trường + chính sách ghi. Cùng mô hình bảo vệ với giao diện Review & Approval (core/approval/server.ts):
 * chỉ nghe 127.0.0.1, cổng ngẫu nhiên, đường dẫn chứa mã phiên ngẫu nhiên, Host/Origin phải là chính máy chủ, nonce dùng một lần cho trang vừa tải,
 * giới hạn số lần thử, và mỗi hành động cần hộp thoại hệ điều hành riêng (EnvHumanConfirm) mà Claude không bấm được.
 * Giới hạn có chủ đích: đây là chốt chặn chống Claude/tiến trình gọi API, không chống người có toàn quyền điều khiển máy.
 */
export interface EnvServerOptions {
  getContext: () => EnvWebContext;
  confirm: EnvHumanConfirm;
  port?: number;
  idleMs?: number;
  onDecision?: (action: string) => void;
}

export interface EnvServer {
  url: string;
  origin: string;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 16 * 1024;
const MAX_ATTEMPTS = 10;

export async function startEnvServer(o: EnvServerOptions): Promise<EnvServer> {
  const token = crypto.randomBytes(24).toString('hex');
  const nonces = new Set<string>();
  let attempts = 0;
  let idle: NodeJS.Timeout | undefined;
  let port = 0;

  const bump = () => {
    if (!o.idleMs) return;
    clearTimeout(idle);
    idle = setTimeout(() => void close(), o.idleMs);
    idle.unref();
  };
  const hostOk = (h?: string) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const originOk = (h?: string) => h === undefined || h === `http://127.0.0.1:${port}` || h === `http://localhost:${port}`;
  const tokenOk = (t: string) => t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));

  const server = http.createServer((req, res) => {
    bump();
    const send = (status: number, body: string, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      });
      res.end(body);
    };
    const json = (status: number, v: unknown) => send(status, JSON.stringify(v), 'application/json; charset=utf-8');
    if (!hostOk(req.headers.host)) return send(403, 'Host không hợp lệ');
    const m = /^\/env\/([0-9a-f]+)(\/state|\/decision)?\/?$/.exec((req.url ?? '').split('?')[0]);
    if (!m || !tokenOk(m[1])) return send(404, 'Không tìm thấy');
    const route = m[2] ?? '';

    if (req.method === 'GET' && route === '') {
      const nonce = crypto.randomBytes(16).toString('hex');
      nonces.add(nonce);
      if (nonces.size > 50) nonces.delete(nonces.values().next().value as string);
      return send(200, renderEnvPage({ nonce, ctx: o.getContext() }));
    }
    if (req.method === 'GET' && route === '/state') return json(200, stateJson(o.getContext()));
    if (req.method === 'POST' && route === '/decision') {
      if (!originOk(req.headers.origin as string | undefined)) return json(403, { ok: false, message: 'Origin không hợp lệ.' });
      if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) return json(415, { ok: false, message: 'Cần application/json.' });
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', async () => {
        const ctx = o.getContext();
        let body: EnvDecisionRequest & { nonce?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return json(400, { ok: false, message: 'Dữ liệu không phải JSON.' });
        }
        if (++attempts > MAX_ATTEMPTS) {
          auditAttempt(ctx.root, ctx.requirement.id, { channel: ENV_CHANNEL, outcome: 'LOCKED', reason: 'quá số lần thử' });
          return json(429, { ok: false, message: 'Quá nhiều lần thử; khởi động lại giao diện chọn môi trường.' });
        }
        if (!body.nonce || !nonces.has(body.nonce)) {
          auditAttempt(ctx.root, ctx.requirement.id, { channel: ENV_CHANNEL, action: body.action, environment: body.environment, outcome: 'REFUSED', reason: 'nonce không hợp lệ (không đến từ trang này)' });
          return json(403, { ok: false, message: 'Yêu cầu không đến từ trang này (thiếu/sai nonce). Hãy mở lại link và thao tác trên trang.' });
        }
        const result = await processEnvDecision(ctx, body, o.confirm);
        // Nonce chỉ tiêu hao khi hành động THÀNH CÔNG (bị từ chối thì người dùng thử lại được; số lần thử vẫn bị giới hạn).
        // Sau khi thành công, trang tự tải lại và nhận nonce mới cho hành động tiếp theo (ví dụ chính sách ghi).
        if (result.ok) {
          nonces.delete(body.nonce);
          o.onDecision?.(String(body.action));
        }
        json(result.status, result);
      });
      return;
    }
    send(405, 'Phương thức không hỗ trợ');
  });

  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  bump();
  const origin = `http://127.0.0.1:${port}`;
  const close = () =>
    new Promise<void>((r) => {
      clearTimeout(idle);
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return { url: `${origin}/env/${token}`, origin, token, close };
}
