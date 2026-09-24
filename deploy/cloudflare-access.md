# Putting Cloudflare in front of crm.gbxps.com

This adds a security perimeter (TLS, CDN, DDoS protection and a Zero Trust
login) in front of the CRM without moving the app off the VPS. The container
keeps running behind Caddy exactly as it does now; Cloudflare sits in front of
it.

The one thing to get right: **gate the human UI, but never the machine
endpoints.** The website lead webhook, the Microsoft sign-in callback and the
health check are called by servers, not people, so they cannot carry a Zero
Trust login and must be allowed through.

## 1. Proxy the DNS record

In the Cloudflare dashboard, `gbxps.com` zone -> DNS:

- Find the `crm` record (A/AAAA/CNAME pointing at the VPS).
- Set it to **Proxied** (orange cloud).

## 2. Keep TLS working behind the proxy

Once the record is proxied, Caddy can no longer renew its Let's Encrypt
certificate over HTTP-01/TLS-ALPN (Cloudflare now terminates 443). Use a
Cloudflare **Origin Certificate** instead, which never needs renewing:

1. Cloudflare -> SSL/TLS -> Origin Server -> **Create Certificate** (hostname
   `crm.gbxps.com`, 15-year). Copy the cert and private key to the VPS, e.g.
   `/root/familyoffice/certs/crm.gbxps.com.pem` and `.key`.
2. In the `crm.gbxps.com` block of the Caddyfile, point Caddy at them:
   ```
   crm.gbxps.com {
       tls /certs/crm.gbxps.com.pem /certs/crm.gbxps.com.key
       reverse_proxy crm:3000
       # ... existing headers / request_body ...
   }
   ```
   (mount the certs dir into the Caddy container), then apply the change with
   `docker compose up -d --force-recreate caddy` (not `caddy reload` — the
   Caddyfile is a single-file bind mount; see DEPLOY.md "Applying Caddyfile
   changes").
3. Cloudflare -> SSL/TLS -> Overview -> set the mode to **Full (strict)**.

Alternative if you would rather keep Let's Encrypt: switch Caddy to the DNS-01
challenge with a scoped Cloudflare API token. The Origin Certificate is simpler
and has nothing to renew.

## 3. Add the Zero Trust login (Cloudflare Access)

Cloudflare **Zero Trust** dashboard -> Access -> Applications -> **Add an
application** -> **Self-hosted**:

- Application name: `GBX Pipeline CRM`
- Session duration: e.g. 24 hours
- Application domain: `crm.gbxps.com` (path left blank = the whole site)
- Identity: add a login method under Settings -> Authentication first. Use
  **Microsoft Entra ID** so it matches the M365 accounts (or email one-time PIN
  to start).
- Policy: **Allow**, with an include rule of either **Emails** (list your
  team's addresses) or **Emails ending in** `@gbxps.com`, or an Entra group.

Everyone who reaches the UI now signs in through Cloudflare first, then through
the CRM's own login (defence in depth). The CRM's TOTP MFA still applies.

## 4. Let the machines through (critical)

Still in Access -> Applications, add these **Bypass** applications so
server-to-server calls are not sent to the login screen. Each is a self-hosted
application scoped to a path, with a single policy of action **Bypass**,
include **Everyone**. Cloudflare evaluates the most specific path first, so
these win over the site-wide app above.

| Application domain + path | Why it must bypass |
|---|---|
| `crm.gbxps.com/api/v1/hooks/*` | Lead webhooks: the gbxps.com website, Google Ads and Meta. Authenticated by API key / signature, not a human login. |
| `crm.gbxps.com/api/v1/auth/microsoft/callback` | The Microsoft sign-in redirect, which arrives before any Access session exists. |
| `crm.gbxps.com/api/v1/health` | The uptime / health check. |

These endpoints are not "open": they enforce their own auth (the webhook API
key, the OIDC state, etc.). Bypass only means "do not show the Access login
here."

### Programmatic API access (Claude agent, Zapier)

Anything that calls the rest of the API with a Bearer key (for example
`GET /api/v1/leads`) is also a machine and would be blocked by the site-wide
Access app. Two clean options:

- **Cloudflare Access service token:** Zero Trust -> Access -> Service Auth ->
  create a token, then add a policy of action **Service Auth** to the CRM app.
  The client sends the `CF-Access-Client-Id` / `CF-Access-Client-Secret`
  headers alongside its Bearer key.
- **Or** add `crm.gbxps.com/api/v1/*` as a Bypass application and rely on the
  CRM's own API-key auth for those routes. Simpler, slightly less layered.

The gbxps.com website only calls `/api/v1/hooks/lead`, so the hooks bypass in
the table above is enough for it; you only need this section if you also drive
the API from Claude or Zapier.

## 5. Verify

- Open `https://crm.gbxps.com` in a fresh browser -> you should hit the
  Cloudflare Access login, then the CRM login.
- `curl -s https://crm.gbxps.com/api/v1/health` -> `{"ok":true,...}` with no
  login redirect.
- Submit a tool on gbxps.com (with `CRM_WEBHOOK_URL` / `CRM_API_KEY` set) ->
  the lead lands in the CRM, proving the webhook bypass works.
