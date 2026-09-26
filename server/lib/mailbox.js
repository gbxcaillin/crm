'use strict';
// Per-user Microsoft 365 mailbox connection (delegated OAuth, authorization code + PKCE).
// A user connects their own inbox so the CRM can read recent mail, draft replies and send as
// them. Tokens live server-side only, encrypted at rest via the vault, and are NEVER synced to
// browsers. Reuses the sign-in app if configured, else the SharePoint app. On that Azure app add:
//   Delegated permissions: Mail.Read, Mail.Send, offline_access, openid, email  (grant consent)
//   Redirect URI (Web): <APP_URL>/api/v1/mail/connect/callback
const crypto = require('node:crypto');
const D = require('./db');

const CID = process.env.SSO_CLIENT_ID || process.env.MS_CLIENT_ID;
const SECRET = process.env.SSO_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
const TENANT = process.env.SSO_TENANT || process.env.MS_TENANT_ID;
const BASE = process.env.APP_URL || 'https://crm.gbxps.com';
const REDIRECT = BASE + '/api/v1/mail/connect/callback';
const SCOPES = 'openid email offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send';
const CACHE_KEY = 'mail:accounts';
const enabled = () => !!(CID && SECRET && TENANT);
const b64u = (b) => Buffer.from(b).toString('base64url');
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function authUrl() {
  const state = b64u(crypto.randomBytes(24)), verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ client_id: CID, response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query', scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
  return { url: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?${q}`, state, verifier };
}
async function tokenReq(params) {
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CID, client_secret: SECRET, redirect_uri: REDIRECT, ...params }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error_description || j.error || 'Token request failed'); return j;
}
function emailFromIdToken(idt) { try { const p = JSON.parse(Buffer.from(String(idt).split('.')[1], 'base64url')); return String(p.email || p.preferred_username || '').toLowerCase(); } catch (_) { return ''; } }

// Encrypted, server-only store (market_cache table + vault). Never enters snapshot/sync.
function load() { const raw = D.cache.get(CACHE_KEY); if (!raw) return []; try { return JSON.parse(D.vault.open(raw)); } catch (_) { return []; } }
function persist(list) { D.cache.set(CACHE_KEY, D.vault.seal(JSON.stringify(list))); }
// What the client is allowed to see: address + when connected, no tokens.
function listFor(uid) { return load().filter((a) => a.user === uid).map((a) => ({ email: a.email, at: a.at })); }

async function connect(uid, code, verifier) {
  const j = await tokenReq({ grant_type: 'authorization_code', code, code_verifier: verifier, scope: SCOPES });
  const email = emailFromIdToken(j.id_token);
  if (!email) throw new Error('Could not read the mailbox address from Microsoft');
  const list = load().filter((a) => !(a.user === uid && a.email === email));
  list.push({ user: uid, email, refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, at: D.nowIso() });
  persist(list);
  return { email };
}
function remove(uid, email) { persist(load().filter((a) => !(a.user === uid && a.email === String(email).toLowerCase()))); }

// A valid access token for one connected mailbox, refreshing (and rotating the refresh token) as needed.
async function accessToken(uid, email) {
  const list = load(); const a = list.find((x) => x.user === uid && x.email === email);
  if (!a) throw new Error('That mailbox is not connected');
  if (a.access && a.exp > Date.now() + 60000) return a.access;
  const j = await tokenReq({ grant_type: 'refresh_token', refresh_token: a.refresh, scope: SCOPES });
  a.access = j.access_token; a.exp = Date.now() + (j.expires_in || 3600) * 1000; if (j.refresh_token) a.refresh = j.refresh_token;
  persist(list); return a.access;
}
async function gget(tok, path) {
  const r = await fetch('https://graph.microsoft.com/v1.0' + path, { headers: { authorization: 'Bearer ' + tok } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('Graph ' + path + ': ' + r.status + ' ' + (j.error ? j.error.message : '')); return j;
}
// Recent inbox messages for one connected mailbox.
async function recent(uid, email, top = 20) {
  const tok = await accessToken(uid, email);
  const j = await gget(tok, `/me/mailFolders/inbox/messages?$top=${top}&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,webLink`);
  return (j.value || []).map((m) => ({ id: m.id, conv: m.conversationId, subject: m.subject || '(no subject)', from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '', fromName: (m.from && m.from.emailAddress && m.from.emailAddress.name) || '', at: m.receivedDateTime, preview: m.bodyPreview || '', read: !!m.isRead, url: m.webLink, account: email }));
}
// Send from a connected mailbox (new message, or a reply when replyTo message id is given).
async function send(uid, email, { to, subject, body, replyTo }) {
  const tok = await accessToken(uid, email);
  const html = `<div style="white-space:pre-wrap;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55">${escHtml(body)}</div>`;
  let path = '/me/sendMail', payload = { message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true };
  if (replyTo) { path = `/me/messages/${encodeURIComponent(replyTo)}/reply`; payload = { message: { toRecipients: [{ emailAddress: { address: to } }] }, comment: body }; }
  const r = await fetch('https://graph.microsoft.com/v1.0' + path, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('Send failed: ' + r.status + ' ' + (j.error ? j.error.message : '')); }
  return { sent: true };
}
module.exports = { enabled, authUrl, connect, remove, accessToken, listFor, recent, send, REDIRECT };
