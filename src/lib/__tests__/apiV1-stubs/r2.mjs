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
// Uploads land in globalThis.__r2Puts (key -> { type, bytes }).
export async function putObject(key, body, contentType) {
  (globalThis.__r2Puts ??= new Map()).set(key, { type: contentType, bytes: body.length });
}
export async function deleteObject(key) {
  (globalThis.__r2Puts ??= new Map()).delete(key);
}
