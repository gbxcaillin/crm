'use strict';
// Web Push via VAPID. Keys come from env or are generated once into DATA_DIR/vapid.json.
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const { db, DATA_DIR, log, nowIso } = require('./db');

let keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
const KEYFILE = path.join(DATA_DIR, 'vapid.json');
if (!keys.publicKey || !keys.privateKey) {
  if (fs.existsSync(KEYFILE)) keys = JSON.parse(fs.readFileSync(KEYFILE, 'utf8'));
  else { keys = webpush.generateVAPIDKeys(); fs.writeFileSync(KEYFILE, JSON.stringify(keys), { mode: 0o600 }); console.log('[push] generated VAPID keys →', KEYFILE); }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:cc@gbxps.com', keys.publicKey, keys.privateKey);

const sIns = db.prepare('INSERT INTO push_subs(endpoint,user_id,device,sub,created_at,failures) VALUES(?,?,?,?,?,0) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, device=excluded.device, sub=excluded.sub, failures=0');
const sDel = db.prepare('DELETE FROM push_subs WHERE endpoint=?');
const sUser = db.prepare('SELECT * FROM push_subs WHERE user_id=?');
const sAll = db.prepare('SELECT endpoint,user_id,device,created_at FROM push_subs ORDER BY created_at DESC');
const sFail = db.prepare('UPDATE push_subs SET failures=failures+1 WHERE endpoint=?');

function subscribe(userId, device, sub) { if (!sub || !sub.endpoint) throw new Error('bad subscription'); sIns.run(sub.endpoint, userId, (device || '').slice(0, 80), JSON.stringify(sub), nowIso()); }
function unsubscribe(endpoint) { sDel.run(endpoint); }
function devices() { return sAll.all().map((s) => ({ name: s.device || 'Device', user: s.user_id, at: s.created_at, mode: 'push', endpoint: s.endpoint.slice(-24) })); }
function hasDevice(userId) { return sUser.all(userId).length > 0; }

// payload: { title, body, url, tag, kind, id, actions }
async function sendToUser(userId, payload) {
  const subs = sUser.all(userId);
  let ok = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify(payload), { TTL: 3600, urgency: 'high' }); ok++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) sDel.run(s.endpoint); else sFail.run(s.endpoint);
      log.push.run(nowIso(), userId, payload.title, 'failed:' + (e.statusCode || e.message));
    }
  }
  if (ok) log.push.run(nowIso(), userId, payload.title, 'sent');
  return ok;
}
function stats7d() { const since = nowIso().slice(0, 10); const d = new Date(); d.setDate(d.getDate() - 7); const rows = log.pushStats.all(d.toISOString().slice(0, 10)); void since; return { sent: rows.filter((r) => r.status === 'sent').reduce((a, r) => a + r.n, 0), failed: rows.filter((r) => r.status !== 'sent').reduce((a, r) => a + r.n, 0) }; }
module.exports = { publicKey: keys.publicKey, subscribe, unsubscribe, devices, hasDevice, sendToUser, stats7d };
