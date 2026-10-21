// Run: npx tsx src/lib/__tests__/partnerReports.smoke.ts
//
// Partner zone prayer reports (src/lib/partners/reports.ts and the
// /api/partner/v1 report routes): who may read what (decided from the
// lists NeoLinguaMeet keeps, never from the zone a page asked for), and
// that the figures are right — session duration kept apart from
// participant prayer time, simultaneous connections counted once, periods
// clipped at the partner's timezone's midnight, averages per participant.
// Attendance is written straight into the store with known timestamps.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "t",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  CLERK_SECRET_KEY: "sk_test_partner_reports",
  PARTNER_EMBED_SECRET: "partner-embed-secret-for-tests-0123456789",
});
delete process.env.ADMIN_EMAILS;

type G = typeof globalThis & { __users: Record<string, { plan?: string; emails?: string[] }>; __kvTtl?: boolean };
const g = globalThis as G;
g.__users = { user_owner: { plan: "pro", emails: ["owner@example.com"] }, user_other: { plan: "pro", emails: ["other@example.com"] } };
g.__kvTtl = true;

let clock = Date.parse("2026-10-21T12:00:00Z");
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
const PC = "https://herald.prayerclouds.org";
const MIN = 60_000;

async function main() {
  const { NextRequest } = await import("next/server");
  const S = await import("../partners/store");
  const A = await import("../partners/attendance");
  const Rp = await import("../partners/reports");
  const { participantIdentity } = await import("../partners/join");
  const R = {
    me: await import("../../app/api/partner/v1/attendance/me/route"),
    zone: await import("../../app/api/partner/v1/reports/zones/[zone]/route"),
    participants: await import("../../app/api/partner/v1/reports/zones/[zone]/participants/route"),
    session: await import("../../app/api/partner/v1/reports/zones/[zone]/sessions/[sessionId]/route"),
    exportCsv: await import("../../app/api/partner/v1/reports/zones/[zone]/export/route"),
    org: await import("../../app/api/partner/v1/reports/org/route"),
    pub: await import("../../app/api/partner/v1/zones/[zone]/public-stats/route"),
    roles: await import("../../app/api/partner/v1/roles/route"),
    leaders: await import("../../app/api/partner/v1/zones/[zone]/leaders/route"),
  };

  const pc = await S.createIntegration({ name: "PrayerClouds", ownerUserId: "user_owner", origins: [PC] });
  await S.updateIntegration(pc.id, { timezone: "Africa/Lagos" });
  const key = (await S.mintPartnerKey(pc.id)).raw;
  const other = await S.createIntegration({ name: "Other church", ownerUserId: "user_other", origins: ["https://other.example"] });
  const otherKey = (await S.mintPartnerKey(other.id)).raw;

  const falf = (await S.resolveZone((await S.getIntegration(pc.id))!, "FALF")).mapping;
  const lagos = (await S.resolveZone((await S.getIntegration(pc.id))!, "LAGOS-1")).mapping;
  const room = (m: typeof falf) => ({ integrationId: pc.id, zoneId: m.zoneId, eventId: m.eventId, room: m.slug });
  const id = (u: string) => participantIdentity({ integrationId: pc.id, externalUserId: `user:${u}` });
  const who = (u: string, name: string) => ({ integrationId: pc.id, zoneId: "FALF", ext: `user:${u}`, name, verified: true });
  let sidN = 0;
  /** u was connected [from, to) in the zone (to null: still connected). */
  async function attend(m: typeof falf, u: string, name: string, from: number, to: number | null) {
    const sid = `PA_${++sidN}`;
    await A.connectionOpened(room(m), id(u), sid, from, who(u, name), from);
    if (to != null) await A.connectionClosed(id(u), sid, to);
    return sid;
  }

  // Route handlers, each with its own params type.
  type Handler = (req: never, ctx: never) => Promise<Response>;
  const get = async (handler: Handler, path: string, opts: { viewer?: string; key?: string; params?: Record<string, string>; etag?: string } = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? key}` };
    if (opts.viewer) headers["x-viewer-id"] = opts.viewer;
    if (opts.etag) headers["if-none-match"] = opts.etag;
    const res = await handler(new NextRequest(`https://neolinguameet.com${path}`, { headers }) as never, { params: opts.params ?? {} } as never);
    const text = res.status === 304 ? "" : await res.text();
    let body: J = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { text };
    }
    return { status: res.status, body, text, headers: res.headers };
  };
  const put = async (handler: Handler, path: string, body: unknown, params: Record<string, string> = {}) => {
    const res = await handler(new NextRequest(`https://neolinguameet.com${path}`, { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }) as never, { params } as never);
    return { status: res.status, body: (await res.json()) as J };
  };

  // Morning prayer in FALF, 07:00-07:30 Lagos (06:00-06:30 UTC): ten people, thirty minutes each.
  const m0 = iso("2026-10-21T06:00:00Z");
  for (let i = 1; i <= 10; i++) await attend(falf, `u${i}`, `Member ${i}`, m0, m0 + 30 * MIN);
  // u1 also had a second device on for part of it: counted once.
  await attend(falf, "u1", "Member 1", m0 + 5 * MIN, m0 + 20 * MIN);
  clock = m0 + 31 * MIN;
  await A.roomClosed(room(falf));
  // A name a spreadsheet would run as a formula.
  clock = iso("2026-10-21T09:00:00Z");
  await attend(falf, "u11", "=HYPERLINK(\"x\")", clock, clock + 10 * MIN);
  clock += 11 * MIN;
  await A.roomClosed(room(falf));
  // LAGOS-1 has its own people.
  clock = iso("2026-10-21T10:00:00Z");
  await attend(lagos, "u1", "Member 1", clock, clock + 15 * MIN);
  await attend(lagos, "l1", "Lagos One", clock, clock + 15 * MIN);
  clock = iso("2026-10-21T12:00:00Z");

  await t("who may read: their own only; leaders their zones; administrators everything; another partner nothing", async () => {
    await put(R.roles.PUT, "/api/partner/v1/roles", { orgAdmins: ["admin1"] });
    await put(R.leaders.PUT, "/api/partner/v1/zones/FALF/leaders", { leaders: ["u1"] }, { zone: "FALF" });
    const zonePath = "/api/partner/v1/reports/zones/FALF?period=today";
    assert.equal((await get(R.zone.GET, zonePath, { params: { zone: "FALF" } })).body.error.code, "viewer_required");
    assert.equal((await get(R.zone.GET, zonePath, { viewer: "u2", params: { zone: "FALF" } })).status, 403);
    assert.equal((await get(R.zone.GET, zonePath, { viewer: "u1", params: { zone: "FALF" } })).status, 200);
    assert.equal((await get(R.zone.GET, zonePath, { viewer: "admin1", params: { zone: "FALF" } })).status, 200);
    // Leading FALF says nothing about LAGOS-1, whatever zone the page asks for.
    assert.equal((await get(R.zone.GET, "/api/partner/v1/reports/zones/LAGOS-1", { viewer: "u1", params: { zone: "LAGOS-1" } })).status, 403);
    assert.equal((await get(R.participants.GET, "/api/partner/v1/reports/zones/LAGOS-1/participants", { viewer: "u1", params: { zone: "LAGOS-1" } })).status, 403);
    assert.equal((await get(R.exportCsv.GET, "/api/partner/v1/reports/zones/LAGOS-1/export", { viewer: "u1", params: { zone: "LAGOS-1" } })).status, 403);
    assert.equal((await get(R.org.GET, "/api/partner/v1/reports/org", { viewer: "u1" })).status, 403);
    assert.equal((await get(R.org.GET, "/api/partner/v1/reports/org", { viewer: "admin1" })).status, 200);
    // Another partner's key never reaches PrayerClouds' zones, even naming a leader.
    assert.equal((await get(R.zone.GET, zonePath, { key: otherKey, viewer: "u1", params: { zone: "FALF" } })).status, 404);
    assert.equal((await get(R.zone.GET, zonePath, { key: "nlm_pk_00000000_" + "0".repeat(48), viewer: "admin1", params: { zone: "FALF" } })).status, 401);
    // Someone's own attendance: theirs, never another's.
    const me = await get(R.me.GET, "/api/partner/v1/attendance/me?zoneId=FALF&period=today", { viewer: "u2" });
    assert.equal(me.status, 200);
    assert.equal(me.body.attendance.prayerSeconds, 1800);
    assert.ok(!me.text.includes("Member 1"));
  });

  await t("session duration, each person's prayer time and the total are kept apart", async () => {
    const r = await get(R.zone.GET, "/api/partner/v1/reports/zones/FALF?period=today", { viewer: "admin1", params: { zone: "FALF" } });
    const morning = r.body.sessions.find((s: J) => s.startedAt === m0);
    assert.equal(morning.durationSeconds, 1800, "the meeting ran 30 minutes");
    assert.equal(morning.participants, 10);
    assert.equal(morning.prayerSeconds, 10 * 1800, "10 people x 30 min = 5 hours");
    assert.equal(r.body.summary.sessions, 2);
    assert.equal(r.body.summary.uniqueParticipants, 11);
    assert.equal(r.body.summary.totalPrayerSeconds, 10 * 1800 + 600);
    assert.equal(r.body.summary.averagePrayerSeconds, Math.round((10 * 1800 + 600) / 11));
    assert.equal(r.body.period.timezone, "Africa/Lagos");
    // u1's second device did not add time.
    const p = await get(R.participants.GET, "/api/partner/v1/reports/zones/FALF/participants?period=today&pageSize=50", { viewer: "admin1", params: { zone: "FALF" } });
    const u1 = p.body.participants.find((x: J) => x.userId === "u1");
    assert.equal(u1.prayerSeconds, 1800);
    assert.equal(u1.sessionsAttended, 1);
    assert.equal(u1.firstJoined, m0);
    assert.equal(u1.lastLeft, m0 + 30 * MIN);
    assert.equal(u1.connected, false);
  });

  await t("the organisation report counts a person once across zones, and keeps each zone's own", async () => {
    const r = await get(R.org.GET, "/api/partner/v1/reports/org?period=today", { viewer: "admin1" });
    assert.equal(r.body.summary.uniqueParticipants, 12, "11 in FALF + l1; u1 is in both");
    assert.equal(r.body.summary.totalPrayerSeconds, 10 * 1800 + 600 + 900 + 900);
    const z = Object.fromEntries(r.body.zones.map((x: J) => [x.zone.zoneId, x.summary]));
    assert.equal(z.FALF.uniqueParticipants, 11);
    assert.equal(z["LAGOS-1"].uniqueParticipants, 2);
  });

  await t("periods are cut at the partner's midnight, and a session across it is split between days", async () => {
    // 23:30-01:30 Lagos time (22:30-00:30 UTC), across Lagos midnight.
    clock = iso("2026-10-21T22:30:00Z");
    await attend(lagos, "n1", "Night", clock, clock + 120 * MIN);
    clock = iso("2026-10-22T01:00:00Z");
    await A.roomClosed(room(lagos));
    clock = iso("2026-10-22T12:00:00Z");
    const day = async (d: string) =>
      (await get(R.participants.GET, `/api/partner/v1/reports/zones/LAGOS-1/participants?period=custom&from=${d}&to=${d}`, { viewer: "admin1", params: { zone: "LAGOS-1" } })).body.participants.find((x: J) => x.userId === "n1");
    assert.equal((await day("2026-10-21")).prayerSeconds, 30 * 60, "23:30-24:00 Lagos");
    assert.equal((await day("2026-10-22")).prayerSeconds, 90 * 60, "00:00-01:30 Lagos");
    const both = await get(R.participants.GET, "/api/partner/v1/reports/zones/LAGOS-1/participants?period=custom&from=2026-10-21&to=2026-10-22", { viewer: "admin1", params: { zone: "LAGOS-1" } });
    assert.equal(both.body.participants.find((x: J) => x.userId === "n1").prayerSeconds, 120 * 60);
    // In UTC the same night falls on one day.
    await S.updateIntegration(pc.id, { timezone: "UTC" });
    assert.equal((await day("2026-10-21")).prayerSeconds, 90 * 60, "22:30-24:00 UTC");
    await S.updateIntegration(pc.id, { timezone: "Africa/Lagos" });
    // The session's own duration is not clipped: it ran two hours.
    const sessions = (await get(R.zone.GET, "/api/partner/v1/reports/zones/LAGOS-1?period=custom&from=2026-10-22&to=2026-10-22", { viewer: "admin1", params: { zone: "LAGOS-1" } })).body.sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].durationSeconds, 120 * 60);
    assert.equal(sessions[0].prayerSeconds, 90 * 60);
  });

  await t("today, this week (from Monday) and this month in the partner's timezone; a day can be 25 hours", async () => {
    const now = iso("2026-10-21T23:30:00Z"); // Thursday 00:30 in Lagos
    const today = Rp.resolvePeriod({ period: "today" }, "Africa/Lagos", now);
    assert.equal(new RealDate(today.from).toISOString(), "2026-10-21T23:00:00.000Z");
    const week = Rp.resolvePeriod({ period: "week" }, "Africa/Lagos", now);
    assert.equal(new RealDate(week.from).toISOString(), "2026-10-18T23:00:00.000Z", "Monday 19 Oct, Lagos");
    assert.equal(week.to - week.from, 7 * 86_400_000);
    const month = Rp.resolvePeriod({ period: "month" }, "Africa/Lagos", iso("2026-10-31T23:30:00Z"));
    assert.equal(new RealDate(month.from).toISOString(), "2026-10-31T23:00:00.000Z", "already 1 November in Lagos");
    const dst = Rp.resolvePeriod({ period: "custom", from: "2026-10-25", to: "2026-10-25" }, "Europe/London");
    assert.equal(dst.to - dst.from, 25 * 3_600_000, "the clocks go back");
    assert.throws(() => Rp.resolvePeriod({ period: "custom", from: "2026-02-30", to: "2026-03-01" }, "UTC"), /YYYY-MM-DD/);
    assert.throws(() => Rp.resolvePeriod({ period: "custom", from: "2025-01-01", to: "2026-10-01" }, "UTC"), /366/);
  });

  await t("the participant table pages; one session shows each person's intervals; another zone's session is not found", async () => {
    clock = iso("2026-10-21T12:00:00Z");
    const page = await get(R.participants.GET, "/api/partner/v1/reports/zones/FALF/participants?period=today&page=2&pageSize=4", { viewer: "u1", params: { zone: "FALF" } });
    assert.equal(page.body.total, 11);
    assert.equal(page.body.pages, 3);
    assert.equal(page.body.participants.length, 4);
    const sessions = (await get(R.zone.GET, "/api/partner/v1/reports/zones/FALF?period=today", { viewer: "u1", params: { zone: "FALF" } })).body.sessions;
    const sid = sessions.find((s: J) => s.startedAt === m0).id;
    const one = await get(R.session.GET, `/api/partner/v1/reports/zones/FALF/sessions/${sid}`, { viewer: "u1", params: { zone: "FALF", sessionId: sid } });
    assert.equal(one.status, 200, one.text);
    assert.equal(one.body.participants.length, 10);
    assert.deepEqual(one.body.participants.find((x: J) => x.userId === "u1").intervals, [{ start: m0, end: m0 + 30 * MIN }]);
    const lagosSid = (await A.currentSession(pc.id, "LAGOS-1")) ? "x" : (await get(R.zone.GET, "/api/partner/v1/reports/zones/LAGOS-1?period=today", { viewer: "admin1", params: { zone: "LAGOS-1" } })).body.sessions[0].id;
    assert.equal((await get(R.session.GET, `/api/partner/v1/reports/zones/FALF/sessions/${lagosSid}`, { viewer: "u1", params: { zone: "FALF", sessionId: lagosSid } })).status, 404);
  });

  await t("CSV: names in the partner's timezone and UTC, the timezone named, nothing a spreadsheet would run", async () => {
    const csv = await get(R.exportCsv.GET, "/api/partner/v1/reports/zones/FALF/export?period=today", { viewer: "admin1", params: { zone: "FALF" } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(lines.length, 12, "a header and 11 people");
    assert.match(lines[0], /First joined \(Africa\/Lagos\)/);
    const u2 = lines.find((l) => l.includes(",u2,"))!;
    assert.match(u2, /2026-10-21 07:00:00,2026-10-21 07:30:00,2026-10-21T06:00:00.000Z/);
    assert.match(u2, /00:30:00,1800,left/);
    assert.ok(csv.text.includes(`"'=HYPERLINK(""x"")"`), "the formula is defused");
  });

  await t("a zone's public page gets only the figures switched on, and never a name", async () => {
    const off = await get(R.pub.GET, "/api/partner/v1/zones/FALF/public-stats?period=today", { params: { zone: "FALF" } });
    assert.deepEqual(off.body.stats, {});
    await S.updateIntegration(pc.id, { publicStats: ["uniqueParticipants", "totalPrayerSeconds"] });
    const on = await get(R.pub.GET, "/api/partner/v1/zones/FALF/public-stats?period=today", { params: { zone: "FALF" } });
    assert.deepEqual(on.body.stats, { uniqueParticipants: 11, totalPrayerSeconds: 10 * 1800 + 600 });
    assert.ok(!on.text.includes("Member") && !on.text.includes("u1"));
    assert.equal((await get(R.pub.GET, "/api/partner/v1/zones/FALF/public-stats?period=custom&from=2026-10-01&to=2026-10-02", { params: { zone: "FALF" } })).status, 400);
  });

  let u12sid = "";
  await t("reports say when they were made, and answer 304 until something changes", async () => {
    const path = "/api/partner/v1/reports/zones/FALF?period=today";
    const first = await get(R.zone.GET, path, { viewer: "admin1", params: { zone: "FALF" } });
    assert.ok(first.body.generatedAt);
    const tag = first.headers.get("etag")!;
    assert.equal((await get(R.zone.GET, path, { viewer: "admin1", params: { zone: "FALF" }, etag: tag })).status, 304);
    u12sid = await attend(falf, "u12", "New", clock, null);
    const changed = await get(R.zone.GET, path, { viewer: "admin1", params: { zone: "FALF" }, etag: tag });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.summary.connectedNow, 1);
    // While someone's time is running the tag moves on its own.
    const live = changed.headers.get("etag")!;
    clock += 20_000;
    assert.equal((await get(R.zone.GET, path, { viewer: "admin1", params: { zone: "FALF" }, etag: live })).status, 200);
  });

  await t("the current-session report: the open session only, with whoever is connected", async () => {
    // Their page beats every 20 s; LiveKit confirms them when asked.
    for (let i = 0; i < 15; i++) {
      clock += 20_000;
      await A.heartbeat(room(falf), id("u12"), u12sid, who("u12", "New"), async () => clock - 6 * MIN);
    }
    const r = await get(R.zone.GET, "/api/partner/v1/reports/zones/FALF?period=current", { viewer: "u1", params: { zone: "FALF" } });
    assert.equal(r.body.summary.sessions, 1);
    assert.equal(r.body.summary.uniqueParticipants, 1);
    assert.equal(r.body.summary.connectedNow, 1);
    const me = await get(R.me.GET, "/api/partner/v1/attendance/me?zoneId=FALF&period=current", { viewer: "u12" });
    assert.equal(me.body.timer.connected, true);
    assert.ok(me.body.timer.seconds >= 5 * 60);
  });

  await t("role lists check their input", async () => {
    assert.equal((await put(R.roles.PUT, "/api/partner/v1/roles", { orgAdmins: ["ok", "<bad>"] })).status, 400);
    assert.equal((await put(R.leaders.PUT, "/api/partner/v1/zones/NOPE/leaders", { leaders: [] }, { zone: "NOPE" })).status, 404);
    assert.deepEqual((await get(R.roles.GET, "/api/partner/v1/roles")).body.orgAdmins, ["admin1"]);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
