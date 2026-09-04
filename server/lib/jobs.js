'use strict';
// In-process scheduler (no host cron needed): chat digests, daily task digest, market refresh,
// nightly SQLite backup (+ SharePoint copy), session pruning.
const fs = require('node:fs');
const path = require('node:path');
const D = require('./db');
const mail = require('./mail');
const graph = require('./graph');
const auth = require('./auth');
const market = require('./market');
const { notify, prefs } = require('./notify');

const ran = (name, key) => { const j = D.jobs.get.get(name); return j && j.last_run === key; };
const mark = (name, key, detail = '') => D.jobs.set.run(name, key, detail);
const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 36e5;
const first = (n) => (n || '').split(' ')[0];

async function chatDigest() {
  const h = prefs().chatHours || 24;
  const rooms = Object.fromEntries(D.listCol('rooms').map((r) => [r.id, r]));
  const msgs = D.listCol('messages');
  const perUser = {};
  for (const m of msgs) {
    const r = rooms[m.room]; if (!r || !m.at || hoursSince(m.at) < h) continue;
    for (const u of r.members || []) { if (u === m.who || (m.read || []).includes(u) || (m.emailed || []).includes(u)) continue; (perUser[u] = perUser[u] || []).push(m); }
  }
  for (const [uid, list] of Object.entries(perUser)) {
    const u = D.users.get(uid); if (!u || u.status !== 'Active') continue;
    const p = (prefs().events || []).find((e) => e.id === 'chat');
    if (p && p.email === false) continue;
    const html = list.slice(0, 12).map((m) => `<p style="margin:0 0 10px"><b>${mail.esc(first((D.users.get(m.who) || {}).name))}</b> in <i>${mail.esc(rooms[m.room].name || 'direct message')}</i> · ${mail.esc(m.at.replace('T', ' '))}<br>${mail.esc(m.text)}</p>`).join('');
    await mail.send({ to: u.email, subject: `${list.length} unread chat message${list.length === 1 ? '' : 's'} in Pipeline`, title: 'Unread for over ' + h + ' hours', html, cta: { label: 'Open chat', url: mail.BASE + '/#/chat' }, kind: 'chat' });
    for (const m of list) { m.emailed = [...new Set([...(m.emailed || []), uid])]; D.putRecord('messages', m, 'system'); }
  }
}
async function dailyDigest() {
  const today = D.today();
  const tasks = D.listCol('tasks').filter((t) => !t.done && t.due && t.due <= today);
  const per = {};
  for (const t of tasks) for (const u of t.who || []) (per[u] = per[u] || []).push(t);
  for (const [uid, list] of Object.entries(per)) {
    const overdue = list.filter((t) => t.due < today), due = list.filter((t) => t.due === today);
    if (overdue.length) await notify('overdue', [uid], { title: `${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}`, body: overdue.slice(0, 3).map((t) => t.title).join(' · '), url: '#/tasks', kind: 'task', id: 'overdue-' + today, emailHtml: overdue.map((t) => `<p><b>${mail.esc(t.title)}</b> · due ${t.due}</p>`).join('') });
    if (due.length) await notify('due', [uid], { title: `${due.length} task${due.length === 1 ? '' : 's'} due today`, body: due.slice(0, 3).map((t) => t.title).join(' · '), url: '#/tasks', kind: 'task', id: 'due-' + today });
  }
}
async function backup() {
  const dir = path.join(D.DATA_DIR, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `crm-${D.today()}.db`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  D.backup(file);
  for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 86400e3) fs.unlinkSync(p); }
  let sp = '';
  if (graph.enabled()) { try { await graph.upload('_CRM Backups', path.basename(file), fs.readFileSync(file)); sp = ' + SharePoint'; } catch (e) { sp = ' (SharePoint copy failed: ' + e.message + ')'; } }
  console.log('[backup]', file + sp);
  return file + sp;
}

async function tick() {
  const now = new Date(); const hhmm = D.nowIso().slice(11, 16); const day = D.today();
  const settings = D.kvGet('settings'); if (!settings) return;
  try { const k = day + 'T' + hhmm.slice(0, 4); if (now.getMinutes() % 15 === 0 && !ran('chat', k)) { mark('chat', k); await chatDigest(); } } catch (e) { console.error('[job chat]', e.message); }
  try { const at = prefs().digest || '07:30'; if (hhmm >= at && !ran('digest', day)) { mark('digest', day); await dailyDigest(); } } catch (e) { console.error('[job digest]', e.message); }
  try { if (hhmm >= '02:30' && !ran('backup', day)) { mark('backup', day); mark('backup', day, await backup()); } } catch (e) { console.error('[job backup]', e.message); }
  try { const mins = Math.max(5, Number((settings.research || {}).refreshMins) || 20); const last = D.jobs.get.get('market'); if (!last || Date.now() - new Date(last.last_run).getTime() > mins * 60e3) { mark('market', new Date().toISOString()); const n = await market.refreshSecurities(); mark('market', new Date().toISOString(), n + ' updated'); } } catch (e) { console.error('[job market]', e.message); }
  try { if (!ran('prune', day)) { mark('prune', day); auth.pruneSessions(); } } catch (e) { /* ignore */ }
}
function start() { setTimeout(() => { tick(); setInterval(tick, 60e3); }, 5000); }
module.exports = { start, tick, backup, chatDigest, dailyDigest };
