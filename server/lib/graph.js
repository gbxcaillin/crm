'use strict';
// Microsoft Graph (client-credentials). Used for SharePoint files, Graph mail and backups.
// Needs an Azure app registration with application permissions:
//   Sites.Selected (or Sites.ReadWrite.All) for the client library, Mail.Send for MAIL_MODE=graph.
const T = process.env.MS_TENANT_ID, C = process.env.MS_CLIENT_ID, S = process.env.MS_CLIENT_SECRET;
const SP_SITE = process.env.SP_SITE || 'gbxps.sharepoint.com:/sites/Clients';
const SP_LIBRARY = process.env.SP_LIBRARY || 'Client Files';
// Optional base folder within the library to nest per-client folders under (e.g. "Client Files").
const SP_FOLDER = (process.env.SP_FOLDER || '').replace(/^\/+|\/+$/g, '');
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
async function g(method, url, body, headers = {}, retried = false) {
  const r = await fetch(url.startsWith('http') ? url : 'https://graph.microsoft.com/v1.0' + url, { method, headers: { authorization: 'Bearer ' + (await token()), ...(body && !(body instanceof Buffer) ? { 'content-type': 'application/json' } : {}), ...headers }, body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined });
  if (r.status === 204 || r.status === 202) return {};
  // A 401 usually means the cached token went stale (admin-consent change, secret rotation, or
  // consent still propagating across Microsoft's token servers). Drop it and retry once with a
  // fresh token so the call self-heals instead of failing for up to the token's lifetime.
  if (r.status === 401 && !retried) { tok = null; return g(method, url, body, headers, true); }
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
// Rename an existing folder (given its current path relative to the library root) to a new
// leaf name, keeping it under the same parent. Returns the updated item, null if the folder
// is not there, and throws a friendly error if a folder with the new name already exists.
async function renameFolder(relPath, newName) {
  const d = await driveId();
  try { return await g('PATCH', `/drives/${d}/root:/${enc(relPath)}`, { name: newName }); }
  catch (e) {
    if (/: 404 /.test(e.message)) return null;
    if (/: 409 /.test(e.message) || /already exist/i.test(e.message)) throw new Error(`A folder named "${newName}" already exists in SharePoint`);
    throw e;
  }
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
// Microsoft Bookings (needs application permission Bookings.Read.All on the app,
// in the tenant that owns the booking mailbox).
async function listBookingBusinesses() {
  const j = await g('GET', '/solutions/bookingBusinesses');
  return (j.value || []).map((b) => ({ id: b.id, name: b.displayName }));
}
async function listAppointments(businessId, { backDays = 2, aheadDays = 60 } = {}) {
  const start = new Date(Date.now() - backDays * 86400e3).toISOString();
  const end = new Date(Date.now() + aheadDays * 86400e3).toISOString();
  const url = `/solutions/bookingBusinesses/${encodeURIComponent(businessId)}/calendarView?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&$top=200`;
  const j = await g('GET', url);
  return j.value || [];
}
module.exports = { enabled, listFolder, upload, renameFolder, download, sendMail, listBookingBusinesses, listAppointments, safe, SP_SITE, SP_LIBRARY, SP_FOLDER };
