# Deploying crm.gbxps.com

The CRM rides on the same Sydney VPS as `office.gbxps.com` and
`play.gbxps.com`: one Docker Compose stack, one front Caddy doing HTTPS.

**What this deploys:** the full app. A Node server (`server/`) keeps the
shared workspace in SQLite, handles login and invites, receives lead
webhooks, sends push notifications and email, talks to SharePoint through
Microsoft Graph, pulls market data from Yahoo Finance, and backs the
database up nightly. It also serves the installable PWA (`dist/`).

## First-time setup

```bash
ssh root@YOUR_SERVER_IP
cd /root/crm && git pull                       # already cloned during the preview
cp .env.production.example .env.production     # fill in later; APP_URL is enough to start
mkdir -p /root/crm-data
```

Replace the `crm:` service in `/root/familyoffice/docker-compose.yml` with the
one in `deploy/compose-service.yml` (it adds the env file and the data
volume), and replace the `crm.gbxps.com` block in
`/root/familyoffice/deploy/Caddyfile` with `deploy/caddy-site.txt`
(`reverse_proxy crm:3000`, no `basic_auth`). Then:

```bash
cd /root/familyoffice
docker compose config >/dev/null && echo compose OK
docker compose up -d --build crm
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
docker compose logs -f crm           # "[boot] GBX Pipeline on :3000 · db /app/data/crm.db · dist ok"
```

Open https://crm.gbxps.com. The database is empty, so the app shows
**Create the first admin**. Set your own account, then invite the team under
Settings → Team. Without email configured, each invite shows a one-time link
to send yourself.

Set `DEMO_DATA=1` in `.env.production` before the first visit if you want the
sample deals, tasks and chat loaded into the new workspace.

## Updating

```bash
/root/crm/deploy/update.sh claude/crm-wireframe-integrations-cmbsqa   # or main once merged
```

Rebuilds only the `crm` container; the data volume is untouched. Browsers
pick up the new shell on next load (`index.html` and `sw.js` are served
`no-cache`).

## Switching features on

Everything below is optional and turns on when its variables are set in
`/root/crm/.env.production` (then `docker compose up -d crm`).

| Feature | Variables | Notes |
|---|---|---|
| Email (invites, resets, task and lead alerts, 24 h chat digest, daily task digest) | `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | Microsoft 365: `smtp.office365.com:587` with a mailbox that has SMTP AUTH enabled. Or `MAIL_MODE=graph` with the Graph app below and `Mail.Send`. Test it from Integrations → Server → *Send me a test email*. |
| SharePoint files | `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `SP_SITE`, `SP_LIBRARY` | Azure app registration with application permission `Sites.Selected` (grant it on the Clients site) or `Sites.ReadWrite.All`. Files upload to `Client Files/<Practice>/`; nightly DB backups also copy to `Client Files/_CRM Backups/`. |
| Google Ads lead forms | `GOOGLE_ADS_KEY` | In Google Ads → lead form asset → *Lead delivery option* → Webhook: URL `https://crm.gbxps.com/api/v1/hooks/google-ads`, key = the same string. Use *Send test data* to check. |
| Meta Lead Ads | `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_PAGE_TOKEN` | Meta app → Webhooks → Page → `leadgen`, callback `https://crm.gbxps.com/api/v1/hooks/meta`. The page token needs `leads_retrieval` and `pages_manage_ads`. Zapier or a similar relay can instead POST straight to `/api/v1/hooks/lead` with an API key. |
| Push | none | VAPID keys are generated into `/root/crm-data/vapid.json` on first boot. Users turn push on per device under Settings → Notifications. |
| Market data | none | Yahoo Finance via `yahoo-finance2`; quotes cached 15 min, history 12 h, stored securities refreshed every `refreshMins`. |
| First admin from env | `ADMIN_NAME/EMAIL/PASSWORD` | Alternative to the setup form. Only read when the database is empty. |

## Claude agent / API

Create a key under Integrations → API keys (scopes `deals:read`,
`deals:write`, `ai:write`). Then:

```bash
curl -H "Authorization: Bearer gbx_live_…" https://crm.gbxps.com/api/v1/leads?stage=new
curl -H "Authorization: Bearer gbx_live_…" https://crm.gbxps.com/api/v1/leads/13
curl -H "Authorization: Bearer gbx_live_…" -H 'content-type: application/json' \
  -X PATCH https://crm.gbxps.com/api/v1/leads/13 -d '{"priority":"High","owner":"u1"}'
curl -H "Authorization: Bearer gbx_live_…" -H 'content-type: application/json' \
  -X POST https://crm.gbxps.com/api/v1/leads/13/activity \
  -d '{"text":"Claude scored lead 81 / 100","detail":"Segment fit, paid campaign match","score":81,"notifyOwner":true}'
curl -H "Authorization: Bearer gbx_live_…" -H 'content-type: application/json' \
  -X POST https://crm.gbxps.com/api/v1/leads \
  -d '{"practice":"Riverbend FA","contact":"Olivia Grant","email":"olivia@riverbendfa.com.au","source":"referral","value":41000}'
```

Duplicates (same email, same email domain or same practice name) return
`409` with the match. Full endpoint list: `server/README.md`.

## Data, backups, recovery

- `/root/crm-data/crm.db` — the workspace (SQLite, WAL mode).
- `/root/crm-data/backups/crm-YYYY-MM-DD.db` — nightly at 02:30 Melbourne
  time, 14 kept, plus a SharePoint copy when Graph is configured.
  Integrations → Server → *Back up database now* runs one on demand.
- Restore: stop the container, copy a backup over `crm.db` (delete
  `crm.db-wal` / `crm.db-shm`), start it again.
- Include `/root/crm-data` in the same off-box backup as the family-office
  data directory.

## Checks

- `curl -s https://crm.gbxps.com/api/v1/health` → `{"ok":true,…}`.
- `docker compose logs crm` shows `[mail:off]` lines while email is not
  configured; they become `[mail]` failures or nothing once it is.
- Chrome DevTools → Application → Manifest and Service Workers show no errors.
