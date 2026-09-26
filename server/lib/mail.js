'use strict';
// Outbound email. Providers: Resend or Postmark (HTTP API, recommended for anything bulk),
// SMTP (nodemailer) or Microsoft Graph sendMail. Unconfigured → logged only.
//
// Two identities keep reputations apart: MAIL_FROM for transactional/notify mail on the main
// domain, MAIL_CAMPAIGN_FROM for newsletters and nurture on a subdomain (e.g. news.gbxps.com),
// so a campaign with complaints can never drag client correspondence into junk.
const { log, nowIso } = require('./db');
const graph = require('./graph');

const env = process.env;
const cfg = {
  mode: env.MAIL_MODE || (env.RESEND_API_KEY ? 'resend' : env.POSTMARK_TOKEN ? 'postmark' : env.SMTP_HOST ? 'smtp' : graph.enabled() && env.MAIL_FROM ? 'graph' : 'off'),
  from: env.MAIL_FROM || 'GBX Professional Services <no-reply@gbxps.com>',
  campaignFrom: env.MAIL_CAMPAIGN_FROM || env.MAIL_FROM || 'GBX Professional Services <hello@gbxps.com>',
  host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), user: env.SMTP_USER, pass: env.SMTP_PASS, secure: env.SMTP_SECURE === '1',
  resendKey: env.RESEND_API_KEY, postmarkToken: env.POSTMARK_TOKEN,
  postmarkStream: env.POSTMARK_STREAM || 'outbound', postmarkBroadcast: env.POSTMARK_BROADCAST_STREAM || 'broadcast',
};
let transport = null;
function enabled() { return ['smtp', 'graph', 'resend', 'postmark'].includes(cfg.mode); }
async function smtp() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined, tls: { minVersion: 'TLSv1.2' } });
  return transport;
}
// Bare address out of "Name <addr>" (Graph wants the mailbox address only).
const addrOf = (s) => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim(); };

const BASE = env.APP_URL || 'https://crm.gbxps.com';
function layout(title, bodyHtml, cta, footer) {
  return `<!doctype html><html><body style="margin:0;background:#F6F3EC;font-family:Montserrat,Segoe UI,Helvetica,Arial,sans-serif;color:#1A1A1A">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F3EC;padding:28px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFDF8;border:1px solid #E4DFD3">
<tr><td style="padding:22px 28px;border-bottom:1px solid #E4DFD3"><span style="display:inline-block;border:1.5px solid #1A1A1A;padding:3px 7px;font-weight:700;letter-spacing:.08em;font-size:12px">GBX</span> <span style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#5A5852;margin-left:8px">Professional Services</span></td></tr>
<tr><td style="padding:26px 28px 8px"><h1 style="margin:0 0 12px;font-weight:400;font-size:22px;font-family:'Cormorant Garamond',Georgia,serif">${title}</h1><div style="font-size:14px;line-height:1.55">${bodyHtml}</div></td></tr>
${cta ? `<tr><td style="padding:8px 28px 26px"><a href="${cta.url}" style="display:inline-block;background:#1A5C4A;color:#FFFDF8;text-decoration:none;padding:11px 18px;font-size:13px;letter-spacing:.04em">${cta.label}</a><div style="font-size:11px;color:#8E8B83;margin-top:10px">${cta.url}</div></td></tr>` : '<tr><td style="padding:8px"></td></tr>'}
<tr><td style="padding:14px 28px;border-top:1px solid #E4DFD3;font-size:11px;color:#8E8B83">${footer || `GBX Professional Services · Notification preferences: ${BASE}/#/settings/notifications`}</td></tr>
</table></td></tr></table></body></html>`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A plain-text alternative from HTML, so every message has a text part (a spam-filter signal).
const toText = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();

async function viaResend(from, to, subject, html, text, headers, attachments) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + cfg.resendKey, 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, html, text, headers: headers || undefined, attachments: attachments && attachments.length ? attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) : undefined }) });
  if (!r.ok) throw new Error('resend ' + r.status + ': ' + (await r.text()).slice(0, 200));
}
async function viaPostmark(from, to, subject, html, text, headers, attachments, stream) {
  const r = await fetch('https://api.postmarkapp.com/email', { method: 'POST', headers: { 'x-postmark-server-token': cfg.postmarkToken, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ From: from, To: to, Subject: subject, HtmlBody: html, TextBody: text, MessageStream: stream, Headers: headers ? Object.entries(headers).map(([Name, Value]) => ({ Name, Value })) : undefined, Attachments: attachments && attachments.length ? attachments.map((a) => ({ Name: a.filename, Content: Buffer.from(a.content).toString('base64'), ContentType: a.contentType || 'application/octet-stream' })) : undefined }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.ErrorCode && j.ErrorCode !== 0)) throw new Error('postmark ' + r.status + ': ' + (j.Message || '').slice(0, 200));
}

// kind: 'notify' (transactional, MAIL_FROM) or 'campaign' (bulk, MAIL_CAMPAIGN_FROM + broadcast stream).
// raw: send the given HTML as-is (pre-prepared newsletters); otherwise wrap in the app layout.
// unsubscribe: a per-recipient URL; adds RFC 8058 one-click List-Unsubscribe headers (Gmail/Yahoo/Outlook
// require them for bulk mail) on providers that can carry custom headers.
async function send({ to, subject, title, html, text, cta, footer, attachments, raw, kind = 'notify', unsubscribe }) {
  const body = raw ? (html || '') : layout(title || subject, html || `<p>${esc(text)}</p>`, cta, footer);
  const plain = text || toText(body) || subject;
  const from = kind === 'campaign' ? cfg.campaignFrom : cfg.from;
  const headers = unsubscribe ? { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : null;
  if (!enabled()) { log.mail.run(nowIso(), to, subject, kind, 'skipped', 'mail not configured'); console.log(`[mail:off] to=${to} "${subject}"`); return false; }
  try {
    if (cfg.mode === 'resend') await viaResend(from, to, subject, body, plain, headers, attachments);
    else if (cfg.mode === 'postmark') await viaPostmark(from, to, subject, body, plain, headers, attachments, kind === 'campaign' ? cfg.postmarkBroadcast : cfg.postmarkStream);
    else if (cfg.mode === 'graph') await graph.sendMail(addrOf(from), to, subject, body, attachments); // Graph cannot set List-Unsubscribe (custom headers must be x-*)
    else await (await smtp()).sendMail({ from, to, subject, html: body, text: plain, headers: headers || undefined, attachments: attachments && attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) });
    log.mail.run(nowIso(), to, subject, kind, 'sent', '');
    return true;
  } catch (e) {
    log.mail.run(nowIso(), to, subject, kind, 'failed', String(e.message || e).slice(0, 300));
    console.error('[mail] failed', to, subject, e.message);
    return false;
  }
}
module.exports = { send, enabled, esc, BASE, mode: () => cfg.mode, campaignFrom: () => cfg.campaignFrom };
