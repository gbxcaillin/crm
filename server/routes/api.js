'use strict';
const crypto = require('node:crypto');
const D = require('../lib/db');
const auth = require('../lib/auth');
const state = require('../lib/state');
const push = require('../lib/push');
const mail = require('../lib/mail');
const graph = require('../lib/graph');
const market = require('../lib/market');
const jobs = require('../lib/jobs');
const leads = require('../lib/leads');
const { notify } = require('../lib/notify');
const { err, send, readJson, readBody, makeRouter } = require('../lib/http');

const r = makeRouter();
const SECURE = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1';
const BASE = mail.BASE;

/* ---------- guards ---------- */
function session(req) { const u = auth.sessionUser(req); if (!u) throw err(401, 'Sign in required'); if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'gbx') throw err(403, 'Missing X-Requested-With header'); return u; }
function admin(req) { const u = session(req); if (u.role !== 'Admin') throw err(403, 'Admin only'); return u; }
// Session OR API key with the given scope.
function actor(req, scope) {
  const k = auth.apiKeyFromReq(req);
  if (k) { if (scope && !k.scopes.includes(scope) && !k.scopes.includes('deals:write')) throw err(403, 'API key lacks scope ' + scope); return { id: 'api:' + k.id, name: k.name, role: 'Api', key: k }; }
  return session(req);
}
const ok = (res, body = { ok: true }) => send(res, 200, body);

/* ---------- health ---------- */
r.get('/health', (req, res) => ok(res, { ok: true, time: D.nowIso(), users: D.users.count(), rev: D.rev() }));

/* ---------- auth ---------- */
r.post('/auth/setup', async (req, res) => {
  if (D.users.count() > 0) throw err(403, 'Workspace already has users');
  const b = await readJson(req);
  const p = auth.passwordProblem(b.password); if (p) throw err(400, p);
  if (!b.email || !/^[^@\s]+@[^@\s]+$/.test(b.email)) throw err(400, 'Valid email required');
  const id = 'u1';
  D.users.insert({ id, email: String(b.email).toLowerCase(), name: String(b.name || 'Admin').slice(0, 80), role: 'Admin', status: 'Active', color: '#2E8B6E', pw_hash: auth.hashPassword(b.password) });
  const s = auth.createSession(id, { remember: true, ua: req.headers['user-agent'], ip: auth.clientIp(req) });
  send(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader(s.raw, s.ttl, SECURE) });
});
r.post('/auth/login', async (req, res) => {
  const ip = auth.clientIp(req);
  if (auth.lockedOut(ip)) throw err(429, 'Too many attempts. Try again in 15 minutes.');
  const b = await readJson(req);
  const u = D.users.byEmail(String(b.email || ''));
  if (!u || u.status !== 'Active' || !auth.verifyPassword(String(b.password || ''), u.pw_hash)) { auth.recordFailure(ip); throw err(401, 'Email or password is incorrect'); }
  auth.recordSuccess(ip);
  D.users.seen(u.id);
  const s = auth.createSession(u.id, { remember: !!b.remember, ua: req.headers['user-agent'], ip });
  send(res, 200, { ok: true, user: D.users.public(u) }, { 'set-cookie': auth.cookieHeader(s.raw, s.ttl, SECURE) });
});
r.post('/auth/logout', (req, res) => { auth.destroySession(req); send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookieHeader(SECURE) }); });
r.get('/auth/token/:token', (req, res) => {
  const kind = auth.peekToken(req.params.token, 'invite') ? 'invite' : auth.peekToken(req.params.token, 'reset') ? 'reset' : null;
  if (!kind) throw err(404, 'This link has expired or was already used');
  const u = D.users.get(auth.peekToken(req.params.token, kind));
  ok(res, { kind, name: u.name, email: u.email });
});
r.post('/auth/accept', async (req, res) => {
  const b = await readJson(req);
  const p = auth.passwordProblem(b.password); if (p) throw err(400, p);
  const kind = auth.peekToken(b.token, 'invite') ? 'invite' : 'reset';
  const uid = auth.consumeToken(b.token, kind); if (!uid) throw err(400, 'This link has expired or was already used');
  D.users.setPassword(uid, auth.hashPassword(b.password));
  auth.destroyUserSessions(uid);
  const s = auth.createSession(uid, { remember: true, ua: req.headers['user-agent'], ip: auth.clientIp(req) });
  send(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader(s.raw, s.ttl, SECURE) });
});
r.post('/auth/forgot', async (req, res) => {
  const b = await readJson(req);
  const u = D.users.byEmail(String(b.email || ''));
  if (u && u.status === 'Active') {
    const t = auth.issueToken(u.id, 'reset', 1);
    await mail.send({ to: u.email, subject: 'Reset your GBX Pipeline password', title: 'Reset your password', html: `<p>Hi ${mail.esc(u.name.split(' ')[0])}, someone asked to reset the password for this account. The link works once and expires in 24 hours. If it wasn't you, ignore this email.</p>`, cta: { label: 'Choose a new password', url: `${BASE}/#/reset/${t}` }, kind: 'reset' });
  }
  ok(res, { ok: true, sent: !!(u && mail.enabled()) });
});
r.post('/auth/password', async (req, res) => {
  const u = session(req); const b = await readJson(req);
  if (!auth.verifyPassword(String(b.current || ''), u.pw_hash)) throw err(400, 'Current password is incorrect');
  const p = auth.passwordProblem(b.password); if (p) throw err(400, p);
  D.users.setPassword(u.id, auth.hashPassword(b.password));
  ok(res);
});

