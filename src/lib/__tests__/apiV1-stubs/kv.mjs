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
  async hgetall(k) { return store.get(k) ?? null; },
};

