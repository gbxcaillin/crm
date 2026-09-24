# Go live: one ordered path

This stitches the individual runbooks into the exact order to switch everything
on: the live CRM backend, website leads, the Cloudflare security perimeter and
Microsoft Bookings. Do the steps in order; the ordering avoids a TLS-behind-proxy
trap and a lockout.

Detailed references: `deploy/DEPLOY.md` (backend), `deploy/cloudflare-access.md`
(perimeter). The website side is in the Website repo's `docs/lead-capture-setup.md`.

Prerequisites: SSH to the Sydney VPS, admin on the Cloudflare account for
`gbxps.com`, and Microsoft 365 admin for the tenant that owns the booking
mailbox.

## 1. Deploy the live CRM backend (DNS still "DNS only")

Keep the `crm.gbxps.com` DNS record grey-clouded for now so Caddy can get its own
Let's Encrypt certificate.

```bash
ssh root@YOUR_VPS
cd /root/crm && git fetch origin main && git checkout main && git pull --ff-only
cp .env.production.example .env.production
node server/tools/keygen.js        # paste output into .env.production as DATA_KEYS=v1:<key>, keep a copy off-server
# set APP_URL=https://crm.gbxps.com ; chmod 600 .env.production
mkdir -p /root/crm-data && chmod 700 /root/crm-data
```

Add the `crm:` service to `/root/familyoffice/docker-compose.yml` (from
`deploy/compose-service.yml`) and the `crm.gbxps.com` block to the Caddyfile
(from `deploy/caddy-site.txt`), then:

```bash
cd /root/familyoffice
docker compose up -d --build crm
docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
docker compose logs -f crm      # look for: [boot] GBX Pipeline on :3000 · dist ok
```

## 2. Verify the backend and create the first admin

```bash
curl -s https://crm.gbxps.com/api/v1/health      # -> {"ok":true,...}
```

Open `https://crm.gbxps.com` -> **Create the first admin** -> set your account
and turn on TOTP MFA when prompted. Invite the team under Settings -> Team.

## 3. Connect the website (leads start flowing)

1. In the CRM: Integrations -> API keys -> new key named `website`, scope
   **`deals:write`**. Copy it once.
2. Cloudflare Pages -> the **Website** project -> Settings -> Variables and
   secrets:
   - `CRM_WEBHOOK_URL` = `https://crm.gbxps.com/api/v1/hooks/lead`
   - `CRM_API_KEY` = the key (encrypted)
3. Redeploy the Website project.
4. Submit any tool on gbxps.com -> the lead appears in the CRM. Done.

## 4. Put Cloudflare in front (security perimeter)

Full detail in `deploy/cloudflare-access.md`. In order:

1. Cloudflare -> SSL/TLS -> Origin Server -> create an Origin Certificate for
   `crm.gbxps.com`; install it in Caddy (`tls <cert> <key>` in the crm block),
   reload Caddy.
2. Cloudflare -> DNS -> set the `crm` record to **Proxied** (orange cloud).
3. Cloudflare -> SSL/TLS -> set mode to **Full (strict)**.
4. Zero Trust -> Access -> Applications -> add a self-hosted app on
   `crm.gbxps.com`, identity Microsoft Entra ID, policy Allow = your team's
   emails (or `@gbxps.com`).
5. Add **Bypass** apps (Everyone) for the machine endpoints, or leads and SSO
   break:
   - `crm.gbxps.com/api/v1/hooks/*`
   - `crm.gbxps.com/api/v1/auth/microsoft/callback`
   - `crm.gbxps.com/api/v1/health`
6. Re-verify: the UI now asks for Cloudflare sign-in; `curl .../api/v1/health`
   still returns `{"ok":true}` with no redirect; submit a tool on gbxps.com and
   confirm the lead still lands.

## 5. Turn on Microsoft Bookings

1. In Entra: on the `MS_*` app registration, add the **application** permission
   **`Bookings.Read.All`** and grant admin consent, in the tenant that owns the
   booking mailbox (`…@openbookwealth.com.au`).
2. In `.env.production` set the `MS_TENANT_ID` / `MS_CLIENT_ID` /
   `MS_CLIENT_SECRET` for that app and `BOOKINGS_BUSINESS=<booking mailbox
   address>`, then `docker compose up -d crm`.
3. Test now (admin session or key): `POST https://crm.gbxps.com/api/v1/integrations/bookings/sync`
   -> `{"added":N,...}`. Booked calls appear as an activity + task on the
   matching lead (or a new lead). After this the 15-minute job keeps it in sync.

## 6. Final end-to-end check

- [ ] `curl https://crm.gbxps.com/api/v1/health` -> ok (no login redirect)
- [ ] Opening the CRM asks for Cloudflare sign-in, then the CRM login
- [ ] A tool submission on gbxps.com creates a lead in the CRM
- [ ] A test booking appears on the matching lead within 15 minutes (or via the
      manual sync)
- [ ] Nightly backups land in `/root/crm-data/backups/`

## Housekeeping

- Flip the repo default branch to `main` (GitHub -> Settings -> Branches) so a
  fresh `git clone` lands on `main`.
- Updates later: `/root/crm/deploy/update.sh` (defaults to `main`).
