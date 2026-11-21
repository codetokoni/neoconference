// Run: npx tsx src/lib/__tests__/micLock.smoke.ts
//
// "Mute everyone" / "Unmute everyone" (src/lib/micLock.ts): a meeting-wide
// microphone lock that LiveKit enforces through each ordinary participant's
// canPublishSources. Through the real /api/livekit/micLock, /api/livekit/token
// and /api/events/[id]/roles routes, with Clerk, KV and the LiveKit server
// stood in for (./apiV1-stubs; its updateParticipant takes a locked
// participant's microphone away, as livekit-server 1.9 does).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_mic_lock";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";

type Track = { sid: string; source: number; muted?: boolean };
type LkPerson = { identity: string; metadata?: string; kind?: number; tracks?: Track[]; permission?: { canPublishSources?: number[] } };
type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __who?: string;
  __lkParticipants?: Record<string, LkPerson[]>;
  __lkUpdated?: { identity: string; permission?: { canPublishSources?: number[] } }[];
  __lkRoomMetadata?: Record<string, string>;
};
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { plan: "pro", emails: ["owner@example.com"] },
  user_mod: { emails: ["mod@example.com"] },
  user_ann: { emails: ["ann@example.com"] },
  user_ben: { emails: ["ben@example.com"] },
  user_late: { emails: ["late@example.com"] },
};

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

const MIC = 2;
const LOCKED = [1, 3, 4];
/** The same, as a token spells it. */
const JWT_LOCKED = ["camera", "screen_share", "screen_share_audio"];
const mic = (sid: string): Track => ({ sid, source: MIC });
const cam = (sid: string): Track => ({ sid, source: 1 });
const screen = (sid: string): Track => ({ sid, source: 3 });
const person = (identity: string, role: string, tracks: Track[], extra: Partial<LkPerson> = {}): LkPerson => ({
  identity,
  metadata: JSON.stringify({ role }),
  tracks,
  permission: { canPublishSources: [] },
  ...extra,
});

