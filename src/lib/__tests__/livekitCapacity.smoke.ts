// Run: npx tsx src/lib/__tests__/livekitCapacity.smoke.ts
//
// The whole LiveKit account full (src/lib/livekitCapacity.ts): the real
// /api/livekit/token route and a partner zone's join refuse with a clear
// "meeting is full" once everyone connected across the account reaches the
// limit, keeping a few places for the people running meetings, and failing
// open when LiveKit cannot be counted. And the early warning: the default
// Admin → Ops alert at 800 connected, which applies even where alert rules
// were saved before it existed. Clerk, KV and LiveKit are stood in for
// (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_capacity";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";
delete process.env.LIVEKIT_MAX_CONCURRENT;
delete process.env.RESEND_API_KEY;

const g = globalThis as typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __who?: string;
  __rooms?: Array<{ name: string; numParticipants: number }>;
  __livekitDown?: boolean;
  __lkParticipants?: Record<string, Array<{ identity: string; kind?: number }>>;
};
g.__users = {
  user_owner: { plan: "enterprise", emails: ["owner@example.com"] },
  user_host: { emails: ["host@example.com"] },
  user_mod: { emails: ["mod@example.com"] },
  user_ann: { emails: ["ann@example.com"] },
  user_admin: { emails: ["platform@example.com"] },
};
g.__lkParticipants = { big: [{ identity: "user_owner#a" }] };

