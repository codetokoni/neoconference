// In-memory Redis for apiAuth and ncService (which have no fallback of their own).
const store = (globalThis.__kvStore ??= new Map());
const sets = () => new Set();
export const kv = {
  async get(k) { return store.has(k) ? structuredClone(store.get(k)) : null; },
  async set(k, v) { store.set(k, structuredClone(v)); return "OK"; },
  async del(k) { return store.delete(k) ? 1 : 0; },
  async sadd(k, ...m) { const s = store.get(k) ?? sets(); m.forEach((x) => s.add(x)); store.set(k, s); return m.length; },
  async srem(k, ...m) { const s = store.get(k) ?? sets(); m.forEach((x) => s.delete(x)); store.set(k, s); return m.length; },
  async smembers(k) { return [...(store.get(k) ?? [])]; },
  async sismember(k, m) { return (store.get(k) ?? sets()).has(m) ? 1 : 0; },
  async incr(k) { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
  async expire() { return 1; },
  async hget(k, f) { return (store.get(k) ?? {})[f] ?? null; },
  async hset(k, o) { store.set(k, { ...(store.get(k) ?? {}), ...o }); return 1; },
  async hgetall(k) { const o = store.get(k); return o && Object.keys(o).length ? structuredClone(o) : null; },
  async hdel(k, ...fields) {
    const o = { ...(store.get(k) ?? {}) };
    let n = 0;
    for (const f of fields) if (f in o) { delete o[f]; n++; }
    store.set(k, o);
    return n;
  },
  async lpush(k, ...vals) { const l = store.get(k) ?? []; for (const v of vals) l.unshift(structuredClone(v)); store.set(k, l); return l.length; },
  async lrange(k, start, end) { const l = store.get(k) ?? []; return structuredClone(l.slice(start, end === -1 ? undefined : end + 1)); },
  async ltrim(k, start, end) { const l = store.get(k) ?? []; store.set(k, l.slice(start, end === -1 ? undefined : end + 1)); return "OK"; },
  // Sorted sets, as a Map member -> score. zrange covers { byScore, offset, count }.
  async zadd(k, ...entries) {
    const z = store.get(k) ?? new Map();
    for (const e of entries) z.set(String(e.member), Number(e.score));
    store.set(k, z);
    return entries.length;
  },
  async zrem(k, ...members) { const z = store.get(k) ?? new Map(); let n = 0; for (const m of members) if (z.delete(String(m))) n++; store.set(k, z); return n; },
  async zscore(k, m) { const z = store.get(k); return z?.has(String(m)) ? z.get(String(m)) : null; },
  async zcard(k) { return (store.get(k) ?? new Map()).size; },
  async zrange(k, min, max, opts = {}) {
    const all = [...(store.get(k) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]);
    const picked = opts.byScore ? all.filter(([, s]) => s >= Number(min) && s <= Number(max)) : all.slice(min, max === -1 ? undefined : max + 1);
    const from = opts.offset ?? 0;
    return picked.slice(from, opts.count != null ? from + opts.count : undefined).map(([m]) => m);
  },
  // Glob with * only, which is all the app asks for.
  async keys(pattern) {
    const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp("^" + escaped.join(".*") + "$");
    return [...store.keys()].filter((k) => re.test(k));
  },
};
