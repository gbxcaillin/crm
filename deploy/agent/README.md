# Claude lead scorer (subscription, no API key)

`score-leads.mjs` runs **headless Claude Code** (`claude -p`) on the VPS to score new
leads in the CRM and write the score back as an AI activity - the "external agent"
the pipeline was built to be driven by. It uses your Claude **subscription** login,
so there is **no Anthropic API key** to manage.

The rule-based score still runs when a lead is created; this adds Claude's read on
top and shows up as *"Claude scored lead N / 100"* on the lead timeline.

## Prerequisites

- Claude Code installed and **logged in** on the VPS (subscription):
  ```bash
  ~/.local/bin/claude          # then /login, choose the subscription option
  ~/.local/bin/claude -p "reply with exactly: OK"   # should print OK
  ```
- Node (already present - it runs the CRM).

## Setup

1. **CRM API key** - in the CRM: Integrations -> API keys -> new key named
   `lead-scorer`, scopes **`deals:read`** and **`ai:write`**. Copy it once.
2. **Config file** on the VPS (keeps the key out of cron and off the CLI):
   ```bash
   cat > /root/crm-agent.env <<'EOF'
   CRM_API_KEY=gbx_live_your_key_here
   MODEL=sonnet
   EOF
   chmod 600 /root/crm-agent.env
   ```
3. **Smoke test** (dry run - scores are logged, nothing written back):
   ```bash
   DRY_RUN=1 CRM_AGENT_ENV=/root/crm-agent.env node /root/crm/deploy/agent/score-leads.mjs
   ```
   You should see one `-> NN (Priority) rationale` line per unscored new lead.
   Drop `DRY_RUN=1` to write the scores for real.

## Schedule it (cron)

Find node's absolute path first (`command -v node`), then `crontab -e` as root and add:

```cron
# Score new CRM leads every 15 minutes
*/15 * * * * HOME=/root CRM_AGENT_ENV=/root/crm-agent.env /usr/bin/node /root/crm/deploy/agent/score-leads.mjs >> /root/crm-data/agent.log 2>&1
```

- `HOME=/root` so `claude` finds your login credentials.
- Swap `/usr/bin/node` for whatever `command -v node` printed.
- Watch it: `tail -f /root/crm-data/agent.log`.

## Config reference

| Var | Default | Notes |
|---|---|---|
| `CRM_API_KEY` | *(required)* | CRM key with `deals:read` + `ai:write`. |
| `CRM_BASE` | `http://localhost:3000` | The CRM on the same box. |
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
  Switching to an `ANTHROPIC_API_KEY` later needs no code change - `claude` picks
  it up from the environment.
- **Idempotent:** a lead already carrying a "Claude scored lead" activity is
  skipped, so re-runs are safe.
- **Scope stays minimal:** the scorer only reads leads and writes AI activities.
  It does not move stages or change owners.
