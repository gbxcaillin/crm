'use strict';
// On-demand Claude for the CRM, via the host helper (deploy/agent/claude-helper.py).
// The CRM never holds Claude credentials: it POSTs a prompt to the helper over a
// mounted Unix socket and gets text back. Off unless CLAUDE_HELPER_SOCKET is set.
const http = require('node:http');

const SOCKET = process.env.CLAUDE_HELPER_SOCKET || '';   // container path, e.g. /run/gbx-claude/claude.sock
const TOKEN = process.env.CLAUDE_HELPER_TOKEN || '';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'sonnet';

function enabled() { return !!SOCKET; }

// run(prompt) -> Promise<string>. Rejects on helper error/timeout.
function run(prompt, { model } = {}) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('Claude helper not configured'));
    const payload = JSON.stringify({ prompt, model: model || DEFAULT_MODEL });
    const req = http.request({
      socketPath: SOCKET, path: '/', method: 'POST', timeout: 175000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(d); } catch { /* non-json */ }
        if (res.statusCode !== 200) return reject(new Error(j.error || ('Claude helper ' + res.statusCode)));
        resolve(String(j.text || ''));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Claude helper timeout')));
    req.end(payload);
  });
}

module.exports = { enabled, run };
