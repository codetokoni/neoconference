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

// Writes land in globalThis.__objects (key, size, date, body) so listings
// and data-governance tests see them, and their bytes in globalThis.__r2Bytes
// (key -> Uint8Array) for the ops snapshots; a test can corrupt one there.
const objects = () => (globalThis.__objects ??= []);
const bytes = () => (globalThis.__r2Bytes ??= new Map());
export async function putObject(key, body, contentType) {
  if (globalThis.__r2Down) throw new Error("R2 unavailable");
  bytes().set(key, new Uint8Array(body));
  const list = objects().filter((o) => o.key !== key);
  list.push({ key, size: body.length, lastModified: new Date(Date.now()).toISOString(), body: Buffer.from(body), contentType });
  globalThis.__objects = list;
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
  globalThis.__objects = objects().filter((o) => o.key !== key);
}
export async function renameObject(from, to) {
  const o = objects().find((x) => x.key === from);
  if (!o) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
  globalThis.__objects = [...objects().filter((x) => x.key !== from && x.key !== to), { ...o, key: to }];
  if (bytes().has(from)) {
    bytes().set(to, bytes().get(from));
    bytes().delete(from);
  }
}
export async function listAllObjects(prefix = "") {
  return { items: objects().filter((o) => o.key.startsWith(prefix)).map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified })), truncated: false };
}
export async function bucketUsage() {
  if (globalThis.__r2Down) throw new Error("connect ECONNREFUSED r2.test");
  const sizes = new Map(objects().map((o) => [o.key, o.size]));
  for (const [k, b] of bytes()) if (!sizes.has(k)) sizes.set(k, b.byteLength);
  const all = [...sizes.values()];
  return { objects: all.length, bytes: all.reduce((n, s) => n + s, 0), truncated: false };
}