/* ---------- bootstrap & sync ---------- */
r.get('/bootstrap', (req, res) => {
  const u = auth.sessionUser(req);
  if (!u) throw err(401, 'Sign in required', { setup: D.users.count() === 0 });
  D.users.seen(u.id);
  ok(res, state.bootstrap(u));
});
r.get('/sync', (req, res) => { const u = session(req); ok(res, state.pull(Number(req.query.get('since')) || 0, u)); });
r.post('/sync', async (req, res) => { const u = session(req); const b = await readJson(req, 12 * 1024 * 1024); ok(res, state.applySync(u, b)); });

/* ---------- users & invites ---------- */
async function sendInvite(u, by) {
  const t = auth.issueToken(u.id, 'invite', 7);
  const url = `${BASE}/#/invite/${t}`;
  const sent = await mail.send({ to: u.email, subject: `${by.name} invited you to GBX Pipeline`, title: 'You have been invited', html: `<p>Hi ${mail.esc(u.name.split(' ')[0])}, ${mail.esc(by.name)} added you to the GBX Professional Services pipeline workspace as <b>${mail.esc(u.role)}</b>. Choose a password to get started. The link expires in 7 days.</p>`, cta: { label: 'Set your password', url }, kind: 'invite' });
  return { url, sent };
}
r.post('/users', async (req, res) => {
  const me = admin(req); const b = await readJson(req);
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw err(400, 'Valid email required');
  if (D.users.byEmail(email)) throw err(409, 'A user with that email already exists');
  const colors = D.kvGet('colors') || ['#2E8B6E', '#B4463F', '#3E6C9B', '#B0812A', '#6E5E9B', '#7A8B2E', '#8B4A6E', '#3F8A8A'];
  const used = D.users.all().map((x) => x.color);
  const u = { id: D.users.newId(), email, name: String(b.name || email.split('@')[0]).slice(0, 80), role: ['Admin', 'Manager', 'Member'].includes(b.role) ? b.role : 'Member', status: 'Invited', color: colors.find((c) => !used.includes(c)) || colors[used.length % colors.length], focus: String(b.focus || '').slice(0, 120) };
  D.users.insert(u);
  const inv = await sendInvite(D.users.get(u.id), me);
  ok(res, { user: D.users.public(D.users.get(u.id)), inviteUrl: inv.url, emailed: inv.sent });
});
r.post('/users/:id/invite', async (req, res) => { const me = admin(req); const u = D.users.get(req.params.id); if (!u) throw err(404, 'No such user'); if (u.status === 'Active' && u.pw_hash) throw err(400, 'User is already active'); const inv = await sendInvite(u, me); ok(res, { inviteUrl: inv.url, emailed: inv.sent }); });
r.post('/users/:id/reset', async (req, res) => { admin(req); const u = D.users.get(req.params.id); if (!u) throw err(404, 'No such user'); const t = auth.issueToken(u.id, 'reset', 1); const url = `${BASE}/#/reset/${t}`; const sent = await mail.send({ to: u.email, subject: 'Reset your GBX Pipeline password', title: 'Reset your password', html: '<p>An admin issued a password reset for your account. The link works once and expires in 24 hours.</p>', cta: { label: 'Choose a new password', url }, kind: 'reset' }); ok(res, { resetUrl: url, emailed: sent }); });

