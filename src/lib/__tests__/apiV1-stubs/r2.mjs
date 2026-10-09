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
// snapshots; a test can corrupt one there.
const bytes = () => (globalThis.__r2Bytes ??= new Map());
export async function putObject(key, body, contentType) {
  if (globalThis.__r2Down) throw new Error("R2 unavailable");
  bytes().set(key, new Uint8Array(body));
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
  bytes().delete(key);
  globalThis.__r2Puts?.delete(key);
}
export async function bucketUsage() {
  if (globalThis.__r2Down) throw new Error("connect ECONNREFUSED r2.test");
  const all = [...(globalThis.__objects ?? []).map((o) => o.size), ...[...bytes().values()].map((b) => b.byteLength)];
  return { objects: all.length, bytes: all.reduce((n, s) => n + s, 0), truncated: false };
}
