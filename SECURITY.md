# Security

How GBX Pipeline protects the client and financial data it holds, what each
control costs, and what to do when something goes wrong. Everything in the
"built in" column ships with the app and costs nothing beyond the VPS and
the Microsoft 365 licences GBX already pays for.

## Threat model

The app holds practice financials (FUM, loan books, engagement values),
client and prospect contact details, invoices, internal chat and documents
links. Realistic threats, in the order they are likely:

1. A staff password is phished or reused from a breached site.
2. A laptop or phone with a signed-in session is lost.
3. The VPS disk, a snapshot or a backup file is copied by someone with
   hosting-provider or SharePoint access.
4. A bug in the app leaks data across users, or an attacker abuses the API.
5. The VPS itself is compromised through an unpatched service or weak SSH.

## Controls

| Layer | Built in | How it works | Cost |
|---|---|---|---|
| Transport | HTTPS only, HSTS, TLS 1.2+ | Caddy terminates TLS with Let's Encrypt; the app adds `Strict-Transport-Security` and `upgrade-insecure-requests`. | $0 |
| Sign-in | scrypt password hashes, 10-char minimum with a number, lockout after 6 failures / 15 min per IP | `server/lib/auth.js` | $0 |
| Second factor | TOTP authenticator app, 8 one-time backup codes, **required for admins by default** (policy: admins / everyone / off) | `server/lib/totp.js`; Settings → Security | $0 |
| Microsoft 365 sign-in | OpenID Connect (auth code + PKCE) against your Entra tenant; Entra's MFA and conditional access apply | `server/lib/oidc.js`; set `SSO_CLIENT_ID/SECRET` | $0 with existing M365 |
| Sessions | Random 256-bit token, hashed in the DB, `__Host-` cookie (Secure, HttpOnly, SameSite=Lax), 12 h or 30 d, list and revoke devices, "sign out other devices" on password change | Settings → Security → Signed-in devices | $0 |
| Encryption at rest | AES-256-GCM on every record, configuration document, MFA secret and log detail before it reaches SQLite. Key from `DATA_KEYS` in the environment, never on the data volume. Versioned keys, rotation tool. Backups and SharePoint copies are therefore ciphertext. | `server/lib/vault.js`, `tools/keygen.js`, `tools/rotate.js` | $0 |
| Authorization | Admin / Manager / Member enforced server-side. Members receive and can change only their own deals, clients and related records. Policy and routing settings are admin-only. | `server/lib/state.js` | $0 |
| API keys | `gbx_live_…` shown once, stored hashed, scoped (`deals:read`, `deals:write`, `ai:write`, …), revocable | Integrations → API keys | $0 |
| Webhooks | Google Ads shared key, Meta HMAC-SHA256 signature check, duplicate rejection | `server/routes/api.js` | $0 |
| Browser hardening | Content-Security-Policy (no third-party scripts or connections), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP | `server/index.js` | $0 |
| Abuse limits | 600 requests/min per IP, 40/min on auth and webhook paths, 5 password-reset requests / 15 min | `server/lib/auth.js` | $0 |
| Audit trail | Append-only log of sign-ins (ok/fail/locked), logouts, password and MFA events, invites, role changes, API keys, deletions, backups, exports. 2-year retention, CSV export. | Settings → Security → Audit log | $0 |
| Backups | Nightly SQLite copy (encrypted content), 14 kept, optional SharePoint copy. On-demand from Integrations. | `server/lib/jobs.js` | $0 |
| Container | Non-root user, no shell tools beyond Node, only port 3000 on the Docker network, health check | `Dockerfile` | $0 |
| Host | `deploy/harden.sh`: unattended security updates, ufw (22/80/443 only), fail2ban on SSH, key-only SSH, Docker log rotation | run once on the VPS | $0 |

## Choices that were made on cost

- **Application-level encryption instead of a KMS.** The key sits in
  `/root/crm/.env.production` (root-only) and in the container's memory.
  That protects against the realistic exposures (disk images, backup files,
  SharePoint copies, provider staff) at no cost. An attacker with root on
  the box can read memory anyway, so a cloud KMS would add little here.
  Upgrade path if ever needed: Azure Key Vault (about A$1/month per key)
  holding the data key, fetched at boot with a managed identity.
- **TOTP + Microsoft sign-in instead of hardware keys / passkeys.** Both are
  free and phishing-resistant enough for this team size. Passkeys
  (WebAuthn) can be added later; Entra already supports them for the
  Microsoft sign-in path.
- **SQLite on one VPS instead of a managed database.** Cheapest option that
  meets the need; the nightly encrypted backup to SharePoint is the
  off-site copy. Keep `/root/crm-data` in the same off-box backup as the
  family-office data.
- **No WAF.** Caddy + the app's own limits are enough for a private tool.
  If the login page ever gets hammered, Cloudflare's free tier in front of
  crm.gbxps.com adds bot filtering and DDoS absorption for $0.

## Operating it

**First deploy**

```bash
node server/tools/keygen.js                 # → DATA_KEYS=v1:<key> in .env.production
chmod 600 /root/crm/.env.production
sudo bash /root/crm/deploy/harden.sh        # once per VPS
```

The server refuses to start in production without `DATA_KEYS`
(`ALLOW_UNENCRYPTED=1` overrides, for a throwaway test only).

**Key rotation** (yearly, or if the key may have been exposed)

```bash
NEW=$(docker compose exec crm node server/tools/keygen.js)
# prepend to DATA_KEYS:  DATA_KEYS=v2:$NEW,v1:<old>
docker compose up -d crm
docker compose exec crm node server/tools/rotate.js
# remove v1 from DATA_KEYS, then: docker compose up -d crm
```

**Keep a copy of the current key** somewhere that is not the VPS (a
password manager entry is fine). Without it the database and every backup
are unreadable.

**Someone leaves**: Settings → Team → Deactivate (their sessions end
immediately), revoke any API key they created, and if they used Microsoft
sign-in disable them in Entra too.

**Lost phone**: an admin uses Reset 2FA on their row; they enrol again at
next sign-in. Backup codes cover the gap.

**Suspected breach**

1. Rotate the data key and every API key; sign everyone out (Settings →
   Security → sign out other devices, per admin) or `docker compose exec
   crm node -e "require('./server/lib/db').db.exec('DELETE FROM sessions')"`.
2. Export the audit log (Settings → Security) and check `login.fail`,
   `login.locked`, `sso.denied`, `record.delete` and `audit.export` rows.
3. Under the Privacy Act's Notifiable Data Breaches scheme, assess within
   30 days whether the breach is likely to cause serious harm; if so,
   notify the OAIC and affected individuals.

## Known limits

- Encryption protects data at rest, not in a running process: anyone with
  root on the VPS can read the key from memory or the env file. Keep SSH
  key-only and patched (`harden.sh`).
- Members' visibility is enforced per record; chat rooms are shared by
  design, and calendar events are visible to everyone in the workspace.
- SMTP credentials and Microsoft app secrets live in `.env.production` as
  plaintext; that file is root-only and outside the data volume.
- Rate limits are per process and reset on restart, which is fine for a
  single container.
