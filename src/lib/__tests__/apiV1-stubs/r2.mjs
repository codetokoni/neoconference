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
// Object bytes in globalThis.__r2Bytes (key -> Uint8Array), for the ops
// snapshots and the upload routes; a test can corrupt one there.
// __r2Writes records put/delete so a test can prove nothing touched the bucket.
const bytes = () => (globalThis.__r2Bytes ??= new Map());
const stamps = () => (globalThis.__r2Stamps ??= new Map());
export async function putObject(key, body, contentType) {
  globalThis.__r2Writes = [...(globalThis.__r2Writes ?? []), { op: "put", key }];
  if (globalThis.__r2Down) throw new Error("R2 unavailable");
  if (globalThis.__r2PutFails) throw new Error("stub put failed");
  bytes().set(key, new Uint8Array(body));
  stamps().set(key, { contentType, lastModified: new Date().toISOString() });
  // And what was uploaded as, in globalThis.__r2Puts (key -> { type, bytes }).
  (globalThis.__r2Puts ??= new Map()).set(key, { type: contentType, bytes: body.length });
}
export async function getObjectBytes(key) {
  const b = bytes().get(key);
  if (!b) throw new Error("NoSuchKey");
  const out = new Uint8Array(b);
  // A test can make reads of some keys come back damaged.
  if (globalThis.__r2CorruptPrefix && key.startsWith(globalThis.__r2CorruptPrefix)) out[out.length - 1] ^= 0xff;
  return out;
}
export async function deleteObject(key) {
  globalThis.__r2Writes = [...(globalThis.__r2Writes ?? []), { op: "delete", key }];
  bytes().delete(key);
  globalThis.__objects = (globalThis.__objects ?? []).filter((o) => o.key !== key);
  globalThis.__r2Puts?.delete(key);
}
export async function bucketUsage() {
  if (globalThis.__r2Down) throw new Error("connect ECONNREFUSED r2.test");
  const all = [...(globalThis.__objects ?? []).map((o) => o.size), ...[...bytes().values()].map((b) => b.byteLength)];
  return { objects: all.length, bytes: all.reduce((n, s) => n + s, 0), truncated: false };
}
/** Everything stored: the listed __objects and the bytes put through putObject. */
export function allStoredObjects() {
  const listed = globalThis.__objects ?? [];
  const put = [...bytes()]
    .filter(([key]) => !listed.some((o) => o.key === key))
    .map(([key, b]) => ({ key, size: b.byteLength, lastModified: stamps().get(key)?.lastModified, contentType: stamps().get(key)?.contentType, etag: '"' + (globalThis.__md5?.(b) ?? "x") + '"' }));
  return [...listed, ...put];
}
// The content index's paged listing and HEAD (key order, as R2 lists).
export async function listObjectsPage({ prefix = "", token = null, maxKeys = 1000 } = {}) {
  const all = allStoredObjects().filter((o) => o.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const start = token ? Number(token) : 0;
  const page = all.slice(start, start + maxKeys);
  const next = start + maxKeys < all.length ? String(start + maxKeys) : null;
  return { objects: page.map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified, etag: o.etag })), next };
}
export async function headObject(key) {
  const o = allStoredObjects().find((x) => x.key === key);
  return o ? { size: o.size, etag: o.etag, contentType: o.contentType, lastModified: o.lastModified } : null;
}
