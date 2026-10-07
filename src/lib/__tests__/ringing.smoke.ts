// Run: npx tsx src/lib/__tests__/ringing.smoke.ts
// The scheduler and the ring engine on a fake clock, against the in-memory
// fallback: reminders, rings and retries, answers, joins, cancels, the
// dispatch secret, and the service worker's Answer / Decline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { createGroup, getMember, updateGroup, addMembers, type Group } from "@/lib/groupStore";
import {
  createGroupMeetings, cleanMeetingFields, cancelGroupMeetings, updateGroupMeetings, addParticipants,
  type CreateMeetingDeps,
} from "@/lib/groupMeetings";
import { jobsFor, claimDue, scheduleJob } from "@/lib/scheduler";
import {
  runDispatch, getCalls, respondToRing, ringNow, ringAgain, ringNewMembers, __setKingsChatSender, STALE_RING_MS, shownStatus,
} from "@/lib/ringEngine";
import { recordAttendance } from "@/lib/attendance";
import { getPresence, setPresence } from "@/lib/presence";
import { listNotifications } from "@/lib/notificationStore";
import { saveSubscription, __setPushSender, type PushPayload } from "@/lib/pushStore";
import { authorizedDispatch, dispatchRefusal } from "@/lib/dispatchAuth";
import { eventStore } from "@/lib/eventStore";

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.RESEND_API_KEY;
Object.assign(process.env, {
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
  VAPID_SUBJECT: "mailto:test@example.com",
});

const MIN = 60_000;
const deps: CreateMeetingDeps = {
  checkCap: async () => ({ blocked: false, used: 0, cap: 0, plan: "pro" }),
  incrementCap: async () => {},
  applyRecurringRoles: async () => {},
};

// Every push and KingsChat message, recorded.
const pushes: Array<{ endpoint: string; payload: PushPayload }> = [];
__setPushSender(async (s, body) => {
  pushes.push({ endpoint: s.endpoint, payload: JSON.parse(body) });
  return { statusCode: 201 };
});
const kc: Array<{ to: string; text: string }> = [];
__setKingsChatSender(async (_from, to, text) => {
  kc.push({ to, text });
  return "sent";
});

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };

let seq = 0;
/** A fresh group: owner + the given members, rings every 3 min up to `max`. */
async function freshGroup(members: string[], max = 5): Promise<Group> {
  seq++;
  const g = await createGroup({ name: `Group ${seq}` }, { userId: `user_owner${seq}`, name: "Owner" }, members.map((m) => ({ userId: m, name: m })));
  return updateGroup(g.id, { settings: { retryIntervalMin: 3, maxAttempts: max } }, `user_owner${seq}`);
}
async function scheduleAt(g: Group, at: number, creator?: string) {
  // Each test owns the queue: earlier tests' meetings are due at the same times.
  await claimDue(Number.MAX_SAFE_INTEGER, 10_000);
  const c = (await getMember(g.id, creator ?? `user_owner${seq}`))!;
  const fields = cleanMeetingFields({ title: "Rehearsal", scheduledAt: new Date(at).toISOString(), timezone: "UTC" }, "scheduled");
  return (await createGroupMeetings({ group: g, creator: c, kind: "scheduled", fields, origin: "https://neo.test" }, deps)).events[0];
}
const status = async (eid: string, uid: string) => (await getCalls(eid)).get(uid);
/** The newest group's owner, as an actor. */
const ownerActor = () =>
  ({ userId: `user_owner${seq}`, emails: [], isPlatformAdmin: false, role: "owner" as const, isOwner: true, reason: "owner" as const });

