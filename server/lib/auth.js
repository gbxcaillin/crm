'use strict';
const crypto = require('node:crypto');
const { db, users, nowIso, bumpRev } = require('./db');

/* ---------- passwords (scrypt, no native deps) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, key] = stored.split('$');
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const k = Buffer.from(key, 'base64');
  return k.length === test.length && crypto.timingSafeEqual(k, test);
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and at least one number';
  return null;
}

/* ---------- sessions ---------- */
const COOKIE = 'gbx_session';
const sIns = db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at,ua,ip) VALUES(?,?,?,?,?,?)');
const sGet = db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>?');
const sDel = db.prepare('DELETE FROM sessions WHERE id=?');
const sDelUser = db.prepare('DELETE FROM sessions WHERE user_id=?');
const sPrune = db.prepare('DELETE FROM sessions WHERE expires_at<?');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId, { remember, ua, ip }) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const ttl = remember ? 30 * 86400e3 : 12 * 3600e3;
  sIns.run(sha(raw), userId, Date.now(), Date.now() + ttl, (ua || '').slice(0, 200), ip || '');
  return { raw, ttl };
}
function sessionUser(req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return null;
  const s = sGet.get(sha(raw), Date.now());
  if (!s) return null;
  const u = users.get(s.user_id);
  if (!u || u.status !== 'Active') return null;
  req.sessionId = sha(raw);
  return u;
}
function destroySession(req) { const raw = parseCookies(req)[COOKIE]; if (raw) sDel.run(sha(raw)); }
function destroyUserSessions(userId) { sDelUser.run(userId); }
function pruneSessions() { sPrune.run(Date.now()); }
function cookieHeader(raw, ttlMs, secure) {
  const parts = [`${COOKIE}=${raw}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(ttlMs / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
function clearCookieHeader(secure) { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`; }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

/* ---------- one-time tokens (invite / password reset) ---------- */
const tIns = db.prepare('INSERT INTO tokens(token,user_id,kind,expires_at) VALUES(?,?,?,?)');
const tGet = db.prepare('SELECT * FROM tokens WHERE token=? AND expires_at>?');
const tDel = db.prepare('DELETE FROM tokens WHERE token=?');
const tDelUser = db.prepare('DELETE FROM tokens WHERE user_id=? AND kind=?');
function issueToken(userId, kind, days) {
  tDelUser.run(userId, kind);
  const raw = crypto.randomBytes(24).toString('base64url');
  tIns.run(sha(raw), userId, kind, Date.now() + days * 86400e3);
  return raw;
}
function consumeToken(raw, kind) {
  const t = tGet.get(sha(raw || ''), Date.now());
  if (!t || t.kind !== kind) return null;
  tDel.run(t.token);
  return t.user_id;
}
function peekToken(raw, kind) { const t = tGet.get(sha(raw || ''), Date.now()); return t && t.kind === kind ? t.user_id : null; }

/* ---------- API keys ---------- */
const kIns = db.prepare('INSERT INTO api_keys(id,name,prefix,hash,scopes,created_at,last_used,created_by) VALUES(?,?,?,?,?,?,?,?)');
const kAll = db.prepare('SELECT id,name,prefix,scopes,created_at,last_used FROM api_keys ORDER BY created_at');
const kByHash = db.prepare('SELECT * FROM api_keys WHERE hash=?');
const kDel = db.prepare('DELETE FROM api_keys WHERE id=?');
const kUsed = db.prepare('UPDATE api_keys SET last_used=? WHERE id=?');
function createApiKey(name, scopes, by) {
  const raw = 'gbx_live_' + crypto.randomBytes(24).toString('base64url');
  const id = 'k' + Date.now().toString(36);
  kIns.run(id, name, raw.slice(0, 13) + '…', sha(raw), (scopes || []).join(' '), nowIso(), null, by);
  bumpRev();
  return { id, key: raw };
}
function listApiKeys() { return kAll.all().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, created: k.created_at.slice(0, 10), last: k.last_used ? relTime(k.last_used) : 'never' })); }
function revokeApiKey(id) { kDel.run(id); bumpRev(); }
function apiKeyFromReq(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  const raw = m ? m[1] : (req.headers['x-api-key'] || '');
  if (!raw) return null;
  const k = kByHash.get(sha(raw));
  if (!k) return null;
  kUsed.run(nowIso(), k.id);
  return { id: k.id, name: k.name, scopes: k.scopes.split(' ').filter(Boolean) };
}
function relTime(iso) { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 2 ? 'just now' : m < 60 ? m + ' min ago' : m < 36 * 60 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }

/* ---------- login rate limit (per IP, in memory) ---------- */
const WINDOW = 15 * 60e3, MAX_FAIL = 6;
const fails = new Map();
function clientIp(req) { const xff = req.headers['x-forwarded-for']; return xff ? String(xff).split(',')[0].trim() : (req.socket.remoteAddress || 'unknown'); }
function lockedOut(ip) { const e = fails.get(ip); if (!e) return false; if (Date.now() - e.at > WINDOW) { fails.delete(ip); return false; } return e.n >= MAX_FAIL; }
function recordFailure(ip) { const e = fails.get(ip); if (!e || Date.now() - e.at > WINDOW) fails.set(ip, { n: 1, at: Date.now() }); else e.n++; }
function recordSuccess(ip) { fails.delete(ip); }

module.exports = { hashPassword, verifyPassword, passwordProblem, createSession, sessionUser, destroySession, destroyUserSessions, pruneSessions, cookieHeader, clearCookieHeader, issueToken, consumeToken, peekToken, createApiKey, listApiKeys, revokeApiKey, apiKeyFromReq, clientIp, lockedOut, recordFailure, recordSuccess };
