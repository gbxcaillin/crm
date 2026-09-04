'use strict';
// Central notification engine: in-app bell record + push + email, per workspace preference.
// pref ids match S.settings.notifyPrefs.events in the front end.
const { users, kvGet, putRecord, nowIso, today } = require('./db');
const push = require('./push');
const mail = require('./mail');

const BASE = mail.BASE;
function prefs() { const s = kvGet('settings') || {}; return s.notifyPrefs || { events: [], quietFrom: '19:00', quietTo: '07:30', chatHours: 24, digest: '07:30' }; }
function pref(id) { return (prefs().events || []).find((e) => e.id === id) || { app: true, email: false, push: true }; }
function inQuiet() {
  const p = prefs(); const t = nowIso().slice(11, 16);
  if (!p.quietFrom || !p.quietTo) return false;
  return p.quietFrom > p.quietTo ? t >= p.quietFrom || t < p.quietTo : t >= p.quietFrom && t < p.quietTo;
}
function first(n) { return (n || '').split(' ')[0]; }

/**
 * notify(evId, to[], { title, body, url, kind, id, actions, emailHtml, emailTitle, force })
 * - bell: a `notifs` record addressed to `to` (all users if `to` is empty and broadcast:true)
 * - push: each recipient's devices, unless quiet hours
 * - email: per event preference
 */
async function notify(evId, to, o) {
  const recips = [...new Set((to || []).filter(Boolean))].filter((id) => { const u = users.get(id); return u && u.status === 'Active'; });
  if (!recips.length) return { push: 0, email: 0 };
  const p = pref(evId);
  const url = o.url || '#/dashboard';
  if (p.app !== false && !o.noBell) {
    putRecord('notifs', { id: Date.now() + Math.floor(Math.random() * 1000), text: o.title, p: o.body || '', at: nowIso().slice(11, 16), read: false, go: url, to: recips, day: today() }, 'system');
  }
  let sent = 0, mailed = 0;
  if (p.push !== false && !inQuiet()) {
    for (const id of recips) sent += await push.sendToUser(id, { title: o.title, body: o.body, url: url, kind: o.kind || evId, id: o.id, tag: 'gbx-' + (o.kind || evId) + '-' + (o.id || Date.now()), actions: o.actions });
  }
  if (p.email === true || o.forceEmail) {
    for (const id of recips) {
      const u = users.get(id);
      if (await mail.send({ to: u.email, subject: o.title, title: o.emailTitle || o.title, html: o.emailHtml || `<p>${mail.esc(o.body || '')}</p>`, cta: { label: o.cta || 'Open in Pipeline', url: BASE + '/' + url }, kind: evId })) mailed++;
    }
  }
  return { push: sent, email: mailed };
}

/* ---------- sync hooks: look at what a client changed and notify the right people ---------- */
const name = (id) => { const u = users.get(id); return u ? u.name : 'Someone'; };
async function onRecordChange(actor, col, prev, next) {
  try {
    if (col === 'tasks' && next) {
      const added = (next.who || []).filter((u) => !(prev && (prev.who || []).includes(u)) && u !== actor);
      if (added.length) await notify('assigned', added, { title: `Task assigned: ${next.title}`, body: `${first(name(actor))} · due ${next.due || 'no deadline'}${next.deal ? ' · deal #' + next.deal : ''}`, url: '#/tasks', kind: 'task', id: next.id, actions: [{ action: 'open', title: 'Open task' }], emailHtml: `<p><b>${mail.esc(name(actor))}</b> assigned you a task.</p><p><b>${mail.esc(next.title)}</b><br>Due ${mail.esc(next.due || '—')}</p><p>${mail.esc(next.desc || '')}</p>` });
      if (next.done && !(prev && prev.done)) {
        const doneBy = next.doneBy || actor;
        if (next.notifyBy !== false && next.by && next.by !== doneBy) await notify('completed_by', [next.by], { title: `${first(name(doneBy))} completed “${next.title}”`, body: next.deal ? 'Deal #' + next.deal : 'Task done', url: '#/tasks', kind: 'task', id: next.id });
        const cc = (next.notify || []).filter((u) => u !== doneBy && u !== next.by);
        if (cc.length) await notify('completed_cc', cc, { title: `Done: ${next.title}`, body: `Completed by ${first(name(doneBy))}`, url: '#/tasks', kind: 'task', id: next.id });
      }
    }
    if (col === 'messages' && next && !prev) {
      const mentioned = users.all().filter((u) => u.id !== next.who && new RegExp('@' + first(u.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(next.text || '')).map((u) => u.id);
      if (mentioned.length) await notify('mention', mentioned, { title: `${first(name(next.who))} mentioned you`, body: String(next.text || '').slice(0, 120), url: '#/chat', kind: 'mention', id: next.id });
    }
    if (col === 'events' && next) {
      const added = (next.who || []).filter((u) => !(prev && (prev.who || []).includes(u)) && u !== actor);
      if (added.length) await notify('invite', added, { title: `Calendar: ${next.title}`, body: `${next.date || next.day || ''} ${next.start || ''}${next.end ? '–' + next.end : ''} · added by ${first(name(actor))}`, url: '#/calendar', kind: 'event', id: next.id });
    }
    if (col === 'deals' && next && next.owner && next.owner !== actor && (!prev || prev.owner !== next.owner)) {
      await notify('lead', [next.owner], { title: `Lead assigned: ${next.practice}`, body: `${first(name(actor))} made you the owner · ${next.contact || ''}`, url: '#/deal/' + next.id, kind: 'lead', id: next.id });
    }
  } catch (e) { console.error('[notify hook]', e.message); }
}
module.exports = { notify, onRecordChange, inQuiet, prefs };
