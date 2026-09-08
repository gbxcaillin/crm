'use strict';
// RFC 6238 TOTP (SHA-1, 30 s, 6 digits) with base32 secrets, ±1 step tolerance, plus one-time backup codes.
const crypto = require('node:crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32dec(s) { let bits = 0, val = 0; const out = []; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function newSecret() { return b32enc(crypto.randomBytes(20)); }
function code(secret, t = Date.now(), step = 30) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(counter).digest();
  const o = h[19] & 15; const n = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6;
  return String(n).padStart(6, '0');
}
function verify(secret, input, t = Date.now()) {
  const c = String(input || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  for (const w of [-1, 0, 1]) { const exp = code(secret, t + w * 30000); if (exp.length === c.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(c))) return true; }
  return false;
}
function otpauthUrl(secret, account, issuer = 'GBX Pipeline') { return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`; }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function newBackupCodes(n = 8) { const codes = []; for (let i = 0; i < n; i++) { const raw = crypto.randomBytes(5).toString('hex'); codes.push(raw.slice(0, 5) + '-' + raw.slice(5)); } return { codes, hashes: codes.map((c) => sha(c.replace('-', ''))) }; }
function useBackupCode(hashes, input) { const h = sha(String(input || '').replace(/[\s-]/g, '').toLowerCase()); const i = (hashes || []).indexOf(h); if (i < 0) return null; const next = hashes.slice(); next.splice(i, 1); return next; }
module.exports = { newSecret, code, verify, otpauthUrl, newBackupCodes, useBackupCode };
