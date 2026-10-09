// R2 as a list of objects the test sets in globalThis.__objects.
export * from "real:r2";
export function isR2Configured() { return true; }
export async function listRecordings(prefix = "", max = 200) {
  globalThis.__r2Prefixes = [...(globalThis.__r2Prefixes ?? []), prefix];
  return (globalThis.__objects ?? [])
    .filter((o) => o.key.startsWith(prefix))
    .slice(0, max)
    .map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified }));
}
export async function signGetUrl(key, expiresIn = 3600) {
  return `https://signed.test/${key}?expires=${expiresIn}`;
}
// The content index's paged listing and HEAD, over the same __objects
// (key order, as R2 lists). __r2Writes records put/delete so a test can
// prove nothing touched the bucket.
export async function listObjectsPage({ prefix = "", token = null, maxKeys = 1000 } = {}) {
  const all = (globalThis.__objects ?? []).filter((o) => o.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const start = token ? Number(token) : 0;
  const page = all.slice(start, start + maxKeys);
  const next = start + maxKeys < all.length ? String(start + maxKeys) : null;
  return { objects: page.map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified, etag: o.etag })), next };
}
export async function headObject(key) {
  const o = (globalThis.__objects ?? []).find((x) => x.key === key);
  return o ? { size: o.size, etag: o.etag, contentType: o.contentType, lastModified: o.lastModified } : null;
}
export async function putObject(key, body, contentType) {
  globalThis.__r2Writes = [...(globalThis.__r2Writes ?? []), { op: "put", key }];
  if (globalThis.__r2PutFails) throw new Error("stub put failed");
  globalThis.__objects = [...(globalThis.__objects ?? []).filter((o) => o.key !== key), { key, size: body.length, contentType, lastModified: new Date().toISOString(), etag: '"' + (globalThis.__md5?.(body) ?? "x") + '"' }];
}
export async function deleteObject(key) {
  globalThis.__r2Writes = [...(globalThis.__r2Writes ?? []), { op: "delete", key }];
  globalThis.__objects = (globalThis.__objects ?? []).filter((o) => o.key !== key);
}
