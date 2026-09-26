'use strict';
// Nurture sequences: timed follow-up emails to leads, run from the CRM so a sequence stops the
// moment the lead replies, the deal moves stage, or they opt out. Two synced collections:
//   sequences  { id, name, active, trigger:{auto,source,service}, from:'campaign'|'mailbox',
//                stopOn:{reply,stage}, hours:{start,end}, steps:[{day,subject,body}] }
//   enrolments { id, seq, deal, at, startedAt, next, step, status, reason, token, sent }
// Steps are offsets in days from enrolment. Sends happen only in Melbourne business hours.
const crypto = require('node:crypto');
const D = require('./db');
const mail = require('./mail');
const mailbox = require('./mailbox');

const TZ = 'Australia/Melbourne';
const BRAND = 'GBX Professional Services';
const rid = () => Date.now() + Math.floor(Math.random() * 1e5);
const seqs = () => D.listCol('sequences');
const enrols = () => D.listCol('enrolments');

function melbNow() {
  const p = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(new Date());
  return { hour: Number((p.find((x) => x.type === 'hour') || {}).value) % 24, weekend: /Sat|Sun/.test((p.find((x) => x.type === 'weekday') || {}).value || '') };
}
function inHours(seq) {
  const { hour, weekend } = melbNow(); const h = seq.hours || {};
  return !weekend && hour >= (h.start ?? 8) && hour < (h.end ?? 18);
}
const dueAt = (startedAt, day) => { const t = new Date(startedAt); t.setDate(t.getDate() + (Number(day) || 0)); return t.toISOString(); };

// Does an auto-enrol sequence apply to this (new) lead?
function matches(seq, d) {
  const t = seq.trigger || {};
  if (!seq.active || !t.auto) return false;
  if (t.source && t.source !== d.source) return false;
  if (t.service && !String(d.service || '').toLowerCase().includes(String(t.service).toLowerCase())) return false;
  return true;
}

