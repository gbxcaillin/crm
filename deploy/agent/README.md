# Claude lead scorer (subscription, no API key)

`score-leads.py` runs **headless Claude Code** (`claude -p`) on the VPS **host** to
score new leads in the CRM and write the score back as an AI activity - the
"external agent" the pipeline was built to be driven by. It uses your Claude
**subscription** login, so there is **no Anthropic API key** to manage, and it needs
**no Node** - only Python 3 (standard on Ubuntu) and the `claude` binary.

**Why host + Python:** the CRM runs in Docker, so Node lives *inside* that
container - but `claude` and its subscription login live on the **host**. This
script runs on the host and reaches the CRM over the network.

The rule-based score still runs when a lead is created; this adds Claude's read on
top and shows up as *"Claude scored lead N / 100"* on the lead timeline.

## Prerequisites

- Claude Code installed and **logged in** on the host (subscription):
  ```bash
  ~/.local/bin/claude          # then /login, choose the subscription option
  ~/.local/bin/claude -p "reply with exactly: OK"   # should print OK
  ```
- **Python 3** on the host: `command -v python3` (standard on Ubuntu; no pip installs).

## Setup

1. **CRM API key** - in the CRM: Integrations -> API keys -> new key named
   `lead-scorer`, scopes **`deals:read`** and **`ai:write`**. Copy it once.
2. **Config file** on the host (keeps the key out of cron and shell history):
   ```bash
   echo 'CRM_API_KEY=gbx_live_your_key_here' > /root/crm-agent.env
   echo 'MODEL=sonnet' >> /root/crm-agent.env
   chmod 600 /root/crm-agent.env
   ```
   `CRM_BASE` defaults to `https://crm.gbxps.com` (the host reaches the CRM through
   Caddy). **Do not** use `http://localhost:3000` - on this box that's a different
   app, not the CRM.
3. **Smoke test** (dry run - scores are logged, nothing written back):
   ```bash
   DRY_RUN=1 CRM_AGENT_ENV=/root/crm-agent.env python3 /root/crm/deploy/agent/score-leads.py
   ```
   With no new leads it prints `0 new lead(s)`; submit any tool on gbxps.com to
   create one, then re-run and you'll see a `-> NN (Priority) rationale` line per
   unscored new lead. Drop `DRY_RUN=1` to write the scores for real.

## Schedule it (cron)

Find python's absolute path first (`command -v python3`), then `crontab -e` as root
and add:

```cron
# Score new CRM leads every 15 minutes
*/15 * * * * HOME=/root CRM_AGENT_ENV=/root/crm-agent.env /usr/bin/python3 /root/crm/deploy/agent/score-leads.py >> /root/crm-data/agent.log 2>&1
```

- `HOME=/root` so `claude` finds your login credentials.
- Swap `/usr/bin/python3` for whatever `command -v python3` printed.
- Watch it: `tail -f /root/crm-data/agent.log`.

## Config reference

| Var | Default | Notes |
|---|---|---|
| `CRM_API_KEY` | *(required)* | CRM key with `deals:read` + `ai:write`. |
| `CRM_BASE` | `https://crm.gbxps.com` | Reaches the CRM via Caddy. Not `localhost:3000`. |
| `CLAUDE_BIN` | `/root/.local/bin/claude` | Path to the Claude Code binary. |
| `MODEL` | `sonnet` | `sonnet` (balanced), `opus` (best), `haiku` (cheapest). |
| `SINCE_DAYS` | `14` | Only score leads created within N days (bounds the first run). |
| `MAX_LEADS` | `25` | Safety cap per run. |
| `DRY_RUN` | *(off)* | `1` logs scores without writing them back. |

## Notes and limits

- **Usage:** each lead is one small `claude -p` call against your subscription
  quota. The 15-minute cadence + `MAX_LEADS` keep it modest. Raise the interval if
  you ever see plan-limit messages in the log.
- **Login persistence:** the subscription token can eventually lapse; if the log
  shows "Please run /login", re-run `~/.local/bin/claude` once to log in again.
  Switching to an `ANTHROPIC_API_KEY` later needs no code change - `claude` reads it
  from the environment.
- **Idempotent:** a lead already carrying a "Claude scored lead" activity is
  skipped, so re-runs are safe.
- **Scope stays minimal:** the scorer only reads leads and writes AI activities.
  It does not move stages or change owners.
