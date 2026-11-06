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
// - auto-pipelining and Upstash's default JSON (de)serialisation, so values
//   round-trip as before;
// - `cache: "no-store"` (Upstash's own default; @vercel/kv set "default").
//   Next 14 patches fetch, and in a GET-only route handler that exports no
//   `revalidate` it keeps every fetch in its Data Cache, keyed by the request
//   body. A command is a POST whose body is the command, so a second
//   `hget k f` was answered from that cache instead of Redis — and an
//   identical write (`del k`) never reached Redis at all. The automation
//   dispatcher (/api/cron/automation) read a rule's state from before its
//   run and wrote that back, so Renewal reminders' "last run" stayed blank
//   (2026-11-06). `export const dynamic = "force-dynamic"` does not prevent
//   this. A KV read must always reach the store;
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
    // Never Next's Data Cache: see the header.
    cache: "no-store",
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

let rawClient: Redis | null = null;

/**
 * The same store without Upstash's JSON (de)serialisation: values come back
 * exactly as stored, as strings. For copying keys verbatim (the ops
 * snapshot and restore in src/lib/ops/backup.ts) — a value read through
 * `kv` and written back can change ('"x"' comes back as x).
 */
export const kvRaw: Redis = new Proxy({} as Redis, {
  get(_target, prop) {
    if (!rawClient) {
      const url = process.env.KV_REST_API_URL;
      const token = process.env.KV_REST_API_TOKEN;
      if (!url || !token) throw new Error("kv: Missing required environment variables KV_REST_API_URL and KV_REST_API_TOKEN");
      rawClient = new Redis({ cache: "no-store", enableAutoPipelining: true, automaticDeserialization: false, url, token });
    }
    return Reflect.get(rawClient, prop);
  },
});
