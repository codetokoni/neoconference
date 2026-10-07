// src/lib/kv.ts
//
// The app's Redis client, in place of the deprecated @vercel/kv. Vercel KV
// stores became Upstash Redis stores; @vercel/kv 3.0.0 was a thin wrapper
// over @upstash/redis, and this is that wrapper's `kv`, kept identical so
// nothing reads or writes differently:
//
// - the same env vars (KV_REST_API_URL / KV_REST_API_TOKEN), which the
//   Upstash integration still provides;
// - created lazily, on first use. Several stores fall back to in-memory when
//   those vars are absent and decide that at call time; the smoke tests
//   delete them after import. Creating the client at import would throw first;
// - the same options (`cache: "default"`, auto-pipelining) and Upstash's
//   default JSON (de)serialisation, so values round-trip as before;
// - Edge-safe: middleware and sessionStore import it. @upstash/redis picks
//   its runtime build by package export conditions, as it did under @vercel/kv.

import { Redis } from "@upstash/redis";

process.env.UPSTASH_DISABLE_TELEMETRY = "1";

let client: Redis | null = null;

function create(): Redis {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      "kv: Missing required environment variables KV_REST_API_URL and KV_REST_API_TOKEN"
    );
  }
  return new Redis({
    // Next.js recommends no value or `default` for fetch's `cache`;
    // @upstash/redis defaults to `no-store`. As @vercel/kv set it.
    cache: "default",
    enableAutoPipelining: true,
    url,
    token,
  });
}

export const kv: Redis = new Proxy({} as Redis, {
  get(_target, prop) {
    if (!client) client = create();
    return Reflect.get(client, prop);
  },
});