function enrol(seq, d, by = 'system') {
  if (!d.email) return { error: 'This lead has no email address' };
  if (d.noNurture) return { error: 'This lead has opted out of nurture emails' };
  if (enrols().some((e) => e.deal === d.id && e.status === 'active')) return { error: 'This lead is already in an active sequence' };
  const steps = seq.steps || []; if (!steps.length) return { error: 'The sequence has no steps' };
  const startedAt = new Date().toISOString();
  const e = { id: D.nextId('enrolments'), seq: seq.id, deal: d.id, at: D.nowIso(), startedAt, next: dueAt(startedAt, steps[0].day), step: 0, status: 'active', token: crypto.randomBytes(12).toString('hex'), sent: 0, by };
  D.putRecord('enrolments', e, by);
  D.putRecord('activity', { id: rid(), deal: d.id, type: 'note', who: by === 'system' ? '' : by, text: 'Enrolled in nurture sequence', detail: seq.name, at: D.nowIso() }, by);
  return { enrolment: e };
}
// Called when a lead is created: the first matching auto-enrol sequence wins.
function autoEnrol(d) {
  for (const s of seqs()) if (matches(s, d)) { const r = enrol(s, d); if (r.enrolment) return r.enrolment; }
  return null;
}
function stop(e, reason, by = 'system') {
  if (e.status !== 'active') return e;
  e.status = reason === 'completed' ? 'done' : 'stopped'; e.reason = reason; e.endedAt = D.nowIso();
  D.putRecord('enrolments', e, by);
  if (reason !== 'completed') { const s = seqs().find((x) => x.id === e.seq); D.putRecord('activity', { id: rid(), deal: e.deal, type: 'note', who: by === 'system' ? '' : by, text: 'Nurture sequence stopped', detail: `${s ? s.name + ' · ' : ''}${reason}`, at: D.nowIso() }, by); }
  return e;
}
// Public opt-out from the link in every nurture email: stops everything for that lead, for good.
function optOut(token) {
  const e = enrols().find((x) => x.token === token); if (!e) return null;
  const d = D.getRecord('deals', e.deal);
  if (d && !d.noNurture) { d.noNurture = true; D.putRecord('deals', d, 'system'); }
  for (const x of enrols().filter((x) => x.deal === e.deal && x.status === 'active')) stop(x, 'opted out');
  return e;
}
// Why an active enrolment should stop now, or '' to carry on.
function stopReason(e, seq, d) {
  if (!d) return 'lead deleted';
  if (d.noNurture) return 'opted out';
  if (!d.email) return 'no email address';
  const on = seq.stopOn || {};
  if (d.stage === 'lost') return 'marked lost';
  if (on.stage !== false && d.stage !== 'new') { const st = (D.kvGet('stages') || []).find((s) => s.id === d.stage); return 'moved to ' + (st ? st.name : d.stage); }
  if (on.reply !== false) {
    // Any human email activity on the deal after enrolment (a reply received, or someone here
    // wrote to them) means a person has the conversation; the sequence steps aside.
    const human = D.listCol('activity').some((a) => a.deal === d.id && a.type === 'email' && a.at > e.at && !/^Nurture/.test(a.text || ''));
    if (human) return 'lead replied / in conversation';
  }
  return '';
}
function personalise(t, d, sender) {
  return String(t || '')
    .replace(/\{\{\s*name\s*\}\}/g, (d.contact || '').split(' ')[0] || 'there')
    .replace(/\{\{\s*practice\s*\}\}/g, d.practice || 'your business')
    .replace(/\{\{\s*service\s*\}\}/g, d.service || 'your enquiry')
    .replace(/\{\{\s*sender\s*\}\}/g, sender);
}
async function sendStep(e, seq, d) {
  const steps = seq.steps || []; const step = steps[e.step];
  if (!step) return stop(e, 'completed');
  const owner = D.users.get(d.owner) || {}; const sender = owner.name || BRAND;
  const subject = personalise(step.subject, d, sender), body = personalise(step.body, d, sender);
  const unsub = `${mail.BASE}/api/v1/nurture/stop/${e.token}`;
  let sent = false, via = '';
  if (seq.from === 'mailbox' && d.owner) {
    const acct = (mailbox.listFor(d.owner)[0] || {}).email;
    if (acct) { try { await mailbox.send(d.owner, acct, { to: d.email, subject, body: `${body}\n\n--\nNot useful? Stop these emails: ${unsub}` }); sent = true; via = acct; } catch (err) { console.error('[nurture] mailbox send failed, falling back:', err.message); } }
  }
  if (!sent) {
    sent = await mail.send({ to: d.email, subject, title: '', html: `<div style="white-space:pre-wrap">${mail.esc(body)}</div>`, footer: `${BRAND} &middot; You are receiving this because you enquired at gbxps.com. <a href="${unsub}" style="color:#8E8B83">Stop these emails</a>.`, kind: 'campaign', unsubscribe: unsub });
    via = mail.campaignFrom();
  }
  D.putRecord('activity', { id: rid(), deal: d.id, type: 'email', who: '', text: sent ? `Nurture email sent (step ${e.step + 1} of ${steps.length})` : `Nurture email failed (step ${e.step + 1})`, detail: `${subject}${via ? ' · from ' + via : ''}`, at: D.nowIso() }, 'system');
  e.step++; e.lastAt = D.nowIso(); e.sent = (e.sent || 0) + (sent ? 1 : 0);
  if (e.step >= steps.length) { e.status = 'done'; e.reason = 'completed'; e.endedAt = D.nowIso(); }
  else e.next = dueAt(e.startedAt, steps[e.step].day);
  D.putRecord('enrolments', e, 'system');
  return e;
}
// Scheduler entry point: send everything that is due, inside business hours (force = ignore the
// window, for an admin pressing "Send due now"). Returns the number of sends made.
async function run(limit = 30, { force = false } = {}) {
  const now = new Date().toISOString(); let n = 0;
  for (const e of enrols().filter((x) => x.status === 'active' && x.next <= now)) {
    const seq = seqs().find((s) => s.id === e.seq);
    if (!seq) { stop(e, 'sequence deleted'); continue; }
    const d = D.getRecord('deals', e.deal);
    const why = stopReason(e, seq, d);
    if (why) { stop(e, why); continue; }
    if (!seq.active || (!force && !inHours(seq))) continue;
    await sendStep(e, seq, d); n++;
    if (n >= limit) break;
  }
  return n;
}
// A sensible default 4-touch sequence, used when Claude assist is off or as a starting point.
function templateSteps(service, source) {
  const s = service ? service : 'your enquiry';
  return [
    { day: 0, subject: `Thanks for getting in touch, {{name}}`, body: `Hi {{name}},\n\nThanks for reaching out to ${BRAND} about ${s}. I have your details and will come back to you personally within two business days.\n\nIf it is easier, just reply to this email with a couple of times that suit you for a 20-minute call and I will lock one in.\n\nKind regards,\n{{sender}}\n${BRAND}` },
    { day: 3, subject: `One thing most businesses miss with ${s}`, body: `Hi {{name}},\n\nA quick one while it is fresh. When we look at ${s} with a business like {{practice}}, the biggest gains usually come from the basics done consistently rather than anything clever: a clear number to watch each week, one owner for it, and a short monthly review.\n\nOur free tools at https://gbxps.com/tools give you a quick read on where you stand. Takes about five minutes.\n\nHappy to talk it through whenever suits.\n\n{{sender}}\n${BRAND}` },
    { day: 7, subject: `How a business like {{practice}} approached this`, body: `Hi {{name}},\n\nOne example that might be useful. A business of a similar size came to us with the same question about ${s}. We started with a short health check, picked the two changes with the best return, and reviewed them monthly. Within a quarter they had a clear picture and a plan they could actually run.\n\nIf you would like the same kind of starting point, a Health Check is a 45-minute conversation with no obligation. Reply and I will send times.\n\n{{sender}}\n${BRAND}` },
    { day: 14, subject: `Should I close the loop, {{name}}?`, body: `Hi {{name}},\n\nI do not want to keep filling your inbox. If ${s} is still on the list, reply with a good time and I will call. If the timing is wrong, no problem at all, just say so and I will leave it there.\n\nEither way, thanks for considering ${BRAND}.\n\n{{sender}}` },
  ].map((x) => ({ ...x, source }));
}

module.exports = { enrol, autoEnrol, stop, optOut, run, matches, templateSteps, inHours };
