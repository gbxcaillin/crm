'use strict';
// Cloudflare Web Analytics (RUM) -> the dashboard "Website -> pipeline" tile.
// Optional and read-only: switches on when CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
// and CLOUDFLARE_SITE_TAG are set. Results are cached (stale-OK on error) so the
// tile never blocks or blanks. Modelled on lib/market.js (cache) and lib/graph.js (fetch).
const D = require('./db');

const GQL = 'https://api.cloudflare.com/client/v4/graphql';
const TTL = 15 * 60e3;
const TOKEN = () => process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = () => process.env.CLOUDFLARE_ACCOUNT_ID;
const SITE = () => process.env.CLOUDFLARE_SITE_TAG;

function enabled() { return !!(TOKEN() && ACCOUNT() && SITE()); }

// The Web Analytics dataset lives under viewer.accounts, filtered by the site tag.
// `count` is page loads (page views); `sum { visits }` is visits (new sessions).
const QUERY = `query($account:string!,$site:string,$start:Time!,$end:Time!,$startDate:Date!,$endDate:Date!){
  viewer{ accounts(filter:{accountTag:$account}){
    totals: rumPageloadEventsAdaptiveGroups(filter:{siteTag:$site, datetime_geq:$start, datetime_leq:$end}, limit:1){ count sum{ visits } }
    byDay: rumPageloadEventsAdaptiveGroups(filter:{siteTag:$site, date_geq:$startDate, date_leq:$endDate}, limit:1000, orderBy:[date_ASC]){ count sum{ visits } dimensions{ date } }
  }}
}`;

async function gql(variables) {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN(), 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Cloudflare GraphQL: ' + r.status);
  if (j.errors && j.errors.length) throw new Error('Cloudflare GraphQL: ' + (j.errors[0].message || 'query error'));
  return j.data;
}

// Returns { enabled, days, visits, pageviews, series:[{date,visits,pageviews}], fetchedAt }.
// On any error, falls back to the last good cached value; never throws.
async function summary({ days = 7, force = false } = {}) {
  if (!enabled()) return { enabled: false };
  const key = 'cf:' + SITE() + ':' + days;
  if (!force) { const c = D.cache.get(key, TTL); if (c) return c; }
  try {
    const now = Date.now();
    const start = new Date(now - days * 86400e3);
    const iso = (d) => d.toISOString().slice(0, 19) + 'Z';
    const day = (d) => d.toISOString().slice(0, 10);
    const data = await gql({ account: ACCOUNT(), site: SITE(), start: iso(start), end: iso(new Date(now)), startDate: day(start), endDate: day(new Date(now)) });
    const acc = (((data || {}).viewer || {}).accounts || [])[0] || {};
    const tot = (acc.totals || [])[0] || {};
    const series = (acc.byDay || []).map((g) => ({ date: (g.dimensions || {}).date, pageviews: g.count || 0, visits: (g.sum && g.sum.visits) || 0 }));
    const out = {
      enabled: true, days,
      visits: (tot.sum && tot.sum.visits) || series.reduce((a, x) => a + x.visits, 0),
      pageviews: tot.count || series.reduce((a, x) => a + x.pageviews, 0),
      series, fetchedAt: new Date().toISOString(),
    };
    D.cache.set(key, out);
    return out;
  } catch (e) {
    console.error('[cloudflare]', e.message);
    return D.cache.get(key) || { enabled: true, error: e.message, series: [] };
  }
}

const refresh = () => summary({ force: true });

module.exports = { enabled, summary, refresh };
