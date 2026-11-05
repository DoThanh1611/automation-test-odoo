import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { evaluateAndSync } from './approval';
import { auditAttempt, processDecision, renderReviewPage, stateJson, type DecisionRequest, type HumanConfirm, type ReviewContext } from './web';

/**
 * Máy chủ cục bộ cho giao diện Review & Approval. CHỈ nghe 127.0.0.1, cổng ngẫu nhiên, đường dẫn chứa mã phiên ngẫu nhiên.
 * Lớp bảo vệ của POST /decision: Host/Origin phải là chính máy chủ (chống DNS rebinding, CSRF từ trang web khác), mã phiên,
 * nonce dùng một lần cấp cho trang vừa tải, giới hạn số lần thử, và với APPROVE: cụm xác nhận gõ tay + hộp thoại hệ điều hành (HumanConfirm).
 * Giới hạn có chủ đích: đây là chốt chặn chống Claude/tiến trình gọi API, không chống người có toàn quyền điều khiển máy (ví dụ điều khiển màn hình).
 */
export interface ReviewServerOptions {
  root: string;
  requirementId: string;
  getContext: () => ReviewContext;
  confirm: HumanConfirm;
  port?: number;
  /** Tự đóng sau thời gian không hoạt động (ms). */
  idleMs?: number;
  /** Gọi sau mỗi quyết định thành công. */
  onDecision?: (action: string) => void;
}

export interface ReviewServer {
  url: string;
  origin: string;
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;
const MAX_ATTEMPTS = 10;

export async function startReviewServer(o: ReviewServerOptions): Promise<ReviewServer> {
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
    const m = /^\/review\/([0-9a-f]+)(\/state|\/decision)?\/?$/.exec((req.url ?? '').split('?')[0]);
    if (!m || !tokenOk(m[1])) return send(404, 'Không tìm thấy');
    const route = m[2] ?? '';

    if (req.method === 'GET' && route === '') {
      const ctx = o.getContext();
      const nonce = crypto.randomBytes(16).toString('hex');
      nonces.add(nonce);
      if (nonces.size > 50) nonces.delete(nonces.values().next().value as string);
      return send(200, renderReviewPage({ nonce, ctx, ev: evaluateAndSync(ctx.root, ctx.requirement, ctx.defs) }));
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
        let body: DecisionRequest & { nonce?: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return json(400, { ok: false, message: 'Dữ liệu không phải JSON.' });
        }
        if (++attempts > MAX_ATTEMPTS) {
          auditAttempt(ctx.root, ctx.requirement.id, { outcome: 'LOCKED', reason: 'quá số lần thử' });
          return json(429, { ok: false, message: 'Quá nhiều lần thử; khởi động lại giao diện review.' });
        }
        if (!body.nonce || !nonces.has(body.nonce)) {
          auditAttempt(ctx.root, ctx.requirement.id, { action: body.action, outcome: 'REFUSED', reason: 'nonce không hợp lệ (không đến từ trang review)' });
          return json(403, { ok: false, message: 'Yêu cầu không đến từ trang review này (thiếu/sai nonce). Hãy mở lại link và thao tác trên trang.' });
        }
        const result = await processDecision(ctx, body, o.confirm);
        // Nonce chỉ tiêu hao khi quyết định THÀNH CÔNG (bị từ chối thì người dùng sửa lại và gửi tiếp được; số lần thử vẫn bị giới hạn).
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
  return { url: `${origin}/review/${token}`, origin, token, close };
}
