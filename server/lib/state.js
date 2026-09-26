'use strict';
// Workspace state: bootstrap snapshot for a signed-in user and the sync endpoint that
// applies client changes record-by-record (last write wins) and fires notification hooks.
const D = require('./db');
const auth = require('./auth');
const push = require('./push');
const graph = require('./graph');
const mail = require('./mail');
const cloudflare = require('./cloudflare');
const claude = require('./claude');
const notify = require('./notify');
const { err } = require('./http');

const SERVER_SETTINGS = (s) => {
  s = s || {};
  s.apiKeys = auth.listApiKeys();
  const st = push.stats7d();
  s.push = { ...(s.push || {}), devices: push.devices(), vapidPublic: push.publicKey, endpoint: '/api/v1/push/subscribe', sent7d: st.sent, failed7d: st.failed };
  s.spSite = process.env.SP_SITE ? graph.SP_SITE.replace(':/', '/') : (s.spSite || 'gbxps.sharepoint.com/sites/Clients');
  s.spLibrary = graph.SP_LIBRARY;
  s.spFolder = graph.SP_FOLDER;
  s.storage = s.storage || 'sharepoint';
  return s;
};
function features() { return { mail: mail.enabled(), mailMode: mail.mode(), sharepoint: graph.enabled(), mailbox: require('./mailbox').enabled(), market: true, push: true, webAnalytics: cloudflare.enabled(), aiAssist: claude.enabled(), bookingUrl: require('./nurture').bookingUrl(), demo: process.env.DEMO_DATA === '1' }; }

/* ---------- visibility: Admins and Managers see everything; Members see the deals and clients they own ---------- */
function scopeFor(user) {
  if (user.role !== 'Member') return null;
  const deals = new Set(D.listCol('deals').filter((d) => d.owner === user.id).map((d) => d.id));
  const clients = new Set(D.listCol('clients').filter((c) => c.owner === user.id || (c.deals || []).some((id) => deals.has(id))).map((c) => c.id));
  return { uid: user.id, deals, clients };
}
function visible(scope, col, r) {
  if (!scope || !r) return true;
  switch (col) {
    case 'deals': return r.owner === scope.uid || scope.deals.has(r.id);
    case 'clients': return scope.clients.has(r.id) || r.owner === scope.uid;
    case 'tasks': return !r.deal || scope.deals.has(r.deal) || (r.who || []).includes(scope.uid) || r.by === scope.uid || (r.notify || []).includes(scope.uid);
    case 'activity': case 'threads': case 'files': return !r.deal || scope.deals.has(r.deal);
    case 'invoices': return (r.deal && scope.deals.has(r.deal)) || (r.clientId && scope.clients.has(r.clientId));
    case 'changes': return r.entity === 'deal' ? scope.deals.has(r.ref) : r.entity === 'client' ? scope.clients.has(r.ref) : true;
    case 'notifs': return !r.to || r.to.includes(scope.uid);
    case 'messages': return true; // room membership is enforced by the front end; DMs are between two members
    default: return true;
  }
}
function filterState(state, scope) { if (!scope) return state; for (const c of Object.keys(D.COLS)) if (state[c]) state[c] = state[c].filter((r) => visible(scope, c, r)); return state; }

function bootstrap(user, session) {
  const scope = scopeFor(user);
  const state = filterState(D.snapshot(), scope);
  state.users = D.users.publicAll();
  const initialised = !!state.settings;
  if (initialised) state.settings = SERVER_SETTINGS(state.settings);
  const sec = securityPolicy();
  return { user: D.users.public(user), rev: D.rev(), state, initialised, maxIds: D.maxIds(), features: features(), vapidPublic: push.publicKey, security: { ...sec, mfaEnrolled: !!D.users.get(user.id).totp_secret, via: session ? session.via : 'password' }, server: { time: D.nowIso(), version: require('../package.json').version } };
}
function securityPolicy() { const s = D.kvGet('settings') || {}; const p = s.security || {}; return { mfaRequired: p.mfaRequired || 'admins', sessionHours: Number(p.sessionHours) || 12, sso: require('./oidc').enabled(), passwordLogin: p.passwordLogin !== false, encryption: D.vault.enabled() }; }
function mfaRequiredFor(user) { const p = securityPolicy().mfaRequired; return p === 'all' || (p === 'admins' && user.role === 'Admin'); }

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
    const scope = scopeFor(actor);
    for (const op of ops) {
      if (!op || typeof op.col !== 'string') continue;
      if (op.col === 'users') { if (op.data) applyUserOp(actor, String(op.id), op.data); continue; }
      if (!D.COLS[op.col]) continue;
      const id = String(op.id);
      const prev = D.getRecord(op.col, id);
      if (scope && prev && !visible(scope, op.col, prev)) throw err(403, 'You do not have access to that ' + op.col.replace(/s$/, ''));
      if (scope && op.data && !visible(scope, op.col, op.data) && op.col !== 'deals' && op.col !== 'clients') throw err(403, 'Members can only change their own deals');
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
      if (key === 'settings' && actor.role !== 'Admin') { const cur = D.kvGet('settings') || {}; v.security = cur.security; v.leadRouting = cur.leadRouting; }
      if (JSON.stringify(D.kvGet(key)) !== JSON.stringify(v)) D.kvSet(key, v);
    }
    for (const op of ops) if (op && op.del && D.COLS[op.col]) D.audit(actor.id, actor.ip, 'record.delete', op.col + '/' + op.id, '');
  })();
  D.users.seen(actor.id);
  // Fire notification hooks after commit, without blocking the response.
  (async () => { for (const [col, prev, next] of hooks) await notify.onRecordChange(actor.id, col, prev, next); })().catch((e) => console.error('[hooks]', e.message));
  // A lead created by hand in the CRM never passes through the webhook path, so auto-enrol it here.
  for (const [col, prev, next] of hooks) if (col === 'deals' && !prev && next && next.stage === 'new') { try { require('./nurture').autoEnrol(next); } catch (e) { console.error('[nurture] auto-enrol skipped:', e.message); } }
  return pull(base, actor);
}
function pull(since, actor) {
  const out = D.changesSince(since);
  const scope = actor ? scopeFor(actor) : null;
  if (scope) out.records = out.records.filter((r) => r.data === null || visible(scope, r.col, r.data));
  if (out.kv.settings) out.kv.settings = SERVER_SETTINGS(out.kv.settings);
  if (actor) D.users.seen(actor.id);
  return { rev: D.rev(), ...out, users: D.users.publicAll(), maxIds: D.maxIds() };
}
module.exports = { bootstrap, applySync, pull, features, SERVER_SETTINGS, scopeFor, visible, securityPolicy, mfaRequiredFor };