async function main() {
  const { NextRequest } = await import("next/server");
  const { eventStore } = await import("../eventStore");
  const L = await import("../micLock");
  const R = {
    lock: await import("../../app/api/livekit/micLock/route"),
    token: await import("../../app/api/livekit/token/route"),
    roles: await import("../../app/api/events/[id]/roles/route"),
  };
  const now = new Date().toISOString();
  await eventStore.create({
    id: "ev_lock", slug: "lock-room", name: "Lock room", ownerUserId: "user_owner", ownerEmail: "owner@example.com",
    state: "live", visibility: "unlisted", livekitRoom: "lock-room", waitingRoomEnabled: false, waitForHost: false,
    createdAt: now, updatedAt: now,
    roles: [{ identifier: "mod@example.com", role: "cohost", label: "mod@example.com", preApproved: true }],
  } as unknown as Parameters<typeof eventStore.create>[0]);

  const seat = () => {
    g.__lkParticipants = {
      "lock-room": [
        person("user_owner#a", "host", [mic("TR_owner")]),
        person("user_mod#a", "cohost", [mic("TR_mod")]),
        person("user_ann#a", "attendee", [mic("TR_ann"), cam("TR_anncam"), screen("TR_annscr")]),
        person("user_ben#a", "attendee", [cam("TR_bencam")]),
        person("agent-captions", "attendee", [mic("TR_agent")], { kind: 4 }),
      ],
    };
    g.__lkUpdated = [];
  };
  const inRoom = (id: string) => g.__lkParticipants!["lock-room"].find((p) => p.identity === id)!;
  const sources = (id: string) => inRoom(id).permission?.canPublishSources ?? [];
  const tracks = (id: string) => (inRoom(id).tracks ?? []).map((tr) => tr.source);

  async function setLock(who: string, locked: unknown, room = "lock-room") {
    g.__who = who;
    const res = await R.lock.POST(
      new NextRequest("https://neolinguameet.com/api/livekit/micLock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomName: room, locked }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function readLock(who: string) {
    g.__who = who;
    const res = await R.lock.GET(new NextRequest("https://neolinguameet.com/api/livekit/micLock?room=lock-room"));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function tokenGrant(who: string) {
    g.__who = who;
    const res = await R.token.GET(new NextRequest("https://neolinguameet.com/api/livekit/token?room=lock-room&event=lock-room&nonce=b1"));
    const body = (await res.json()) as { token?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    const claims = JSON.parse(Buffer.from(body.token!.split(".")[1], "base64url").toString());
    return claims.video as { canPublishSources?: string[] };
  }

  await t("only the owner, a host or a moderator may lock, checked on every call", async () => {
    seat();
    for (const who of ["user_ann", "user_late"]) {
      const r = await setLock(who, true);
      assert.equal(r.status, 403, who);
    }
    g.__who = undefined;
    assert.equal((await setLock(undefined as unknown as string, true)).status, 401);
    assert.equal((await setLock("user_owner", "yes")).status, 400);
    assert.equal((await setLock("user_owner", true, "no-such-room")).status, 404);
    // Nothing changed for anyone.
    assert.deepEqual(g.__lkUpdated, []);
    assert.equal((await readLock("user_ann")).body.locked, false);
  });

  await t("Mute everyone: ordinary microphones go at once; cameras, screens, hosts and agents stay", async () => {
    seat();
    const r = await setLock("user_mod", true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.locked, true);
    assert.deepEqual(sources("user_ann#a"), LOCKED);
    assert.deepEqual(sources("user_ben#a"), LOCKED);
    assert.deepEqual(tracks("user_ann#a"), [1, 3]);
    assert.deepEqual(tracks("user_owner#a"), [MIC]);
    assert.deepEqual(tracks("user_mod#a"), [MIC]);
    assert.deepEqual(tracks("agent-captions"), [MIC]);
    assert.deepEqual(g.__lkUpdated!.map((u) => u.identity).sort(), ["user_ann#a", "user_ben#a"]);
    // Every host's button reads this; the stored lock is what tokens follow.
    assert.equal(JSON.parse(g.__lkRoomMetadata!["lock-room"]).micLock, true);
    assert.equal((await readLock("user_owner")).body.locked, true);
    // Pressing it again changes nobody.
    g.__lkUpdated = [];
    assert.equal((await setLock("user_owner", true)).status, 200);
    assert.deepEqual(g.__lkUpdated, []);
  });

  await t("someone joining or reconnecting while locked gets no microphone; elevated roles do", async () => {
    assert.deepEqual((await tokenGrant("user_late")).canPublishSources, JWT_LOCKED);
    assert.deepEqual((await tokenGrant("user_ann")).canPublishSources, JWT_LOCKED);
    assert.equal((await tokenGrant("user_owner")).canPublishSources, undefined);
    assert.equal((await tokenGrant("user_mod")).canPublishSources, undefined);
  });

  await t("a role change while locked: promoted gets the microphone back, demoted loses it", async () => {
    g.__who = "user_owner";
    const roles = (body: unknown) =>
      R.roles.POST(
        new NextRequest("https://neolinguameet.com/api/events/ev_lock/roles", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: "ev_lock" }) },
      );
    const up = await roles({ userId: "user_ben", role: "moderator" });
    assert.equal(up.status, 200, await up.clone().text());
    assert.deepEqual(sources("user_ben#a"), []);
    const down = await roles({ userId: "user_ben", role: "participant" });
    assert.equal(down.status, 200, await down.clone().text());
    assert.deepEqual(sources("user_ben#a"), LOCKED);
  });

  await t("LiveKit unreachable: the lock is put back and the caller keeps the last state", async () => {
    const saved = g.__lkParticipants;
    g.__lkParticipants = undefined; // listParticipants throws
    const r = await setLock("user_owner", false);
    assert.equal(r.status, 502);
    assert.equal(r.body.locked, true);
    assert.match(String(r.body.message), /Couldn't unmute everyone/);
    assert.equal((await readLock("user_owner")).body.locked, true);
    g.__lkParticipants = saved;
  });

  await t("Unmute everyone lifts the lock; nobody is unmuted for them", async () => {
    g.__lkUpdated = [];
    const r = await setLock("user_owner", false);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.locked, false);
    assert.deepEqual(sources("user_ann#a"), []);
    assert.deepEqual(sources("user_ben#a"), []);
    // Lifting changes permissions only: no microphone comes back by itself.
    assert.deepEqual(tracks("user_ann#a"), [1, 3]);
    assert.equal(JSON.parse(g.__lkRoomMetadata!["lock-room"]).micLock, false);
    assert.equal((await tokenGrant("user_late")).canPublishSources, undefined);
  });

  await t("locked with nobody in the room waits for the first token", async () => {
    g.__lkParticipants = { other: [] };
    const r = await setLock("user_owner", true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await tokenGrant("user_late")).canPublishSources, JWT_LOCKED);
    await setLock("user_owner", false);
  });

  await t("planMicLock and the grant, alone", () => {
    assert.deepEqual(L.micLockGrant({ micLock: { locked: true, by: "u", at: now } }, "attendee").canPublishSources, LOCKED);
    assert.deepEqual(L.micLockGrant({ micLock: { locked: true, by: "u", at: now } }, "cohost"), {});
    assert.deepEqual(L.micLockGrant({}, "attendee"), {});
    assert.deepEqual(L.planMicLock([person("x", "attendee", [], { permission: { canPublishSources: LOCKED } })], true), []);
    assert.equal(L.planMicLock([person("x", "host", [], { permission: { canPublishSources: LOCKED } })], true).length, 1);
    assert.equal(JSON.parse(L.roomMetadataWithLock('{"theme":"dark"}', true)).theme, "dark");
    assert.equal(JSON.parse(L.roomMetadataWithLock("not json", false)).micLock, false);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
