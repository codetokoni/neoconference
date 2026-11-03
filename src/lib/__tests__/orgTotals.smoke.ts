// Run: npx tsx src/lib/__tests__/orgTotals.smoke.ts
//
// The organisation report from day totals (src/lib/partners/orgTotals.ts),
// checked against the way it used to be built: buildReport over every zone,
// then again for each zone on its own. Same figures for every kind of
// period, with days worked out live and with days stored; sessions across
// midnight, a person in two zones at once, two devices, someone still
// connected and an empty zone. Then: it costs a handful of store requests
// for hundreds of zones, the nightly job stores finished days once, and the
// report's tag moves when attendance does.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "t",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  CLERK_SECRET_KEY: "sk_test_org_totals",
  PARTNER_EMBED_SECRET: "partner-embed-secret-for-tests-0123456789",
  CRON_SECRET: "cron_SECRET_VALUE",
});
delete process.env.ADMIN_EMAILS;

type G = typeof globalThis & { __users: Record<string, { plan?: string; emails?: string[] }>; __kvTtl?: boolean; __kvRoundTrips?: number; __kvStore: Map<string, unknown> };
const g = globalThis as G;
g.__users = { user_owner: { plan: "pro", emails: ["owner@example.com"] } };

let clock = Date.parse("2026-10-19T08:00:00Z");
const RealDate = Date;
class TestDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [number]));
  }
  static now() {
    return clock;
  }
}
globalThis.Date = TestDate as DateConstructor;
const iso = (s: string) => RealDate.parse(s);

let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("exited before the last check — something never answered");
    process.exitCode = 1;
  }
});

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

const MIN = 60_000;
const TZ = "Africa/Lagos";

