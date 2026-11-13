// src/lib/__tests__/appVersionCounts.smoke.ts
//
// People per Android app version, counted where every join starts
// (/api/livekit/token) and read by Analytics → App versions. Before this,
// a week's 30,124 joins said which app version made them only 41 times.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
});
delete process.env.LIVEKIT_URL;
delete process.env.ADMIN_EMAILS;

type Stubbed = typeof globalThis & { __users: Record<string, { emails?: string[] }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = { user_host: { emails: ["host@example.com"] } };
for (const u of ["a", "b", "c", "d", "e"]) g.__users[`user_${u}`] = { emails: [`${u}@example.com`] };

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  // Through the KV stub, as in production.
  process.env.KV_REST_API_URL = "https://kv.example.com";
  process.env.KV_REST_API_TOKEN = "test";
  const { NextRequest } = await import("next/server");
  const { eventStore } = await import("../eventStore");
  const counts = await import("../appVersionCounts");
  const { buildAnalytics } = await import("../admin/analytics");
  const { periodFromQuery } = await import("../activityReports");
  const token = await import("../../app/api/livekit/token/route");

  const now = Date.now();
  const slug = "versions-check";
  await eventStore.create({
    id: "ev_versions",
    slug,
    name: slug,
    ownerUserId: "user_host",
    ownerEmail: "host@example.com",
    visibility: "public",
    state: "live",
    startedAt: new Date(now - 60_000).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    livekitRoom: slug,
    qrSeed: "x",
    roles: [],
    waitingRoomEnabled: false,
    waitForHost: false,
  } as unknown as Parameters<typeof eventStore.create>[0]);

  /** A join as the app (Bearer, with its client string) or the website (neither). */
  async function join(who: string, client?: string) {
    g.__who = who;
    const q = new URLSearchParams({ room: slug, event: slug, nonce: "n" });
    if (client !== undefined) q.set("client", client);
    const headers: Record<string, string> = client !== undefined ? { authorization: "Bearer app-session-jwt" } : {};
    return (await token.GET(new NextRequest(`https://www.neoconference.app/api/livekit/token?${q}`, { headers }))).status;
  }
  const today = counts.utcDayOf(Date.now());

  await t("joins are counted per app version, each person once a day; the website is not counted", async () => {
    assert.equal(await join("user_a", "android 1.2.10+5224 OPPO CPH2599 / Android 16"), 200);
    assert.equal(await join("user_a", "android 1.2.10+5224 OPPO CPH2599 / Android 16"), 200, "a rejoin");
    assert.equal(await join("user_b", "android 1.2.10+5224 Tecno X / Android 14"), 200);
    await join("user_c", "android 1.2.9+5223 Samsung A15 / Android 14");
    await join("user_d"); // the website
    assert.deepEqual(await counts.appVersionsOver([today]), [
      { version: "1.2.10", people: 2 },
      { version: "1.2.9", people: 1 },
    ]);
  });

  await t("an app refused as too old is counted too: it is what the minimum decides", async () => {
    assert.equal(await join("user_e", "android 1.2.3+5216 OPPO CPH2599 / Android 16"), 426);
    const v = await counts.appVersionsOver([today]);
    assert.deepEqual(v.at(-1), { version: "1.2.3", people: 1 });
  });

  await t("over several days, a person is one person", async () => {
    const tomorrow = Date.now() + 86_400_000;
    await counts.recordAppJoin("android 1.2.10+5224 OPPO", "user_a", tomorrow);
    await counts.recordAppJoin("android 1.2.10+5224 OPPO", "user_new", tomorrow);
    const days = [today, counts.utcDayOf(tomorrow)];
    assert.equal((await counts.appVersionsOver(days))[0].people, 3, "user_a, user_b, user_new");
  });

  await t("Analytics carries the counts for its period, newest version first", async () => {
    const report = await buildAnalytics(periodFromQuery(new URLSearchParams(), 7));
    assert.deepEqual(report.appVersions.map((x) => x.version), ["1.2.10", "1.2.9", "1.2.3"]);
    assert.equal(report.appVersions[0].people, 2);
  });

  await t("a failing store never stops a join: counting gives up quietly", async () => {
    const store = (globalThis as unknown as { __kvStore: Map<string, unknown> }).__kvStore;
    const realGet = store.get.bind(store);
    let threw = 0;
    store.get = () => {
      threw++;
      throw new Error("store down");
    };
    try {
      await counts.recordAppJoin("android 1.2.10+5224 OPPO", "user_x");
    } finally {
      store.get = realGet;
    }
    assert.ok(threw > 0, "the store was asked and failed");
  });

  console.log(`appVersionCounts: ${n} passed`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