(async () => {
  const T = Date.now() + 2 * 24 * 60 * MIN;   // a meeting two days out; the clock below is fake

  console.log("scheduling");

  await t("a meeting at T queues reminders at T-60 and T-30 and the first ring at T", async () => {
    const g = await freshGroup(["user_a1"]);
    const ev = await scheduleAt(g, T);
    const jobs = await jobsFor(ev.id);
    assert.deepEqual(jobs.map((j) => [j.type, j.fireAt]), [["remind60", T - 60 * MIN], ["remind30", T - 30 * MIN], ["ring", T]]);
  });

  await t("rescheduling moves the jobs; cancelling removes them all", async () => {
    const g = await freshGroup(["user_b1"]);
    const ev = await scheduleAt(g, T);
    const moved = T + 24 * 60 * MIN;
    await updateGroupMeetings(ev, { scheduledAt: new Date(moved).toISOString() }, "this", (await getMember(g.id, `user_owner${seq}`))!);
    assert.deepEqual((await jobsFor(ev.id)).map((j) => j.fireAt), [moved - 60 * MIN, moved - 30 * MIN, moved]);
    await cancelGroupMeetings((await eventStore.byId(ev.id))!, "this", (await getMember(g.id, `user_owner${seq}`))!);
    assert.deepEqual(await jobsFor(ev.id), []);
  });

  console.log("reminders and rings");

  await t("reminders reach every invitee; an unanswered member is rung at T, T+3, T+6 and stops at the limit", async () => {
    const g = await freshGroup(["user_c1"], 3);
    const ev = await scheduleAt(g, T);

    assert.equal((await runDispatch(T - 60 * MIN)).ran, 1);
    assert.equal((await runDispatch(T - 30 * MIN)).ran, 1);
    const reminders = (await listNotifications("user_c1")).items.filter((i) => i.type === "reminder");
    assert.deepEqual(reminders.map((r) => r.title).reverse(), ["Rehearsal starts in 1 hour", "Rehearsal starts in 30 minutes"]);

    await runDispatch(T);
    assert.equal((await status(ev.id, "user_c1"))!.attempts, 1);
    assert.equal((await status(ev.id, "user_c1"))!.status, "ringing");
    assert.deepEqual((await jobsFor(ev.id)).map((j) => [j.type, j.fireAt]), [["ring", T + 3 * MIN]]);

    await runDispatch(T + 3 * MIN);
    assert.equal((await status(ev.id, "user_c1"))!.attempts, 2);
    assert.equal((await listNotifications("user_c1")).items.filter((i) => i.type === "missed").length, 1);
    assert.deepEqual((await jobsFor(ev.id)).map((j) => j.fireAt), [T + 6 * MIN]);

    await runDispatch(T + 6 * MIN);
    assert.equal((await status(ev.id, "user_c1"))!.attempts, 3);
    assert.deepEqual(await jobsFor(ev.id), []);              // at the limit: nothing more queued
    const rings = (await listNotifications("user_c1")).items.filter((i) => i.type === "ring");
    assert.equal(rings.length, 3);
    assert.ok(rings[0].ringId && rings[0].expiresAt === T + 6 * MIN + 45_000);
    assert.equal(rings[0].url, `/room/${ev.slug}?event=${ev.slug}&join=1`);
  });

  await t("a decline stops that member only", async () => {
    const g = await freshGroup(["user_d1", "user_d2"]);
    const ev = await scheduleAt(g, T);
    await claimDue(T - 1);
    await runDispatch(T);
    await respondToRing(ev.id, "user_d1", "decline", T + MIN);
    await runDispatch(T + 3 * MIN);
    assert.equal((await status(ev.id, "user_d1"))!.status, "declined");
    assert.equal((await status(ev.id, "user_d1"))!.attempts, 1);
    assert.equal((await status(ev.id, "user_d2"))!.attempts, 2);
  });

  await t("a recorded join stops the retries", async () => {
    const g = await freshGroup(["user_e1"]);
    const ev = await scheduleAt(g, T);
    await claimDue(T - 1);
    await runDispatch(T);
    await recordAttendance(ev.id, { action: "join", userId: "user_e1#tab1", name: "E1", source: "webhook" });
    assert.equal((await status(ev.id, "user_e1"))!.status, "joined");
    await runDispatch(T + 3 * MIN);
    assert.equal((await status(ev.id, "user_e1"))!.attempts, 1);
    assert.deepEqual(await jobsFor(ev.id), []);
    // Whoever made the meeting is never rung by it.
    assert.equal(await status(ev.id, `user_owner${seq}`), undefined);
  });

  await t("someone already in the room is not rung; someone in another meeting is told quietly", async () => {
    const g = await freshGroup(["user_f1", "user_f2"]);
    const ev = await scheduleAt(g, T);
    await claimDue(T - 1);
    await setPresence("user_f1", { eventSlug: ev.slug, eventId: ev.id, ts: T });
    await setPresence("user_f2", { eventSlug: "other", eventId: "other-id", ts: T });
    const before = pushes.length;
    await runDispatch(T);
    assert.equal((await status(ev.id, "user_f1"))!.status, "joined");
    assert.equal((await status(ev.id, "user_f2"))!.status, "busy");
    assert.equal(pushes.length, before);                       // nobody's phone rang
    assert.match((await listNotifications("user_f2")).items[0].body, /another meeting/);
  });

  await t("a ring job more than 2 minutes late is skipped: the ringing are marked missed, the next round is queued", async () => {
    const g = await freshGroup(["user_g1"]);
    const ev = await scheduleAt(g, T);
    await claimDue(T - 1);
    await runDispatch(T);
    const late = T + 3 * MIN + STALE_RING_MS + MIN;
    const res = await runDispatch(late);
    assert.equal(res.skipped, 1);
    assert.equal((await status(ev.id, "user_g1"))!.status, "missed");
    assert.equal((await status(ev.id, "user_g1"))!.attempts, 1);
    assert.deepEqual((await jobsFor(ev.id)).map((j) => j.fireAt), [late + 3 * MIN]);
  });

  console.log("ringing now");

  await t("Start now rings everyone but the starter; Add participants rings only the new people", async () => {
    const g = await freshGroup(["user_h1", "user_h2"]);
    const owner = (await getMember(g.id, `user_owner${seq}`))!;
    const { events } = await createGroupMeetings(
      { group: g, creator: owner, kind: "now", fields: cleanMeetingFields({ title: "Now" }, "now"), origin: "https://neo.test" },
      deps
    );
    const ev = events[0];
    const round = await ringNow(ev.id, { except: owner.userId });
    assert.deepEqual(round.rung.sort(), ["user_h1", "user_h2"]);

    const g2 = await freshGroup(["user_i1", "user_i2", "user_i3"]);
    const o2 = (await getMember(g2.id, `user_owner${seq}`))!;
    const call = (await createGroupMeetings(
      { group: g2, creator: o2, kind: "call", fields: cleanMeetingFields({ title: "Call" }, "call"), callUserIds: ["user_i1"], origin: "https://neo.test" },
      deps
    )).events[0];
    assert.deepEqual((await ringNow(call.id, { except: o2.userId })).rung, ["user_i1"]);
    const added = await addParticipants(call, [{ userId: "user_i2" }], o2);
    const next = await ringNow(call.id, { only: added.map((a) => a.userId!) });
    assert.deepEqual(next.rung, ["user_i2"]);
    assert.equal((await status(call.id, "user_i1"))!.attempts, 1);
  });

  await t("Ring again starts someone's count over", async () => {
    const g = await freshGroup(["user_j1"], 1);
    const owner = (await getMember(g.id, `user_owner${seq}`))!;
    const ev = (await createGroupMeetings(
      { group: g, creator: owner, kind: "now", fields: cleanMeetingFields({ title: "Again" }, "now"), origin: "https://neo.test" },
      deps
    )).events[0];
    await ringNow(ev.id, { except: owner.userId, now: T });
    assert.deepEqual((await ringNow(ev.id, { except: owner.userId, now: T + MIN })).rung, []);   // at its limit of 1
    assert.deepEqual((await ringAgain(ev.id, ["user_j1"], T + 2 * MIN)).rung, ["user_j1"]);
  });

  await t("someone who joined and left shows as left, and only Ring again reaches them", async () => {
    const g = await freshGroup(["user_jl"]);
    const owner = (await getMember(g.id, `user_owner${seq}`))!;
    const ev = (await createGroupMeetings(
      { group: g, creator: owner, kind: "now", fields: cleanMeetingFields({ title: "Back" }, "now"), origin: "https://neo.test" },
      deps
    )).events[0];
    const shown = async (now: number) =>
      shownStatus((await status(ev.id, "user_jl"))!, await getPresence("user_jl", now), ev.id, now);
    await ringNow(ev.id, { except: owner.userId, now: T });
    await recordAttendance(ev.id, { action: "join", userId: "user_jl", name: "JL", source: "webhook", ts: T + MIN });

    // Just in, before the first heartbeat: here, not gone.
    assert.equal(await shown(T + MIN + 30_000), "joined");
    // In the meeting by its heartbeat: Ring again leaves them alone.
    await setPresence("user_jl", { eventSlug: ev.slug, eventId: ev.id, ts: T + 2 * MIN });
    assert.equal(await shown(T + 2 * MIN + 30_000), "joined");
    assert.deepEqual((await ringAgain(ev.id, ["user_jl"], T + 2 * MIN + 30_000)).rung, []);

    // Gone: the heartbeat stopped and its 90 s ran out.
    const gone = T + 5 * MIN;
    assert.equal(await shown(gone), "left");
    // The automatic rounds still treat them as settled.
    assert.deepEqual((await ringNow(ev.id, { except: owner.userId, now: gone })).rung, []);
    // The host's Ring again rings them, from a fresh count.
    assert.deepEqual((await ringAgain(ev.id, ["user_jl"], gone)).rung, ["user_jl"]);
    const after = (await status(ev.id, "user_jl"))!;
    assert.equal(after.status, "ringing");
    assert.equal(after.attempts, 1);

    // Back in: joined again, with the grace starting over.
    await recordAttendance(ev.id, { action: "join", userId: "user_jl", name: "JL", source: "webhook", ts: gone + MIN });
    assert.equal(await shown(gone + MIN + 30_000), "joined");
  });

  await t("someone in another meeting is not shown as left from this one", async () => {
    const g = await freshGroup(["user_jo"]);
    const owner = (await getMember(g.id, `user_owner${seq}`))!;
    const ev = (await createGroupMeetings(
      { group: g, creator: owner, kind: "now", fields: cleanMeetingFields({ title: "Here" }, "now"), origin: "https://neo.test" },
      deps
    )).events[0];
    await ringNow(ev.id, { except: owner.userId, now: T });
    await recordAttendance(ev.id, { action: "join", userId: "user_jo", name: "JO", source: "webhook", ts: T + MIN });
    // Now in a different meeting: gone from this one.
    await setPresence("user_jo", { eventSlug: "elsewhere", eventId: "other-event", ts: T + 5 * MIN });
    const c = (await status(ev.id, "user_jo"))!;
    assert.equal(shownStatus(c, await getPresence("user_jo", T + 5 * MIN), ev.id, T + 5 * MIN), "left");
  });

  console.log("people who arrive late");

  await t("a late ring job when everyone has since joined queues nothing more", async () => {
    const g = await freshGroup(["user_l1"]);
    const ev = await scheduleAt(g, T);
    await claimDue(T - 1);
    await runDispatch(T);
    await recordAttendance(ev.id, { action: "join", userId: "user_l1", name: "L1", source: "webhook" });
    await scheduleJob(ev.id, "ring", T + 3 * MIN, { attempt: 2 });
    const res = await runDispatch(T + 3 * MIN + STALE_RING_MS + MIN);
    assert.equal(res.skipped, 1);
    assert.deepEqual(await jobsFor(ev.id), []);
  });

  await t("someone who joins the group mid-call is rung next round, even as the only one left", async () => {
    const g = await freshGroup(["user_m1"]);
    const ev = await scheduleAt(g, T);
    await claimDue(T - 1);
    await runDispatch(T);
    await respondToRing(ev.id, "user_m1", "decline", T + MIN);
    // Added without the route's immediate ring, so only the rounds can reach them.
    await addMembers(g.id, [{ userId: "user_m2", name: "M2" }], ownerActor());
    // The round due at T+3 runs late: no one rung before is still due, but
    // the newcomer has never been rung, so another round is queued for them.
    const late = T + 3 * MIN + STALE_RING_MS + MIN;
    await runDispatch(late);
    const next = await jobsFor(ev.id);
    assert.deepEqual(next.map((j) => j.fireAt), [late + 3 * MIN]);
    await runDispatch(late + 3 * MIN);
    assert.equal((await status(ev.id, "user_m2"))!.attempts, 1);
    assert.equal((await status(ev.id, "user_m1"))!.status, "declined");
  });

  await t("joining a group while its meeting is on rings you into it at once (not into private calls)", async () => {
    const g = await freshGroup(["user_n1"]);
    const owner = (await getMember(g.id, `user_owner${seq}`))!;
    const live = (await createGroupMeetings(
      { group: g, creator: owner, kind: "now", fields: cleanMeetingFields({ title: "On now" }, "now"), origin: "https://neo.test" },
      deps
    )).events[0];
    const call = (await createGroupMeetings(
      { group: g, creator: owner, kind: "call", fields: cleanMeetingFields({ title: "Private" }, "call"), callUserIds: ["user_n1"], origin: "https://neo.test" },
      deps
    )).events[0];
    await addMembers(g.id, [{ userId: "user_n2", name: "N2" }], ownerActor());
    assert.equal(await ringNewMembers(g.id, ["user_n2"]), 1);
    assert.equal((await status(live.id, "user_n2"))!.status, "ringing");
    assert.equal(await status(call.id, "user_n2"), undefined);
  });

  console.log("KingsChat");

  await t("KingsChat fires once per person per meeting: at ring 1 without a browser, at ring 2 with one", async () => {
    const g = await freshGroup(["user_k1", "user_k2"]);
    await saveSubscription("user_k2", { endpoint: "https://push.example.com/k2", keys: { p256dh: "p", auth: "a" } }, "UA");
    const ev = await scheduleAt(g, T);
    await claimDue(T - 1);
    const sentTo = () => kc.filter((m) => m.text.includes(ev.slug)).map((m) => m.to);
    await runDispatch(T);
    assert.deepEqual(sentTo(), ["user_k1"]);
    await runDispatch(T + 3 * MIN);
    assert.deepEqual(sentTo().sort(), ["user_k1", "user_k2"]);
    await runDispatch(T + 6 * MIN);
    await runDispatch(T + 9 * MIN);
    assert.deepEqual(sentTo().sort(), ["user_k1", "user_k2"]);
    assert.ok(kc.find((m) => m.to === "user_k1")!.text.includes(`/room/${ev.slug}?event=${ev.slug}&join=1`));
  });

  console.log("dispatch");

  await t("two dispatches at once run each job once", async () => {
    await claimDue(T + 365 * 24 * 60 * MIN);   // empty the queue
    await scheduleJob("evt-x", "remind60", T);
    await scheduleJob("evt-y", "remind30", T);
    const [a, b] = await Promise.all([claimDue(T), claimDue(T)]);
    assert.equal(a.length + b.length, 2);
    assert.equal(new Set([...a, ...b].map((j) => j.id)).size, 2);

    await scheduleJob("evt-z", "remind60", T);
    const [r1, r2] = await Promise.all([runDispatch(T), runDispatch(T)]);
    assert.equal(Number(r1.locked === true) + Number(r2.locked === true), 1);
    assert.equal(r1.ran + r1.skipped + r2.ran + r2.skipped, 1);
  });

  await t("the dispatch route refuses a wrong or missing secret with 401", async () => {
    assert.equal(authorizedDispatch("Bearer right", ["right", undefined]), true);
    assert.equal(authorizedDispatch("Bearer right", [undefined, "right"]), true);   // CRON_SECRET
    assert.equal(authorizedDispatch("Bearer wrong", ["right", undefined]), false);
    assert.equal(authorizedDispatch(null, ["right"]), false);
    assert.equal(authorizedDispatch("Bearer ", [undefined, undefined]), false);
    // A secret pasted into the dashboard with a trailing newline still matches.
    assert.equal(authorizedDispatch("Bearer right", ["right\n", undefined]), true);
    assert.equal(authorizedDispatch("Bearer right", ["   ", undefined]), false);
    // The log says which side is wrong, without the values.
    assert.equal(dispatchRefusal(null, { DISPATCH_SECRET: "right" }), "no Bearer token sent");
    assert.equal(dispatchRefusal("Bearer x", { DISPATCH_SECRET: undefined, CRON_SECRET: " " }), "none of DISPATCH_SECRET, CRON_SECRET is set");
    const why = dispatchRefusal("Bearer wrong!", { DISPATCH_SECRET: "right\n", CRON_SECRET: undefined });
    assert.equal(why, "token of 6 chars matches no secret (DISPATCH_SECRET is 5 chars)");
    assert.ok(!why.includes("right") && !why.includes("wrong"));
    process.env.DISPATCH_SECRET = "right";
    const { POST } = await import("@/app/api/internal/dispatch/route");
    const bad = await POST(new Request("https://neo.test/api/internal/dispatch", { method: "POST", headers: { authorization: "Bearer wrong" } }));
    assert.equal(bad.status, 401);
    const good = await POST(new Request("https://neo.test/api/internal/dispatch", { method: "POST", headers: { authorization: "Bearer right" } }));
    assert.equal(good.status, 200);
    delete process.env.DISPATCH_SECRET;
  });

  console.log("service worker");

  await t("a ring notification offers Answer and Decline; Decline tells the server, Answer opens the room", async () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const shown: Array<Record<string, unknown>> = [];
    const posted: Array<{ url: string; body: string }> = [];
    const opened: string[] = [];
    const self = {
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
      skipWaiting: () => {},
      location: { origin: "https://neo.test" },
      registration: { showNotification: async (_t: string, o: Record<string, unknown>) => { shown.push(o); } },
      clients: { matchAll: async () => [], openWindow: async (u: string) => { opened.push(u); }, claim: async () => {} },
    };
    const fetch = async (url: string, init: { body: string }) => {
      posted.push({ url, body: init.body });
      return { ok: true, json: async () => ({ roomUrl: "/room/a?event=a&join=1" }) };
    };
    vm.runInNewContext(readFileSync(join(process.cwd(), "public", "sw.js"), "utf8"), { self, URL, console, fetch });
    const fire = async (type: string, event: Record<string, unknown>) => {
      let pending: Promise<unknown> = Promise.resolve();
      handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; } });
      await pending;
    };
    const ring = { type: "ring", title: "Choir: Practice", body: "Ada is calling", url: "/room/a?event=a&join=1", eventSlug: "a", ringId: "r1", expiresAt: Date.now() + 45_000 };
    await fire("push", { data: { json: () => ring } });
    assert.deepEqual(JSON.parse(JSON.stringify(shown[0].actions)), [{ action: "answer", title: "Answer" }, { action: "decline", title: "Decline" }]);

    await fire("notificationclick", { action: "decline", notification: { close: () => {}, data: ring } });
    assert.equal(posted[0].url, "/api/events/a/call-response");
    assert.deepEqual(JSON.parse(posted[0].body), { action: "decline", ringId: "r1" });
    assert.deepEqual(opened, []);

    await fire("notificationclick", { action: "", notification: { close: () => {}, data: ring } });   // the body = Answer
    assert.deepEqual(JSON.parse(posted[1].body), { action: "answer", ringId: "r1" });
    assert.deepEqual(opened, ["https://neo.test/room/a?event=a&join=1"]);
  });

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
