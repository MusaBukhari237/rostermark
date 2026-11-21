// Minimal HTTP toolkit: router, JSON bodies, signed-cookie sessions, static files.
// Zero dependencies — runs on Node.js 22+.
import { createServer } from 'node:http';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const test = scryptSync(String(password), salt, 32);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && timingSafeEqual(known, test);
}

export function createSessions(secret, cookieName = 'sid', maxAgeDays = 14) {
  const sign = (v) => createHmac('sha256', secret).update(v).digest('base64url');
  return {
    issue(res, payload) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + maxAgeDays * 864e5 })).toString('base64url');
      const value = `${body}.${sign(body)}`;
      res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}`);
    },
    clear(res) { res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); },
    read(req) {
      const raw = parseCookies(req.headers.cookie)[cookieName];
      if (!raw) return null;
      const [body, sig] = raw.split('.');
      if (!body || !sig) return null;
      const expect = sign(body);
      if (expect.length !== sig.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
      try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString());
        return data.exp > Date.now() ? data : null;
      } catch { return null; }
    }
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req, limit = 3_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) fail(413, 'Request body too large'); chunks.push(c); }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { fail(400, 'Invalid JSON body'); }
}

export function createRouter() {
  const routes = [];
  const add = (method) => (path, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handlers });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    async handle(req, res, ctx) {
      const url = new URL(req.url, 'http://local');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        const c = { ...ctx, req, res, params, query: Object.fromEntries(url.searchParams), body, url };
        let out;
        for (const h of r.handlers) { out = await h(c); if (out === STOP) return true; }
        if (!res.writableEnded) {
          if (out instanceof RawResponse) out.send(res);
          else json(res, 200, out ?? { ok: true });
        }
        return true;
      }
      return false;
    }
  };
}
export const STOP = Symbol('stop');

export class RawResponse {
  constructor(body, type, filename) { this.body = body; this.type = type; this.filename = filename; }
  send(res) {
    const h = { 'Content-Type': this.type, 'Cache-Control': 'no-store' };
    if (this.filename) h['Content-Disposition'] = `attachment; filename="${this.filename}"`;
    res.writeHead(200, h); res.end(this.body);
  }
}

export function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export async function serveStatic(req, res, roots, fallbackFile) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  for (const root of roots) {
    const file = normalize(join(root, path));
    if (!file.startsWith(resolve(root))) continue;
    try {
      const s = await stat(file);
      if (s.isFile()) return sendFile(res, file, path.includes('/vendor/') ? 'public, max-age=604800' : 'no-cache');
    } catch { /* try next */ }
  }
  if (fallbackFile && !path.startsWith('/api/') && !extname(path)) return sendFile(res, fallbackFile, 'no-cache');
  return false;
}

async function sendFile(res, file, cache) {
  const data = await readFile(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
  res.end(data);
  return true;
}

export function startServer({ port, host = '0.0.0.0', handler, name }) {
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      const handled = await handler(req, res);
      if (!handled && !res.writableEnded) json(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      if (!res.writableEnded) json(res, status, { error: status >= 500 ? 'Server error' : err.message });
    }
  });
  server.listen(port, host, () => console.log(`${name} listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
  return server;
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  return '﻿' + [head, ...rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','))].join('\r\n');
}

// Simple fixed-window rate limiter keyed by IP + bucket.
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const e = hits.get(key);
    if (!e || e.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    e.n += 1;
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return e.n <= max;
  };
}
export const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
