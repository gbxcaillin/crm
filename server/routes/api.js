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
const bookings = require('../lib/bookings');
const cloudflare = require('../lib/cloudflare');
const claude = require('../lib/claude');
const { notify } = require('../lib/notify');
const totp = require('../lib/totp');
const oidc = require('../lib/oidc');
const QR = require('qrcode');
const { err, send, readJson, readBody, makeRouter } = require('../lib/http');

const r = makeRouter();
const SECURE = auth.SECURE;
const BASE = mail.BASE;

/* ---------- guards ---------- */
// Paths a "limited" session (signed in, but MFA enrolment still required by policy) may call.
const LIMITED_OK = /^\/(bootstrap|auth\/(logout|mfa\/setup|mfa\/enable|password|sessions.*))$/;
function session(req, { allowLimited = false } = {}) {
  const u = auth.sessionUser(req); if (!u) throw err(401, 'Sign in required');
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'gbx') throw err(403, 'Missing X-Requested-With header');
  if (!allowLimited && !LIMITED_OK.test(req.apiPath || '') && (req.session.limited || (state.mfaRequiredFor(u) && !u.totp_secret && req.session.via !== 'sso'))) throw err(403, 'Set up two-factor authentication to continue', { mfaSetup: true });
  u.ip = auth.clientIp(req);
  return u;
}
function admin(req) { const u = session(req); if (u.role !== 'Admin') throw err(403, 'Admin only'); return u; }
const audit = (req, who, action, target, detail) => D.audit(who, auth.clientIp(req), action, target, detail);
function finishLogin(req, res, u, { remember, via }) {
  const limited = via !== 'sso' && state.mfaRequiredFor(u) && !u.totp_secret;
  const s = auth.createSession(u.id, { remember: !!remember, ua: req.headers['user-agent'], ip: auth.clientIp(req), limited, via });
  D.users.seen(u.id);
  audit(req, u.id, 'login.ok', u.email, via + (limited ? ' (mfa setup pending)' : ''));
  return { user: D.users.public(u), cookie: auth.cookieHeader(s.raw, s.ttl, SECURE), mfaSetup: limited };
}
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
  audit(req, id, 'workspace.setup', b.email, '');
  const f = finishLogin(req, res, D.users.get(id), { remember: true, via: 'password' });
  send(res, 200, { ok: true, mfaSetup: f.mfaSetup }, { 'set-cookie': f.cookie });
});
r.post('/auth/login', async (req, res) => {
  const ip = auth.clientIp(req);
  if (auth.lockedOut(ip)) { audit(req, '', 'login.locked', ip, ''); throw err(429, 'Too many attempts. Try again in 15 minutes.'); }
  if (!state.securityPolicy().passwordLogin) throw err(403, 'Password sign-in is turned off. Use Sign in with Microsoft.');
  const b = await readJson(req);
  const u = D.users.byEmail(String(b.email || ''));
  if (!u || u.status !== 'Active' || !u.pw_hash || !auth.verifyPassword(String(b.password || ''), u.pw_hash)) { auth.recordFailure(ip); audit(req, u ? u.id : '', 'login.fail', String(b.email || '').slice(0, 80), ''); throw err(401, 'Email or password is incorrect'); }
  auth.recordSuccess(ip);
  if (u.totp_secret) { const ticket = auth.issueToken(u.id, 'mfa', 0, 10); return ok(res, { mfa: true, ticket, remember: !!b.remember }); }
  const f = finishLogin(req, res, u, { remember: b.remember, via: 'password' });
  send(res, 200, { ok: true, user: f.user, mfaSetup: f.mfaSetup }, { 'set-cookie': f.cookie });
});
// Second factor after a correct password: a TOTP code or a one-time backup code.
r.post('/auth/mfa', async (req, res) => {
  const ip = auth.clientIp(req); if (auth.lockedOut(ip)) throw err(429, 'Too many attempts. Try again in 15 minutes.');
  const b = await readJson(req);
  const uid = auth.peekToken(b.ticket, 'mfa'); if (!uid) throw err(401, 'Sign in again');
  const u = D.users.get(uid); const m = D.users.mfa(uid);
  let via = 'mfa';
  if (!totp.verify(m.secret, b.code)) {
    const left = totp.useBackupCode(m.codes, b.code);
    if (!left) { auth.recordFailure(ip); audit(req, uid, 'mfa.fail', u.email, ''); throw err(401, 'That code is not valid'); }
    D.users.setMfa(uid, { secret: m.secret, pending: null, codes: left }); via = 'backup-code'; audit(req, uid, 'mfa.backupcode', u.email, `${left.length} left`);
  }
  auth.consumeToken(b.ticket, 'mfa'); auth.recordSuccess(ip);
  const f = finishLogin(req, res, u, { remember: b.remember, via });
  send(res, 200, { ok: true, user: f.user }, { 'set-cookie': f.cookie });
});
r.post('/auth/logout', (req, res) => { const u = auth.sessionUser(req); if (u) audit(req, u.id, 'logout', u.email, ''); auth.destroySession(req); send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookieHeader(SECURE) }); });
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
  audit(req, uid, kind === 'invite' ? 'invite.accept' : 'password.reset', D.users.get(uid).email, '');
  const f = finishLogin(req, res, D.users.get(uid), { remember: true, via: 'password' });
  send(res, 200, { ok: true, mfaSetup: f.mfaSetup }, { 'set-cookie': f.cookie });
});
r.post('/auth/forgot', async (req, res) => {
  const ip = auth.clientIp(req); if (auth.limited('forgot:' + ip, 5, 15 * 60e3)) throw err(429, 'Too many requests');
  const b = await readJson(req);
  const u = D.users.byEmail(String(b.email || ''));
  if (u && u.status === 'Active') {
    const t = auth.issueToken(u.id, 'reset', 1);
    audit(req, u.id, 'password.forgot', u.email, '');
    await mail.send({ to: u.email, subject: 'Reset your GBX Pipeline password', title: 'Reset your password', html: `<p>Hi ${mail.esc(u.name.split(' ')[0])}, someone asked to reset the password for this account. The link works once and expires in 24 hours. If it wasn't you, ignore this email.</p>`, cta: { label: 'Choose a new password', url: `${BASE}/#/reset/${t}` }, kind: 'reset' });
  }
  ok(res, { ok: true, sent: !!(u && mail.enabled()) });
});
r.post('/auth/password', async (req, res) => {
  const u = session(req, { allowLimited: true }); const b = await readJson(req);
  if (u.pw_hash && !auth.verifyPassword(String(b.current || ''), u.pw_hash)) throw err(400, 'Current password is incorrect');
  const p = auth.passwordProblem(b.password); if (p) throw err(400, p);
  D.users.setPassword(u.id, auth.hashPassword(b.password));
  auth.revokeOtherSessions(u.id, req.sessionId);
  audit(req, u.id, 'password.change', u.email, 'other sessions signed out');
  ok(res);
});

