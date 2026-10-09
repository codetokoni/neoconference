// In-memory Redis for apiAuth and ncService (which have no fallback of their own).
const store = (globalThis.__kvStore ??= new Map());
const sets = () => new Set();
// Which keys are hashes / sorted sets (a hash and a JSON value are both plain
// objects here), and when keys expire — for TYPE, SCAN, PTTL and SET NX PX.
const hashes = (globalThis.__kvHashes ??= new Set());
const zsets = (globalThis.__kvZsets ??= new Set());
const expires = (globalThis.__kvExpires ??= new Map());
// TTLs are kept only when a test asks (globalThis.__kvTtl = true); the older
// tests were written against a store where nothing expires.
const ttlOn = () => globalThis.__kvTtl === true;
function alive(k) {
  const at = expires.get(k);
  if (at != null && Date.now() >= at) {
    store.delete(k);
    expires.delete(k);
    hashes.delete(k);
    zsets.delete(k);
  }
  return store.has(k);
}
function glob(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
    else if (c === "*") re += ".*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
export const kv = {
  async get(k) { return alive(k) ? structuredClone(store.get(k)) : null; },
  async set(k, v, opts = {}) {
    if (opts?.nx && alive(k)) return null;
    store.set(k, structuredClone(v));
    hashes.delete(k);
    zsets.delete(k);
    expires.delete(k);
    if (ttlOn() && opts?.px) expires.set(k, Date.now() + opts.px);
    else if (ttlOn() && opts?.ex) expires.set(k, Date.now() + opts.ex * 1000);
    return "OK";
  },
  async del(k) { hashes.delete(k); zsets.delete(k); expires.delete(k); return store.delete(k) ? 1 : 0; },
  async sadd(k, ...m) { const s = store.get(k) ?? sets(); m.forEach((x) => s.add(x)); store.set(k, s); return m.length; },
  async srem(k, ...m) { const s = store.get(k) ?? sets(); m.forEach((x) => s.delete(x)); store.set(k, s); return m.length; },
  async smembers(k) { return [...(store.get(k) ?? [])]; },
  async sismember(k, m) { return (store.get(k) ?? sets()).has(m) ? 1 : 0; },
  async incr(k) { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
  async expire(k, s) { if (ttlOn() && store.has(k)) expires.set(k, Date.now() + s * 1000); return 1; },
  async pexpire(k, ms) { if (ttlOn() && store.has(k)) expires.set(k, Date.now() + ms); return 1; },
  async pttl(k) { if (!alive(k)) return -2; const at = expires.get(k); return at == null ? -1 : at - Date.now(); },
  async hget(k, f) { return (store.get(k) ?? {})[f] ?? null; },
  async hset(k, o) { store.set(k, { ...(store.get(k) ?? {}), ...o }); hashes.add(k); return 1; },
  async hincrby(k, f, by) { const o = { ...(store.get(k) ?? {}) }; o[f] = Number(o[f] ?? 0) + by; store.set(k, o); hashes.add(k); return o[f]; },
  async hgetall(k) { const o = store.get(k); return o && Object.keys(o).length ? structuredClone(o) : null; },
  async hdel(k, ...fields) {
    const o = { ...(store.get(k) ?? {}) };
    let n = 0;
    for (const f of fields) if (f in o) { delete o[f]; n++; }
    store.set(k, o);
    return n;
  },
  async lpush(k, ...vals) { const l = store.get(k) ?? []; for (const v of vals) l.unshift(structuredClone(v)); store.set(k, l); return l.length; },
  async rpush(k, ...vals) { const l = store.get(k) ?? []; for (const v of vals) l.push(structuredClone(v)); store.set(k, l); return l.length; },
  async lrange(k, start, end) { const l = store.get(k) ?? []; return structuredClone(l.slice(start, end === -1 ? undefined : end + 1)); },
  async ltrim(k, start, end) { const l = store.get(k) ?? []; store.set(k, l.slice(start, end === -1 ? undefined : end + 1)); return "OK"; },
  // Sorted sets as [member, score] pairs kept in score order.
  async zadd(k, ...members) {
    const z = new Map((store.get(k) ?? []).map(([m, s]) => [m, s]));
    for (const { score, member } of members) z.set(member, score);
    store.set(k, [...z.entries()].sort((a, b) => a[1] - b[1]));
    zsets.add(k);
    return members.length;
  },
  async zrange(k, start, end, opts = {}) {
    const z = (store.get(k) ?? []).slice(start, end === -1 ? undefined : end + 1);
    return opts.withScores ? z.flat() : z.map(([m]) => m);
  },
  // Glob with * only, which is all the app asks for.
  async keys(pattern) {
    const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp("^" + escaped.join(".*") + "$");
    return [...store.keys()].filter((k) => re.test(k));
  },
  // SCAN in pages of `count`; the cursor is an offset into the key list.
  async scan(cursor, { match = "*", count = 10 } = {}) {
    const re = glob(match);
    const all = [...store.keys()].filter((k) => alive(k));
    const from = Number(cursor) || 0;
    const page = all.slice(from, from + count).filter((k) => re.test(k));
    const next = from + count >= all.length ? "0" : String(from + count);
    return [next, page];
  },
  async type(k) {
    if (!alive(k)) return "none";
    const v = store.get(k);
    if (zsets.has(k)) return "zset";
    if (v instanceof Set) return "set";
    if (Array.isArray(v)) return "list";
    if (hashes.has(k)) return "hash";
    return "string";
  },
  async dbsize() { return [...store.keys()].filter((k) => alive(k)).length; },
};
// Values here are already stored as they were written, so the raw client is the same store.
export const kvRaw = kv;
