// Run: npx tsx src/lib/__tests__/notifications.smoke.ts
// Call alerts against the in-memory fallback: what each notice says, how
// browsers are stored and dropped, what notifyInvitees delivers where, and
// what the service worker (public/sw.js, run in a sandbox) shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import type { NeoEvent } from "@/types/event";
import {
  saveSubscription, listDevices, removeSubscription, sendPush, deviceId, isPushConfigured, cleanSubscription,
  __setPushSender, MAX_DEVICES, type BrowserSubscription, type PushPayload,
} from "@/lib/pushStore";
import { addNotification, listNotifications, markRead, unreadCount, MAX_NOTIFICATIONS } from "@/lib/notificationStore";
import { noticePayload, pushOptionsFor, notifyInvitees, joinUrl } from "@/lib/groupNotify";
import { createGroup } from "@/lib/groupStore";
import { createGroupMeetings, cleanMeetingFields, inviteesOf, type CreateMeetingDeps } from "@/lib/groupMeetings";
import { getMember } from "@/lib/groupStore";

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.RESEND_API_KEY;

const VAPID_ENV = {
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
  VAPID_SUBJECT: "mailto:test@example.com",
};
const withVapid = () => Object.assign(process.env, VAPID_ENV);
const withoutVapid = () => { for (const k of Object.keys(VAPID_ENV)) delete process.env[k]; };

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };

const sub = (i: number | string): BrowserSubscription => ({
  endpoint: `https://push.example.com/send/${i}`,
  keys: { p256dh: `p256-${i}`, auth: `auth-${i}` },
});
const ctx = { senderUserId: "user_host", senderName: "Ada", origin: "https://neo.test" };
const ev = (over: Partial<NeoEvent> = {}): NeoEvent =>
  ({
    id: "e1", slug: "choir-practice", name: "Choir practice", ownerUserId: "user_owner", visibility: "private",
    waitingRoomEnabled: true, livekitRoom: "choir-practice", qrSeed: "x", roles: [], waitingRoom: [], recordings: [],
    state: "scheduled", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), groupId: "g1",
    groupMeeting: { kind: "scheduled", durationMin: 60, timezone: "UTC", createdBy: "user_host", sequence: 0 },
    ...over,
  }) as NeoEvent;