/* ---------- two-factor (TOTP) ---------- */
r.post('/auth/mfa/setup', async (req, res) => {
  const u = session(req, { allowLimited: true });
  const secret = totp.newSecret(); const m = D.users.mfa(u.id);
  D.users.setMfa(u.id, { secret: m.secret, pending: secret, codes: m.codes });
  const url = totp.otpauthUrl(secret, u.email);
  ok(res, { secret, url, qr: await QR.toDataURL(url, { margin: 1, width: 200, color: { dark: '#1A1A1A', light: '#FFFDF8' } }) });
});
r.post('/auth/mfa/enable', async (req, res) => {
  const u = session(req, { allowLimited: true }); const b = await readJson(req);
  const m = D.users.mfa(u.id); if (!m.pending) throw err(400, 'Start setup first');
  if (!totp.verify(m.pending, b.code)) throw err(400, 'That code is not valid — check the time on your phone and try again');
  const codes = totp.newBackupCodes();
  D.users.setMfa(u.id, { secret: m.pending, pending: null, codes: codes.hashes });
  auth.unlimitSession(req.sessionId, 'mfa'); auth.revokeOtherSessions(u.id, req.sessionId);
  audit(req, u.id, 'mfa.enable', u.email, '');
  ok(res, { ok: true, backupCodes: codes.codes });
});
r.post('/auth/mfa/codes', async (req, res) => {
  const u = session(req); const b = await readJson(req);
  const m = D.users.mfa(u.id); if (!m.secret) throw err(400, 'Two-factor is not enabled');
  if (!totp.verify(m.secret, b.code)) throw err(400, 'Enter a current code from your authenticator');
  const codes = totp.newBackupCodes(); D.users.setMfa(u.id, { secret: m.secret, pending: null, codes: codes.hashes });
  audit(req, u.id, 'mfa.codes', u.email, 'regenerated'); ok(res, { backupCodes: codes.codes });
});
r.post('/auth/mfa/disable', async (req, res) => {
  const u = session(req); const b = await readJson(req);
  if (state.mfaRequiredFor(u)) throw err(403, 'Two-factor is required for your role');
  if (u.pw_hash && !auth.verifyPassword(String(b.password || ''), u.pw_hash)) throw err(400, 'Password is incorrect');
  D.users.setMfa(u.id, { secret: null, pending: null, codes: null }); audit(req, u.id, 'mfa.disable', u.email, ''); ok(res);
});
r.post('/users/:id/mfa-reset', (req, res) => {
  const me = admin(req); const u = D.users.get(req.params.id); if (!u) throw err(404, 'No such user');
  D.users.setMfa(u.id, { secret: null, pending: null, codes: null }); auth.destroyUserSessions(u.id);
  audit(req, me.id, 'mfa.reset', u.email, 'by admin'); ok(res, { user: D.users.public(D.users.get(u.id)) });
});

