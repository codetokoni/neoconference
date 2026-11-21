// Run: npx tsx src/lib/__tests__/micLock.smoke.ts
//
// Locking participant microphones (src/lib/micLock.ts), through the real
// /api/livekit/mic-lock and /api/livekit/token routes with Clerk, KV and
// LiveKit's room service stood in for (./apiV1-stubs). That LiveKit itself
// takes a revoked microphone down and refuses to publish it again is checked
// against a real LiveKit server separately (the bench in the PR).

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

type Perm = { canPublish?: boolean; canSubscribe?: boolean; canPublishData?: boolean; canPublishSources?: number[]; hidden?: boolean };
type P = { identity: string; metadata?: string; kind?: number; permission?: Perm };
const g = globalThis as typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __who?: string;
  __lkParticipants?: Record<string, P[]>;
  __lkUpdated?: Array<{ identity: string; permission?: Perm }>;
  __lkData?: Array<{ room: string; data: { type: string; locked: boolean; allowed: string[] }; options?: { topic?: string } }>;
};
g.__users = {
  user_owner: { plan: "pro", emails: ["owner@example.com"] },
  user_host: { emails: ["host@example.com"] },
  user_mod: { emails: ["mod@example.com"] },
  user_ann: { emails: ["ann@example.com"] },
  user_ben: { emails: ["ben@example.com"] },
  user_late: { emails: ["late@example.com"] },
  user_stranger: { emails: ["stranger@example.com"] },
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

const FULL: Perm = { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [] };
const person = (identity: string, role: string): P => ({ identity, metadata: JSON.stringify({ role }), kind: 0, permission: { ...FULL } });
const micOk = (identity: string) => {
  const p = g.__lkParticipants!.room1.find((x) => x.identity === identity)!;
  const s = p.permission?.canPublishSources ?? [];
  return p.permission?.canPublish !== false && (s.length === 0 || s.includes(2));
};

async function main() {
  const { NextRequest } = await import("next/server");
  const { eventStore } = await import("../eventStore");
  const roles = await import("../meeting-roles");
  const M = await import("../micLock");
  const R = {
    lock: await import("../../app/api/livekit/mic-lock/route"),
    token: await import("../../app/api/livekit/token/route"),
  };
  const now = new Date().toISOString();
  await eventStore.create({
    id: "ev_mic", slug: "room1", name: "Mic meeting", ownerUserId: "user_owner", ownerEmail: "owner@example.com",
    state: "live", visibility: "unlisted", livekitRoom: "room1", waitingRoomEnabled: false, waitForHost: false,
    createdAt: now, updatedAt: now, roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);
  const owner = { userId: "user_owner", emails: ["owner@example.com"], isPlatformAdmin: false, role: "owner" as const, isOwner: true, reason: "owner" as const };
  await roles.assignMeetingRole("ev_mic", { userId: "user_host" }, "host", owner);
  await roles.assignMeetingRole("ev_mic", { userId: "user_mod" }, "moderator", owner);

  // Who is in the room, as LiveKit lists them (owner and host are "host" on
  // the wire, the moderator "cohost"), with a captions agent and a recorder.
  g.__lkParticipants = {
    room1: [
      person("user_owner#a", "host"),
      person("user_host#b", "host"),
      person("user_mod#c", "cohost"),
      person("user_ann#d", "attendee"),
      person("user_ann#e", "attendee"), // Ann on a second device
      person("user_ben#f", "attendee"),
      { identity: "agent-translate-1", kind: 4, permission: { ...FULL } },
      { identity: "EG_rec1", kind: 2, permission: { ...FULL } },
      // The captions worker joins as an ordinary participant: known by name.
      { identity: "neo-captions", kind: 0, metadata: JSON.stringify({ role: "attendee" }), permission: { ...FULL } },
    ],
  };

  async function act(who: string, action: string, participantIdentity?: string, extra: Record<string, unknown> = {}) {
    g.__who = who;
    const res = await R.lock.POST(
      new Request("https://www.neoconference.app/api/livekit/mic-lock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "room1", action, ...(participantIdentity ? { participantIdentity } : {}), ...extra }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function state(who: string) {
    g.__who = who;
    const res = await R.lock.GET(new Request("https://www.neoconference.app/api/livekit/mic-lock?slug=room1"));
    return (await res.json()) as Record<string, unknown>;
  }
  /** Whether the join token this person gets now locks them (canPublish false). */
  async function tokenLocked(who: string) {
    g.__who = who;
    // The join screen confirms a full name for attendance first (src/lib/attendanceName.ts).
    await (await import("../attendanceName")).rememberConfirmation(who, "Test Attendee");
    const res = await R.token.GET(new NextRequest(`https://www.neoconference.app/api/livekit/token?room=room1&event=room1&nonce=z9`));
    const body = (await res.json()) as { token?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    const claims = JSON.parse(Buffer.from(body.token!.split(".")[1], "base64url").toString()) as { video: { canPublish?: boolean } };
    return claims.video.canPublish === false;
  }
  /** What the join token this person gets now lets them publish (by name; null for anything). */
  async function tokenSources(who: string) {
    g.__who = who;
    await (await import("../attendanceName")).rememberConfirmation(who, "Test Attendee");
    const res = await R.token.GET(new NextRequest(`https://www.neoconference.app/api/livekit/token?room=room1&event=room1&nonce=z9`));
    const body = (await res.json()) as { token?: string };
    const claims = JSON.parse(Buffer.from(body.token!.split(".")[1], "base64url").toString()) as { video: { canPublishSources?: string[] } };
    return claims.video.canPublishSources ?? null;
  }

  console.log("who may");

  await t("an ordinary participant or a stranger may not lock, unlock, allow or lock again", async () => {
    for (const who of ["user_ann", "user_stranger"]) {
      for (const [action, target] of [["lock"], ["unlock"], ["allow", "user_ben#f"], ["relock", "user_ben#f"]] as Array<[string, string?]>) {
        const r = await act(who, action, target);
        assert.equal(r.status, 403, `${who} ${action}`);
      }
    }
    g.__who = undefined;
    const res = await R.lock.POST(new Request("https://x.test/api/livekit/mic-lock", { method: "POST", body: JSON.stringify({ slug: "room1", action: "lock" }) }));
    assert.equal(res.status, 401, "signed out");
    assert.equal(micOk("user_ann#d"), true, "nothing changed");
    assert.deepEqual(await state("user_owner"), { locked: false, allowed: [] });
  });

  console.log("locking");

  await t("a Moderator locks: everyone else's microphone, camera and screen are taken away at once; Owner, Host, Moderator and the agents keep theirs", async () => {
    const r = await act("user_mod", "lock");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.changed, 3);
    for (const id of ["user_ann#d", "user_ann#e", "user_ben#f"]) assert.equal(micOk(id), false, id);
    for (const id of ["user_owner#a", "user_host#b", "user_mod#c", "agent-translate-1", "EG_rec1", "neo-captions"]) assert.equal(micOk(id), true, id);
    // Nothing may be published; watching, listening and chat go on.
    const ann = g.__lkParticipants!.room1.find((x) => x.identity === "user_ann#d")!.permission!;
    assert.equal(ann.canPublish, false);
    assert.deepEqual(ann.canPublishSources, []);
    assert.equal(ann.canSubscribe, true);
    assert.equal(ann.canPublishData, true);
    const said = g.__lkData!.at(-1)!;
    assert.deepEqual([said.data.type, said.data.locked, said.options?.topic], ["mic_lock", true, "mic_lock"]);
  });

  await t("someone still under the earlier microphone-only lock loses camera and screen too", async () => {
    const old = { ...person("user_old#k", "attendee"), permission: { ...FULL, canPublishSources: [1, 3, 4] } };
    g.__lkParticipants!.room1.push(old);
    const r = await M.enforceMicLockFor("ev_mic", "room1", old as never);
    assert.equal(r?.changed, 1);
    assert.equal(g.__lkParticipants!.room1.find((x) => x.identity === "user_old#k")!.permission!.canPublish, false);
    g.__lkParticipants!.room1 = g.__lkParticipants!.room1.filter((x) => x.identity !== "user_old#k");
  });

  await t("the moderators see the state; others only that it is locked", async () => {
    assert.deepEqual(await state("user_host"), { locked: true, allowed: [] });
    assert.deepEqual(await state("user_ben"), { locked: true, youMayUnmute: false });
  });

  await t("someone who joins late, or rejoins, gets a token that publishes nothing; Owner, Host and Moderator do not", async () => {
    assert.equal(await tokenLocked("user_late"), true);
    assert.equal(await tokenLocked("user_ann"), true);
    assert.equal(await tokenLocked("user_mod"), false);
    assert.equal(await tokenLocked("user_host"), false);
    assert.equal(await tokenLocked("user_owner"), false);
  });

  await t("a reconnect with a token from before the lock is locked when LiveKit says they joined", async () => {
    const back = person("user_late#g", "attendee");
    g.__lkParticipants!.room1.push(back);
    const r = await M.enforceMicLockFor("ev_mic", "room1", back as never);
    assert.equal(r?.changed, 1);
    assert.equal(micOk("user_late#g"), false);
  });

  console.log("allowing one person");

  await t("allowing Ann lets her unmute on every device, but not her camera or screen, and turns nothing on; Ben stays locked", async () => {
    const before = g.__lkUpdated!.length;
    const r = await act("user_host", "allow", "user_ann#d");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(micOk("user_ann#d"), true);
    assert.equal(micOk("user_ann#e"), true);
    assert.equal(micOk("user_ben#f"), false);
    // Only permission changes: nothing published, nothing unmuted.
    const changes = g.__lkUpdated!.slice(before);
    assert.deepEqual(changes.map((c) => c.identity).sort(), ["user_ann#d", "user_ann#e"]);
    assert.ok(changes.every((c) => c.permission && Object.keys(c).sort().join() === "identity,permission,room"));
    // Her microphone only: camera and screen stay locked (owner's decision, 2026-11-21).
    for (const id of ["user_ann#d", "user_ann#e"]) {
      const perm = g.__lkParticipants!.room1.find((x) => x.identity === id)!.permission!;
      assert.deepEqual([perm.canPublish, perm.canPublishSources], [true, [2]], id);
    }
    assert.deepEqual(await state("user_ann"), { locked: true, youMayUnmute: true });
    assert.equal(await tokenLocked("user_ann"), false, "and on rejoining...");
    assert.deepEqual(await tokenSources("user_ann"), ["microphone"], "...with her microphone only");
  });

  await t("locking Ann again takes her microphone away again", async () => {
    const r = await act("user_owner", "relock", "user_ann#d");
    assert.equal(r.status, 200);
    assert.equal(micOk("user_ann#d"), false);
    assert.equal(micOk("user_ann#e"), false);
    assert.deepEqual(await state("user_owner"), { locked: true, allowed: [] });
  });

  await t("allowing or locking again needs a person, and the lock to be on", async () => {
    assert.equal((await act("user_mod", "allow")).status, 400);
  });

  await t("a Moderator's own microphone is never locked, whatever they are sent", async () => {
    const r = await act("user_host", "relock", "user_mod#c");
    assert.equal(r.status, 200);
    assert.equal(micOk("user_mod#c"), true);
  });

  console.log("unlocking");

  await t("unlocking lets everyone unmute; nobody is unmuted", async () => {
    const before = g.__lkUpdated!.length;
    const r = await act("user_mod", "unlock");
    assert.equal(r.status, 200);
    for (const id of ["user_ann#d", "user_ann#e", "user_ben#f", "user_late#g"]) assert.equal(micOk(id), true, id);
    assert.ok(g.__lkUpdated!.slice(before).every((c) => c.permission && !("metadata" in c && c.metadata !== undefined)));
    const ben = g.__lkParticipants!.room1.find((x) => x.identity === "user_ben#f")!.permission!;
    assert.deepEqual([ben.canPublish, ben.canPublishSources], [true, []]);
    assert.equal(await tokenLocked("user_late"), false);
    assert.equal((await act("user_mod", "allow", "user_ben#f")).status, 409, "nothing to allow when unlocked");
  });

  await t("a reconnect with a token from the lock is let go when LiveKit says they joined", async () => {
    const stale = { ...person("user_ben#h", "attendee"), permission: { ...FULL, canPublishSources: [1, 3, 4] } };
    g.__lkParticipants!.room1.push(stale);
    await M.enforceMicLockFor("ev_mic", "room1", stale as never);
    assert.equal(micOk("user_ben#h"), true);
  });

  console.log("the rules");

  await t("a permission keeps what it had; only publishing changes", () => {
    assert.deepEqual(M.withAccess({ canPublish: true, canPublishSources: [], hidden: false } as Perm, "none"), { canPublish: false, canPublishSources: [], hidden: false });
    assert.deepEqual(M.withAccess({ canPublish: false, canPublishSources: [] }, "mic"), { canPublish: true, canPublishSources: [2] });
    assert.deepEqual(M.withAccess({ canPublish: false, canPublishSources: [] }, "open"), { canPublish: true, canPublishSources: [] });
    // A list a lock made is cleared on the way back: the mic-only one and the earlier lock's.
    assert.deepEqual(M.withAccess({ canPublish: true, canPublishSources: [2] }, "open"), { canPublish: true, canPublishSources: [] });
    assert.deepEqual(M.withAccess({ canPublish: true, canPublishSources: [1, 3, 4] }, "open"), { canPublish: true, canPublishSources: [] });
    assert.deepEqual(M.withAccess({ canPublish: true, canPublishSources: [1] }, "open"), { canPublish: true, canPublishSources: [1, 2] });
    // That earlier lock is locked, but not locked enough; mic-only is not open.
    assert.equal(M.permitsMicrophone({ canPublish: true, canPublishSources: [1, 3, 4] }), false);
    assert.equal(M.permissionIsAsWanted({ canPublish: true, canPublishSources: [1, 3, 4] }, "none"), false);
    assert.equal(M.permissionIsAsWanted({ canPublish: false, canPublishSources: [] }, "none"), true);
    assert.equal(M.permissionIsAsWanted({ canPublish: true, canPublishSources: [2] }, "mic"), true);
    assert.equal(M.permissionIsAsWanted({ canPublish: true, canPublishSources: [2] }, "open"), false);
    assert.equal(M.permissionIsAsWanted({ canPublish: true, canPublishSources: [] }, "mic"), false);
    assert.equal(M.permitsMicrophone(undefined), true);
  });

  await t("a room in another meeting cannot be named", async () => {
    await eventStore.create({
      id: "ev_other", slug: "other-room", name: "Other", ownerUserId: "user_stranger", ownerEmail: "stranger@example.com",
      state: "live", visibility: "unlisted", livekitRoom: "other-room", createdAt: now, updatedAt: now, roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
    const r = await act("user_owner", "lock", undefined, { room: "other-room" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "room_not_this_meeting");
  });

  finished = true;
  console.log(`micLock: ${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
