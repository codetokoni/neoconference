// In-memory Redis for apiAuth and ncService (which have no fallback of their own).
// A test that sets KV_REST_API_URL/TOKEN after installing the stubs sends
// every store through here instead of its in-memory fallback.
const store = (globalThis.__kvStore ??= new Map());
const sets = () => new Set();
// Upstash JSON-parses what it reads back (a string that is valid JSON comes
// back as the value), so a stored '"name"' reads as 'name' and '007' as 7.
const de = (v) => {
  if (typeof v !== "string") return structuredClone(v);
  try { return JSON.parse(v); } catch { return v; }
};
const globRe = (pattern) => {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + escaped.join(".*") + "$");
};
export const kv = {
  async get(k) { return store.has(k) ? de(store.get(k)) : null; },
  async set(k, v, opts) {
    if (opts?.nx && store.has(k)) return null;
    // Upstash sends a non-string as JSON, so it is stored as a string value.
    store.set(k, typeof v === "string" ? v : JSON.stringify(v));
    return "OK";
  },
  async del(...ks) { let n = 0; for (const k of ks) if (store.delete(k)) n++; return n; },
  async sadd(k, ...m) { const s = store.get(k) ?? sets(); m.forEach((x) => s.add(x)); store.set(k, s); return m.length; },
  async srem(k, ...m) { const s = store.get(k) ?? sets(); m.forEach((x) => s.delete(x)); store.set(k, s); return m.length; },
  async smembers(k) { return [...(store.get(k) ?? [])].map(de); },
  async sismember(k, m) { return (store.get(k) ?? sets()).has(m) ? 1 : 0; },
  async incr(k) { const n = Number(store.get(k) ?? 0) + 1; store.set(k, n); return n; },
  async expire() { return 1; },
  async hget(k, f) { const v = (store.get(k) ?? {})[f]; return v == null ? null : de(v); },
  async hset(k, o) { store.set(k, { ...(store.get(k) ?? {}), ...o }); return 1; },
  async hgetall(k) { const o = store.get(k); return o && Object.keys(o).length ? Object.fromEntries(Object.entries(o).map(([f, v]) => [f, de(v)])) : null; },
  async hlen(k) { return Object.keys(store.get(k) ?? {}).length; },
  async hincrby(k, f, by) { const o = { ...(store.get(k) ?? {}) }; o[f] = Number(o[f] ?? 0) + by; store.set(k, o); return o[f]; },
  async hdel(k, ...fields) {
    const o = { ...(store.get(k) ?? {}) };
    let n = 0;
    for (const f of fields) if (f in o) { delete o[f]; n++; }
    store.set(k, o);
    return n;
  },
  async lpush(k, ...vals) { const l = store.get(k) ?? []; for (const v of vals) l.unshift(structuredClone(v)); store.set(k, l); return l.length; },
  async lrange(k, start, end) { const l = store.get(k) ?? []; return l.slice(start, end === -1 ? undefined : end + 1).map(de); },
  async ltrim(k, start, end) { const l = store.get(k) ?? []; store.set(k, l.slice(start, end === -1 ? undefined : end + 1)); return "OK"; },
  // Sorted sets: a Map member -> score. zrange covers the byScore + rev form userMeetings uses.
  async zadd(k, ...entries) { const z = store.get(k) ?? new Map(); for (const e of entries) z.set(e.member, e.score); store.set(k, z); return entries.length; },
  async zscore(k, m) { const z = store.get(k); return z?.has(m) ? z.get(m) : null; },
  async zrange(k, hi, lo, opts = {}) {
    const z = store.get(k) ?? new Map();
    if (!opts.byScore) {
      // By rank (lowest score first), as Redis ZRANGE without BYSCORE.
      const all = [...z.entries()].sort((a, b) => a[1] - b[1]);
      const n = all.length;
      const from = hi < 0 ? n + hi : hi;
      const to = lo < 0 ? n + lo : lo;
      const rows = all.slice(from, to + 1);
      return opts.withScores ? rows.flatMap(([m, s]) => [m, s]) : rows.map(([m]) => m);
    }
    const bound = (b) => (b === "-inf" ? -Infinity : b === "+inf" ? Infinity : String(b).startsWith("(") ? Number(String(b).slice(1)) : Number(b));
    const top = bound(hi);
    const topOpen = String(hi).startsWith("(");
    const bottom = bound(lo);
    let rows = [...z.entries()].filter(([, s]) => (topOpen ? s < top : s <= top) && s >= bottom).sort((a, b) => b[1] - a[1]);
    rows = rows.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.count ?? rows.length));
    return opts.withScores ? rows.flatMap(([m, s]) => [m, s]) : rows.map(([m]) => m);
  },
  async zrem(k, ...m) { const z = store.get(k) ?? new Map(); let n = 0; for (const x of m) if (z.delete(x)) n++; store.set(k, z); return n; },
  async rpush(k, ...vals) { const l = store.get(k) ?? []; for (const v of vals) l.push(structuredClone(v)); store.set(k, l); return l.length; },
  async llen(k) { return (store.get(k) ?? []).length; },
  async lindex(k, i) { const l = store.get(k) ?? []; const v = l[i < 0 ? l.length + i : i]; return v === undefined ? null : de(v); },
  async lset(k, i, v) { const l = store.get(k) ?? []; l[i] = structuredClone(v); store.set(k, l); return "OK"; },
  async exists(...ks) { return ks.filter((k) => store.has(k)).length; },
  // No expiry in the stub: a key with a TTL reads as -1 (none), as a plain key.
  async pttl(k) { return store.has(k) ? -1 : -2; },
  async pexpire() { return 1; },
  async type(k) {
    if (!store.has(k)) return "none";
    const v = store.get(k);
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "zset";
    if (Array.isArray(v)) return "list";
    if (v && typeof v === "object") return "hash";
    return "string";
  },
  // Glob with * only, which is all the app asks for.
  async keys(pattern) { const re = globRe(pattern); return [...store.keys()].filter((k) => re.test(k)); },
  // One pass: every match and cursor "0" (done).
  async scan(_cursor, opts = {}) { const re = globRe(opts.match ?? "*"); return ["0", [...store.keys()].filter((k) => re.test(k))]; },
};