/* ---------- API keys ---------- */
r.post('/keys', async (req, res) => { const me = admin(req); const b = await readJson(req); if (!b.name) throw err(400, 'Name required'); const scopes = (Array.isArray(b.scopes) ? b.scopes : []).filter((s) => ['deals:read', 'deals:write', 'contacts:write', 'files:read', 'ai:write'].includes(s)); const k = auth.createApiKey(String(b.name).slice(0, 60), scopes.length ? scopes : ['deals:read'], me.id); ok(res, { id: k.id, key: k.key, keys: auth.listApiKeys() }); });
r.delete('/keys/:id', (req, res) => { admin(req); auth.revokeApiKey(req.params.id); ok(res, { keys: auth.listApiKeys() }); });

/* ---------- push ---------- */
r.get('/push/key', (req, res) => ok(res, { publicKey: push.publicKey }));
r.post('/push/subscribe', async (req, res) => { const u = session(req); const b = await readJson(req); push.subscribe(u.id, b.device, b.subscription); ok(res, { devices: push.devices() }); });
r.post('/push/unsubscribe', async (req, res) => { session(req); const b = await readJson(req); if (b.endpoint) push.unsubscribe(b.endpoint); ok(res, { devices: push.devices() }); });
r.post('/push/test', async (req, res) => { const u = session(req); const n = await push.sendToUser(u.id, { title: 'GBX Pipeline test', body: 'Push is working on this device.', url: '#/settings/notifications', kind: 'system', id: 'test' }); ok(res, { sent: n }); });

