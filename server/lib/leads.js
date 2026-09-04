'use strict';
// Lead intake shared by the webhooks and the /leads API: normalise, de-duplicate, create the
// deal with its activity, change-log, first-call task and notifications.
const { listCol, putRecord, nextId, kvGet, users, nowIso, today, transaction, log } = require('./db');
const { notify } = require('./notify');

const FREEMAIL = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'bigpond.com', 'live.com'];
const domain = (e) => { const m = String(e || '').toLowerCase().split('@')[1] || ''; return FREEMAIL.includes(m) ? '' : m; };
const normName = (n) => String(n || '').toLowerCase().replace(/\b(pty|ltd|group|solutions|partners|co|the|advisory|advice|financial|planning|services|mortgage|broking|lending)\b/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function findDupes(o) {
  const em = String(o.email || '').toLowerCase(), dom = domain(em), nn = normName(o.practice);
  const out = [];
  for (const d of listCol('deals')) {
    const r = [];
    if (em && String(d.email || '').toLowerCase() === em) r.push('same email'); else if (dom && domain(d.email) === dom) r.push('same email domain');
    if (nn && nn.length > 3 && normName(d.practice) === nn) r.push('same practice name');
    if (r.length) out.push({ kind: 'deal', id: d.id, name: d.practice, reason: r.join(', ') });
  }
  for (const c of listCol('clients')) {
    const r = [];
    if (em && String(c.email || '').toLowerCase() === em) r.push('same email'); else if (dom && domain(c.email) === dom) r.push('same email domain');
    if (nn && nn.length > 3 && normName(c.name) === nn) r.push('same client name');
    if (r.length) out.push({ kind: 'client', id: c.id, name: c.name, reason: r.join(', ') });
  }
  return out;
}
function score(d) { let s = 40; if (d.priority === 'High') s += 25; if (d.priority === 'Medium') s += 10; if (d.advisers >= 10) s += 12; else if (d.advisers >= 5) s += 6; if (d.source === 'referral') s += 15; if (d.source === 'google') s += 5; return Math.min(98, s); }
const sourceLabel = (k) => { const s = (kvGet('sources') || {})[k]; return s ? s.label : k; };

function pickOwner(settings) {
  const cfg = (settings && settings.leadRouting) || {};
  const active = users.all().filter((u) => u.status === 'Active');
  if (cfg.owner && active.some((u) => u.id === cfg.owner)) return cfg.owner;
  if (cfg.mode === 'roundrobin' && active.length) { const deals = listCol('deals'); return active[deals.length % active.length].id; }
  return '';
}

/**
 * createLead(input, {source, campaign, via}) → { deal } or { duplicate }
 * input: { practice, contact, email, phone, city, segment, advisers, value, service, notes, owner, priority, ...customFields }
 */
async function createLead(input, { source = 'website', campaign = '', via = 'api', allowDuplicate = false } = {}) {
  const settings = kvGet('settings') || {};
  const practice = String(input.practice || input.company || input.practice_name || '').trim();
  const contact = String(input.contact || input.name || input.full_name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  if (!practice && !contact && !email) return { error: 'practice, contact or email required' };
  const dupes = allowDuplicate ? [] : findDupes({ email, practice });
  if (dupes.length) {
    putRecord('notifs', { id: Date.now(), text: 'Webhook: duplicate lead rejected (409)', p: `${practice || contact} matches ${dupes[0].name} · ${dupes[0].reason}`, at: nowIso().slice(11, 16), read: false, go: '#/integrations', day: today() }, 'system');
    log.hook.run(nowIso(), via, 'duplicate', `${practice || email} ↔ ${dupes[0].name} (${dupes[0].reason})`, String(dupes[0].id));
    return { duplicate: dupes[0] };
  }
  const owner = input.owner && users.get(input.owner) ? input.owner : pickOwner(settings);
  const fields = kvGet('fields') || [];
  const d = { id: nextId('deals'), practice: practice || contact, contact, email, phone: String(input.phone || ''), value: Number(input.value) || 0, service: input.service || '', segment: input.segment || '', advisers: input.advisers ? Number(input.advisers) : '', fum: input.fum || '', city: input.city || '', licensee: input.licensee || '', priority: input.priority || 'Medium', stage: 'new', source, owner, created: today(), close: '', notes: String(input.notes || '') };
  for (const f of fields) if (!(f.id in d) && input[f.id] != null) d[f.id] = input[f.id];
  const at = nowIso();
  const sc = score(d);
  transaction(() => {
    putRecord('deals', d, 'system');
    const camp = kvGet('campaigns') || {}; if (campaign) { camp[d.id] = campaign; require('./db').kvSet('campaigns', camp); }
    putRecord('activity', { id: Date.now(), deal: d.id, type: 'created', who: '', text: `Lead created via ${sourceLabel(source)}`, detail: campaign ? 'Campaign: ' + campaign : 'Via ' + via, at }, 'system');
    putRecord('changes', { id: Date.now() + 1, entity: 'deal', ref: d.id, at, who: '', field: 'Lead created', from: '', to: sourceLabel(source) + (campaign ? ' · ' + campaign : '') }, 'system');
    putRecord('activity', { id: Date.now() + 2, deal: d.id, type: 'ai', who: '', text: `Lead scored ${sc} / 100`, detail: 'Rule-based first pass; a Claude agent can update this via the API.', at }, 'system');
    const due = new Date(); due.setDate(due.getDate() + 1);
    putRecord('tasks', { id: nextId('tasks'), title: 'First call within 24 h of lead', desc: 'Auto-created by the lead rule. Call, qualify, book a Health Check if there is fit.', deal: d.id, due: require('./db').localIso(due).slice(0, 10), who: owner ? [owner] : [], by: '', notify: [], notifyBy: false, channels: ['app', 'email'], repeat: null, files: [], done: false, created: at, auto: sourceLabel(source) + ' lead rule' }, 'system');
  })();
  log.hook.run(nowIso(), via, 'created', `${d.practice} · ${sourceLabel(source)}${campaign ? ' · ' + campaign : ''}`, String(d.id));
  const body = `${sourceLabel(source)} · ${contact || email}${d.value ? ' · A$' + d.value.toLocaleString('en-AU') : ''} · score ${sc}`;
  const everyone = users.all().filter((u) => u.status === 'Active' && u.id !== owner).map((u) => u.id);
  if (owner) await notify('lead', [owner], { title: `New lead · ${d.practice}`, body, url: '#/deal/' + d.id, kind: 'lead', id: d.id, actions: [{ action: 'open', title: 'Open lead' }] });
  if (everyone.length) await notify('lead_any', everyone, { title: `New ${sourceLabel(source)} lead: ${d.practice}`, body: body + (owner ? ' · assigned to ' + (users.get(owner) || {}).name : ' · unassigned'), url: '#/deal/' + d.id, kind: 'lead', id: d.id, noBell: !!owner });
  return { deal: d, score: sc };
}

/* ---------- provider payload parsers ---------- */
// Google Ads lead form webhook: { lead_id, user_column_data:[{column_id,column_name,string_value}], campaign_id, form_id, google_key, is_test }
function fromGoogle(body) {
  const cols = {};
  for (const c of body.user_column_data || []) cols[(c.column_id || c.column_name || '').toUpperCase()] = c.string_value;
  const custom = Object.entries(cols).filter(([k]) => !['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE_NUMBER', 'COMPANY_NAME', 'CITY', 'POSTAL_CODE', 'JOB_TITLE'].includes(k)).map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')}: ${v}`).join('\n');
  return { practice: cols.COMPANY_NAME || '', contact: cols.FULL_NAME || [cols.FIRST_NAME, cols.LAST_NAME].filter(Boolean).join(' '), email: cols.EMAIL || '', phone: cols.PHONE_NUMBER || '', city: cols.CITY || '', notes: [`Google Ads lead form${body.is_test ? ' (TEST)' : ''} · lead ${body.lead_id || ''}`, body.gcl_id ? 'gclid ' + body.gcl_id : '', custom].filter(Boolean).join('\n'), campaign: body.campaign_name || (body.campaign_id ? 'Campaign ' + body.campaign_id : '') };
}
// Meta Lead Ads field_data: [{name, values:[..]}]
function fromMetaFields(fieldData, meta = {}) {
  const f = {};
  for (const x of fieldData || []) f[String(x.name || '').toLowerCase()] = (x.values || [])[0] || '';
  const std = ['full_name', 'first_name', 'last_name', 'email', 'phone_number', 'company_name', 'city', 'job_title', 'street_address', 'post_code', 'state'];
  const custom = Object.entries(f).filter(([k]) => !std.includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n');
  return { practice: f.company_name || '', contact: f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' '), email: f.email || '', phone: f.phone_number || '', city: f.city || '', notes: [`Meta lead form${meta.form_name ? ' "' + meta.form_name + '"' : ''} · ${meta.leadgen_id || ''}`, custom].filter(Boolean).join('\n'), campaign: meta.campaign_name || meta.ad_name || '' };
}
module.exports = { createLead, findDupes, fromGoogle, fromMetaFields, score };
