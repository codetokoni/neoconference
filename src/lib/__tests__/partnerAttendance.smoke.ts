// Run: npx tsx src/lib/__tests__/partnerAttendance.smoke.ts
//
// Partner zone prayer time (src/lib/partners/attendance.ts): the visitor's
// timer is their connected time in the zone's current prayer session, from
// LiveKit's own timestamps — its webhook and its confirmation of the
// page's heartbeats — never from a counter in the browser. Driven through
// the real LiveKit webhook route and the embed's attendance route, with the
// clock moved by the test and KV, Clerk and LiveKit stood in for.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "t",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  CLERK_SECRET_KEY: "sk_test_partner_attendance",
  PARTNER_EMBED_SECRET: "partner-embed-secret-for-tests-0123456789",
});
delete process.env.ADMIN_EMAILS;

type G = typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __lkParticipants?: Record<string, { identity: string; sid: string; joinedAt: number }[]>;
  __kvTtl?: boolean;
};
const g = globalThis as G;
g.__users = { user_owner: { plan: "pro", emails: ["owner@example.com"] } };
g.__kvTtl = true;
g.__lkParticipants = {};

// The test's clock: T(s) is s seconds after the start.
const realNow = Date.now.bind(Date);
const BASE = Date.parse("2026-10-21T06:00:00Z");
let offset = 0;
Date.now = () => BASE + offset;
const at = (seconds: number) => {
  offset = seconds * 1000;
};
// `new Date()` must read the same clock: the webhook stamps events with it.
const RealDate = Date;
class TestDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(BASE + offset);
    else super(...(args as [number]));
  }
  static now() {
    return BASE + offset;
  }
}
globalThis.Date = TestDate as DateConstructor;
void realNow;

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

