// src/lib/__tests__/kvNoStore.smoke.ts
//
// Every KV command must reach Redis: the client's fetches carry
// `cache: "no-store"`, so Next's Data Cache never answers them.
//
// With `cache: "default"`, a GET-only route handler (the automation
// dispatcher, the other crons) kept each command's response in Next's Data
// Cache, keyed by the command. A repeated `hget` came back from before the
// last write, and the dispatcher wrote that old state back: Renewal
// reminders' "last run" stayed blank in production (2026-11-06). Run against
// `next dev` with a stand-in Upstash, the second dispatcher tick sent no
// read of the rule state to the store at all; with "no-store" it sent six.

import assert from "node:assert/strict";

process.env.KV_REST_API_URL = "https://kv.example.com";
process.env.KV_REST_API_TOKEN = "test";

const seen: { url: string; cache: RequestCache | undefined; body: string }[] = [];
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = String(init?.body ?? "");
  seen.push({ url: String(url), cache: init?.cache, body });
  const parsed = JSON.parse(body || "[]");
  // A pipeline gets one answer per command; a single command gets one answer.
  const answer = Array.isArray(parsed[0]) ? parsed.map(() => ({ result: null })) : { result: null };
  return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { kv, kvRaw } = await import("../kv");

  await t("kv: reads and writes are sent with cache: no-store", async () => {
    seen.length = 0;
    await kv.hget("neo:auto:state", "builtin_renewal");
    await kv.hset("neo:auto:state", { builtin_renewal: "{}" });
    await kv.del("neo:ops:job:lock:x");
    assert.equal(seen.length, 3, "one request per awaited command");
    for (const s of seen) assert.equal(s.cache, "no-store", `${s.body} was sent with cache: ${s.cache}`);
  });

  await t("kv: the same read twice reaches the store twice", async () => {
    seen.length = 0;
    await kv.get("neo:auto:seeded");
    await kv.get("neo:auto:seeded");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].body, seen[1].body, "an identical command: exactly what a body-keyed cache would answer");
    for (const s of seen) assert.equal(s.cache, "no-store");
  });

  await t("kvRaw: no-store too", async () => {
    seen.length = 0;
    await kvRaw.smembers("neo:partners:all");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cache, "no-store");
  });

  console.log(`kvNoStore: ${n} passed`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
