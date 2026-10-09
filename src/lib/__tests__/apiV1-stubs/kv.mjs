// In-memory Redis for apiAuth and ncService (which have no fallback of their own).
const store = (globalThis.__kvStore ??= new Map());
const sets = () => new Set();
const base = {
  async get(k) { return store.has(k) ? structuredClone(store.get(k)) : null; },
  async set(k, v, opts) {
    if (opts?.nx && store.has(k)) return null;
    store.set(k, structuredClone(v));
    return "OK";
  },
  async del(k) { return store.delete(k) ? 1 : 0; },
  // As Redis: how many members were new.
  async sadd(k, ...m) { const s = store.get(k) ?? sets(); const before = s.size; m.forEach((x) => s.add(x)); store.set(k, s); return s.size - before; },
  async srem(k, ...m) { const s = store.get(k) ?? sets(); m.forEach((x) => s.delete(x)); store.set(k, s); return m.length; },
  async smembers(k) { return [...(store.get(k) ?? [])]; },
  async sismember(k, m) { return (store.get(k) ?? sets()).has(m) ? 1 : 0; },
  async incr(k) { const n = (store.get(k) ?? 0) + 1; store.set(k, n); return n; },
  async hincrby(k, f, by) { const o = { ...(store.get(k) ?? {}) }; o[f] = Number(o[f] ?? 0) + by; store.set(k, o); return o[f]; },
  async scard(k) { return (store.get(k) ?? sets()).size; },
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
  // Glob with * only, which is all the app asks for.
  async keys(pattern) {
    const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp("^" + escaped.join(".*") + "$");
    return [...store.keys()].filter((k) => re.test(k));
  },
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
