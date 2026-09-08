'use strict';
// GBX Pipeline server: serves the built PWA from dist/ and the JSON API under /api/v1.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const D = require('./lib/db');
const auth = require('./lib/auth');
const { send, serveStatic, HttpError } = require('./lib/http');
const api = require('./routes/api');
const jobs = require('./lib/jobs');
const vault = require('./lib/vault');

const PORT = Number(process.env.PORT || 3000);
const DIST = process.env.DIST_DIR || path.join(__dirname, '..', 'dist');

// First-run admin from the environment (optional; otherwise the app shows a setup form).
if (D.users.count() === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  D.users.insert({ id: 'u1', email: process.env.ADMIN_EMAIL.toLowerCase(), name: process.env.ADMIN_NAME || 'Admin', role: 'Admin', status: 'Active', color: '#2E8B6E', pw_hash: auth.hashPassword(process.env.ADMIN_PASSWORD) });
  console.log('[boot] created admin', process.env.ADMIN_EMAIL);
}

// Encryption at rest: seal any plaintext rows on the first boot with a key, or refuse to start without one in production.
if (vault.enabled()) { const n = D.resealAll(false); if (n) console.log(`[vault] sealed ${n} plaintext rows with ${vault.current()}`); }
else if (process.env.NODE_ENV === 'production' && process.env.ALLOW_UNENCRYPTED !== '1') { console.error('[vault] DATA_KEYS is not set. Generate one with: node server/tools/keygen.js  (or set ALLOW_UNENCRYPTED=1 to run without encryption at rest)'); process.exit(1); }
else console.warn('[vault] WARNING: running without encryption at rest');

const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' data: https://*.sharepoint.com", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self' https://login.microsoftonline.com", "upgrade-insecure-requests"].join('; ');
const SEC_HEADERS = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin' };
if (process.env.NODE_ENV === 'production') SEC_HEADERS['strict-transport-security'] = 'max-age=31536000; includeSubDomains';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  req.query = url.searchParams;
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  try {
    if (url.pathname.startsWith('/api/v1/')) {
      const ip = auth.clientIp(req); const p = url.pathname.slice('/api/v1'.length); req.apiPath = p;
      if (auth.limited('api:' + ip, 600, 60e3) || (/^\/(auth|hooks)\//.test(p) && auth.limited('auth:' + ip, 40, 60e3))) throw new HttpError(429, 'Too many requests');
      const m = api.match(req.method, p);
      if (!m) throw new HttpError(404, 'No such endpoint');
      req.params = m.params;
      await m.handler(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(DIST, req, res, url.pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[api]', req.method, url.pathname, e);
    send(res, status, { error: e.message || 'Server error', ...(e.extra || {}) });
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[boot] GBX Pipeline on :${PORT} · db ${D.DB_PATH} · dist ${fs.existsSync(path.join(DIST, 'index.html')) ? 'ok' : 'MISSING (run build.sh)'}`);
  jobs.start();
});
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
