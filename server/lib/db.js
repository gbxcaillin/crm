'use strict';
// SQLite via node:sqlite (built into Node 22+, no native build step).
// One workspace database: auth tables plus a generic record store that mirrors
// the front-end state collections. Every write bumps a global revision so
// clients can pull "everything since rev N".
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'crm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Member', status TEXT NOT NULL DEFAULT 'Invited',
  color TEXT, focus TEXT DEFAULT '', pw_hash TEXT, created_at TEXT, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER, expires_at INTEGER, ua TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, name TEXT, prefix TEXT, hash TEXT UNIQUE, scopes TEXT, created_at TEXT, last_used TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, device TEXT, sub TEXT NOT NULL, created_at TEXT, failures INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS records(col TEXT NOT NULL, id TEXT NOT NULL, data TEXT, rev INTEGER NOT NULL, updated_at TEXT, updated_by TEXT, deleted INTEGER DEFAULT 0, PRIMARY KEY(col,id));
CREATE INDEX IF NOT EXISTS records_rev ON records(rev);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT, rev INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS market_cache(key TEXT PRIMARY KEY, value TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS mail_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, to_addr TEXT, subject TEXT, kind TEXT, status TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS push_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, user_id TEXT, title TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS webhook_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, source TEXT, status TEXT, detail TEXT, ref TEXT);
CREATE TABLE IF NOT EXISTS job_state(name TEXT PRIMARY KEY, last_run TEXT, detail TEXT);
`);

/* ---------- revision counter ---------- */
const getMeta = db.prepare('SELECT value FROM meta WHERE key=?');
const setMeta = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
function rev() { const r = getMeta.get('rev'); return r ? Number(r.value) : 0; }
function bumpRev() { const n = rev() + 1; setMeta.run('rev', String(n)); return n; }
function nowIso() { return localIso(new Date()); }
// Local-time ISO (YYYY-MM-DDTHH:MM) — matches what the front end stores.
function localIso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function today() { return nowIso().slice(0, 10); }

/* ---------- record store ---------- */
// Collections and the field that identifies a record in each.
const COLS = { deals: 'id', tasks: 'id', clients: 'id', invoices: 'id', events: 'id', messages: 'id', rooms: 'id', threads: 'id', files: 'id', notifs: 'id', activity: 'id', changes: 'id', models: 'id', securities: 't' };
// Singleton documents (configuration).
const KV = ['stages', 'sources', 'fields', 'colors', 'campaigns', 'spend', 'watchlist', 'settings'];

const qGet = db.prepare('SELECT data, deleted FROM records WHERE col=? AND id=?');
const qUpsert = db.prepare(`INSERT INTO records(col,id,data,rev,updated_at,updated_by,deleted) VALUES(?,?,?,?,?,?,0)
  ON CONFLICT(col,id) DO UPDATE SET data=excluded.data, rev=excluded.rev, updated_at=excluded.updated_at, updated_by=excluded.updated_by, deleted=0`);
const qDelete = db.prepare('UPDATE records SET deleted=1, data=NULL, rev=?, updated_at=?, updated_by=? WHERE col=? AND id=?');
const qAll = db.prepare('SELECT col,id,data FROM records WHERE deleted=0 ORDER BY rev');
const qCol = db.prepare('SELECT data FROM records WHERE col=? AND deleted=0');
const qSince = db.prepare('SELECT col,id,data,deleted FROM records WHERE rev>? ORDER BY rev');
const qKvGet = db.prepare('SELECT value FROM kv WHERE key=?');
const qKvSet = db.prepare('INSERT INTO kv(key,value,rev) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, rev=excluded.rev');
const qKvAll = db.prepare('SELECT key,value FROM kv');
const qKvSince = db.prepare('SELECT key,value FROM kv WHERE rev>?');
const qMaxId = db.prepare("SELECT MAX(CAST(id AS INTEGER)) AS m FROM records WHERE col=?");

function getRecord(col, id) { const r = qGet.get(col, String(id)); return r && !r.deleted ? JSON.parse(r.data) : null; }
function listCol(col) { return qCol.all(col).map((r) => JSON.parse(r.data)); }
function putRecord(col, obj, by = '', r) { const n = r || bumpRev(); qUpsert.run(col, String(obj[COLS[col]]), JSON.stringify(obj), n, nowIso(), by); return n; }
function delRecord(col, id, by = '', r) { const n = r || bumpRev(); qDelete.run(n, nowIso(), by, col, String(id)); return n; }
function nextId(col) { const r = qMaxId.get(col); return (r && r.m ? Number(r.m) : 0) + 1; }
function kvGet(key, dflt = null) { const r = qKvGet.get(key); return r ? JSON.parse(r.value) : dflt; }
function kvSet(key, value, r) { const n = r || bumpRev(); qKvSet.run(key, JSON.stringify(value), n); return n; }
function snapshot() {
  const state = {};
  for (const c of Object.keys(COLS)) state[c] = [];
  for (const row of qAll.all()) if (state[row.col]) state[row.col].push(JSON.parse(row.data));
  for (const row of qKvAll.all()) state[row.key] = JSON.parse(row.value);
  return state;
}
function changesSince(since) {
  return {
    records: qSince.all(since).map((r) => ({ col: r.col, id: r.id, data: r.deleted ? null : JSON.parse(r.data) })),
    kv: Object.fromEntries(qKvSince.all(since).map((r) => [r.key, JSON.parse(r.value)])),
  };
}
const transaction = (fn) => (...args) => { db.exec('BEGIN IMMEDIATE'); try { const out = fn(...args); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } };

/* ---------- users ---------- */
const uAll = db.prepare('SELECT * FROM users ORDER BY created_at');
const uGet = db.prepare('SELECT * FROM users WHERE id=?');
const uByEmail = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)');
const uIns = db.prepare('INSERT INTO users(id,email,name,role,status,color,focus,pw_hash,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?)');
const uUpd = db.prepare('UPDATE users SET email=?, name=?, role=?, status=?, color=?, focus=? WHERE id=?');
const uPw = db.prepare('UPDATE users SET pw_hash=?, status=CASE WHEN status=\'Invited\' THEN \'Active\' ELSE status END WHERE id=?');
const uSeen = db.prepare('UPDATE users SET last_seen=? WHERE id=?');
const uCount = db.prepare('SELECT COUNT(*) AS n FROM users');
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, color: u.color || '#2E8B6E', focus: u.focus || '', last: relTime(u.last_seen) };
}
function relTime(iso) {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 2) return 'Just now'; if (m < 60) return m + ' min ago'; if (m < 36 * 60) return Math.round(m / 60) + ' h ago';
  return Math.round(m / 1440) + ' d ago';
}
const users = {
  all: () => uAll.all(), get: (id) => uGet.get(id), byEmail: (e) => uByEmail.get(e), count: () => uCount.get().n,
  insert: (u) => { uIns.run(u.id, u.email, u.name, u.role || 'Member', u.status || 'Invited', u.color || null, u.focus || '', u.pw_hash || null, nowIso(), null); bumpRev(); },
  update: (u) => { uUpd.run(u.email, u.name, u.role, u.status, u.color, u.focus, u.id); bumpRev(); },
  setPassword: (id, hash) => { uPw.run(hash, id); bumpRev(); },
  seen: (id) => uSeen.run(nowIso(), id),
  public: publicUser, publicAll: () => uAll.all().map(publicUser),
  newId: () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
};

/* ---------- misc tables ---------- */
const log = {
  mail: db.prepare('INSERT INTO mail_log(at,to_addr,subject,kind,status,detail) VALUES(?,?,?,?,?,?)'),
  push: db.prepare('INSERT INTO push_log(at,user_id,title,status) VALUES(?,?,?,?)'),
  hook: db.prepare('INSERT INTO webhook_log(at,source,status,detail,ref) VALUES(?,?,?,?,?)'),
  mailRecent: db.prepare('SELECT * FROM mail_log ORDER BY id DESC LIMIT ?'),
  pushStats: db.prepare("SELECT status, COUNT(*) n FROM push_log WHERE at>=? GROUP BY status"),
  hookRecent: db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT ?'),
};
const jobs = {
  get: db.prepare('SELECT * FROM job_state WHERE name=?'),
  set: db.prepare('INSERT INTO job_state(name,last_run,detail) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET last_run=excluded.last_run, detail=excluded.detail'),
};
const cache = {
  get: (key, maxAgeMs) => { const r = db.prepare('SELECT value, at FROM market_cache WHERE key=?').get(key); if (!r) return null; if (maxAgeMs != null && Date.now() - r.at > maxAgeMs) return null; return JSON.parse(r.value); },
  set: (key, value) => db.prepare('INSERT INTO market_cache(key,value,at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, at=excluded.at').run(key, JSON.stringify(value), Date.now()),
};

function backup(destPath) { db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`); }

module.exports = { db, DATA_DIR, DB_PATH, COLS, KV, rev, bumpRev, nowIso, localIso, today, getRecord, listCol, putRecord, delRecord, nextId, kvGet, kvSet, snapshot, changesSince, transaction, users, log, jobs, cache, backup };
