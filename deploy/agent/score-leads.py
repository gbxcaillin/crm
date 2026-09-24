#!/usr/bin/env python3
"""GBX Pipeline - Claude lead scorer (host-side, stdlib only).

Runs headless Claude Code (`claude -p`, subscription auth, NO API key) to score
new CRM leads and write the score back as an AI activity - the external agent the
pipeline was built to be driven by. It needs no Node: the CRM runs in Docker
(Node lives in that container), but `claude` and its subscription login live on the
host, so this runs on the host with Python 3 (standard on Ubuntu) and reaches the
CRM over the network. Meant for cron.

The rule-based score still runs on lead creation; this adds Claude's read on top,
shown as "Claude scored lead N / 100" on the lead timeline.

Config - env vars, optionally from an env file (CRM_AGENT_ENV, default
/root/crm-agent.env; KEY=VALUE lines):
  CRM_API_KEY   required - a CRM API key with scopes: deals:read AND ai:write
  CRM_BASE      default https://crm.gbxps.com  (host reaches the CRM via Caddy;
                NOT http://localhost:3000, which is a different app on this box)
  CLAUDE_BIN    default /root/.local/bin/claude
  MODEL         default sonnet                 (sonnet | opus | haiku)
  SINCE_DAYS    default 14   - only score leads created within N days
  MAX_LEADS     default 25   - safety cap per run
  DRY_RUN       set to 1 to log scores without writing them back
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone


def load_env_file(path):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip("\"'")


load_env_file(os.environ.get("CRM_AGENT_ENV", "/root/crm-agent.env"))

BASE = os.environ.get("CRM_BASE", "https://crm.gbxps.com").rstrip("/")
KEY = os.environ.get("CRM_API_KEY")
CLAUDE = os.environ.get("CLAUDE_BIN", "/root/.local/bin/claude")
MODEL = os.environ.get("MODEL", "sonnet")
SINCE_DAYS = int(os.environ.get("SINCE_DAYS", "14"))
MAX_LEADS = int(os.environ.get("MAX_LEADS", "25"))
DRY = os.environ.get("DRY_RUN") == "1"
HOME = os.environ.get("HOME", "/root")


def log(*a):
    print(datetime.now(timezone.utc).isoformat(), "[scorer]", *a, flush=True)


if not KEY:
    sys.stderr.write("[scorer] CRM_API_KEY is not set (env or the env file)\n")
    sys.exit(1)


def api(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + "/api/v1" + path, data=data, method=method,
        headers={"authorization": "Bearer " + KEY, "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode()).get("error", "")
        except Exception:
            pass
        raise RuntimeError(f"{method} {path} -> {e.code} {detail}")


def score_with_claude(lead):
    prompt = "\n".join([
        "You are scoring an inbound business lead for GBX Professional Services, which offers professional services and workplace financial education/wellbeing to businesses of any kind.",
        "Rate how promising the lead is and how urgently to follow up (0 = weak, 100 = drop everything). Weigh fit, buying signals, source quality, and how complete the details are.",
        'Return ONLY compact JSON, no prose and no code fences: {"score":<integer 0-100>,"priority":"High"|"Medium"|"Low","rationale":"<one concise sentence>"}',
        "",
        "Lead:",
        f"company/practice: {lead.get('practice', '')}",
        f"contact: {lead.get('contact', '')}",
        f"email: {lead.get('email', '')}",
        f"source: {lead.get('source', '')}",
        f"segment: {lead.get('segment', '')}",
        f"team size: {lead.get('advisers', '')}",
        f"value: {lead.get('value', '')}",
        f"notes: {str(lead.get('notes', ''))[:800]}",
    ])
    out = subprocess.run(
        [CLAUDE, "-p", prompt, "--model", MODEL, "--output-format", "json"],
        capture_output=True, text=True, timeout=180, cwd=HOME,
    )
    if out.returncode != 0:
        raise RuntimeError("claude failed: " + (out.stderr or out.stdout).strip()[:200])
    # `--output-format json` wraps the reply as {..., "result": "<text>"}; fall back to raw.
    text = out.stdout
    try:
        env = json.loads(out.stdout)
        if isinstance(env, dict) and isinstance(env.get("result"), str):
            text = env["result"]
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise RuntimeError("no JSON in Claude output")
    j = json.loads(m.group(0))
    score = max(0, min(100, int(round(float(j["score"])))))
    priority = j.get("priority") if j.get("priority") in ("High", "Medium", "Low") else "Medium"
    rationale = re.sub(r"\s+", " ", str(j.get("rationale", ""))).strip()[:180]
    return score, priority, rationale


def already_scored(lead_id):
    data = api("/leads/" + str(lead_id))
    for a in data.get("activity", []):
        if a.get("type") == "ai" and re.search(r"Claude scored lead", a.get("text", ""), re.I):
            return True
    return False


def main():
    since = (datetime.now(timezone.utc) - timedelta(days=SINCE_DAYS)).strftime("%Y-%m-%d")
    leads = api(f"/leads?stage=new&since={since}&limit=100").get("leads", [])
    log(f"{len(leads)} new lead(s) since {since}; model={MODEL}" + (" (dry run)" if DRY else ""))

    scored = skipped = failed = 0
    for lead in leads:
        if scored >= MAX_LEADS:
            log(f"reached MAX_LEADS={MAX_LEADS}, stopping")
            break
        lid = lead.get("id")
        try:
            if already_scored(lid):
                skipped += 1
                continue
            score, priority, rationale = score_with_claude(lead)
            who = lead.get("practice") or lead.get("contact") or lead.get("email") or ""
            log(f"#{lid} {who} -> {score} ({priority}) {rationale}")
            if not DRY:
                api("/leads/" + str(lid) + "/activity", "POST", {
                    "text": rationale or f"Scored {score}/100",
                    "detail": f"Suggested priority: {priority}. Scored by Claude ({MODEL}).",
                    "score": score,
                })
            scored += 1
        except Exception as e:
            failed += 1
            log(f"#{lid} FAILED: {e}")
    log(f"done: {scored} scored, {skipped} already scored, {failed} failed")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"[scorer] {e}\n")
        sys.exit(1)
