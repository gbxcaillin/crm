'use strict';
// Microsoft Graph (client-credentials). Used for SharePoint files, Graph mail and backups.
// Needs an Azure app registration with application permissions:
//   Sites.Selected (or Sites.ReadWrite.All) for the client library, Mail.Send for MAIL_MODE=graph.
const T = process.env.MS_TENANT_ID, C = process.env.MS_CLIENT_ID, S = process.env.MS_CLIENT_SECRET;
const SP_SITE = process.env.SP_SITE || 'gbxps.sharepoint.com:/sites/Clients';
const SP_LIBRARY = process.env.SP_LIBRARY || 'Client Files';
let tok = null;
function enabled() { return !!(T && C && S); }
async function token() {
  if (tok && tok.exp > Date.now() + 60e3) return tok.v;
  const r = await fetch(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: C, client_secret: S, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }) });
  const j = await r.json();
  if (!r.ok) throw new Error('Graph token: ' + (j.error_description || r.status));
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.v;
}
async function g(method, url, body, headers = {}) {
  const r = await fetch(url.startsWith('http') ? url : 'https://graph.microsoft.com/v1.0' + url, { method, headers: { authorization: 'Bearer ' + (await token()), ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined });
  if (r.status === 204 || r.status === 202) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Graph ${method} ${url}: ${r.status} ${j.error ? j.error.message : ''}`);
  return j;
}
let drive = null;
async function driveId() {
  if (drive) return drive;
  const site = await g('GET', `/sites/${SP_SITE}`);
  const drives = await g('GET', `/sites/${site.id}/drives`);
  const d = drives.value.find((x) => x.name === SP_LIBRARY) || drives.value[0];
  if (!d) throw new Error('SharePoint library not found: ' + SP_LIBRARY);
  drive = d.id; return drive;
}
const enc = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const safe = (n) => String(n || 'Unfiled').replace(/[\\/:*?"<>|#%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
async function listFolder(folder) {
  const d = await driveId();
  try {
    const j = await g('GET', `/drives/${d}/root:/${enc(folder)}:/children?$top=200&$select=id,name,size,webUrl,lastModifiedDateTime,lastModifiedBy,folder,file`);
    return j.value.map((it) => ({ spId: it.id, name: it.name, size: it.size, url: it.webUrl, at: (it.lastModifiedDateTime || '').slice(0, 10), byName: it.lastModifiedBy && it.lastModifiedBy.user ? it.lastModifiedBy.user.displayName : '', folder: !!it.folder }));
  } catch (e) { if (/404/.test(e.message)) return []; throw e; }
}
async function upload(folder, name, buf) {
  const d = await driveId();
  const p = `${enc(folder)}/${encodeURIComponent(name)}`;
  if (buf.length <= 4 * 1024 * 1024) return g('PUT', `/drives/${d}/root:/${p}:/content`, buf, { 'content-type': 'application/octet-stream' });
  const sess = await g('POST', `/drives/${d}/root:/${p}:/createUploadSession`, { item: { '@microsoft.graph.conflictBehavior': 'rename' } });
  const CH = 5 * 1024 * 1024; let last = null;
  for (let off = 0; off < buf.length; off += CH) {
    const part = buf.subarray(off, Math.min(off + CH, buf.length));
    const r = await fetch(sess.uploadUrl, { method: 'PUT', headers: { 'content-length': part.length, 'content-range': `bytes ${off}-${off + part.length - 1}/${buf.length}` }, body: part });
    last = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Upload chunk failed: ' + r.status);
  }
  return last;
}
async function download(spId) { const d = await driveId(); const r = await fetch(`https://graph.microsoft.com/v1.0/drives/${d}/items/${spId}/content`, { headers: { authorization: 'Bearer ' + (await token()) }, redirect: 'follow' }); if (!r.ok) throw new Error('Download failed ' + r.status); return Buffer.from(await r.arrayBuffer()); }
async function sendMail(from, to, subject, html) {
  return g('POST', `/users/${encodeURIComponent(from)}/sendMail`, { message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false });
}
module.exports = { enabled, listFolder, upload, download, sendMail, safe, SP_SITE, SP_LIBRARY };