/* ---------- Microsoft 365 sign-in (OIDC) ---------- */
r.get('/auth/microsoft', (req, res) => {
  if (!oidc.enabled()) throw err(404, 'Microsoft sign-in is not configured');
  const a = oidc.authUrl(); auth.stashOidc(a.state, { nonce: a.nonce, verifier: a.verifier });
  res.writeHead(302, { location: a.url, 'cache-control': 'no-store' }); res.end();
});
r.get('/auth/microsoft/callback', async (req, res) => {
  const back = (msg) => { res.writeHead(302, { location: BASE + '/#/login?error=' + encodeURIComponent(msg) }); res.end(); };
  try {
    if (!oidc.enabled()) return back('Microsoft sign-in is not configured');
    const q = req.query; if (q.get('error')) return back(q.get('error_description') || q.get('error'));
    const st = auth.takeOidc(q.get('state')); if (!st) return back('Sign-in expired, try again');
    const id = await oidc.exchange(q.get('code'), st.verifier, st.nonce);
    let u = D.users.byEmail(id.email);
    if (!u && process.env.SSO_AUTO_PROVISION === '1' && process.env.SSO_DOMAIN && id.email.endsWith('@' + process.env.SSO_DOMAIN.toLowerCase())) {
      u = { id: D.users.newId(), email: id.email, name: id.name, role: 'Member', status: 'Active', color: '#3E6C9B', sso_oid: id.oid }; D.users.insert(u); u = D.users.get(u.id); audit(req, u.id, 'user.provisioned', id.email, 'via Microsoft sign-in');
    }
    if (!u) { audit(req, '', 'sso.denied', id.email, 'no matching user'); return back('No Pipeline account for ' + id.email + '. Ask an admin to invite you.'); }
    if (u.status === 'Invited') { D.users.update({ ...u, status: 'Active' }); u = D.users.get(u.id); }
    if (u.status !== 'Active') return back('This account is deactivated');
    if (!u.sso_oid) D.users.linkSso(u.id, id.oid);
    const f = finishLogin(req, res, u, { remember: true, via: 'sso' });
    res.writeHead(302, { location: BASE + '/#/dashboard', 'set-cookie': f.cookie, 'cache-control': 'no-store' }); res.end();
  } catch (e) { console.error('[sso]', e.message); back('Microsoft sign-in failed: ' + e.message); }
});

