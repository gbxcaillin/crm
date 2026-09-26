'use strict';
// Mailing list + bulk email. Subscribers are a synced collection; website signups arrive via
// POST /hooks/subscribe and land here immediately (or as "pending" until they confirm, when
// MAILING_DOUBLE_OPTIN=1). Bulk sends go through mail.js, one message per recipient with a per-recipient
// unsubscribe link and one-click List-Unsubscribe headers (Spam Act 2003 requires a working
// unsubscribe; Gmail/Yahoo/Outlook require the headers), rate-limited to stay under send limits.
//
// Statuses: pending (awaiting confirmation) · subscribed · unsubscribed · bounced · complained.
// Only "subscribed" ever receives campaign mail.
const crypto = require('node:crypto');
const D = require('./db');
const mail = require('./mail');

const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const newToken = () => crypto.randomBytes(16).toString('hex');
const find = (email) => D.listCol('subscribers').find((s) => s.email === normEmail(email));
const byToken = (t) => (t ? D.listCol('subscribers').find((s) => s.token === t) : null);
// Website signups are single-click by default. Set MAILING_DOUBLE_OPTIN=1 to require an emailed
// confirmation first (only takes effect when we can actually send the confirmation email).
const doubleOptIn = () => process.env.MAILING_DOUBLE_OPTIN === '1' && mail.enabled();
const brand = 'GBX Professional Services';

async function sendConfirm(s) {
  const url = `${mail.BASE}/api/v1/subscribe/confirm/${s.token}`;
  const first = (s.name || '').split(' ')[0];
  return mail.send({ to: s.email, subject: `Please confirm your subscription to ${brand}`, title: 'One more step', html: `<p>Hi ${mail.esc(first || 'there')},</p><p>Thanks for subscribing to insights from ${brand}. Please confirm it was you by clicking the button below. If you did not sign up, you can ignore this email and you will not hear from us.</p>`, cta: { label: 'Confirm my subscription', url }, footer: `${brand} · You are receiving this one-off email because this address was entered at gbxps.com.`, kind: 'campaign' });
}

// Add a subscriber, or re-subscribe/enrich an existing one. Idempotent on email.
// { confirm: true } (website signups) applies double opt-in when it is switched on: new or
// previously unsubscribed addresses become "pending" and get a confirmation email. Otherwise,
// and for staff adding someone in the CRM, the address is subscribed immediately.
async function add(input, by = 'system', { confirm = false } = {}) {
  const email = normEmail(input.email);
  if (!validEmail(email)) return { error: 'A valid email is required' };
  const now = D.nowIso();
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).slice(0, 40)).filter(Boolean).slice(0, 20) : [];
  const needsConfirm = confirm && doubleOptIn();
  let s = find(email);
  if (s) {
    const was = s.status;
    if (was === 'subscribed') { // already in: just enrich, never re-mail
      if (input.name && !s.name) s.name = String(input.name).slice(0, 120);
      if (tags.length) s.tags = [...new Set([...(s.tags || []), ...tags])].slice(0, 20);
      D.putRecord('subscribers', s, by);
      return { subscriber: s, created: false, resubscribed: false, pending: false };
    }
    if (!s.token) s.token = newToken();
    if (input.name && !s.name) s.name = String(input.name).slice(0, 120);
    if (input.source && !s.source) s.source = String(input.source).slice(0, 60);
    if (tags.length) s.tags = [...new Set([...(s.tags || []), ...tags])].slice(0, 20);
    s.status = needsConfirm ? 'pending' : 'subscribed';
    if (!needsConfirm) { s.confirmedAt = now; delete s.unsubAt; }
    D.putRecord('subscribers', s, by);
    if (needsConfirm) await sendConfirm(s);
    return { subscriber: s, created: false, resubscribed: !needsConfirm && was !== 'subscribed', pending: needsConfirm };
  }
  s = { id: D.nextId('subscribers'), email, name: String(input.name || '').slice(0, 120), source: String(input.source || 'website').slice(0, 60), tags, status: needsConfirm ? 'pending' : 'subscribed', token: newToken(), at: now };
  if (!needsConfirm) s.confirmedAt = now;
  D.putRecord('subscribers', s, by);
  if (needsConfirm) await sendConfirm(s);
  return { subscriber: s, created: true, pending: needsConfirm };
}

