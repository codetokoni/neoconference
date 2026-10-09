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

// Writes land in the same list, with their bytes, so a test can read them back.
const objects = () => (globalThis.__objects ??= []);
export async function putObject(key, body, contentType) {
  const list = objects().filter((o) => o.key !== key);
  list.push({ key, size: body.length, lastModified: new Date(Date.now()).toISOString(), body: Buffer.from(body), contentType });
  globalThis.__objects = list;
}
export async function deleteObject(key) {
  globalThis.__objects = objects().filter((o) => o.key !== key);
}
export async function renameObject(from, to) {
  const o = objects().find((x) => x.key === from);
  if (!o) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
  globalThis.__objects = [...objects().filter((x) => x.key !== from && x.key !== to), { ...o, key: to }];
}
export async function listAllObjects(prefix = "") {
  return { items: objects().filter((o) => o.key.startsWith(prefix)).map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified })), truncated: false };
}