async function main() {
  const { NextRequest } = await import("next/server");
  const { AccessToken } = await import("livekit-server-sdk");
  const S = await import("../partners/store");
  const A = await import("../partners/attendance");
  const M = await import("../partners/attendanceMath");
  const R = {
    sessions: await import("../../app/api/partner/v1/join-sessions/route"),
    redeem: await import("../../app/api/partner/embed/redeem/route"),
    join: await import("../../app/api/partner/embed/join/route"),
    attendance: await import("../../app/api/partner/embed/attendance/route"),
    webhook: await import("../../app/api/livekit/webhook/route"),
  };

  const pc = await S.createIntegration({ name: "PrayerClouds", ownerUserId: "user_owner", origins: [PC] });
  const key = (await S.mintPartnerKey(pc.id)).raw;

  let ip = 1;
  const post = async (handler: (req: InstanceType<typeof NextRequest>) => Promise<Response>, url: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await handler(
      new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.2.0.${ip++ % 250}`, ...headers }, body: JSON.stringify(body) }),
    );
    return { status: res.status, body: (await res.json().catch(() => ({}))) as J };
  };

  /** A PrayerClouds visitor through to a participant token: their embed session, room and identity. */
  async function visitor(zoneId: string, id: string, displayName: string) {
    const s = await post(R.sessions.POST, "https://neolinguameet.com/api/partner/v1/join-sessions", { zoneId, origin: PC, user: { id, displayName } }, { authorization: `Bearer ${key}` });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const r = await post(R.redeem.POST, "https://neolinguameet.com/api/partner/embed/redeem", { code: s.body.code, parentOrigin: PC });
    const j = await post(R.join.POST, "https://neolinguameet.com/api/partner/embed/join", { session: r.body.session });
    assert.equal(j.body.status, "ready", JSON.stringify(j.body));
    const identity = JSON.parse(Buffer.from(String(j.body.token).split(".")[1], "base64url").toString()).sub as string;
    return { session: r.body.session as string, room: j.body.room as string, identity };
  }

  async function webhook(event: Record<string, unknown>) {
    const body = JSON.stringify({ ...event, createdAt: String(Math.floor(Date.now() / 1000)) });
    const tok = new AccessToken("lk", process.env.LIVEKIT_API_SECRET!);
    tok.sha256 = createHash("sha256").update(body).digest("base64");
    const res = await R.webhook.POST(new Request("https://neolinguameet.com/api/livekit/webhook", { method: "POST", headers: { authorization: await tok.toJwt(), "content-type": "application/webhook+json" }, body }));
    assert.equal(res.status, 200);
  }
  /** LiveKit: a connection joins (its webhook, and what getParticipant answers). */
  async function connect(v: { room: string; identity: string }, sid: string, name = "x") {
    g.__lkParticipants![v.room] = [...(g.__lkParticipants![v.room] ?? []).filter((p) => p.identity !== v.identity), { identity: v.identity, sid, joinedAt: Math.floor(Date.now() / 1000) }];
    await webhook({ event: "participant_joined", room: { name: v.room }, participant: { sid, identity: v.identity, name } });
  }
  async function disconnect(v: { room: string; identity: string }, sid: string) {
    g.__lkParticipants![v.room] = (g.__lkParticipants![v.room] ?? []).filter((p) => p.sid !== sid);
    await webhook({ event: "participant_left", room: { name: v.room }, participant: { sid, identity: v.identity } });
  }
  const beat = (v: { session: string }, sid?: string) => post(R.attendance.POST, "https://neolinguameet.com/api/partner/embed/attendance", sid ? { session: v.session, sid } : { session: v.session });

  at(0);
  const grace = await visitor("FALF", "pc_grace", "Grace");

  await t("the timer starts only when LiveKit has the visitor connected, not when the page or preview opens", async () => {
    const before = await beat(grace);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.seconds, 0);
    assert.equal(before.body.connected, false);
    assert.equal(before.body.sessionId, null);
    // A connection id LiveKit does not have counts for nothing.
    const fake = await beat(grace, "PA_fake");
    assert.equal(fake.body.beat, "unknown_connection");
    assert.equal(fake.body.seconds, 0);

    at(10);
    await connect(grace, "PA_g1", "Grace");
    at(75);
    const r = await beat(grace, "PA_g1");
    assert.equal(r.body.beat, "ok");
    assert.equal(r.body.connected, true);
    assert.equal(r.body.seconds, 65);
    assert.match(r.body.sessionId, /^ps_/);
  });

  await t("a heartbeat that arrives before LiveKit's webhook is confirmed with LiveKit, from LiveKit's join time", async () => {
    at(20);
    const ben = await visitor("FALF", "pc_ben", "Ben");
    g.__lkParticipants![ben.room] = [...(g.__lkParticipants![ben.room] ?? []), { identity: ben.identity, sid: "PA_b1", joinedAt: Math.floor(Date.now() / 1000) }];
    at(32);
    const r = await beat(ben, "PA_b1");
    assert.equal(r.body.beat, "ok");
    assert.equal(r.body.seconds, 12);
    // The webhook arriving later does not start it again.
    await webhook({ event: "participant_joined", room: { name: ben.room }, participant: { sid: "PA_b1", identity: ben.identity, name: "Ben" } });
    at(60);
    assert.equal((await beat(ben, "PA_b1")).body.seconds, 40);
    // Someone else's connection id is not theirs to beat for.
    assert.equal((await beat(ben, "PA_g1")).body.beat, "unknown_connection");
  });

  await t("a reload or quick reconnect resumes the time; a gap within 60 s is counted", async () => {
    at(300);
    await disconnect(grace, "PA_g1");
    at(310);
    await connect(grace, "PA_g2", "Grace");
    at(320);
    const r = await beat(grace, "PA_g2");
    assert.equal(r.body.seconds, 310, "10..320 with the 10 s gap counted");
    assert.equal(r.body.connected, true);
  });

  await t("a longer drop pauses the time: the gap is not counted, and it resumes from the earlier total", async () => {
    at(600);
    await disconnect(grace, "PA_g2");
    const paused = await beat(grace);
    assert.equal(paused.body.seconds, 590);
    assert.equal(paused.body.connected, false);
    at(780);
    await connect(grace, "PA_g3", "Grace");
    at(800);
    assert.equal((await beat(grace, "PA_g3")).body.seconds, 610, "590 + 20, not the 3-minute gap");
  });

  await t("two tabs or devices at once count once", async () => {
    at(790);
    await connect(grace, "PA_g4", "Grace");
    at(900);
    await beat(grace, "PA_g3");
    const r = await beat(grace, "PA_g4");
    assert.equal(r.body.seconds, 710, "590 + (780..900), not doubled");
  });

  await t("a tab closed with no goodbye ends at its last heartbeat once heartbeats stop", async () => {
    // No leave from LiveKit, no more heartbeats after 900.
    at(1100);
    const r = await beat(grace);
    assert.equal(r.body.connected, false);
    assert.equal(r.body.seconds, 710);
    // A late heartbeat for a connection LiveKit no longer has does not bring it back.
    g.__lkParticipants![grace.room] = [];
    assert.equal((await beat(grace, "PA_g4")).body.beat, "ended");
    assert.equal((await beat(grace)).body.seconds, 710);
  });

  await t("when the room closes the session ends; the next opening is a new session with a new timer", async () => {
    const first = (await beat(grace)).body.sessionId;
    at(1200);
    await webhook({ event: "room_finished", room: { name: grace.room } });
    const s = await A.getSession(first);
    assert.ok(s?.endedAt, "closed");
    assert.equal(s!.startedAt, BASE + 10_000);
    assert.equal((await beat(grace)).body.sessionId, null);
    at(1500);
    await connect(grace, "PA_g5", "Grace");
    at(1530);
    const r = await beat(grace, "PA_g5");
    assert.notEqual(r.body.sessionId, first);
    assert.equal(r.body.seconds, 30);
  });

  await t("zones keep their own sessions and time", async () => {
    at(1540);
    const lagos = await visitor("LAGOS-1", "pc_grace", "Grace");
    assert.notEqual(lagos.room, grace.room);
    await connect(lagos, "PA_l1", "Grace");
    at(1600);
    const l = await beat(lagos, "PA_l1");
    assert.equal(l.body.seconds, 60);
    const f = await beat(grace, "PA_g5");
    assert.equal(f.body.seconds, 100);
    assert.notEqual(l.body.sessionId, f.body.sessionId);
  });

  await t("the host and others in the room keep the session's clock without prayer time of their own", async () => {
    at(1610);
    await webhook({ event: "participant_joined", room: { name: grace.room }, participant: { sid: "PA_host", identity: "user_owner#web", name: "Host" } });
    const s = await A.currentSession(pc.id, "FALF");
    assert.ok(s);
    assert.equal((await A.getPerson(s!.id, "user_owner")), null);
    assert.ok(s!.lastActivity >= BASE + 1_610_000);
  });

  await t("two first connections at once start one session", async () => {
    at(2000);
    const z = { integrationId: pc.id, zoneId: "NEWZONE", eventId: "ev_x", room: "room-x" };
    const who = { integrationId: pc.id, zoneId: "NEWZONE", ext: "user:a", name: "A", verified: true };
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => A.connectionOpened(z, `pz-x-${i}`, `PA_c${i}`, Date.now(), who)));
    assert.equal(new Set(made.map((s) => s!.id)).size, 1);
  });

  await t("a session nobody has been in for 10 minutes (no room_finished came) is closed at its last activity", async () => {
    at(2000);
    const z = { integrationId: pc.id, zoneId: "QUIET", eventId: "ev_q", room: "room-q" };
    const s1 = await A.ensureSession(z, Date.now());
    at(2000 + 11 * 60);
    const s2 = await A.ensureSession(z, Date.now());
    assert.notEqual(s2.id, s1.id);
    assert.equal((await A.getSession(s1.id))!.endedAt, BASE + 2_000_000);
  });

  await t("the attendance route needs a valid session for an active zone", async () => {
    assert.equal((await post(R.attendance.POST, "https://neolinguameet.com/api/partner/embed/attendance", { session: "nope.nope" })).status, 401);
    await S.setZoneStatus(pc.id, "FALF", "disabled");
    assert.equal((await beat(grace)).body.error.code, "zone_disabled");
    await S.setZoneStatus(pc.id, "FALF", "active");
    assert.equal((await beat(grace)).status, 200);
  });

  await t("the counting rules: grace joins short gaps only, never a trailing one; clipping after merging", async () => {
    const iv = (a: number, b: number) => ({ start: a, end: b });
    assert.deepEqual(M.mergeIntervals([iv(0, 100_000), iv(150_000, 200_000)]), [iv(0, 200_000)]);
    assert.deepEqual(M.mergeIntervals([iv(0, 100_000), iv(161_000, 200_000)]), [iv(0, 100_000), iv(161_000, 200_000)]);
    assert.deepEqual(M.mergeIntervals([iv(0, 100_000), iv(50_000, 120_000)]), [iv(0, 120_000)]);
    assert.equal(M.totalMs(M.countedIntervals([iv(0, 100_000), iv(130_000, 200_000)], 50_000, 150_000)), 100_000);
    const open = M.connectionEnd({ s: 0, l: 100_000 }, 200_000);
    assert.deepEqual(open, { end: 200_000, open: true });
    assert.deepEqual(M.connectionEnd({ s: 0, l: 100_000 }, 100_000 + M.HEARTBEAT_EXPIRY_MS + 1), { end: 100_000, open: false });
    assert.deepEqual(M.connectionEnd({ s: 0, l: 100_000 }, 500_000, 80_000), { end: 80_000, open: false });
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
