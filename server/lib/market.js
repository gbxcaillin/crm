'use strict';
// Market data via yahoo-finance2 (free, delayed). Results are cached in SQLite so a provider
// hiccup never blanks the research section.
const D = require('./db');
let yf = null;
async function yahoo() { if (!yf) { const { default: YahooFinance } = await import('yahoo-finance2'); yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] }); } return yf; }
const QUOTE_TTL = 15 * 60e3, HIST_TTL = 12 * 3600e3;
const fmtCap = (n, ccy) => { if (!n) return ''; const p = ccy === 'USD' ? 'US$' : 'A$'; return n >= 1e9 ? p + (n / 1e9).toFixed(1) + 'b' : n >= 1e6 ? p + (n / 1e6).toFixed(0) + 'm' : p + n; };

async function quote(sym) {
  const key = 'q:' + sym;
  const c = D.cache.get(key, QUOTE_TTL); if (c) return c;
  try {
    const q = await (await yahoo()).quote(sym);
    if (!q || q.regularMarketPrice == null) return D.cache.get(key) || null;
    const out = { t: sym, name: q.longName || q.shortName || sym, price: q.regularMarketPrice, chg: q.regularMarketChangePercent != null ? +q.regularMarketChangePercent.toFixed(2) : 0, ccy: q.currency || 'AUD', ex: q.fullExchangeName || q.exchange || '', mcap: fmtCap(q.marketCap, q.currency), pe: q.trailingPE ? +q.trailingPE.toFixed(1) : null, yld: q.dividendYield != null ? +(q.dividendYield > 1 ? q.dividendYield : q.dividendYield * 100).toFixed(2) : q.trailingAnnualDividendYield != null ? +(q.trailingAnnualDividendYield * 100).toFixed(2) : null, w52: [q.fiftyTwoWeekLow, q.fiftyTwoWeekHigh], kind: q.quoteType === 'ETF' ? 'ETF' : q.quoteType === 'MUTUALFUND' ? 'Fund' : q.quoteType === 'INDEX' ? 'Index' : 'Share', asOf: q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : new Date().toISOString(), src: 'Yahoo Finance' };
    D.cache.set(key, out); return out;
  } catch (e) { console.error('[market] quote', sym, e.message); return D.cache.get(key) || null; }
}
async function quotes(syms) { const out = []; for (const s of syms) { const q = await quote(s); if (q) out.push(q); } return out; }

// Daily closes for up to 5 years, plus derived return/vol/drawdown stats.
async function history(sym, years = 5) {
  const key = `h:${sym}:${years}`;
  const c = D.cache.get(key, HIST_TTL); if (c) return c;
  try {
    const p1 = new Date(); p1.setFullYear(p1.getFullYear() - years);
    const r = await (await yahoo()).chart(sym, { period1: p1, interval: '1d' });
    const pts = (r.quotes || []).filter((x) => x.close != null).map((x) => ({ d: new Date(x.date).toISOString().slice(0, 10), c: +x.close.toFixed(4), a: x.adjclose != null ? +x.adjclose.toFixed(4) : null }));
    const out = { t: sym, pts, stats: stats(pts), asOf: new Date().toISOString() };
    D.cache.set(key, out); return out;
  } catch (e) { console.error('[market] history', sym, e.message); return D.cache.get(key) || null; }
}
function stats(pts) {
  if (pts.length < 30) return null;
  const px = pts.map((p) => p.a ?? p.c); const last = px[px.length - 1];
  const back = (days) => { const i = Math.max(0, px.length - 1 - days); return (last / px[i] - 1) * 100; };
  const yrs = (px.length - 1) / 252;
  const cagr = (n) => { const i = Math.max(0, px.length - 1 - n * 252); const y = Math.min(n, yrs); return (Math.pow(last / px[i], 1 / y) - 1) * 100; };
  const rets = []; for (let i = 1; i < px.length; i++) rets.push(Math.log(px[i] / px[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length; const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100;
  let peak = px[0], mdd = 0; for (const v of px) { if (v > peak) peak = v; mdd = Math.min(mdd, (v / peak - 1) * 100); }
  return { m1: +back(21).toFixed(1), m3: +back(63).toFixed(1), y1: +back(252).toFixed(1), y3: +cagr(3).toFixed(1), y5: +cagr(5).toFixed(1), vol: +sd.toFixed(1), mdd: +mdd.toFixed(1), years: +yrs.toFixed(1) };
}
async function search(q) {
  try { const r = await (await yahoo()).search(q, { quotesCount: 8, newsCount: 0 }); return (r.quotes || []).filter((x) => x.symbol).map((x) => ({ t: x.symbol, name: x.longname || x.shortname || x.symbol, ex: x.exchDisp || x.exchange || '', kind: x.quoteType })); }
  catch (e) { return []; }
}
async function fx() { const q = await quote('AUD=X'); return q ? { pair: 'AUD=X', rate: q.price, asOf: q.asOf } : null; }

// Refresh stored securities so every client sees the same prices via sync.
async function refreshSecurities() {
  const secs = D.listCol('securities'); let n = 0;
  for (const s of secs) {
    const q = await quote(s.t); if (!q) continue;
    const h = await history(s.t, 5);
    const next = { ...s, price: q.price, chg: q.chg, w52: q.w52[0] != null ? q.w52 : s.w52, mcap: q.mcap || s.mcap, pe: q.pe ?? s.pe, yld: q.yld ?? s.yld, src: 'Yahoo Finance', asOf: q.asOf };
    if (h && h.stats) { next.ret = { m1: h.stats.m1, m3: h.stats.m3, y1: h.stats.y1, y3: h.stats.y3, y5: h.stats.y5 }; next.vol = h.stats.vol; next.mdd = h.stats.mdd; }
    if (JSON.stringify(next) !== JSON.stringify(s)) { D.putRecord('securities', next, 'market'); n++; }
  }
  const s = D.kvGet('settings'); if (s) { const f = await fx(); s.research = { ...(s.research || {}), lastRefresh: D.nowIso(), fx: f ? `AUD=X · ${f.rate.toFixed(4)} USD` : (s.research || {}).fx }; D.kvSet('settings', s); }
  return n;
}
module.exports = { quote, quotes, history, search, fx, refreshSecurities };
