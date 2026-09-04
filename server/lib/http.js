'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const err = (status, message, extra) => new HttpError(status, message, extra);

function send(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store', ...headers });
  res.end(data);
}
const MAX_BODY = 2 * 1024 * 1024;
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(err(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  req.rawBody = raw;
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { throw err(400, 'Invalid JSON'); }
}

/* ---------- tiny router ---------- */
function makeRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };
  const r = { get: (p, h) => add('GET', p, h), post: (p, h) => add('POST', p, h), put: (p, h) => add('PUT', p, h), patch: (p, h) => add('PATCH', p, h), delete: (p, h) => add('DELETE', p, h) };
  r.match = (method, pathname) => {
    for (const rt of routes) {
      if (rt.method !== method) continue;
      const m = rt.re.exec(pathname);
      if (m) { const params = {}; rt.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); return { handler: rt.handler, params }; }
    }
    return null;
  };
  return r;
}

/* ---------- static files (the built PWA in dist/) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.css': 'text/css', '.txt': 'text/plain', '.woff2': 'font/woff2' };
function serveStatic(root, req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  let file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { file = path.join(root, 'index.html'); p = '/index.html'; }
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not built. Run build.sh'); }
  const ext = path.extname(file);
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  headers['cache-control'] = ['/index.html', '/sw.js', '/manifest.webmanifest'].includes(p) ? 'no-cache, must-revalidate' : 'public, max-age=86400';
  if (p === '/sw.js') headers['service-worker-allowed'] = '/';
  headers['x-content-type-options'] = 'nosniff';
  const data = fs.readFileSync(file);
  const ae = String(req.headers['accept-encoding'] || '');
  if (data.length > 1024 && /\bgzip\b/.test(ae) && /text|json|svg|javascript/.test(headers['content-type'])) {
    const gz = zlib.gzipSync(data); headers['content-encoding'] = 'gzip'; headers['content-length'] = gz.length; res.writeHead(200, headers); return res.end(gz);
  }
  headers['content-length'] = data.length; res.writeHead(200, headers); res.end(data);
}

module.exports = { HttpError, err, send, readBody, readJson, makeRouter, serveStatic };