/* ---------- sessions ---------- */
r.get('/auth/sessions', (req, res) => { const u = session(req, { allowLimited: true }); ok(res, { sessions: auth.listSessions(u.id, req.sessionId) }); });
r.delete('/auth/sessions/:id', (req, res) => { const u = session(req, { allowLimited: true }); if (!auth.revokeSession(u.id, req.params.id)) throw err(404, 'No such session'); audit(req, u.id, 'session.revoke', req.params.id, ''); ok(res, { sessions: auth.listSessions(u.id, req.sessionId) }); });
r.post('/auth/sessions/revoke-others', (req, res) => { const u = session(req, { allowLimited: true }); const n = auth.revokeOtherSessions(u.id, req.sessionId); audit(req, u.id, 'session.revoke', 'others', n + ' sessions'); ok(res, { revoked: n, sessions: auth.listSessions(u.id, req.sessionId) }); });

/* ---------- bootstrap & sync ---------- */
r.get('/bootstrap', (req, res) => {
  const u = auth.sessionUser(req);
  if (!u) { const pol = state.securityPolicy(); throw err(401, 'Sign in required', { setup: D.users.count() === 0, sso: pol.sso, passwordLogin: pol.passwordLogin }); }
  D.users.seen(u.id);
  const b = state.bootstrap(u, req.session);
  b.security.needsMfaSetup = req.session.limited || (state.mfaRequiredFor(u) && !u.totp_secret && req.session.via !== 'sso');
  if (b.security.needsMfaSetup) { delete b.state; b.rev = 0; }
  ok(res, b);
});
r.get('/sync', (req, res) => { const u = session(req); ok(res, state.pull(Number(req.query.get('since')) || 0, u)); });
r.post('/sync', async (req, res) => { const u = session(req); const b = await readJson(req, 12 * 1024 * 1024); ok(res, state.applySync(u, b)); });
// A Member's role changes are audited through the users op path; log role/status edits explicitly.

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
  audit(req, me.id, 'invite.create', email, u.role);
  const inv = await sendInvite(D.users.get(u.id), me);
  ok(res, { user: D.users.public(D.users.get(u.id)), inviteUrl: inv.url, emailed: inv.sent });
});
r.post('/users/:id/invite', async (req, res) => { const me = admin(req); const u = D.users.get(req.params.id); if (!u) throw err(404, 'No such user'); if (u.status === 'Active' && u.pw_hash) throw err(400, 'User is already active'); const inv = await sendInvite(u, me); ok(res, { inviteUrl: inv.url, emailed: inv.sent }); });
r.post('/users/:id/reset', async (req, res) => { admin(req); const u = D.users.get(req.params.id); if (!u) throw err(404, 'No such user'); const t = auth.issueToken(u.id, 'reset', 1); const url = `${BASE}/#/reset/${t}`; const sent = await mail.send({ to: u.email, subject: 'Reset your GBX Pipeline password', title: 'Reset your password', html: '<p>An admin issued a password reset for your account. The link works once and expires in 24 hours.</p>', cta: { label: 'Choose a new password', url }, kind: 'reset' }); ok(res, { resetUrl: url, emailed: sent }); });

/* ---------- API keys ---------- */
r.post('/keys', async (req, res) => { const me = admin(req); const b = await readJson(req); if (!b.name) throw err(400, 'Name required'); const scopes = (Array.isArray(b.scopes) ? b.scopes : []).filter((s) => ['deals:read', 'deals:write', 'contacts:write', 'files:read', 'ai:write'].includes(s)); const k = auth.createApiKey(String(b.name).slice(0, 60), scopes.length ? scopes : ['deals:read'], me.id); audit(req, me.id, 'key.create', b.name, scopes.join(' ')); ok(res, { id: k.id, key: k.key, keys: auth.listApiKeys() }); });
r.delete('/keys/:id', (req, res) => { const me = admin(req); auth.revokeApiKey(req.params.id); audit(req, me.id, 'key.revoke', req.params.id, ''); ok(res, { keys: auth.listApiKeys() }); });

