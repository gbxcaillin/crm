'use strict';
// Claude lead scoring, shared by the on-click button (/leads/:id/ai) and the scheduler, which
// scores every new lead automatically a few minutes after it arrives (Settings → Claude
// triggers → Score). Writes the score onto the deal and a timeline entry.
const D = require('./db');
const claude = require('./claude');

function facts(d) {
  const stages = D.kvGet('stages') || []; const stageName = (s) => (stages.find((x) => x.id === s) || {}).name || s;
  return [
    `Company/practice: ${d.practice || ''}`, `Contact: ${d.contact || ''}`, `Email: ${d.email || ''}`,
    `Source: ${d.source || ''}`, `Segment: ${d.segment || ''}`, `Team size: ${d.advisers || ''}`,
    `Value: ${d.value || ''}`, `Stage: ${stageName(d.stage)}`,
    d.notes ? `Notes: ${String(d.notes).slice(0, 700)}` : '',
  ].filter(Boolean).join('\n');
}
async function scoreLead(d, who = '') {
  const prompt = [
    'You are scoring an inbound business lead for GBX Professional Services, which offers professional services and workplace financial education/wellbeing to businesses of any kind.',
    'Rate how promising the lead is and how urgently to follow up (0 = weak, 100 = drop everything). Weigh fit, buying signals, source quality and how complete the details are.',
    'Return ONLY compact JSON, no prose and no code fences: {"score":<integer 0-100>,"priority":"High"|"Medium"|"Low","rationale":"<one concise sentence>"}',
    '', 'Lead:', facts(d),
  ].join('\n');
  const text = await claude.run(prompt);
  const m = text.match(/\{[\s\S]*\}/); if (!m) throw new Error('Claude returned no score');
  const j = JSON.parse(m[0]);
  const score = Math.max(0, Math.min(100, Math.round(Number(j.score))));
  const priority = ['High', 'Medium', 'Low'].includes(j.priority) ? j.priority : 'Medium';
  const rationale = String(j.rationale || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  D.putRecord('activity', { id: Date.now() + Math.floor(Math.random() * 1e5), deal: d.id, type: 'ai', who, text: `Claude scored lead ${score} / 100`, detail: `${priority}. ${rationale}${who ? '' : ' (automatic)'}`, at: D.nowIso() }, who || 'system');
  D.putRecord('deals', { ...D.getRecord('deals', d.id), aiScore: score, aiPriority: priority, aiRationale: rationale, aiScoredAt: D.nowIso() }, who || 'system');
  return { score, priority, rationale };
}
// Scheduler: score unscored New Leads from the last 30 days, a few per run. Off when the helper
// is not configured or the Score trigger is switched off in Settings.
async function autoScore(limit = 3) {
  if (!claude.enabled()) return 0;
  const s = D.kvGet('settings') || {}; if (s.claudeTriggers && s.claudeTriggers.score === false) return 0;
  const since = new Date(); since.setDate(since.getDate() - 30); const cutoff = D.localIso(since).slice(0, 10);
  const todo = D.listCol('deals').filter((d) => d.stage === 'new' && !d.aiScoredAt && (d.created || '') >= cutoff).slice(0, limit);
  let n = 0;
  for (const d of todo) { try { await scoreLead(d, ''); n++; } catch (e) { console.error('[score] failed for', d.id, e.message); D.putRecord('deals', { ...d, aiScoredAt: D.nowIso(), aiScoreError: String(e.message).slice(0, 120) }, 'system'); } }
  return n;
}
module.exports = { scoreLead, autoScore, facts };
