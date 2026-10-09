// In-memory Redis for apiAuth and ncService (which have no fallback of their own).
// A test that sets KV_REST_API_URL/TOKEN after installing the stubs sends
// every store through here instead of its in-memory fallback.
const store = (globalThis.__kvStore ??= new Map());
const sets = () => new Set();
// Which keys are hashes (a hash and a JSON value are both plain objects
// here) and when keys expire — for TYPE, PTTL and SET NX PX (the ops job
// lock and snapshots, src/lib/ops).
const hashes = (globalThis.__kvHashes ??= new Set());
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
  }
  return store.has(k);
}
// Upstash JSON-parses what it reads back (a string that is valid JSON comes
// back as the value), so a stored '"name"' reads as 'name' and '007' as 7.
const de = (v) => {
  if (typeof v !== "string") return structuredClone(v);
  try { return JSON.parse(v); } catch { return v; }
};
// Redis glob: * matches anything; a backslash escapes the next character.
const globRe = (pattern) => {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.+?^${}()|[\]\\*]/g, "\\$&");
    else if (c === "*") re += ".*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
};
const base = {
  async get(k) { return alive(k) ? de(store.get(k)) : null; },
  async set(k, v, opts) {
    if (opts?.nx && alive(k)) return null;
    store.set(k, structuredClone(v));
    hashes.delete(k);
    expires.delete(k);
    if (ttlOn() && opts?.px) expires.set(k, Date.now() + opts.px);
    else if (ttlOn() && opts?.ex) expires.set(k, Date.now() + opts.ex * 1000);
    return "OK";
  },
  async del(...ks) { let n = 0; for (const k of ks) { hashes.delete(k); expires.delete(k); if (store.delete(k)) n++; } return n; },
  // As Redis: how many members were new.
  async sadd(k, ...m) { const s = store.get(k) ?? sets(); const before = s.size; m.forEach((x) => s.add(x)); store.set(k, s); return s.size - before; },
  // As Redis: how many were actually there to remove.
  async srem(k, ...m) { const s = store.get(k) ?? sets(); let n = 0; m.forEach((x) => { if (s.delete(x)) n++; }); store.set(k, s); return n; },
  async smembers(k) { return [...(store.get(k) ?? [])].map(de); },
  async sismember(k, m) { return (store.get(k) ?? sets()).has(m) ? 1 : 0; },
  async incr(k) { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
  async scard(k) { return (store.get(k) ?? sets()).size; },
  async expire(k, s) { if (ttlOn() && store.has(k)) expires.set(k, Date.now() + s * 1000); return 1; },
  async pexpire(k, ms) { if (ttlOn() && store.has(k)) expires.set(k, Date.now() + ms); return 1; },
  async pttl(k) { if (!alive(k)) return -2; const at = expires.get(k); return at == null ? -1 : at - Date.now(); },
  async hget(k, f) { const v = (store.get(k) ?? {})[f]; return v == null ? null : de(v); },
  async hset(k, o) { store.set(k, { ...(store.get(k) ?? {}), ...o }); hashes.add(k); return 1; },
  async hsetnx(k, f, v) { const o = store.get(k) ?? {}; if (f in o) return 0; store.set(k, { ...o, [f]: structuredClone(v) }); return 1; },
  async hgetall(k) { const o = store.get(k); return o && Object.keys(o).length ? Object.fromEntries(Object.entries(o).map(([f, v]) => [f, de(v)])) : null; },
  async hlen(k) { return Object.keys(store.get(k) ?? {}).length; },
  async hincrby(k, f, by) { const o = { ...(store.get(k) ?? {}) }; o[f] = Number(o[f] ?? 0) + by; store.set(k, o); hashes.add(k); return o[f]; },
  async hdel(k, ...fields) {
    const o = { ...(store.get(k) ?? {}) };
    let n = 0;
    for (const f of fields) if (f in o) { delete o[f]; n++; }
    store.set(k, o);
    return n;
  },
  async rpush(k, ...vals) { const l = store.get(k) ?? []; for (const v of vals) l.push(structuredClone(v)); store.set(k, l); return l.length; },
  async lpush(k, ...vals) { const l = store.get(k) ?? []; for (const v of vals) l.unshift(structuredClone(v)); store.set(k, l); return l.length; },
  async lrange(k, start, end) { const l = store.get(k) ?? []; return l.slice(start, end === -1 ? undefined : end + 1).map(de); },
  // As Redis with count 0: remove every element equal to value.
  async lrem(k, _count, value) { const l = store.get(k) ?? []; const keep = l.filter((x) => JSON.stringify(x) !== JSON.stringify(value)); store.set(k, keep); return l.length - keep.length; },
  async ltrim(k, start, end) { const l = store.get(k) ?? []; store.set(k, l.slice(start, end === -1 ? undefined : end + 1)); return "OK"; },
  // Sorted sets: a Map member -> score. zrange follows Upstash's byScore
  // form: (min, max) ascending, or with rev (max, min) descending; bounds may
  // be "-inf", "+inf" or "(n" (exclusive). Used by userMeetings, scheduler and
  // the subscription indexes (src/lib/billing/subscriptions.ts).
  async zadd(k, ...entries) { const z = store.get(k) ?? new Map(); for (const e of entries) z.set(String(e.member), Number(e.score)); store.set(k, z); return entries.length; },
  async zrem(k, ...members) { const z = store.get(k) ?? new Map(); let n = 0; for (const m of members) if (z.delete(String(m))) n++; store.set(k, z); return n; },
  async zscore(k, m) { const z = store.get(k); return z?.has(String(m)) ? z.get(String(m)) : null; },
  async zcard(k) { return (store.get(k) ?? new Map()).size; },
  async zrange(k, a, b, opts = {}) {
    const z = store.get(k) ?? new Map();
    const bound = (x) => (x === "-inf" ? -Infinity : x === "+inf" ? Infinity : String(x).startsWith("(") ? Number(String(x).slice(1)) : Number(x));
    const open = (x) => String(x).startsWith("(");
    let rows = [...z.entries()].sort((x, y) => x[1] - y[1]);
    if (opts.byScore) {
      const [lo, hi] = opts.rev ? [b, a] : [a, b];
      rows = rows.filter(([, s]) => (open(lo) ? s > bound(lo) : s >= bound(lo)) && (open(hi) ? s < bound(hi) : s <= bound(hi)));
      if (opts.rev) rows.reverse();
    } else {
      if (opts.rev) rows.reverse();
      rows = rows.slice(a, b === -1 ? undefined : b + 1);
    }
    rows = rows.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.count ?? rows.length));
    return opts.withScores ? rows.flatMap(([m, s]) => [m, s]) : rows.map(([m]) => m);
  },
  async keys(pattern) { const re = globRe(pattern); return [...store.keys()].filter((k) => alive(k) && re.test(k)); },
  // One pass: every match and cursor "0" (done).
  async scan(_cursor, opts = {}) { const re = globRe(opts.match ?? "*"); return ["0", [...store.keys()].filter((k) => alive(k) && re.test(k))]; },
  async type(k) {
    if (!alive(k)) return "none";
    const v = store.get(k);
    if (v instanceof Map) return "zset";
    if (v instanceof Set) return "set";
    if (Array.isArray(v)) return "list";
    if (hashes.has(k)) return "hash";
    return "string";
  },
  async dbsize() { return [...store.keys()].filter((k) => alive(k)).length; },
};

// globalThis.__kvFault = (method, args) => "fail" | "hang" | undefined lets a
// test make KV refuse or never answer, to prove a caller survives it.
export const kv = new Proxy(base, {
  get(target, prop) {
    const fn = target[prop];
    if (typeof fn !== "function") return fn;
    return (...args) => {
      const fault = globalThis.__kvFault?.(prop, args);
      if (fault === "fail") return Promise.reject(new Error("kv: unavailable (test)"));
      if (fault === "hang") return new Promise(() => {});
      return fn.apply(target, args);
    };
  },
});

// src/lib/kv.ts kvRaw: the same store without JSON parsing on the way out.
const raw = (v) => structuredClone(v);
export const kvRaw = {
  ...base,
  async get(k) { return alive(k) ? raw(store.get(k)) : null; },
  async hget(k, f) { const v = (store.get(k) ?? {})[f]; return v == null ? null : raw(v); },
  async hgetall(k) { const o = store.get(k); return o && Object.keys(o).length ? raw(o) : null; },
  async lrange(k, start, end) { const l = store.get(k) ?? []; return raw(l.slice(start, end === -1 ? undefined : end + 1)); },
  async smembers(k) { return raw([...(store.get(k) ?? [])]); },
};
