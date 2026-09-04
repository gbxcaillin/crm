# Deploying crm.gbxps.com

The CRM rides on the same Sydney VPS as `office.gbxps.com` and
`play.gbxps.com`: one Docker Compose stack, one front Caddy doing HTTPS.
Adding the CRM is the same three steps used for the game relay.

**What this deploys today:** the installable static preview (the full UI,
the manifest, the service worker, icons). Data lives in each browser until
the backend is built; there is no shared database, no email/SharePoint sync
and no server push yet. It is protected by a Caddy basic-auth prompt.

## Prerequisites (already true on the VPS)

- Docker + Compose installed; `/root/familyoffice` running `app`, `caddy`
  and `gamerelay`.
- DNS: `crm.gbxps.com` A record → the VPS IP (done at VentraIP).
- Port 80/443 open in `ufw`.

## 1. Get the code onto the server

```bash
ssh root@YOUR_SERVER_IP
cd /root
# Private repo: use a fine-grained GitHub token with read access, same as familyoffice.
git clone https://github.com/gbxcaillin/crm.git
cd crm && git checkout claude/crm-wireframe-integrations-cmbsqa   # or main once merged
```

## 2. Register the service and the hostname in the shared stack

Add the service to `/root/familyoffice/docker-compose.yml` (same level as
`app:`, `caddy:`, `gamerelay:`):

```yaml
  crm:
    build: /root/crm
    restart: unless-stopped
```

Generate a password hash for the preview gate:

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'choose-a-strong-password'
```

Append the site block from `deploy/caddy-site.txt` to
`/root/familyoffice/deploy/Caddyfile`, pasting the hash in place of
`REPLACE_WITH_HASH…`.

## 3. Build and start

```bash
cd /root/familyoffice
docker compose up -d --build crm
docker compose restart caddy      # picks up the new site block and fetches the certificate
docker compose logs -f crm        # should show Caddy serving :80
```

Visit https://crm.gbxps.com — enter the basic-auth password, then sign in
to the app with any email from the sample team (e.g. `caillin@gbxps.com`,
any password of 6+ characters).

## Updating

```bash
chmod +x /root/crm/deploy/update.sh
/root/crm/deploy/update.sh claude/crm-wireframe-integrations-cmbsqa
```

`update.sh` pulls the branch, rebuilds only the `crm` container and prints
the running commit. Browsers pick up the new shell on next load because
`index.html` and `sw.js` are served with `no-cache`.

## Installing on phones

Open https://crm.gbxps.com in Safari (iPhone) or Chrome (Android) →
Share / menu → **Add to Home Screen**. Note: while basic-auth is on, some
browsers refuse to install because the manifest fetch is unauthenticated.
Either accept "open from bookmark" for now, or replace `basic_auth` with an
IP allow-list for the office and home connections:

```
	@allowed remote_ip 203.0.113.10 198.51.100.0/24
	handle @allowed {
		reverse_proxy crm:80
	}
	respond "Not authorised" 403
```

## Checks

- `curl -I https://crm.gbxps.com/manifest.webmanifest` → 200 (after auth).
- `docker compose exec crm caddy version` → Caddy 2.x.
- Chrome DevTools → Application → Manifest and Service Workers show no errors.

## What changes when the backend arrives

- `crm:` gains `env_file: .env.production` and a `./crm-data:/app/data`
  volume, and `build:` points at the app image instead of the static one.
- The Caddy block drops `basic_auth` (the app has its own login and SSO).
- Webhooks become live at `https://crm.gbxps.com/api/v1/hooks/google-ads`
  and `/meta`; push subscriptions at `/api/v1/push/subscribe`.
- A nightly job copies the SQLite database to SharePoint via Graph.
