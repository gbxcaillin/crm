'use strict';
// Outbound email: SMTP (nodemailer) or Microsoft Graph sendMail. Unconfigured → logged only.
const { log, nowIso } = require('./db');
const graph = require('./graph');

const cfg = {
  mode: process.env.MAIL_MODE || (process.env.SMTP_HOST ? 'smtp' : graph.enabled() && process.env.MAIL_FROM ? 'graph' : 'off'),
  from: process.env.MAIL_FROM || 'GBX Pipeline <no-reply@gbxps.com>',
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
  secure: process.env.SMTP_SECURE === '1',
};
let transport = null;
function enabled() { return cfg.mode === 'smtp' || cfg.mode === 'graph'; }
async function smtp() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined, tls: { minVersion: 'TLSv1.2' } });
  return transport;
}

const BASE = process.env.APP_URL || 'https://crm.gbxps.com';
function layout(title, bodyHtml, cta) {
  return `<!doctype html><html><body style="margin:0;background:#F6F3EC;font-family:Montserrat,Segoe UI,Helvetica,Arial,sans-serif;color:#1A1A1A">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F3EC;padding:28px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFDF8;border:1px solid #E4DFD3">
<tr><td style="padding:22px 28px;border-bottom:1px solid #E4DFD3"><span style="display:inline-block;border:1.5px solid #1A1A1A;padding:3px 7px;font-weight:700;letter-spacing:.08em;font-size:12px">GBX</span> <span style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#5A5852;margin-left:8px">Pipeline</span></td></tr>
<tr><td style="padding:26px 28px 8px"><h1 style="margin:0 0 12px;font-weight:400;font-size:22px;font-family:'Cormorant Garamond',Georgia,serif">${title}</h1><div style="font-size:14px;line-height:1.55">${bodyHtml}</div></td></tr>
${cta ? `<tr><td style="padding:8px 28px 26px"><a href="${cta.url}" style="display:inline-block;background:#1A5C4A;color:#FFFDF8;text-decoration:none;padding:11px 18px;font-size:13px;letter-spacing:.04em">${cta.label}</a><div style="font-size:11px;color:#8E8B83;margin-top:10px">${cta.url}</div></td></tr>` : '<tr><td style="padding:8px"></td></tr>'}
<tr><td style="padding:14px 28px;border-top:1px solid #E4DFD3;font-size:11px;color:#8E8B83">GBX Professional Services · sent by the Pipeline app. Notification preferences: ${BASE}/#/settings/notifications</td></tr>
</table></td></tr></table></body></html>`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function send({ to, subject, title, html, text, cta, kind = 'notify' }) {
  const body = layout(title || subject, html || `<p>${esc(text)}</p>`, cta);
  if (!enabled()) { log.mail.run(nowIso(), to, subject, kind, 'skipped', 'mail not configured'); console.log(`[mail:off] to=${to} "${subject}"`); return false; }
  try {
    if (cfg.mode === 'graph') await graph.sendMail(process.env.MAIL_FROM, to, subject, body);
    else await (await smtp()).sendMail({ from: cfg.from, to, subject, html: body, text: text || subject });
    log.mail.run(nowIso(), to, subject, kind, 'sent', '');
    return true;
  } catch (e) {
    log.mail.run(nowIso(), to, subject, kind, 'failed', String(e.message || e).slice(0, 300));
    console.error('[mail] failed', to, subject, e.message);
    return false;
  }
}
module.exports = { send, enabled, esc, BASE, mode: () => cfg.mode };
