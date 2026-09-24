'use strict';
// Microsoft Bookings -> CRM. Polls the booking calendar and turns each new
// appointment into activity + a task on the matching lead (by customer email),
// or a fresh lead when there is no match. Runs from the in-process scheduler
// (jobs.js) and can be triggered on demand from the API. Best effort: it never
// throws into the scheduler.
//
// Enable by setting BOOKINGS_BUSINESS (the booking business id, usually the
// booking mailbox address) with the MS_* Graph app configured and granted the
// application permission Bookings.Read.All in the tenant that owns the mailbox.
const graph = require('./graph');
const D = require('./db');

function enabled() { return graph.enabled() && !!process.env.BOOKINGS_BUSINESS; }

function findDeal(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  return D.listCol('deals').find((d) => String(d.email || '').trim().toLowerCase() === em) || null;
}

// Normalise a Graph bookingAppointment into the fields we use. Kept pure so it
// can be unit-tested without Graph.
function normalise(a) {
  const cust = (a.customers && a.customers[0]) || {};
  const email = a.customerEmailAddress || cust.emailAddress || '';
  const name = a.customerName || cust.name || '';
  const startIso = (a.startDateTime && a.startDateTime.dateTime) || '';
  const when = startIso ? startIso.replace('T', ' ').slice(0, 16) : 'a scheduled time';
  const service = a.serviceName || 'call';
  return { id: a.id, email, name, startIso, when, service };
}

async function sync() {
  if (!enabled()) return { skipped: 'not configured' };
  const business = process.env.BOOKINGS_BUSINESS;
  const appts = await graph.listAppointments(business);
  const seen = new Set(D.kvGet('bookings_seen', []));
  let added = 0;
  for (const raw of appts) {
    const a = normalise(raw);
    if (!a.id || seen.has(a.id)) continue;
    const at = D.nowIso();
    const deal = findDeal(a.email);
    if (deal) {
      D.putRecord('activity', {
        id: Date.now() * 1000 + (added % 1000),
        deal: deal.id, type: 'system', who: '',
        text: `Call booked: ${a.service}`,
        detail: `${a.when}${a.name ? ' · ' + a.name : ''}${a.email ? ' · ' + a.email : ''} (Microsoft Bookings)`,
        at,
      }, 'system');
      D.putRecord('tasks', {
        id: D.nextId('tasks'),
        title: `Booked ${a.service}`,
        desc: `Booked via Microsoft Bookings for ${a.when}. ${a.name} <${a.email}>`.trim(),
        deal: deal.id, due: (a.startIso || '').slice(0, 10),
        who: deal.owner ? [deal.owner] : [], by: '',
        notify: deal.owner ? [deal.owner] : [], notifyBy: false,
        channels: ['app'], repeat: null, files: [], done: false,
        created: at, auto: 'Microsoft Bookings',
      }, 'system');
    } else if (a.email || a.name) {
      // No matching lead: capture the booking as a new lead.
      const leads = require('./leads');
      await leads.createLead(
        { contact: a.name, email: a.email, service: a.service, notes: `Booked ${a.service} via Microsoft Bookings for ${a.when}.` },
        { source: 'bookings', via: 'bookings' }
      );
    } else {
      continue; // nothing to match or create on
    }
    seen.add(a.id);
    added++;
    try { D.log.hook.run(D.nowIso(), 'bookings', 'created', `${a.service} · ${a.name || a.email} · ${a.when}`, String(a.id)); } catch { /* log best effort */ }
  }
  // Keep the seen set bounded.
  D.kvSet('bookings_seen', [...seen].slice(-2000));
  return { added, total: appts.length };
}

module.exports = { enabled, sync, normalise, findDeal };
