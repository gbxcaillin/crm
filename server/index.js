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

const PORT = Number(process.env.PORT || 3000);
const DIST = process.env.DIST_DIR || path.join(__dirname, '..', 'dist');

// First-run admin from the environment (optional; otherwise the app shows a setup form).
if (D.users.count() === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  D.users.insert({ id: 'u1', email: process.env.ADMIN_EMAIL.toLowerCase(), name: process.env.ADMIN_NAME || 'Admin', role: 'Admin', status: 'Active', color: '#2E8B6E', pw_hash: auth.hashPassword(process.env.ADMIN_PASSWORD) });
  console.log('[boot] created admin', process.env.ADMIN_EMAIL);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  req.query = url.searchParams;
  try {
    if (url.pathname.startsWith('/api/v1/')) {
      const m = api.match(req.method, url.pathname.slice('/api/v1'.length));
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
