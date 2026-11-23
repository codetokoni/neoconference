// Run: npx tsx src/lib/__tests__/bigMeeting.smoke.ts
//
// Big-meeting receiving (src/lib/bigMeeting.ts): the plan of what one browser
// receives, and the real /api/livekit/token route's answer — off unless the
// meeting owner's feature switch is on; then "selective", and muted on
// entering a meeting of 50 or more (not for its Hosts and Moderators).
// Clerk, KV and LiveKit are stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_big_meeting";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";

const g = globalThis as typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __who?: string;
  __rooms?: Array<{ name: string; numParticipants: number }>;
  __livekitDown?: boolean;
  __lkParticipants?: Record<string, Array<{ identity: string }>>;
};
g.__users = {
  user_owner: { plan: "enterprise", emails: ["owner@example.com"] },
  user_host: { emails: ["host@example.com"] },
  user_mod: { emails: ["mod@example.com"] },
  user_ann: { emails: ["ann@example.com"] },
};
g.__lkParticipants = { big: [] };

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
  const B = await import("../bigMeeting");
  const { receivePlan, MAX_AUDIO, MAX_VIDEO } = B;

  console.log("what one browser receives");

  const mic = (identity: string, muted = false) => ({ key: identity + "/mic", identity, kind: "audio" as const, source: "microphone" as const, muted });
  const cam = (identity: string) => ({ key: identity + "/cam", identity, kind: "video" as const, source: "camera" as const, muted: false });
  const st = (o: Partial<{ spokeAt: Map<string, number>; liveAt: Map<string, number>; visible: Set<string>; priority: Set<string> }> = {}) => ({
    spokeAt: o.spokeAt ?? new Map(),
    liveAt: o.liveAt ?? new Map(),
    visible: o.visible ?? new Set<string>(),
    priority: o.priority ?? new Set<string>(),
  });
  const on = (plan: Map<string, boolean>) => [...plan].filter(([, v]) => v).map(([k]) => k).sort();

  await t("muted microphones are never received; unmuted ones are", () => {
    const plan = receivePlan([mic("a"), mic("b", true), mic("c")], st());
    assert.deepEqual(on(plan), ["a/mic", "c/mic"]);
    assert.equal(plan.get("b/mic"), false);
  });

  await t(`at most ${MAX_AUDIO} microphones: Hosts and Moderators first, then whoever spoke or unmuted last`, () => {
    const people = Array.from({ length: 30 }, (_, i) => mic("p" + i));
    const spokeAt = new Map([["p29", 900], ["p3", 800]]);
    const liveAt = new Map([["p7/mic", 850]]);
    const plan = receivePlan([...people, mic("host")], st({ spokeAt, liveAt, priority: new Set(["host"]) }));
    const heard = on(plan);
    assert.equal(heard.length, MAX_AUDIO);
    for (const k of ["host/mic", "p29/mic", "p7/mic", "p3/mic"]) assert.ok(heard.includes(k), k);
    // Someone quiet starts speaking: they are heard, the quietest goes.
    const later = receivePlan([...people, mic("host")], st({ spokeAt: new Map([...spokeAt, ["p15", 1000]]), liveAt, priority: new Set(["host"]) }));
    assert.equal(later.get("p15/mic"), true);
    assert.equal(on(later).length, MAX_AUDIO);
  });

  await t("cameras only while their tile is on screen, at most " + MAX_VIDEO + "; screen shares always", () => {
    const share = { key: "s/share", identity: "s", kind: "video" as const, source: "screen_share" as const, muted: false };
    const shareAudio = { key: "s/shareaudio", identity: "s", kind: "audio" as const, source: "screen_share_audio" as const, muted: false };
    const plan = receivePlan([cam("a"), cam("b"), share, shareAudio], st({ visible: new Set(["a"]) }));
    assert.deepEqual(on(plan), ["a/cam", "s/share", "s/shareaudio"]);
    assert.equal(plan.get("b/cam"), false, "scrolled away: let go");
    const many = Array.from({ length: 40 }, (_, i) => cam("v" + i));
    assert.equal(on(receivePlan(many, st({ visible: new Set(many.map((c) => c.identity)) }))).length, MAX_VIDEO);
  });

  await t("the token's answer is read safely: anything unexpected is receive-all, not muted", () => {
    assert.deepEqual(B.receiveModeOf({ receive: "selective", joinMuted: true }), { receive: "selective", joinMuted: true });
    for (const v of [null, undefined, {}, { receive: "SELECTIVE" }, { joinMuted: "true" }]) assert.deepEqual(B.receiveModeOf(v), { receive: "all", joinMuted: false });
  });

  console.log("the token route's answer (/api/livekit/token)");

  const { NextRequest } = await import("next/server");
  const { eventStore } = await import("../eventStore");
  const roles = await import("../meeting-roles");
  const C = await import("../livekitCapacity");
  const settings = await import("../platform/settings");
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
  const inMeeting = (count: number) => {
    g.__rooms = [{ name: "big", numParticipants: count }, { name: "elsewhere", numParticipants: 300 }];
    C.__resetConnectedCache();
  };
  const join = async (who: string) => {
    g.__who = who;
    await rememberConfirmation(who, "Test Attendee");
    const res = await token.GET(new NextRequest("https://www.neoconference.app/api/livekit/token?room=big&event=big&nonce=z1"));
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(body));
    return body;
  };

  await t("off unless turned on: receive everything, as before, however big", async () => {
    inMeeting(600);
    const b = await join("user_ann");
    assert.equal(b.receive, "all");
    assert.equal(b.joinMuted, undefined);
  });

  await t("turned on for the meeting owner's account: selective; under 50 present, nobody comes in muted", async () => {
    await settings.setAccountOverrides("user_owner", { big_meeting_receiving: "allow" });
    inMeeting(49);
    const b = await join("user_ann");
    assert.equal(b.receive, "selective");
    assert.equal(b.joinMuted, undefined);
  });

  await t("50 or more present: an attendee comes in muted; the Owner, a Host and a Moderator do not", async () => {
    inMeeting(50);
    assert.equal((await join("user_ann")).joinMuted, true);
    for (const who of ["user_owner", "user_host", "user_mod"]) {
      const b = await join(who);
      assert.equal(b.receive, "selective", who);
      assert.equal(b.joinMuted, undefined, who);
    }
  });

  await t("the size is this meeting's, not the whole account's", async () => {
    g.__rooms = [{ name: "big", numParticipants: 10 }, { name: "elsewhere", numParticipants: 900 }];
    C.__resetConnectedCache();
    assert.equal((await join("user_ann")).joinMuted, undefined);
  });

  await t("LiveKit cannot be counted: still selective, nobody muted", async () => {
    g.__livekitDown = true;
    C.__resetConnectedCache();
    try {
      const b = await join("user_ann");
      assert.equal(b.receive, "selective");
      assert.equal(b.joinMuted, undefined);
    } finally {
      g.__livekitDown = false;
    }
  });

  await t("turned off everywhere (Admin → Features): back to receiving everything", async () => {
    const c = await settings.getFeatureControls();
    await settings.saveFeatureControls({ ...c, global: { ...c.global, big_meeting_receiving: false } });
    inMeeting(600);
    const b = await join("user_ann");
    assert.equal(b.receive, "all");
    assert.equal(b.joinMuted, undefined);
  });

  await t("or turned on for a whole plan", async () => {
    await settings.setAccountOverrides("user_owner", {});
    const c = await settings.getFeatureControls();
    await settings.saveFeatureControls({ ...c, global: {}, perPlan: { big_meeting_receiving: { enterprise: true } } });
    assert.equal((await join("user_ann")).receive, "selective");
    await settings.saveFeatureControls({ ...c, global: {}, perPlan: { big_meeting_receiving: { pro: true } } });
    assert.equal((await join("user_ann")).receive, "all", "another plan's switch does not count");
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