/* ---------- leads API (Claude agent, Zapier, ads platforms) ---------- */
const dealView = (d) => ({ ...d, campaign: (D.kvGet('campaigns') || {})[d.id] || '' });
r.get('/leads', (req, res) => {
  actor(req, 'deals:read');
  const q = req.query; let list = D.listCol('deals');
  if (q.get('stage')) list = list.filter((d) => d.stage === q.get('stage'));
  if (q.get('owner')) list = list.filter((d) => d.owner === q.get('owner'));
  if (q.get('source')) list = list.filter((d) => d.source === q.get('source'));
  if (q.get('since')) list = list.filter((d) => (d.created || '') >= q.get('since'));
  list.sort((a, b) => (a.created < b.created ? 1 : -1));
  ok(res, { leads: list.slice(0, Number(q.get('limit')) || 200).map(dealView), stages: D.kvGet('stages') || [], users: D.users.publicAll().map((u) => ({ id: u.id, name: u.name })) });
});
r.get('/leads/:id', (req, res) => {
  actor(req, 'deals:read'); const d = D.getRecord('deals', req.params.id); if (!d) throw err(404, 'No such lead');
  const id = d.id;
  ok(res, { lead: dealView(d), activity: D.listCol('activity').filter((a) => a.deal === id).sort((a, b) => (a.at < b.at ? 1 : -1)), tasks: D.listCol('tasks').filter((t) => t.deal === id), changes: D.listCol('changes').filter((c) => c.entity === 'deal' && c.ref === id), files: D.listCol('files').filter((f) => f.deal === id), invoices: D.listCol('invoices').filter((i) => i.deal === id).map((i) => ({ id: i.id, number: i.number, status: i.status, issued: i.issued, due: i.due })) });
});
r.post('/leads', async (req, res) => {
  const a = actor(req, 'deals:write'); const b = await readJson(req);
  const out = await leads.createLead(b, { source: b.source || 'website', campaign: b.campaign || '', via: a.key ? 'api:' + a.name : 'user:' + a.id, allowDuplicate: !!b.allowDuplicate });
  if (out.error) throw err(400, out.error);
  if (out.duplicate) return send(res, 409, { error: 'Duplicate lead', duplicate: out.duplicate });
  send(res, 201, { lead: dealView(out.deal), score: out.score });
});
const EDITABLE = ['practice', 'contact', 'email', 'phone', 'value', 'service', 'segment', 'advisers', 'fum', 'city', 'licensee', 'priority', 'stage', 'owner', 'close', 'notes'];
r.patch('/leads/:id', async (req, res) => {
  const a = actor(req, 'deals:write'); const b = await readJson(req);
  const d = D.getRecord('deals', req.params.id); if (!d) throw err(404, 'No such lead');
  const fields = D.kvGet('fields') || []; const allowed = new Set([...EDITABLE, ...fields.map((f) => f.id)]);
  const stages = D.kvGet('stages') || []; const stageName = (s) => (stages.find((x) => x.id === s) || {}).name || s;
  const at = D.nowIso(); const who = a.key ? '' : a.id; const next = { ...d }; const changed = [];
  for (const [k, v] of Object.entries(b)) {
    if (!allowed.has(k) || JSON.stringify(d[k]) === JSON.stringify(v)) continue;
    if (k === 'stage' && !stages.some((s) => s.id === v)) throw err(400, 'Unknown stage ' + v);
    if (k === 'owner' && v && !D.users.get(v)) throw err(400, 'Unknown user ' + v);
    next[k] = v; changed.push(k);
    const label = k === 'stage' ? 'Stage' : k === 'owner' ? 'Owner' : (fields.find((f) => f.id === k) || {}).label || k;
    const fmt = (x) => (k === 'stage' ? stageName(x) : k === 'owner' ? (D.users.get(x) || {}).name || 'Unassigned' : String(x ?? ''));
    D.putRecord('changes', { id: Date.now() + changed.length, entity: 'deal', ref: d.id, at, who, field: label, from: fmt(d[k]), to: fmt(v), via: a.key ? a.name : undefined }, who || 'api');
  }
  if (changed.length) { D.putRecord('deals', next, who || 'api'); D.putRecord('activity', { id: Date.now() + 50, deal: d.id, type: a.key ? 'ai' : 'note', who, text: (a.key ? a.name + ' updated ' : 'Updated ') + changed.join(', '), detail: changed.map((k) => `${k}: ${next[k]}`).join(' · ').slice(0, 300), at }, who || 'api'); }
  if (changed.includes('owner') && next.owner && next.owner !== who) await notify('lead', [next.owner], { title: `Lead assigned: ${next.practice}`, body: `${a.name} made you the owner`, url: '#/deal/' + d.id, kind: 'lead', id: d.id });
  ok(res, { lead: dealView(next), changed });
});
r.post('/leads/:id/activity', async (req, res) => {
  const a = actor(req, 'ai:write'); const b = await readJson(req);
  const d = D.getRecord('deals', req.params.id); if (!d) throw err(404, 'No such lead');
  if (!b.text) throw err(400, 'text required');
  const rec = { id: Date.now(), deal: d.id, type: ['ai', 'note', 'call', 'email', 'meeting'].includes(b.type) ? b.type : a.key ? 'ai' : 'note', who: a.key ? '' : a.id, text: String(b.text).slice(0, 200), detail: String(b.detail || '').slice(0, 2000), at: D.nowIso() };
  D.putRecord('activity', rec, a.key ? 'api' : a.id);
  if (b.score != null) { D.putRecord('activity', { ...rec, id: rec.id + 1, type: 'ai', text: `Claude scored lead ${Number(b.score)} / 100`, detail: String(b.detail || '') }, 'api'); }
  if (b.notifyOwner && d.owner) await notify('lead', [d.owner], { title: `${a.name}: ${d.practice}`, body: rec.text, url: '#/deal/' + d.id, kind: 'lead', id: d.id });
  send(res, 201, { activity: rec });
});
r.get('/stages', (req, res) => { actor(req, 'deals:read'); ok(res, { stages: D.kvGet('stages') || [], sources: D.kvGet('sources') || {}, fields: D.kvGet('fields') || [] }); });
r.get('/users', (req, res) => { actor(req, 'deals:read'); ok(res, { users: D.users.publicAll().map((u) => ({ id: u.id, name: u.name, role: u.role, status: u.status })) }); });

