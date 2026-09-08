'use strict';
// Application-level encryption at rest. Every record, configuration document, secret and
// log detail is sealed with AES-256-GCM before it touches SQLite, so the database file,
// its WAL, nightly backups and the SharePoint copies are ciphertext. The key never lives
// on the data volume: it comes from DATA_KEYS in the environment (.env.production, root only).
//
//   DATA_KEYS="v2:<base64 32 bytes>,v1:<base64 32 bytes>"   first entry = current key
//   node server/tools/keygen.js                              prints a fresh key
//   node server/tools/rotate.js                              re-seals everything with the current key
const crypto = require('node:crypto');

const keys = new Map(); let current = null;
(function loadKeys() {
  const raw = process.env.DATA_KEYS || (process.env.DATA_KEY ? 'v1:' + process.env.DATA_KEY : '');
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(v\d+):(.+)$/.exec(part); if (!m) throw new Error('DATA_KEYS entry must look like v1:<base64>');
    const k = Buffer.from(m[2], 'base64'); if (k.length !== 32) throw new Error(`DATA_KEYS ${m[1]} must be 32 bytes (base64)`);
    keys.set(m[1], k); if (!current) current = m[1];
  }
})();
const enabled = () => !!current;
const SEALED = /^(v\d+):([A-Za-z0-9+/=]+)$/;

function seal(plain) {
  if (plain == null) return plain;
  if (!current) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.get(current), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${current}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}
function open(stored) {
  if (stored == null) return stored;
  const m = SEALED.exec(stored);
  if (!m) return stored;                       // legacy plaintext row (pre-encryption); migrated at boot
  const key = keys.get(m[1]); if (!key) throw new Error(`No key for ${m[1]} in DATA_KEYS`);
  const buf = Buffer.from(m[2], 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
const isSealed = (s) => typeof s === 'string' && SEALED.test(s);
const sealedWith = (s) => { const m = SEALED.exec(s || ''); return m ? m[1] : null; };
function newKey() { return crypto.randomBytes(32).toString('base64'); }
module.exports = { seal, open, enabled, isSealed, sealedWith, current: () => current, newKey, versions: () => [...keys.keys()] };
