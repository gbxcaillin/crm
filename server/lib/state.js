'use strict';
// Workspace state: bootstrap snapshot for a signed-in user and the sync endpoint that
// applies client changes record-by-record (last write wins) and fires notification hooks.
const D = require('./db');
const auth = require('./auth');
const push = require('./push');
const graph = require('./graph');
const mail = require('./mail');
const notify = require('./notify');
const { err } = require('./http');

const SERVER_SETTINGS = (s) => {
  s = s || {};
  s.apiKeys = auth.listApiKeys();
  const st = push.stats7d();
  s.push = { ...(s.push || {}), devices: push.devices(), vapidPublic: push.publicKey, endpoint: '/api/v1/push/subscribe', sent7d: st.sent, failed7d: st.failed };
  s.spSite = process.env.SP_SITE ? graph.SP_SITE.replace(':/', '/') : (s.spSite || 'gbxps.sharepoint.com/sites/Clients');
  s.spLibrary = graph.SP_LIBRARY;
  s.storage = s.storage || 'sharepoint';
  return s;
};
function features() { return { mail: mail.enabled(), mailMode: mail.mode(), sharepoint: graph.enabled(), market: true, push: true, demo: process.env.DEMO_DATA === '1' }; }

function bootstrap(user) {
  const state = D.snapshot();
  state.users = D.users.publicAll();
  const initialised = !!state.settings;
  if (initialised) state.settings = SERVER_SETTINGS(state.settings);
  return { user: D.users.public(user), rev: D.rev(), state, initialised, features: features(), vapidPublic: push.publicKey, server: { time: D.nowIso(), version: require('../package.json').version } };
}

// Strip fields the server owns before persisting client-sent settings.
function cleanSettings(s) {
  s = { ...(s || {}) };
  delete s.apiKeys;
  if (s.push) { const p = { ...s.push }; delete p.devices; delete p.vapidPublic; delete p.endpoint; delete p.sent7d; delete p.failed7d; s.push = p; }
  return s;
}
const ADMIN_KV = ['fields', 'stages', 'sources', 'colors'];

function applyUserOp(actor, id, data) {
  const u = D.users.get(id);
  const isAdmin = actor.role === 'Admin';
  if (!u) {
    if (!isAdmin) throw err(403, 'Only admins can add users');
    return; // creation goes through POST /users (needs an invite token); ignore stray inserts
  }
  const next = { ...u };
  if (isAdmin) { if (data.role) next.role = data.role; if (data.status && ['Active', 'Invited', 'Inactive'].includes(data.status)) next.status = data.status; if (data.email) next.email = String(data.email).toLowerCase(); }
  if (isAdmin || actor.id === id) { if (data.name) next.name = String(data.name).slice(0, 80); if (data.color) next.color = String(data.color).slice(0, 9); if (data.focus != null) next.focus = String(data.focus).slice(0, 120); }
  if (actor.id === id && data.role && data.role !== u.role && !isAdmin) throw err(403, 'You cannot change your own role');
  if (u.role === 'Admin' && next.role !== 'Admin' && D.users.all().filter((x) => x.role === 'Admin' && x.status === 'Active').length <= 1) throw err(400, 'The workspace needs at least one active admin');
  D.users.update(next);
  if (next.status !== 'Active') auth.destroyUserSessions(id);
}

function applySync(actor, body) {
  const ops = Array.isArray(body.ops) ? body.ops : [];
  const kv = body.kv && typeof body.kv === 'object' ? body.kv : {};
  const base = Number(body.base) || 0;
  const hooks = [];
  D.transaction(() => {
    for (const op of ops) {
      if (!op || typeof op.col !== 'string') continue;
      if (op.col === 'users') { if (op.data) applyUserOp(actor, String(op.id), op.data); continue; }
      if (!D.COLS[op.col]) continue;
      const id = String(op.id);
      const prev = D.getRecord(op.col, id);
      if (op.del) { if (prev) { D.delRecord(op.col, id, actor.id); hooks.push([op.col, prev, null]); } continue; }
      if (!op.data || typeof op.data !== 'object') continue;
      const data = { ...op.data, [D.COLS[op.col]]: op.col === 'securities' ? id : isNaN(+id) ? id : +id };
      if (JSON.stringify(prev) === JSON.stringify(data)) continue;
      D.putRecord(op.col, data, actor.id);
      hooks.push([op.col, prev, data]);
    }
    for (const [key, value] of Object.entries(kv)) {
      if (!D.KV.includes(key)) continue;
      if (ADMIN_KV.includes(key) && !['Admin', 'Manager'].includes(actor.role)) throw err(403, 'Only admins and managers can change ' + key);
      const v = key === 'settings' ? cleanSettings(value) : value;
      if (JSON.stringify(D.kvGet(key)) !== JSON.stringify(v)) D.kvSet(key, v);
    }
  })();
  D.users.seen(actor.id);
  // Fire notification hooks after commit, without blocking the response.
  (async () => { for (const [col, prev, next] of hooks) await notify.onRecordChange(actor.id, col, prev, next); })().catch((e) => console.error('[hooks]', e.message));
  return pull(base, actor);
}
function pull(since, actor) {
  const out = D.changesSince(since);
  if (out.kv.settings) out.kv.settings = SERVER_SETTINGS(out.kv.settings);
  if (actor) D.users.seen(actor.id);
  return { rev: D.rev(), ...out, users: D.users.publicAll() };
}
module.exports = { bootstrap, applySync, pull, features, SERVER_SETTINGS };
