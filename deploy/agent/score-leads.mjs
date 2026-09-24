#!/usr/bin/env node
// GBX Pipeline - Claude lead scorer.
//
// Runs headless Claude Code (`claude -p`, subscription auth, NO API key) to score
// new leads in the CRM and write the score back as an AI activity. Designed to run
// on the VPS from cron. The rule-based score still runs on lead creation; this adds
// Claude's read on top, exactly as the pipeline was designed to be driven.
//
// Config - environment variables, optionally loaded from an env file
// (CRM_AGENT_ENV, default /root/crm-agent.env; KEY=VALUE lines):
//   CRM_API_KEY   required - a CRM API key with scopes: deals:read AND ai:write
//   CRM_BASE      default http://localhost:3000   (same box, no TLS hop)
//   CLAUDE_BIN    default /root/.local/bin/claude
//   MODEL         default sonnet                  (sonnet | opus | haiku)
//   SINCE_DAYS    default 14   - only score leads created within N days
//   MAX_LEADS     default 25   - safety cap per run
//   DRY_RUN       set to 1 to log scores without writing them back
//
// Exit codes: 0 ok, 1 config/fatal error. Per-lead failures are logged, not fatal.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const envFile = process.env.CRM_AGENT_ENV || '/root/crm-agent.env';
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const BASE = (process.env.CRM_BASE || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.CRM_API_KEY;
const CLAUDE = process.env.CLAUDE_BIN || '/root/.local/bin/claude';
const MODEL = process.env.MODEL || 'sonnet';
const SINCE_DAYS = Number(process.env.SINCE_DAYS || 14);
const MAX_LEADS = Number(process.env.MAX_LEADS || 25);
const DRY = process.env.DRY_RUN === '1';
const CWD = process.env.HOME || '/root';

const log = (...a) => console.log(new Date().toISOString(), '[scorer]', ...a);
if (!KEY) { console.error('[scorer] CRM_API_KEY is not set (env or ' + envFile + ')'); process.exit(1); }

const H = { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' };
async function api(path, opts = {}) {
  const r = await fetch(BASE + '/api/v1' + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${r.status} ${j.error || ''}`);
  return j;
}

// Ask headless Claude to score one lead. Returns {score, priority, rationale}.
function scoreWithClaude(lead) {
  const prompt = [
    'You are scoring an inbound business lead for GBX Professional Services, which offers professional services and workplace financial education/wellbeing to businesses of any kind.',
    'Rate how promising the lead is and how urgently to follow up (0 = weak, 100 = drop everything). Weigh fit, buying signals, source quality, and how complete the details are.',
    'Return ONLY compact JSON, no prose and no code fences: {"score":<integer 0-100>,"priority":"High"|"Medium"|"Low","rationale":"<one concise sentence>"}',
    '',
    'Lead:',
    `company/practice: ${lead.practice || ''}`,
    `contact: ${lead.contact || ''}`,
    `email: ${lead.email || ''}`,
    `source: ${lead.source || ''}`,
    `segment: ${lead.segment || ''}`,
    `team size: ${lead.advisers || ''}`,
    `value: ${lead.value || ''}`,
    `notes: ${(lead.notes || '').slice(0, 800)}`,
  ].join('\n');

  const out = execFileSync(CLAUDE, ['-p', prompt, '--model', MODEL, '--output-format', 'json'],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, cwd: CWD });

  // `--output-format json` wraps the reply as {..., result: "<text>"}; fall back to raw.
  let text = out;
  try { const env = JSON.parse(out); if (env && typeof env.result === 'string') text = env.result; } catch { /* raw */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in Claude output');
  const j = JSON.parse(m[0]);
  const score = Math.round(Number(j.score));
  if (!Number.isFinite(score)) throw new Error('bad score: ' + j.score);
  return {
    score: Math.max(0, Math.min(100, score)),
    priority: ['High', 'Medium', 'Low'].includes(j.priority) ? j.priority : 'Medium',
    rationale: String(j.rationale || '').replace(/\s+/g, ' ').slice(0, 180),
  };
}

async function alreadyScored(id) {
  const { activity = [] } = await api('/leads/' + id);
  return activity.some((a) => a.type === 'ai' && /Claude scored lead/i.test(a.text || ''));
}

async function main() {
  const since = new Date(Date.now() - SINCE_DAYS * 86400e3).toISOString().slice(0, 10);
  const { leads = [] } = await api(`/leads?stage=new&since=${since}&limit=100`);
  log(`${leads.length} new lead(s) since ${since}; model=${MODEL}${DRY ? ' (dry run)' : ''}`);

  let scored = 0, skipped = 0, failed = 0;
  for (const lead of leads) {
    if (scored >= MAX_LEADS) { log(`reached MAX_LEADS=${MAX_LEADS}, stopping`); break; }
    try {
      if (await alreadyScored(lead.id)) { skipped++; continue; }
      const { score, priority, rationale } = scoreWithClaude(lead);
      log(`#${lead.id} ${lead.practice || lead.contact || lead.email || ''} -> ${score} (${priority}) ${rationale}`);
      if (!DRY) {
        await api('/leads/' + lead.id + '/activity', {
          method: 'POST',
          body: JSON.stringify({
            text: rationale || `Scored ${score}/100`,
            detail: `Suggested priority: ${priority}. Scored by Claude (${MODEL}).`,
            score,
          }),
        });
      }
      scored++;
    } catch (e) { failed++; log(`#${lead.id} FAILED: ${e.message}`); }
  }
  log(`done: ${scored} scored, ${skipped} already scored, ${failed} failed`);
}

main().catch((e) => { console.error('[scorer]', e.message); process.exit(1); });