let finished = false;
process.on("exit", (code) => {
  if (code === 0 && !finished) {
    console.error("exited before the last check — something never answered");
    process.exitCode = 1;
  }
});

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { NextRequest } = await import("next/server");
  const { eventStore } = await import("../eventStore");
  const roles = await import("../meeting-roles");
  const C = await import("../livekitCapacity");
  const token = await import("../../app/api/livekit/token/route");
  const { rememberConfirmation } = await import("../attendanceName");

  const now = new Date().toISOString();
  await eventStore.create({
    id: "ev_big", slug: "big", name: "Big meeting", ownerUserId: "user_owner", ownerEmail: "owner@example.com",
    state: "live", visibility: "unlisted", livekitRoom: "big", waitingRoomEnabled: false, waitForHost: false,
    createdAt: now, updatedAt: now, roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);
  const owner = { userId: "user_owner", emails: ["owner@example.com"], isPlatformAdmin: false, role: "owner" as const, isOwner: true, reason: "owner" as const };
  await roles.assignMeetingRole("ev_big", { userId: "user_host" }, "host", owner);
  await roles.assignMeetingRole("ev_big", { userId: "user_mod" }, "moderator", owner);

  /** Everyone connected across the account, spread over a few rooms as LiveKit lists them. */
  const connected = (total: number) => {
    const a = Math.floor(total / 2);
    g.__rooms = [{ name: "big", numParticipants: a }, { name: "other", numParticipants: total - a - 3 }, { name: "small", numParticipants: 3 }];
    C.__resetConnectedCache();
  };
  async function join(who: string) {
    g.__who = who;
    await rememberConfirmation(who, "Test Attendee");
    const res = await token.GET(new NextRequest("https://www.neoconference.app/api/livekit/token?room=big&event=big&nonce=z1"));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  console.log("the rule");

  await t("ordinary joiners stop 20 short of the limit; the people running meetings may use those 20, not more", () => {
    assert.equal(C.accountLimit(), 1000);
    assert.equal(C.capacityRefusal(979, false), null);
    assert.equal(C.capacityRefusal(980, false)?.error, "room_full");
    assert.equal(C.capacityRefusal(980, false)?.scope, "service");
    assert.equal(C.capacityRefusal(999, true), null);
    assert.equal(C.capacityRefusal(1000, true)?.connected, 1000);
    assert.equal(C.capacityRefusal(null, false), null, "not counted: nobody refused");
    process.env.LIVEKIT_MAX_CONCURRENT = "5000";
    assert.equal(C.capacityRefusal(4979, false), null, "the limit follows the plan when set");
    assert.equal(C.capacityRefusal(4980, false)?.limit, 5000);
    delete process.env.LIVEKIT_MAX_CONCURRENT;
  });

  console.log("joining the web room or the app (/api/livekit/token)");

  await t("below the line everyone gets in", async () => {
    connected(979);
    for (const who of ["user_ann", "user_mod", "user_host", "user_owner"]) {
      const r = await join(who);
      assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
    }
  });

  await t("at it, an attendee is told the meeting is full, in words, as every app version already shows it", async () => {
    connected(980);
    const r = await join("user_ann");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "room_full", "the code apps already show as a full meeting");
    assert.equal(r.body.scope, "service");
    assert.equal(r.body.message, C.SERVICE_FULL_MESSAGE);
    assert.match(String(r.body.message), /full/);
    assert.match(String(r.body.message), /try again/);
    assert.equal(r.body.token, undefined, "no token");
  });

  await t("the Owner, a Host, a Moderator and a platform admin still get in, up to the limit itself", async () => {
    connected(999);
    for (const who of ["user_owner", "user_host", "user_mod", "user_admin"]) {
      const r = await join(who);
      assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.body)}`);
    }
    connected(1000);
    for (const who of ["user_host", "user_mod"]) {
      assert.equal((await join(who)).body.error, "room_full", `${who} at the limit itself`);
    }
  });

  await t("when LiveKit cannot be counted, nobody is refused", async () => {
    connected(2000);
    g.__livekitDown = true;
    C.__resetConnectedCache();
    try {
      assert.equal((await join("user_ann")).status, 200);
    } finally {
      g.__livekitDown = false;
    }
  });

  await t("one count is reused for a few seconds, so a crowd joining is not a crowd of LiveKit calls", async () => {
    let calls = 0;
    const svc = { listRooms: async () => (calls++, [{ numParticipants: 7 }, { numParticipants: 5 }]) } as never;
    C.__resetConnectedCache();
    assert.equal(await C.connectedNow(svc, 1_000_000), 12);
    assert.equal(await C.connectedNow(svc, 1_004_000), 12);
    assert.equal(calls, 1);
    assert.equal(await C.connectedNow(svc, 1_005_001), 12);
    assert.equal(calls, 2, "counted again once it is stale");
  });

  await t("a count LiveKit never answers is given up on, and the join goes ahead", async () => {
    C.__resetConnectedCache();
    const started = Date.now();
    const v = await C.connectedNow({ listRooms: () => new Promise(() => {}) } as never);
    assert.equal(v, null);
    assert.ok(Date.now() - started < 4000, "within the timeout");
  });

  console.log("joining a partner zone");

  await t("a partner's visitor is told the meeting is full too, and gets in below the line", async () => {
    const { joinZone } = await import("../partners/join");
    const grant = { integrationId: "pi_abcdef123", zoneId: "z1", eventId: "ev_big", origin: "https://partner.test", externalUserId: "u1", displayName: "Visitor", verified: true, role: "participant" as const };
    connected(990);
    await assert.rejects(joinZone(grant), (e: { code?: string; message?: string }) => e.code === "room_full" && e.message === C.SERVICE_FULL_MESSAGE);
    connected(100);
    const out = (await joinZone(grant)) as { status: string };
    assert.equal(out.status, "ready", JSON.stringify(out));
  });

  console.log("the early warning (Admin → Ops alerts)");

  const A = await import("../ops/alerts");
  const { kv } = await import("../kv");
  const probe = (participants: number) => [
    { id: "livekit", label: "LiveKit Cloud", group: "Media", status: "up" as const, latencyMs: 40, checkedAt: Date.now(), detail: "", metrics: { rooms: 3, participants }, lastFailureAt: null, lastFailure: null },
  ];
  const active = async () => (await A.listAlerts({ status: "active" })).filter((a) => a.kind === "livekit_connections");

  await t("on by default at 800, emailed and shown in Admin", async () => {
    const r = (await A.listRules()).find((x) => x.id === "default_livekit_connections");
    assert.ok(r);
    assert.equal(r!.threshold, 800);
    assert.equal(r!.enabled && r!.email && r!.inApp, true);
    assert.ok(A.ALERT_KINDS.some((k) => k.kind === "livekit_connections"), "editable in Admin");
  });

  await t("799 connected raises nothing; 800 opens one alert that says how many and what happens at the limit; below again, it resolves", async () => {
    await A.evaluateAlerts(probe(799));
    assert.equal((await active()).length, 0);
    await A.evaluateAlerts(probe(800));
    const [a] = await active();
    assert.ok(a, "alert open");
    assert.equal(a.subject, "livekit");
    assert.match(a.message, /^800 people connected/);
    assert.match(a.message, /At 1,000/);
    assert.equal(a.notified, true);
    await A.evaluateAlerts(probe(850));
    assert.equal((await active()).length, 1, "still one alert");
    assert.equal((await active())[0].occurrences, 2);
    await A.evaluateAlerts(probe(500));
    assert.equal((await active()).length, 0, "resolved");
  });

  await t("a LiveKit check with no count raises nothing", async () => {
    const [p] = probe(0);
    await A.evaluateAlerts([{ ...p, status: "down", metrics: undefined }]);
    assert.equal((await active()).length, 0);
  });

  await t("rules saved before it existed still get it; a saved copy wins; deleted, it stays gone", async () => {
    await kv.del("neo:ops:alert:rules");
    await kv.del("neo:ops:alert:rules:removed");
    // A store saved before this rule existed: the older defaults only.
    const older = A.DEFAULT_RULES.filter((r) => r.id !== "default_livekit_connections");
    await kv.hset("neo:ops:alert:rules", Object.fromEntries(older.map((r) => [r.id, JSON.stringify(r)])));
    const has = async () => (await A.listRules()).find((r) => r.id === "default_livekit_connections");
    assert.equal((await has())?.threshold, 800, "the new default applies");
    assert.equal((await A.listRules()).length, older.length + 1);

    await A.saveRule({ ...(await has())!, threshold: 900 });
    assert.equal((await has())?.threshold, 900, "the saved copy");
    await A.evaluateAlerts(probe(850));
    assert.equal((await active()).length, 0, "the saved threshold is the one used");

    await A.deleteRule("default_livekit_connections");
    assert.equal(await has(), undefined, "deleted stays gone");
    await A.evaluateAlerts(probe(950));
    assert.equal((await active()).length, 0);

    // Deleting an older default leaves it gone, as before.
    await A.deleteRule("default_degraded");
    assert.equal((await A.listRules()).some((r) => r.id === "default_degraded"), false);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
