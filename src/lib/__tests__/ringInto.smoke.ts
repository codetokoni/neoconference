// Run: npx tsx src/lib/__tests__/ringInto.smoke.ts
//
// Ringing a group's members into a meeting that is not a group meeting
// (POST /api/events/[id]/ring-in, 2026-11-13): the owner opened neomeeting
// from their history and wanted to call people into it, not start a new
// group meeting. Through the real routes — ring-in, call-response, calls and
// ring (Ring again) — with Clerk, KV and push stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  CLERK_SECRET_KEY: "sk_test_ring_into",
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "stub",
  PLATFORM_OWNER_EMAILS: "platform@example.com",
  ADMIN_EMAILS: "",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
  VAPID_SUBJECT: "mailto:test@example.com",
});

type Stubbed = typeof globalThis & { __users: Record<string, { plan?: string; emails?: string[] }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { plan: "pro", emails: ["owner@example.com"] },
  user_a: { emails: ["a@example.com"] },
  user_b: { emails: ["b@example.com"] },
  user_c: { emails: ["c@example.com"] },
  user_mod: { emails: ["mod@example.com"] },
  user_out: { emails: ["out@example.com"] },
};

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

async function main() {
  const { NextRequest } = await import("next/server");
  const { eventStore } = await import("../eventStore");
  const { createGroup, setRole } = await import("../groupStore");
  const { saveSubscription, __setPushSender } = await import("../pushStore");
  const { __setKingsChatSender, getCalls, getRingInto, runDispatch } = await import("../ringEngine");
  const { listNotifications } = await import("../notificationStore");
  const { jobsFor } = await import("../scheduler");
  const R = {
    ringIn: await import("../../app/api/events/[id]/ring-in/route"),
    respond: await import("../../app/api/events/[id]/call-response/route"),
    calls: await import("../../app/api/events/[id]/calls/route"),
    ring: await import("../../app/api/events/[id]/ring/route"),
  };

  const pushes: Array<{ title: string; body: string; url: string }> = [];
  __setPushSender(async (_s, body) => {
    const p = JSON.parse(body);
    pushes.push({ title: p.title, body: p.body, url: p.url });
    return { statusCode: 201 };
  });
  __setKingsChatSender(async () => "sent");
  for (const u of ["user_a", "user_b", "user_c"]) {
    await saveSubscription(u, { endpoint: `https://push.test/${u}`, keys: { p256dh: "k", auth: "a" } }, "UA");
  }

  const grp = await createGroup({ name: "Choir" }, { userId: "user_owner", name: "Victor" }, [
    { userId: "user_a", name: "Ada" },
    { userId: "user_b", name: "Bola" },
    { userId: "user_c", name: "Chi" },
    { userId: "user_mod", name: "Musa" },
  ]);
  const ownerActor = { userId: "user_owner", emails: [], isPlatformAdmin: false, role: "owner" as const, isOwner: true, reason: "owner" as const };
  await setRole(grp.id, "user_mod", "moderator", ownerActor);

  const now = new Date().toISOString();
  const meeting = (slug: string, owner = "user_owner", state = "live") =>
    eventStore.create({
      id: "ev_" + slug, slug, name: slug, ownerUserId: owner, ownerEmail: `${owner}@example.com`, ownerName: "Victor",
      state, visibility: "unlisted", livekitRoom: slug, waitingRoomEnabled: false, waitForHost: false,
      createdAt: now, updatedAt: now, roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
  await meeting("neomeeting");
  await meeting("ended-room", "user_owner", "ended");
  await meeting("mods-room", "user_mod");

  const post = async (route: { POST: (r: never, c: never) => Promise<Response> }, slug: string, who: string, body: unknown) => {
    g.__who = who;
    const res = await route.POST(
      new NextRequest(`https://neo.test/api/events/${slug}/x`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never,
      { params: Promise.resolve({ id: slug }) } as never,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const getCallsRoute = async (slug: string, who: string) => {
    g.__who = who;
    const res = await R.calls.GET(new NextRequest(`https://neo.test/api/events/${slug}/calls`) as never, { params: Promise.resolve({ id: slug }) } as never);
    return { status: res.status, body: (await res.json()) as { people?: Array<{ userId: string; name: string; status: string }> } };
  };

  await t("the meeting's host rings two members of their group into it: they are called, from the group, by the host", async () => {
    const r = await post(R.ringIn, "neomeeting", "user_owner", { groupId: grp.id, userIds: ["user_a", "user_b"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.rung, ["user_a", "user_b"]);
    assert.deepEqual(pushes.map((p) => p.title), ["Choir: neomeeting", "Choir: neomeeting"]);
    assert.equal(pushes[0].body, "Victor is calling");
    assert.equal(pushes[0].url, "/room/neomeeting?event=neomeeting&join=1");
    const ring = (await listNotifications("user_a")).items.find((i) => i.type === "ring");
    assert.equal(ring?.eventSlug, "neomeeting");
    // Nobody else in the group was rung.
    assert.equal((await listNotifications("user_c")).items.length, 0);
  });

  await t("the meeting stays what it was: not a group meeting, nobody's access changed", async () => {
    const ev = (await eventStore.bySlug("neomeeting"))!;
    assert.equal(ev.groupId, undefined);
    assert.equal(ev.groupMeeting, undefined);
    assert.deepEqual((await getRingInto(ev.id))?.userIds, ["user_a", "user_b"]);
  });

  await t("someone rung answers or declines; someone who was not rung cannot", async () => {
    const a = await post(R.respond, "neomeeting", "user_a", { action: "answer" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.status, "answered");
    assert.equal(a.body.roomUrl, "/room/neomeeting?event=neomeeting&join=1");
    const b = await post(R.respond, "neomeeting", "user_b", { action: "decline" });
    assert.equal(b.body.status, "declined");
    assert.equal((await post(R.respond, "neomeeting", "user_c", { action: "answer" })).status, 404);
  });

  await t("the room's Calling list shows them to the host; not to someone who is not a moderator in the group", async () => {
    const list = await getCallsRoute("neomeeting", "user_owner");
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(
      list.body.people!.map((p) => [p.name, p.status]),
      [["Ada", "answered"], ["Bola", "declined"]],
    );
    assert.equal((await getCallsRoute("neomeeting", "user_a")).status, 403);
  });

  await t("ringing more people adds them; Ring again works for someone who declined", async () => {
    const r = await post(R.ringIn, "neomeeting", "user_owner", { groupId: grp.id, userIds: ["user_c"] });
    assert.deepEqual(r.body.rung, ["user_c"]);
    assert.deepEqual((await getRingInto("ev_neomeeting"))?.userIds, ["user_a", "user_b", "user_c"]);
    const again = await post(R.ring, "neomeeting", "user_owner", { userIds: ["user_b"] });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.rung, ["user_b"]);
    assert.equal((await getCalls("ev_neomeeting")).get("user_b")?.status, "ringing");
  });

  await t("unanswered rings are repeated by the group's settings, like a group meeting's", async () => {
    const calls = await getCalls("ev_neomeeting");
    const before = calls.get("user_c")!.attempts;
    const due = (await jobsFor("ev_neomeeting")).filter((j) => j.type === "ring").map((j) => j.fireAt);
    assert.equal(due.length, 1, "the next round is queued");
    await runDispatch(due[0]);
    assert.equal((await getCalls("ev_neomeeting")).get("user_c")!.attempts, before + 1);
    assert.equal((await getCalls("ev_neomeeting")).get("user_a")!.status, "answered", "someone who answered is left alone");
  });

  await t("only people in that group, and not the caller themselves", async () => {
    const r = await post(R.ringIn, "neomeeting", "user_owner", { groupId: grp.id, userIds: ["user_out"] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "not_members");
    assert.equal((await post(R.ringIn, "neomeeting", "user_owner", { groupId: grp.id, userIds: ["user_owner"] })).status, 400);
    assert.equal((await post(R.ringIn, "neomeeting", "user_owner", { groupId: grp.id, userIds: [] })).status, 400);
  });

  await t("only someone who runs the meeting, and may call in the group", async () => {
    // A member of the group who does not run neomeeting.
    assert.equal((await post(R.ringIn, "neomeeting", "user_a", { groupId: grp.id, userIds: ["user_b"] })).status, 403);
    // Runs their own meeting, but is a moderator in the group: may call.
    const mod = await post(R.ringIn, "mods-room", "user_mod", { groupId: grp.id, userIds: ["user_a"] });
    assert.equal(mod.status, 200, JSON.stringify(mod.body));
    // Someone outside the group cannot use it, even for their own meeting.
    await meeting("outs-room", "user_out");
    assert.equal((await post(R.ringIn, "outs-room", "user_out", { groupId: grp.id, userIds: ["user_a"] })).status, 404);
  });

  await t("not once the meeting has ended", async () => {
    const r = await post(R.ringIn, "ended-room", "user_owner", { groupId: grp.id, userIds: ["user_a"] });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "meeting_not_open");
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
