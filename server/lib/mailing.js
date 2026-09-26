'use strict';
// Mailing list + bulk email. Subscribers are a synced collection; website signups arrive via
// POST /hooks/subscribe and land here immediately. Bulk sends go through mail.js, one message
// per recipient with a per-recipient unsubscribe link (Spam Act 2003 requires a working
// unsubscribe), rate-limited to stay under mailbox send limits.
const crypto = require('node:crypto');
const D = require('./db');
const mail = require('./mail');

const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const newToken = () => crypto.randomBytes(16).toString('hex');
const find = (email) => D.listCol('subscribers').find((s) => s.email === normEmail(email));
const byToken = (t) => (t ? D.listCol('subscribers').find((s) => s.token === t) : null);

// Add a subscriber, or re-subscribe/enrich an existing one. Idempotent on email.
function add(input, by = 'system') {
  const email = normEmail(input.email);
  if (!validEmail(email)) return { error: 'A valid email is required' };
  const now = D.nowIso();
  const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t).slice(0, 40)).filter(Boolean).slice(0, 20) : [];
  let s = find(email);
  if (s) {
    const wasUnsub = s.status === 'unsubscribed';
    s.status = 'subscribed';
    if (input.name && !s.name) s.name = String(input.name).slice(0, 120);
    if (input.source && !s.source) s.source = String(input.source).slice(0, 60);
    if (tags.length) s.tags = [...new Set([...(s.tags || []), ...tags])].slice(0, 20);
    if (!s.token) s.token = newToken();
    D.putRecord('subscribers', s, by);
    return { subscriber: s, created: false, resubscribed: wasUnsub };
  }
  s = { id: D.nextId('subscribers'), email, name: String(input.name || '').slice(0, 120), source: String(input.source || 'website').slice(0, 60), tags, status: 'subscribed', token: newToken(), at: now };
  D.putRecord('subscribers', s, by);
  return { subscriber: s, created: true };
}

// Mark a subscriber unsubscribed by their unsubscribe token (from an email link). Idempotent.
function unsubscribe(token) {
  const s = byToken(token);
  if (!s) return null;
  if (s.status !== 'unsubscribed') { s.status = 'unsubscribed'; s.unsubAt = D.nowIso(); D.putRecord('subscribers', s, 'system'); }
  return s;
}

// Send a bulk email to subscribed recipients. Audience is one of: an explicit `emails` batch
// (per-person selection), a `tag`, or everyone subscribed. {{name}} is personalised and a
// per-recipient unsubscribe link is added. `prepared` = the html is a complete newsletter and
// is sent as-is (unsubscribe appended); otherwise it is wrapped in the branded app layout.
async function sendBulk({ subject, html, tag, emails, prepared }, by = 'system') {
  if (!mail.enabled()) return { error: 'Email is not configured on the server (set SMTP_* or MAIL_MODE=graph)' };
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
      const withFooter = personalised + `<p style="margin-top:22px;font-size:11px;color:#8E8B83;font-family:Helvetica,Arial,sans-serif">You are receiving this because you subscribed at gbxps.com. <a href="${unsub}" style="color:#8E8B83">Unsubscribe</a>.</p>`;
      okSent = await mail.send({ to: s.email, subject, html: withFooter, raw: true, kind: 'campaign' });
    } else {
      const footer = `GBX Professional Services &middot; You are receiving this because you subscribed at gbxps.com. <a href="${unsub}" style="color:#8E8B83">Unsubscribe</a>.`;
      okSent = await mail.send({ to: s.email, subject, title: '', html: personalised, footer, kind: 'campaign' });
    }
    if (okSent) sent++; else failed++;
    await new Promise((r) => setTimeout(r, 250)); // ~4/sec, comfortably under M365 limits
  }
  return { total: list.length, sent, failed };
}

module.exports = { add, unsubscribe, sendBulk, find, normEmail };