/* ---------- Microsoft Bookings ---------- */
r.get('/integrations/bookings', (req, res) => { admin(req); const last = D.jobs.get.get('bookings'); ok(res, { enabled: bookings.enabled(), business: process.env.BOOKINGS_BUSINESS || '', lastRun: last ? last.last_run : null, lastResult: last ? last.detail : '' }); });
r.post('/integrations/bookings/sync', async (req, res) => { const me = admin(req); if (!bookings.enabled()) throw err(400, 'Bookings is not configured. Set BOOKINGS_BUSINESS and the MS_* Graph app with Bookings.Read.All.'); const out = await bookings.sync(); audit(req, me.id, 'bookings.sync', String(out.added || 0) + ' new', ''); ok(res, out); });
r.get('/integrations/cloudflare', (req, res) => { admin(req); ok(res, { enabled: cloudflare.enabled(), account: process.env.CLOUDFLARE_ACCOUNT_ID || '', site: process.env.CLOUDFLARE_SITE_TAG || '' }); });
r.post('/integrations/cloudflare/sync', async (req, res) => { const me = admin(req); if (!cloudflare.enabled()) throw err(400, 'Cloudflare Web Analytics is not configured. Set CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_SITE_TAG.'); const out = await cloudflare.refresh(); audit(req, me.id, 'cloudflare.sync', String(out.visits || 0) + ' visits', ''); ok(res, out); });