/* ---------- ads webhooks ---------- */
r.post('/hooks/google-ads', async (req, res) => {
  const b = await readJson(req);
  const keyOk = auth.apiKeyFromReq(req);
  const secret = process.env.GOOGLE_ADS_KEY;
  if (!keyOk && !(secret && b.google_key && String(b.google_key).length === secret.length && crypto.timingSafeEqual(Buffer.from(String(b.google_key)), Buffer.from(secret)))) { D.log.hook.run(D.nowIso(), 'google', 'rejected', 'bad google_key', ''); throw err(401, 'Invalid google_key'); }
  const lead = leads.fromGoogle(b);
  const out = await leads.createLead(lead, { source: 'google', campaign: lead.campaign, via: 'google' });
  if (out.duplicate) return send(res, 200, { ok: true, duplicate: out.duplicate }); // Google retries non-2xx; a duplicate is not an error for them
  ok(res, { ok: true, id: out.deal && out.deal.id });
});
r.get('/hooks/meta', (req, res) => {
  const q = req.query;
  if (q.get('hub.mode') === 'subscribe' && process.env.META_VERIFY_TOKEN && q.get('hub.verify_token') === process.env.META_VERIFY_TOKEN) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(q.get('hub.challenge') || ''); }
  throw err(403, 'Verification failed');
});
r.post('/hooks/meta', async (req, res) => {
  const raw = await readBody(req); let b = {}; try { b = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw err(400, 'Invalid JSON'); }
  const keyOk = auth.apiKeyFromReq(req);
  if (!keyOk) {
    const sig = String(req.headers['x-hub-signature-256'] || ''); const secret = process.env.META_APP_SECRET;
    const exp = secret ? 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') : '';
    if (!secret || sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) { D.log.hook.run(D.nowIso(), 'meta', 'rejected', 'bad signature', ''); throw err(401, 'Bad signature'); }
  }
  // Direct/Zapier-style payload with an API key: { practice, contact, email, ... }
  if (keyOk && (b.email || b.practice || b.contact)) { const out = await leads.createLead(b, { source: 'meta', campaign: b.campaign || '', via: 'meta:' + keyOk.name }); return out.duplicate ? send(res, 409, { duplicate: out.duplicate }) : ok(res, { ok: true, id: out.deal.id }); }
  const ids = [];
  for (const e of b.entry || []) for (const c of e.changes || []) if (c.field === 'leadgen' && c.value && c.value.leadgen_id) ids.push(c.value);
  const token = process.env.META_PAGE_TOKEN; const results = [];
  for (const v of ids) {
    if (!token) { D.log.hook.run(D.nowIso(), 'meta', 'skipped', 'META_PAGE_TOKEN not set; lead ' + v.leadgen_id + ' not fetched', v.leadgen_id); D.putRecord('notifs', { id: Date.now(), text: 'Meta lead received but not imported', p: 'Set META_PAGE_TOKEN on the server to fetch lead details', at: D.nowIso().slice(11, 16), read: false, go: '#/integrations', day: D.today() }, 'system'); continue; }
    try {
      const g = await fetch(`https://graph.facebook.com/v21.0/${v.leadgen_id}?fields=field_data,ad_name,campaign_name,form_id,created_time&access_token=${encodeURIComponent(token)}`);
      const j = await g.json(); if (!g.ok) throw new Error(j.error ? j.error.message : g.status);
      const lead = leads.fromMetaFields(j.field_data, { leadgen_id: v.leadgen_id, campaign_name: j.campaign_name, ad_name: j.ad_name, form_name: v.form_name });
      results.push(await leads.createLead(lead, { source: 'meta', campaign: lead.campaign, via: 'meta' }));
    } catch (e) { D.log.hook.run(D.nowIso(), 'meta', 'failed', e.message, v.leadgen_id); }
  }
  ok(res, { ok: true, received: ids.length, created: results.filter((x) => x.deal).length });
});
r.post('/hooks/lead', async (req, res) => { const a = actor(req, 'deals:write'); const b = await readJson(req); const out = await leads.createLead(b, { source: b.source || 'website', campaign: b.campaign || '', via: 'hook:' + a.name }); if (out.error) throw err(400, out.error); if (out.duplicate) return send(res, 409, { duplicate: out.duplicate }); send(res, 201, { ok: true, id: out.deal.id }); });