async function main() {
  const { NextRequest } = await import("next/server");
  const S = await import("../partners/store");
  const A = await import("../partners/attendance");
  const Rp = await import("../partners/reports");
  const O = await import("../partners/orgTotals");
  const { participantIdentity } = await import("../partners/join");
  const orgRoute = await import("../../app/api/partner/v1/reports/org/route");
  const cron = await import("../../app/api/cron/partner-totals/route");

  const pc = await S.createIntegration({ name: "PrayerClouds", ownerUserId: "user_owner", origins: ["https://herald.prayerclouds.org"] });
  await S.updateIntegration(pc.id, { timezone: TZ });
  const key = (await S.mintPartnerKey(pc.id)).raw;
  await S.setOrgAdmins(pc.id, ["admin1"]);
  const integ = async () => (await S.getIntegration(pc.id))!;
  const zone = async (z: string) => (await S.resolveZone(await integ(), z)).mapping;
  const falf = await zone("FALF");
  const lagos = await zone("LAGOS-1");
  await zone("QUIET"); // never used
  const room = (m: typeof falf) => ({ integrationId: pc.id, zoneId: m.zoneId, eventId: m.eventId, room: m.slug });
  const id = (u: string) => participantIdentity({ integrationId: pc.id, externalUserId: `user:${u}` });
  const who = (m: typeof falf, u: string) => ({ integrationId: pc.id, zoneId: m.zoneId, ext: `user:${u}`, name: u, verified: true });
  let sidN = 0;
  /** u connected in zone m over [from, to); to null: still connected. */
  async function attend(m: typeof falf, u: string, from: number, to: number | null) {
    const sid = `PA_${++sidN}`;
    const was = clock;
    clock = from;
    await A.connectionOpened(room(m), id(u), sid, from, who(m, u), from);
    if (to != null) await A.connectionClosed(id(u), sid, to);
    clock = was;
  }
  async function close(m: typeof falf, at: number) {
    const was = clock;
    clock = at;
    await A.roomClosed(room(m));
    clock = was;
  }

  // Monday 19 Oct (Lagos is UTC+1).
  const mon = iso("2026-10-19T06:00:00Z");
  for (let i = 1; i <= 6; i++) await attend(falf, `u${i}`, mon, mon + 30 * MIN);
  await attend(falf, "u1", mon + 5 * MIN, mon + 20 * MIN); // a second device: once
  await close(falf, mon + 31 * MIN);
  // u1 in LAGOS-1 at the same time as in FALF: once for the organisation.
  await attend(lagos, "u1", mon + 10 * MIN, mon + 40 * MIN);
  await attend(lagos, "l1", mon + 10 * MIN, mon + 40 * MIN);
  await close(lagos, mon + 41 * MIN);
  // Monday night across Lagos midnight: 23:30-01:00 (22:30-00:00 UTC).
  const night = iso("2026-10-19T22:30:00Z");
  await attend(lagos, "n1", night, night + 90 * MIN);
  await attend(falf, "n1", night + 30 * MIN, night + 60 * MIN); // both zones, after midnight
  await close(falf, night + 61 * MIN);
  await close(lagos, night + 91 * MIN);
  // Wednesday: a longer FALF meeting with someone joining late.
  const wed = iso("2026-10-21T17:00:00Z");
  await attend(falf, "u2", wed, wed + 60 * MIN);
  await attend(falf, "u7", wed + 45 * MIN, wed + 50 * MIN);
  await close(falf, wed + 61 * MIN);
  // Thursday (today): finished in the morning, and someone still connected now.
  const thu = iso("2026-10-22T07:00:00Z");
  await attend(lagos, "u3", thu, thu + 20 * MIN);
  await close(lagos, thu + 21 * MIN);
  clock = iso("2026-10-22T12:00:00Z");
  // Joined a minute ago, inside the heartbeat window: connected now.
  await attend(falf, "live1", clock - MIN, null);

  /** The organisation report the way the route built it before day totals. */
  async function reference(period: ReturnType<typeof Rp.resolvePeriod>, now: number) {
    const i = await integ();
    const zones = await S.listZones(pc.id);
    const all = await Rp.buildReport({ integration: i, zones, period, now });
    const perZone = await Promise.all(
      zones.map(async (z) => {
        const r = await Rp.buildReport({ integration: i, zones: [z], period, now });
        return { zone: r.zones[0], summary: r.summary };
      }),
    );
    return { period: all.period, summary: all.summary, zones: perZone, generatedAt: all.generatedAt };
  }
  const periods = (now: number) => [
    Rp.resolvePeriod({ period: "today" }, TZ, now),
    Rp.resolvePeriod({ period: "week" }, TZ, now),
    Rp.resolvePeriod({ period: "month" }, TZ, now),
    Rp.resolvePeriod({ period: "custom", from: "2026-10-19", to: "2026-10-20" }, TZ, now),
    Rp.resolvePeriod({ period: "custom", from: "2026-10-20", to: "2026-10-20" }, TZ, now),
    { ...Rp.resolvePeriod({ period: "current" }, TZ, now), kind: "current" as const },
  ];
  const dayKeys = () => [...g.__kvStore.keys()].filter((k) => k.startsWith(`neo:pz:${pc.id}:day:`)).sort();

  await t("every period, worked out live: exactly the figures the zone-by-zone build gave", async () => {
    const now = clock;
    for (const p of periods(now)) {
      const want = await reference(p, now);
      const got = await O.orgReport(await integ(), await S.listZones(pc.id), p, now);
      assert.deepEqual(got, want, `${p.kind} ${p.label}`);
    }
    const today = await O.orgReport(await integ(), await S.listZones(pc.id), Rp.resolvePeriod({ period: "today" }, TZ, now), now);
    assert.equal(today.summary.connectedNow, 1, "live1 is connected");
    const week = await O.orgReport(await integ(), await S.listZones(pc.id), Rp.resolvePeriod({ period: "week" }, TZ, now), now);
    assert.ok(week.summary.uniqueParticipants >= 10 && week.summary.totalPrayerSeconds > 0);
    assert.deepEqual(week.zones.find((z) => z.zone.zoneId === "QUIET")!.summary, { sessions: 0, uniqueParticipants: 0, connectedNow: 0, totalPrayerSeconds: 0, averagePrayerSeconds: 0 });
  });

  await t("finished days are stored once (six hours after they end), and the figures do not change", async () => {
    const stored = dayKeys();
    // The month's report stored every finished day of October, the empty
    // ones too (so they are never worked out again); not today.
    assert.deepEqual(
      stored.map((k) => k.split(":").pop()),
      Array.from({ length: 21 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`),
    );
    assert.ok(stored.every((k) => k.startsWith(`neo:pz:${pc.id}:day:${TZ}:`)), "keyed by the partner's timezone");
    const now = clock;
    for (const p of periods(now)) assert.deepEqual(await O.orgReport(await integ(), await S.listZones(pc.id), p, now), await reference(p, now), `${p.kind} ${p.label}, from stored days`);
    // A stored day is read, not worked out again.
    const [i, zones] = [await integ(), await S.listZones(pc.id)];
    g.__kvRoundTrips = 0;
    await O.orgReport(i, zones, Rp.resolvePeriod({ period: "custom", from: "2026-10-19", to: "2026-10-21" }, TZ, now), now);
    assert.equal(g.__kvRoundTrips, 1, "three stored days: one request");
  });

  await t("a stored day is what the report adds up: change its record and the report follows", async () => {
    const k = dayKeys().find((x) => x.endsWith(":2026-10-19"))!;
    const before = structuredClone(g.__kvStore.get(k));
    const rec = structuredClone(before) as { org: { p: Record<string, number> } };
    rec.org.p["extra-person"] = 3_600_000;
    g.__kvStore.set(k, rec);
    const p = Rp.resolvePeriod({ period: "custom", from: "2026-10-19", to: "2026-10-19" }, TZ, clock);
    const r = await O.orgReport(await integ(), await S.listZones(pc.id), p, clock);
    assert.equal(r.summary.totalPrayerSeconds, (await reference(p, clock)).summary.totalPrayerSeconds + 3600);
    g.__kvStore.set(k, before);
  });

  await t("hundreds of zones: the report is a few batched requests, not thousands", async () => {
    for (let i = 0; i < 600; i++) await S.resolveZone(await integ(), `Z${String(i).padStart(3, "0")}`);
    const zones = await S.listZones(pc.id);
    assert.equal(zones.length, 603);
    const now = clock;
    for (const kind of ["today", "month"] as const) {
      const p = Rp.resolvePeriod({ period: kind }, TZ, now);
      g.__kvRoundTrips = 0;
      const got = await O.orgReport(await integ(), zones, p, now);
      const used = g.__kvRoundTrips ?? 0;
      g.__kvRoundTrips = 0;
      const want = await reference(p, now);
      const old = g.__kvRoundTrips ?? 0;
      assert.deepEqual(got, want, kind);
      assert.ok(used <= 20, `${kind}: ${used} store requests`);
      assert.ok(old > 1000, `${kind}: the old way made ${old}`);
    }
    g.__kvRoundTrips = 0;
    await S.listZones(pc.id);
    assert.ok((g.__kvRoundTrips ?? 0) <= 3, `listing 603 zones took ${g.__kvRoundTrips} requests`);
  });

  await t("the route answers the same report, and its tag moves when attendance does", async () => {
    const call = async (path: string, etag?: string) => {
      const headers: Record<string, string> = { authorization: `Bearer ${key}`, "x-viewer-id": "admin1" };
      if (etag) headers["if-none-match"] = etag;
      const res = await orgRoute.GET(new NextRequest(`https://neolinguameet.com${path}`, { headers }));
      return { status: res.status, etag: res.headers.get("etag") ?? "", body: res.status === 304 ? null : await res.json() };
    };
    const first = await call("/api/partner/v1/reports/org?period=custom&from=2026-10-19&to=2026-10-21");
    assert.equal(first.status, 200);
    const p = Rp.resolvePeriod({ period: "custom", from: "2026-10-19", to: "2026-10-21" }, TZ, clock);
    assert.deepEqual(first.body, JSON.parse(JSON.stringify(await reference(p, clock))));
    assert.equal((await call("/api/partner/v1/reports/org?period=custom&from=2026-10-19&to=2026-10-21", first.etag)).status, 304, "nothing changed");
    await attend(lagos, "late", clock - 5 * MIN, clock - 2 * MIN);
    assert.equal((await call("/api/partner/v1/reports/org?period=custom&from=2026-10-19&to=2026-10-21", first.etag)).status, 200, "attendance moved the tag");
  });

  await t("the nightly job stores finished days not stored yet, once; a second run stores nothing", async () => {
    const cronCall = async (auth?: string) => {
      const res = await cron.GET(new NextRequest("https://neolinguameet.com/api/cron/partner-totals", { headers: auth ? { authorization: auth } : {} }));
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await cronCall()).status, 401);
    // Two days on: Thursday and Friday are now over.
    clock = iso("2026-10-24T09:00:00Z");
    const before = dayKeys().length;
    const r1 = await cronCall("Bearer cron_SECRET_VALUE");
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.ok(r1.body.done.find((d: { integrationId: string }) => d.integrationId === pc.id).days > 0);
    assert.ok(dayKeys().length > before);
    assert.ok(dayKeys().some((k) => k.endsWith(":2026-10-22")), "Thursday stored");
    const r2 = await cronCall("Bearer cron_SECRET_VALUE");
    assert.equal(r2.body.done.find((d: { integrationId: string }) => d.integrationId === pc.id).days, 0, "nothing left to store");
    for (const p of [Rp.resolvePeriod({ period: "week" }, TZ, clock), Rp.resolvePeriod({ period: "month" }, TZ, clock)]) {
      assert.deepEqual(await O.orgReport(await integ(), await S.listZones(pc.id), p, clock), await reference(p, clock), `${p.kind} after the job`);
    }
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
