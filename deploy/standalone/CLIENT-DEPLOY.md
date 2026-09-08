# Deploying GBX Pipeline for a client

A standalone install on the client's own server or a VPS you run for them.
Written for a financial planning firm whose leads come from Google Ads and
Meta Lead Ads. Plan about 60–90 minutes end to end; the ad-platform steps
depend on the client's marketing person being available to click "connect".

Decide up front **whose Microsoft 365 tenant** you use. Email, SharePoint
file storage and single sign-on all key off it. Using the client's own
tenant is cleanest (their data stays in their Microsoft account); you'll need
a Global Admin there to approve one app registration.

---

## 1. Domain and server

1. Pick a hostname, e.g. `crm.clientname.com.au`.
2. Get a small VPS — 1 vCPU / 2 GB RAM is plenty (Vultr/DigitalOcean Sydney,
   or the client's existing host). Ubuntu 22.04 or 24.04.
3. In the domain's DNS, add an **A record** `crm` → the server's IP.
4. Point your SSH key at the box and confirm you can log in as root.

## 2. Base install

```bash
ssh root@SERVER_IP
apt-get update && apt-get install -y docker.io docker-compose-v2 git
systemctl enable --now docker
mkdir -p /opt/pipeline && cd /opt/pipeline
git clone https://github.com/gbxcaillin/crm.git crm      # or the client's fork
cd crm/deploy/standalone
cp .env.production.example .env.production
```

## 3. Encryption key (required)

Financial data must be encrypted at rest, and the app refuses to start in
production without a key.

```bash
docker compose run --rm crm node server/tools/keygen.js
```

Copy the printed line into `.env.production` as `DATA_KEYS=v1:<key>`, and
**store the same key in your password manager**. Without it, the database
and every backup are unreadable. Then:

```bash
chmod 600 .env.production
```

Edit `.env.production` and set `APP_URL=https://crm.clientname.com.au`.
Edit `Caddyfile` and replace `crm.CLIENTDOMAIN.com` with the same hostname.

## 4. First start

```bash
cd /opt/pipeline/crm/deploy/standalone
docker compose up -d --build
docker compose logs -f crm      # look for: [boot] GBX Pipeline on :3000 ... dist ok
```

Give Caddy a minute to fetch the certificate, then open
`https://crm.clientname.com.au`. You'll see **Create the first admin** — set
up your own account (or the client's principal). Sign in.

## 5. Harden the server (once)

```bash
sudo bash /opt/pipeline/crm/deploy/harden.sh
```

Automatic security updates, firewall (22/80/443 only), fail2ban on SSH,
key-only SSH, Docker log rotation.

## 6. Shape the pipeline for financial planning

In the app, as admin:

- **Settings → Fields** — the defaults already fit advice firms (FUM, adviser
  headcount, licensee, service line). Adjust labels to the client's language,
  add fields like "Advice type" (Comprehensive / Insurance / SMSF) if useful.
- **Settings → Stages** — rename to their sales process, e.g. *New enquiry →
  Discovery call → SOA in progress → Presented → Client*.
- **Settings → Team** — invite advisers and support staff. Each gets an email
  link to set a password. Members see only their own leads; managers and
  admins see everything.

## 7. Turn on security

- **Settings → Security → Workspace policy** — set *Require two-factor* to
  **Everyone** for a firm holding client financials. Each person enrols an
  authenticator app at next sign-in.
- If you want Microsoft sign-in as well, do step 10.

## 8. Connect Google Ads

1. In `.env.production`, set `GOOGLE_ADS_KEY` to a long random string
   (`openssl rand -hex 24`), then `docker compose up -d crm`.
2. In **Google Ads → the lead-form asset → Lead delivery → Webhook**:
   - Webhook URL: `https://crm.clientname.com.au/api/v1/hooks/google-ads`
   - Key: the same string.
3. Click **Send test data** in Google Ads. A test lead appears in the
   pipeline under stage *New*, with a first-call task and a score. Real
   enquiries now flow in the moment someone submits the form.

## 9. Connect Meta Lead Ads

Two ways — pick one.

**A. Direct (needs a Meta app; most robust).**
1. Set `META_VERIFY_TOKEN` (any string you choose), `META_APP_SECRET` (from
   the Meta app), and `META_PAGE_TOKEN` (a long-lived Page token with
   `leads_retrieval` + `pages_manage_ads`) in `.env.production`;
   `docker compose up -d crm`.
2. Meta app → **Webhooks → Page → leadgen**:
   - Callback URL: `https://crm.clientname.com.au/api/v1/hooks/meta`
   - Verify token: your `META_VERIFY_TOKEN`.
   - Subscribe the client's Facebook Page.
3. Submit a test lead from Meta's Lead Ads Testing Tool.

**B. Via Zapier/Make (no Meta app; fastest to stand up).**
- Trigger: *Facebook Lead Ads → New Lead*. Action: *Webhooks → POST* to
  `https://crm.clientname.com.au/api/v1/hooks/lead` with header
  `Authorization: Bearer <API key>` (make the key in step 12), body
  `{"practice": "...", "contact": "...", "email": "...", "phone": "...",
  "source": "meta", "campaign": "..."}`.

Either way, duplicate leads (same email, domain or firm name) are rejected
automatically so the same enquiry from both platforms doesn't create two
cards.

## 10. Email, SharePoint, Microsoft sign-in (client's M365 tenant)

These share one Azure app registration. In the client's **Entra admin
centre → App registrations → New registration**:

- Redirect URI (Web): `https://crm.clientname.com.au/api/v1/auth/microsoft/callback`
- Add a client secret; copy tenant ID, client ID, secret.
- API permissions (application): `Sites.Selected` (grant it on the Clients
  SharePoint site) for files; `Mail.Send` if you want the app to send from a
  shared mailbox via Graph.

In `.env.production`:
- **SharePoint files:** `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`,
  `SP_SITE`, `SP_LIBRARY`.
- **Email:** either the SMTP block (a mailbox with SMTP AUTH on) or
  `MAIL_MODE=graph` with the app above.
- **Single sign-on:** `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_TENANT`
  (the tenant ID). Staff can then click *Sign in with Microsoft* and the
  client's own MFA/conditional-access rules apply.

`docker compose up -d crm` after editing. Test each from **Integrations →
Server** (*Send me a test email*) and by uploading a file to a deal.

## 11. Let Claude read and score leads (optional)

**Integrations → API keys → New key**, scopes `deals:read`, `deals:write`,
`ai:write`. Give it to your Claude agent. It can list new leads, post a score
and a note, set priority and owner — all logged in each deal's changelog. See
`server/README.md` for the endpoints.

## 12. Roll out to the team

- Everyone opens `https://crm.clientname.com.au` on their phone → **Add to
  Home Screen** (installs as an app). Turn on notifications for new leads and
  tasks under Settings → Notifications.
- Advisers get a lead alert the instant a Google/Meta form is submitted.

## 13. Ongoing

- **Backups** run nightly (encrypted) into `crm-data/backups`, plus a
  SharePoint copy if Graph is configured. Also back up the whole
  `/opt/pipeline/crm/deploy/standalone/crm-data` directory off-box, and keep
  the `DATA_KEYS` value somewhere separate.
- **Updates:** `deploy/standalone/update.sh main` pulls and rebuilds; data is
  untouched.
- **Someone leaves:** Settings → Team → Deactivate (ends their sessions),
  revoke any API key they made, disable them in Entra if using SSO.

---

### Cost to the client
VPS ~A$12–20/month, domain ~A$20/year, TLS free, everything in the app free.
Email, SharePoint and SSO reuse the Microsoft 365 they already pay for.
See `SECURITY.md` for the full control-by-control breakdown.