/* ---------- SharePoint files ---------- */
function dealFolder(dealId) { const d = D.getRecord('deals', dealId); if (!d) throw err(404, 'No such deal'); return { d, folder: graph.safe(d.practice) }; }
r.get('/files', async (req, res) => {
  session(req); if (!graph.enabled()) return ok(res, { configured: false, files: [] });
  const { d, folder } = dealFolder(req.query.get('deal'));
  const items = (await graph.listFolder(folder)).filter((x) => !x.folder);
  // Mirror into the files collection so the rest of the app (tasks, changelog) can link them.
  const existing = D.listCol('files').filter((f) => f.deal === d.id);
  for (const it of items) if (!existing.some((f) => f.spId === it.spId)) D.putRecord('files', { id: D.nextId('files'), deal: d.id, name: it.name, size: fmtSize(it.size), by: '', byName: it.byName, at: it.at, kind: it.name.split('.').pop().toUpperCase().slice(0, 3), url: it.url, spId: it.spId }, 'system');
  ok(res, { configured: true, folder: `${graph.SP_LIBRARY}/${folder}`, files: items });
});
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
r.put('/files/upload', async (req, res) => {
  const u = session(req); if (!graph.enabled()) throw err(503, 'SharePoint is not configured on the server');
  const { d, folder } = dealFolder(req.query.get('deal'));
  const name = String(req.query.get('name') || 'upload.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
  const buf = await readBody(req, 100 * 1024 * 1024);
  const item = await graph.upload(folder, name, buf);
  const rec = { id: D.nextId('files'), deal: d.id, name: item.name || name, size: fmtSize(buf.length), by: u.id, at: D.today(), kind: name.split('.').pop().toUpperCase().slice(0, 3), url: item.webUrl, spId: item.id };
  D.putRecord('files', rec, u.id);
  D.putRecord('activity', { id: Date.now(), deal: d.id, type: 'file', who: u.id, text: 'Uploaded to SharePoint', detail: rec.name, at: D.nowIso() }, u.id);
  ok(res, { file: rec });
});

/* ---------- market data ---------- */
r.get('/market/quotes', async (req, res) => { session(req); const syms = String(req.query.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 40); ok(res, { quotes: await market.quotes(syms), fx: await market.fx() }); });
r.get('/market/history', async (req, res) => { session(req); const sym = String(req.query.get('symbol') || '').toUpperCase(); if (!sym) throw err(400, 'symbol required'); const h = await market.history(sym, Math.min(10, Number(req.query.get('years')) || 5)); if (!h) throw err(404, 'No history for ' + sym); ok(res, h); });
r.get('/market/search', async (req, res) => { session(req); ok(res, { results: await market.search(String(req.query.get('q') || '')) }); });
r.post('/market/refresh', async (req, res) => { session(req); ok(res, { updated: await market.refreshSecurities() }); });

/* ---------- admin / ops ---------- */
r.get('/admin/status', (req, res) => { admin(req); ok(res, { features: state.features(), mail: D.log.mailRecent.all(20), hooks: D.log.hookRecent.all(30), push: push.stats7d(), devices: push.devices(), jobs: ['chat', 'digest', 'backup', 'market', 'prune'].map((n) => ({ name: n, ...(D.jobs.get.get(n) || {}) })), db: D.DB_PATH, rev: D.rev() }); });
r.post('/admin/backup', async (req, res) => { admin(req); ok(res, { file: await jobs.backup() }); });
r.post('/admin/test-mail', async (req, res) => { const u = admin(req); const sent = await mail.send({ to: u.email, subject: 'GBX Pipeline test email', title: 'Email is working', text: 'This is a test from the Pipeline server.', cta: { label: 'Open Pipeline', url: BASE }, kind: 'test' }); ok(res, { sent, mode: mail.mode() }); });
r.post('/admin/run-job', async (req, res) => { admin(req); const b = await readJson(req); const fn = { chat: jobs.chatDigest, digest: jobs.dailyDigest, backup: jobs.backup, market: market.refreshSecurities }[b.job]; if (!fn) throw err(400, 'Unknown job'); ok(res, { result: await fn() }); });

module.exports = r;