(async () => {
  console.log("notices");

  await t("each kind becomes the right push type, wording and link", () => {
    const scheduled = noticePayload([ev()], "scheduled", ctx);
    assert.equal(scheduled.type, "invite");
    assert.equal(scheduled.title, "Choir practice");
    assert.match(scheduled.body, /^Ada invited you · /);
    assert.equal(scheduled.url, "/choir-practice");
    assert.equal(scheduled.eventSlug, "choir-practice");
    assert.equal(scheduled.groupId, "g1");

    assert.equal(noticePayload([ev()], "updated", ctx).type, "updated");
    assert.match(noticePayload([ev()], "updated", ctx).title, /^Changed: /);

    const cancelled = noticePayload([ev(), ev({ id: "e2", slug: "choir-2" })], "cancelled", ctx);
    assert.equal(cancelled.type, "cancelled");
    assert.equal(cancelled.url, "/dashboard/groups/g1");
    assert.match(cancelled.body, /cancelled 2 meetings/);

    const live = ev({ state: "live", scheduledAt: undefined, startedAt: new Date().toISOString() });
    const started = noticePayload([live], "started", ctx);
    assert.equal(started.type, "started");
    assert.equal(started.url, "/room/choir-practice?event=choir-practice&join=1");
    assert.equal(started.url, joinUrl("choir-practice"));
    assert.equal(noticePayload([live], "added", ctx).url, joinUrl("choir-practice"));
    assert.equal(noticePayload([ev()], "added", ctx).url, "/choir-practice");   // not live yet: the meeting page
  });

  await t("joining-now notices are urgent and short-lived; invitations wait for a phone to come back", () => {
    const live = noticePayload([ev({ state: "live", startedAt: new Date().toISOString(), scheduledAt: undefined })], "started", ctx);
    const o1 = pushOptionsFor(live);
    assert.equal(o1.urgency, "high");
    assert.equal(o1.ttlSec, 15 * 60);
    const o2 = pushOptionsFor(noticePayload([ev()], "scheduled", ctx));
    assert.equal(o2.urgency, "normal");
    assert.ok(o2.ttlSec! > 86_400 && o2.ttlSec! <= 7 * 86_400);
    assert.ok(o2.topic && o2.topic.length <= 32 && /^[A-Za-z0-9_-]+$/.test(o2.topic));
  });

  console.log("browsers");

  await t("the same browser twice is one device, keeping when it first signed up", async () => {
    await saveSubscription("user_a", sub("same"), "Chrome", 1_000);
    await saveSubscription("user_a", sub("same"), "Chrome", 9_000);
    const devices = await listDevices("user_a");
    assert.equal(devices.size, 1);
    assert.equal(devices.get(deviceId(sub("same").endpoint))!.createdAt, 1_000);
  });

  await t("an 11th browser pushes out the oldest", async () => {
    for (let i = 0; i < MAX_DEVICES; i++) await saveSubscription("user_b", sub(`b${i}`), "UA", 100 + i);
    const { evicted } = await saveSubscription("user_b", sub("b-new"), "UA", 1_000);
    const devices = await listDevices("user_b");
    assert.equal(devices.size, MAX_DEVICES);
    assert.deepEqual(evicted, [deviceId(sub("b0").endpoint)]);
    assert.ok(!devices.has(deviceId(sub("b0").endpoint)));
    assert.ok(devices.has(deviceId(sub("b-new").endpoint)));
    assert.equal(await removeSubscription("user_b", sub("b-new").endpoint), true);
    assert.equal((await listDevices("user_b")).size, MAX_DEVICES - 1);
  });

  await t("only real https push subscriptions are accepted", () => {
    assert.equal(cleanSubscription({ endpoint: "http://x.test/1", keys: { p256dh: "a", auth: "b" } }), null);
    assert.equal(cleanSubscription({ endpoint: "https://x.test/1" }), null);
    assert.ok(cleanSubscription({ endpoint: "https://x.test/1", keys: { p256dh: "a", auth: "b" } }));
  });

  console.log("sending");

  await t("without VAPID keys push is skipped, not an error", async () => {
    withoutVapid();
    assert.equal(isPushConfigured(), false);
    const res = await sendPush("user_a", { type: "invite", title: "x", body: "y", url: "/" });
    assert.deepEqual(res, { configured: false, devices: [] });
  });

  await t("a 410 deletes that browser; the others record a delivery", async () => {
    withVapid();
    await saveSubscription("user_c", sub("c-live"), "UA");
    await saveSubscription("user_c", sub("c-dead"), "UA");
    const sent: string[] = [];
    __setPushSender(async (s, body) => {
      sent.push(s.endpoint);
      assert.equal((JSON.parse(body) as PushPayload).title, "Hello");
      if (s.endpoint.endsWith("c-dead")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      return { statusCode: 201 };
    });
    const res = await sendPush("user_c", { type: "invite", title: "Hello", body: "", url: "/" }, { topic: "t" });
    __setPushSender(null);
    assert.equal(sent.length, 2);
    const outcomes = Object.fromEntries(res.devices.map((d) => [d.id, d.outcome]));
    assert.equal(outcomes[deviceId(sub("c-dead").endpoint)], "gone");
    assert.equal(outcomes[deviceId(sub("c-live").endpoint)], "sent");
    const devices = await listDevices("user_c");
    assert.equal(devices.size, 1);
    assert.ok(devices.get(deviceId(sub("c-live").endpoint))!.lastOkAt > 0);
  });

  console.log("the bell");

  await t("newest first, capped at 100, unread counted and marked read", async () => {
    for (let i = 0; i < MAX_NOTIFICATIONS + 5; i++) {
      await addNotification("user_d", { type: "invite", title: `n${i}`, body: "", url: "/x" }, 1_000 + i);
    }
    const page = await listNotifications("user_d");
    assert.equal(page.items[0].title, `n${MAX_NOTIFICATIONS + 4}`);
    assert.equal(page.items.length, 20);
    assert.equal(page.nextCursor, 20);
    assert.equal(page.unread, MAX_NOTIFICATIONS);
    assert.equal(await markRead("user_d", { ids: [page.items[0].id, page.items[1].id] }), MAX_NOTIFICATIONS - 2);
    assert.equal(await markRead("user_d", { all: true }), 0);
    assert.equal(await unreadCount("user_d"), 0);
    const off = await addNotification("user_d", { type: "invite", title: "evil", body: "", url: "https://evil.test/" });
    assert.equal(off.url, "/dashboard");
  });

  console.log("notifyInvitees");

  await t("every invitee gets an in-app notice; only the one with a browser gets a push", async () => {
    withVapid();
    const g = await createGroup({ name: "Ushers" }, { userId: "user_o", name: "Owen" }, [
      { userId: "user_p", name: "Pat" },
      { userId: "user_q", name: "Quinn" },
      { userId: "user_r", name: "Rae" },
    ]);
    const deps: CreateMeetingDeps = { checkCap: async () => ({ blocked: false, used: 0, cap: 0, plan: "pro" }), incrementCap: async () => {}, applyRecurringRoles: async () => {} };
    const { events } = await createGroupMeetings(
      { group: g, creator: (await getMember(g.id, "user_o"))!, kind: "now", fields: cleanMeetingFields({ title: "Ushers now" }, "now"), origin: "https://neo.test" },
      deps
    );
    await saveSubscription("user_q", sub("q1"), "UA");
    const pushedTo: string[] = [];
    __setPushSender(async (s, body) => {
      pushedTo.push(s.endpoint);
      const p = JSON.parse(body) as PushPayload;
      assert.equal(p.type, "started");
      assert.equal(p.url, joinUrl(events[0].slug));
      return { statusCode: 201 };
    });
    const summary = await notifyInvitees(events[0], await inviteesOf(events[0], "user_o"), "started", { ...ctx, senderUserId: "user_o", senderName: "Owen" });
    __setPushSender(null);

    assert.deepEqual(pushedTo, [sub("q1").endpoint]);
    for (const uid of ["user_p", "user_q", "user_r"]) {
      const { items } = await listNotifications(uid);
      assert.equal(items.length, 1, uid);
      assert.equal(items[0].type, "started");
      assert.equal(items[0].url, joinUrl(events[0].slug));
    }
    assert.equal((await listNotifications("user_o")).items.length, 0);   // the starter is not told
    const byUser = Object.fromEntries(summary.results.map((r) => [r.userId, r.channels]));
    assert.equal(byUser.user_q.push, "sent");
    assert.equal(byUser.user_p.push, "unavailable");
    assert.equal(summary.sent, 3);
    withoutVapid();
  });

  console.log("service worker");

  // public/sw.js in a sandbox with a fake browser around it. Values made
  // inside it belong to another realm, so they are compared as plain copies.
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  function loadWorker(windows: Array<{ url: string; visibilityState: string; navigate?: (u: string) => Promise<unknown> }>) {
    const handlers: Record<string, (e: unknown) => void> = {};
    const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
    const opened: string[] = [];
    const messages: unknown[] = [];
    const focused: string[] = [];
    const clientsList = windows.map((w) => ({
      ...w,
      postMessage: (m: unknown) => messages.push(m),
      focus: async () => { focused.push(w.url); },
    }));
    const self = {
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
      skipWaiting: () => {},
      location: { origin: "https://neo.test" },
      registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
      clients: {
        matchAll: async () => clientsList,
        openWindow: async (u: string) => { opened.push(u); },
        claim: async () => {},
      },
    };
    vm.runInNewContext(readFileSync(join(process.cwd(), "public", "sw.js"), "utf8"), { self, URL, console, fetch: async () => ({}) });
    const fire = async (type: string, event: Record<string, unknown>) => {
      let pending: Promise<unknown> = Promise.resolve();
      handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; } });
      await pending;
    };
    const push = (p: Partial<PushPayload>) => fire("push", { data: { json: () => p, text: () => JSON.stringify(p) } });
    return { fire, push, shown, opened, messages, focused };
  }

  await t("an invite is shown as a system notification only when no tab is in view", async () => {
    const hidden = loadWorker([{ url: "https://neo.test/dashboard", visibilityState: "hidden" }]);
    await hidden.push({ type: "invite", title: "Choir", body: "b", url: "/choir", eventSlug: "choir" });
    assert.equal(hidden.shown.length, 1);
    assert.equal(hidden.shown[0].options.tag, "choir");
    assert.equal(hidden.shown[0].options.icon, "/icons/icon-192.png");
    assert.equal(hidden.shown[0].options.badge, "/icons/badge-96.png");
    assert.deepEqual(plain((hidden.shown[0].options.actions as Array<{ action: string }>).map((a) => a.action)), ["open"]);
    assert.equal(hidden.messages.length, 1);

    const visible = loadWorker([{ url: "https://neo.test/dashboard", visibilityState: "visible" }]);
    await visible.push({ type: "invite", title: "Choir", body: "b", url: "/choir", eventSlug: "choir" });
    assert.equal(visible.shown.length, 0);
    assert.deepEqual(plain(visible.messages), [{ kind: "neo-push", payload: { type: "invite", title: "Choir", body: "b", url: "/choir", eventSlug: "choir" } }]);
  });

  await t("a ring always shows, insists, and re-alerts; an expired push shows nothing", async () => {
    const w = loadWorker([{ url: "https://neo.test/x", visibilityState: "visible" }]);
    await w.push({ type: "ring", title: "Call", body: "", url: "/room/a?event=a&join=1", eventSlug: "a" });
    assert.equal(w.shown.length, 1);
    assert.equal(w.shown[0].options.requireInteraction, true);
    assert.equal(w.shown[0].options.renotify, true);
    await w.push({ type: "invite", title: "Old", body: "", url: "/", expiresAt: Date.now() - 1 });
    assert.equal(w.shown.length, 1);
    const none = loadWorker([]);
    await none.push({ type: "cancelled", title: "Off", body: "", url: "/dashboard" });
    assert.equal((none.shown[0].options.actions as unknown[]).length, 0);
  });

  await t("a click focuses an open tab and takes it there, else opens one; never off-site", async () => {
    const nav: string[] = [];
    const w = loadWorker([{ url: "https://neo.test/dashboard", visibilityState: "hidden", navigate: async (u) => { nav.push(u); } }]);
    const click = (url: string) => w.fire("notificationclick", { notification: { close: () => {}, data: { url } } });
    await click("/room/a?event=a&join=1");
    assert.deepEqual(w.focused, ["https://neo.test/dashboard"]);
    assert.deepEqual(nav, ["https://neo.test/room/a?event=a&join=1"]);

    const empty = loadWorker([]);
    await empty.fire("notificationclick", { notification: { close: () => {}, data: { url: "https://evil.test/" } } });
    assert.deepEqual(empty.opened, ["https://neo.test/dashboard"]);
  });

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
