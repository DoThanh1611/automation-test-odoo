import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Máy chủ Odoo GIẢ trên 127.0.0.1 cho framework test (không phải Odoo thật, không mạng ngoài).
 * Mô phỏng đủ: trang /web/login (nhãn Email / Mật khẩu / nút Đăng nhập), cookie session_id, get_session_info, version_info.
 */
export interface MockUser {
  login: string;
  password: string;
  admin?: boolean;
}

export interface MockOptions {
  version?: string;
  users: MockUser[];
  /** Sau khi đăng nhập đúng, chuyển hướng sang URL tuyệt đối này (giả lập SSO/redirect sang host khác). */
  redirectAfterLogin?: string;
  /** Máy chủ báo tên đăng nhập khác với tên đã dùng để đăng nhập (giả lập tài khoản bị ánh xạ nhầm). */
  reportLoginAs?: string;
}

export interface MockServer {
  url: string;
  origin: string;
  /** Mọi request máy chủ nhận được (để chứng minh "không có kết nối" hoặc "không có cookie của môi trường khác"). */
  hits: { method: string; path: string; cookie?: string }[];
  close(): Promise<void>;
}

const page = (error?: string) => `<!doctype html><meta charset="utf-8"><title>Login</title>
<form method="post" action="/web/login">
<label for="login">Email</label><input id="login" name="login" type="text">
<label for="password">Mật khẩu</label><input id="password" name="password" type="text">
${error ? `<p role="alert">${error}</p>` : ''}
<button type="submit">Đăng nhập</button></form>`;

export async function startMockOdoo(opts: MockOptions): Promise<MockServer> {
  const sessions = new Map<string, MockUser>();
  const hits: MockServer['hits'] = [];
  let counter = 0;
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const cookie = /(?:^|;\s*)session_id=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    hits.push({ method: req.method ?? 'GET', path: url, cookie });
    const body: Buffer[] = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const user = cookie ? sessions.get(cookie) : undefined;
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (url === '/web/login' && req.method === 'POST') {
        const form = new URLSearchParams(Buffer.concat(body).toString());
        const u = opts.users.find((x) => x.login === form.get('login') && x.password === form.get('password'));
        if (!u) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(page('Sai tài khoản hoặc mật khẩu'));
        }
        const sid = `sid${++counter}-${u.login.replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 10)}`;
        sessions.set(sid, u);
        res.writeHead(302, { 'set-cookie': `session_id=${sid}; Path=/; HttpOnly`, location: opts.redirectAfterLogin ?? '/odoo' });
        return res.end();
      }
      if (url === '/web/login') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page());
      }
      if (url === '/odoo') {
        if (!user) {
          res.writeHead(302, { location: '/web/login' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset="utf-8"><title>Odoo</title><h1>Odoo giả lập</h1>');
      }
      if (url === '/web/session/get_session_info') {
        return json({ result: user ? { uid: 2, username: opts.reportLoginAs ?? user.login, is_admin: Boolean(user.admin), is_system: Boolean(user.admin) } : {} });
      }
      if (url === '/web/webclient/version_info') return json({ result: opts.version ? { server_version: opts.version } : {} });
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>404</title><p>Không có trang này</p>');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return { url: origin, origin, hits, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
