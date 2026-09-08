'use strict';
// Microsoft 365 (Entra ID) sign-in with OpenID Connect, authorization code + PKCE.
// Entra enforces the tenant's MFA and conditional-access policies, so this is the cheapest
// strong login for an M365 shop: no extra licence, no secrets typed into the app.
//   SSO_CLIENT_ID, SSO_CLIENT_SECRET, SSO_TENANT (defaults to MS_TENANT_ID)
//   Redirect URI to register in Azure: <APP_URL>/api/v1/auth/microsoft/callback
const crypto = require('node:crypto');
const TENANT = process.env.SSO_TENANT || process.env.MS_TENANT_ID;
const CID = process.env.SSO_CLIENT_ID, SECRET = process.env.SSO_CLIENT_SECRET;
const BASE = process.env.APP_URL || 'https://crm.gbxps.com';
const REDIRECT = BASE + '/api/v1/auth/microsoft/callback';
const enabled = () => !!(TENANT && CID && SECRET);
const b64u = (b) => Buffer.from(b).toString('base64url');

function authUrl() {
  const state = b64u(crypto.randomBytes(24)), nonce = b64u(crypto.randomBytes(16)), verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ client_id: CID, response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query', scope: 'openid profile email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
  return { url: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?${q}`, state, nonce, verifier };
}
let jwks = { keys: [], at: 0 };
async function getKey(kid) {
  if (!jwks.keys.some((k) => k.kid === kid) || Date.now() - jwks.at > 3600e3) {
    const r = await fetch(`https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`); jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  }
  const jwk = jwks.keys.find((k) => k.kid === kid); if (!jwk) throw new Error('Unknown signing key');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}
async function exchange(code, verifier, nonce) {
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CID, client_secret: SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error_description || 'Token exchange failed');
  const [h, p, s] = String(j.id_token || '').split('.'); if (!s) throw new Error('No id_token');
  const header = JSON.parse(Buffer.from(h, 'base64url')); const claims = JSON.parse(Buffer.from(p, 'base64url'));
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), await getKey(header.kid), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('id_token signature invalid');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== CID) throw new Error('id_token audience mismatch');
  if (!String(claims.iss || '').startsWith('https://login.microsoftonline.com/')) throw new Error('id_token issuer mismatch');
  if (TENANT !== 'common' && TENANT !== 'organizations' && claims.tid && claims.tid !== TENANT) throw new Error('Wrong tenant');
  if (claims.exp < now - 60 || claims.nbf > now + 60) throw new Error('id_token expired');
  if (claims.nonce !== nonce) throw new Error('nonce mismatch');
  const email = String(claims.email || claims.preferred_username || '').toLowerCase();
  if (!email.includes('@')) throw new Error('No email in token');
  return { email, name: claims.name || email, oid: claims.oid };
}
module.exports = { enabled, authUrl, exchange, REDIRECT };