// Confirm a pending subscription from the emailed link. Idempotent; returns null for a bad token.
function confirm(token) {
  const s = byToken(token);
  if (!s) return null;
  if (s.status !== 'subscribed') { s.status = 'subscribed'; s.confirmedAt = D.nowIso(); delete s.unsubAt; D.putRecord('subscribers', s, 'system'); }
  return s;
}

// Mark a subscriber unsubscribed by their unsubscribe token (from an email link). Idempotent.
function unsubscribe(token) {
  const s = byToken(token);
  if (!s) return null;
  if (s.status !== 'unsubscribed') { s.status = 'unsubscribed'; s.unsubAt = D.nowIso(); D.putRecord('subscribers', s, 'system'); }
  return s;
}

// Suppress an address after a hard bounce or spam complaint (provider webhook). Complaints
// always win over bounces. Unknown addresses are ignored (they were not on the list).
function suppress(email, reason, detail = '') {
  const s = find(email);
  if (!s) return null;
  const status = reason === 'complaint' ? 'complained' : 'bounced';
  if (s.status === 'complained' || s.status === status) return s;
  s.status = status; s.suppressedAt = D.nowIso(); s.suppressReason = String(detail || reason).slice(0, 120);
  D.putRecord('subscribers', s, 'system');
  return s;
}

// Send a bulk email to subscribed recipients. Audience is one of: an explicit `emails` batch
// (per-person selection), a `tag`, or everyone subscribed. {{name}} is personalised and a
// per-recipient unsubscribe link is added. `prepared` = the html is a complete newsletter and
// is sent as-is (unsubscribe appended); otherwise it is wrapped in the branded app layout.
async function sendBulk({ subject, html, tag, emails, prepared }, by = 'system') {
  if (!mail.enabled()) return { error: 'Email is not configured on the server (set RESEND_API_KEY, POSTMARK_TOKEN, SMTP_* or MAIL_MODE=graph)' };
  if (!String(subject || '').trim() || !String(html || '').trim()) return { error: 'Subject and body are required' };
  let list = D.listCol('subscribers').filter((s) => s.status === 'subscribed');
  if (Array.isArray(emails) && emails.length) { const set = new Set(emails.map(normEmail)); list = list.filter((s) => set.has(s.email)); }
  else if (tag) list = list.filter((s) => (s.tags || []).includes(tag));
  let sent = 0, failed = 0;
  for (const s of list) {
    if (!s.token) { s.token = newToken(); D.putRecord('subscribers', s, by); }
    const unsub = `${mail.BASE}/api/v1/unsubscribe/${s.token}`;
    const personalised = String(html).replace(/\{\{\s*name\s*\}\}/g, mail.esc((s.name || '').split(' ')[0] || 'there'));
    let okSent;
    if (prepared) {
      const withFooter = personalised + `<p style="margin-top:22px;font-size:11px;color:#8E8B83;font-family:Helvetica,Arial,sans-serif">${brand} · You are receiving this because you subscribed at gbxps.com. <a href="${unsub}" style="color:#8E8B83">Unsubscribe</a>.</p>`;
      okSent = await mail.send({ to: s.email, subject, html: withFooter, raw: true, kind: 'campaign', unsubscribe: unsub });
    } else {
      const footer = `${brand} &middot; You are receiving this because you subscribed at gbxps.com. <a href="${unsub}" style="color:#8E8B83">Unsubscribe</a>.`;
      okSent = await mail.send({ to: s.email, subject, title: '', html: personalised, footer, kind: 'campaign', unsubscribe: unsub });
    }
    if (okSent) sent++; else failed++;
    await new Promise((r) => setTimeout(r, 250)); // ~4/sec, comfortably under provider limits
  }
  return { total: list.length, sent, failed };
}

module.exports = { add, confirm, unsubscribe, suppress, sendBulk, find, normEmail, doubleOptIn };