/* ---------- analytics (website traffic tile) ---------- */
r.get('/analytics/summary', async (req, res) => { session(req); ok(res, await cloudflare.summary({ days: Math.min(90, Math.max(1, Number(req.query.get('days')) || 7)) })); });

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
  if (b.score != null) { const sc = Math.max(0, Math.min(100, Math.round(Number(b.score)))); D.putRecord('activity', { ...rec, id: rec.id + 1, type: 'ai', text: `Claude scored lead ${sc} / 100`, detail: String(b.detail || '') }, 'api'); D.putRecord('deals', { ...d, aiScore: sc, aiRationale: String(b.text || '').slice(0, 200), aiScoredAt: D.nowIso() }, a.key ? 'api' : a.id); }
  if (b.notifyOwner && d.owner) await notify('lead', [d.owner], { title: `${a.name}: ${d.practice}`, body: rec.text, url: '#/deal/' + d.id, kind: 'lead', id: d.id });
  send(res, 201, { activity: rec });
});
// On-demand Claude for the per-lead buttons (score / draft follow-up / draft reply).
// Runs via the host helper (no API key in the CRM); human session only.
r.post('/leads/:id/ai', async (req, res) => {
  const u = session(req); const b = await readJson(req);
  if (!claude.enabled()) throw err(503, 'Claude assist is not set up on the server yet (start the Claude helper).');
  const d = D.getRecord('deals', req.params.id); if (!d) throw err(404, 'No such lead');
  const stages = D.kvGet('stages') || []; const stageName = (s) => (stages.find((x) => x.id === s) || {}).name || s;
  const facts = [
    `Company/practice: ${d.practice || ''}`, `Contact: ${d.contact || ''}`, `Email: ${d.email || ''}`,
    `Source: ${d.source || ''}`, `Segment: ${d.segment || ''}`, `Team size: ${d.advisers || ''}`,
    `Value: ${d.value || ''}`, `Stage: ${stageName(d.stage)}`,
    d.notes ? `Notes: ${String(d.notes).slice(0, 700)}` : '',
  ].filter(Boolean).join('\n');

  if (b.task === 'score') {
    const prompt = [
      'You are scoring an inbound business lead for GBX Professional Services, which offers professional services and workplace financial education/wellbeing to businesses of any kind.',
      'Rate how promising the lead is and how urgently to follow up (0 = weak, 100 = drop everything). Weigh fit, buying signals, source quality and how complete the details are.',
      'Return ONLY compact JSON, no prose and no code fences: {"score":<integer 0-100>,"priority":"High"|"Medium"|"Low","rationale":"<one concise sentence>"}',
      '', 'Lead:', facts,
    ].join('\n');
    const text = await claude.run(prompt);
    const m = text.match(/\{[\s\S]*\}/); if (!m) throw err(502, 'Claude returned no score');
    const j = JSON.parse(m[0]);
    const score = Math.max(0, Math.min(100, Math.round(Number(j.score))));
    const priority = ['High', 'Medium', 'Low'].includes(j.priority) ? j.priority : 'Medium';
    const rationale = String(j.rationale || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    D.putRecord('activity', { id: Date.now(), deal: d.id, type: 'ai', who: u.id, text: `Claude scored lead ${score} / 100`, detail: `${priority}. ${rationale}`, at: D.nowIso() }, u.id);
    D.putRecord('deals', { ...d, aiScore: score, aiPriority: priority, aiRationale: rationale, aiScoredAt: D.nowIso() }, u.id);
    return ok(res, { score, priority, rationale });
  }

  if (b.task === 'draft' || b.task === 'reply') {
    const common = `Keep it professional, warm and specific, under 150 words. Return ONLY the email body - no subject line, no preamble, no markdown. Sign off as: ${u.name}, GBX Professional Services.`;
    const prompt = b.task === 'reply'
      ? ['Draft a reply email on behalf of GBX Professional Services to the message below.', common, '', 'Lead:', facts, '', 'Message to reply to:', String(b.context || '').slice(0, 1500)].join('\n')
      : ['Draft a follow-up email on behalf of GBX Professional Services to this lead, appropriate to their pipeline stage.', common, '', 'Lead:', facts].join('\n');
    const draft = (await claude.run(prompt)).trim();
    return ok(res, { draft });
  }
  throw err(400, 'Unknown task');
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
function dealFolder(dealId) { const d = D.getRecord('deals', dealId); if (!d) throw err(404, 'No such deal'); return { d, folder: [graph.SP_FOLDER, graph.safe(d.practice)].filter(Boolean).join('/') }; }
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
r.get('/admin/status', (req, res) => { admin(req); ok(res, { features: state.features(), security: state.securityPolicy(), keyVersions: D.vault.versions(), mail: D.log.mailRecent.all(20), hooks: D.log.hookRecent.all(30), push: push.stats7d(), devices: push.devices(), jobs: ['chat', 'digest', 'backup', 'market', 'prune'].map((n) => ({ name: n, ...(D.jobs.get.get(n) || {}) })), db: D.DB_PATH, rev: D.rev() }); });
r.post('/admin/backup', async (req, res) => { const me = admin(req); const f = await jobs.backup(); audit(req, me.id, 'admin.backup', f, ''); ok(res, { file: f }); });
r.get('/admin/audit', (req, res) => { admin(req); const since = req.query.get('since') || ''; ok(res, { rows: D.auditRecent(Math.min(2000, Number(req.query.get('limit')) || 200), since) }); });
r.get('/admin/audit.csv', (req, res) => { const me = admin(req); audit(req, me.id, 'audit.export', '', ''); const rows = D.auditRecent(20000, req.query.get('since') || ''); const csv = ['at,who,ip,action,target,detail', ...rows.map((r) => [r.at, r.who, r.ip, r.action, r.target, r.detail].map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','))].join('\n'); res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="pipeline-audit.csv"', 'cache-control': 'no-store' }); res.end(csv); });
r.post('/admin/test-mail', async (req, res) => { const u = admin(req); const sent = await mail.send({ to: u.email, subject: 'GBX Pipeline test email', title: 'Email is working', text: 'This is a test from the Pipeline server.', cta: { label: 'Open Pipeline', url: BASE }, kind: 'test' }); ok(res, { sent, mode: mail.mode() }); });
r.post('/admin/run-job', async (req, res) => { admin(req); const b = await readJson(req); const fn = { chat: jobs.chatDigest, digest: jobs.dailyDigest, backup: jobs.backup, market: market.refreshSecurities }[b.job]; if (!fn) throw err(400, 'Unknown job'); ok(res, { result: await fn() }); });

module.exports = r;
