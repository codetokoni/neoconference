// Run: npx tsx src/lib/__tests__/notificationClear.smoke.ts
// Clearing the bell (DELETE /api/me/notifications): one by one or all at
// once, through the stand-in Redis (apiV1-stubs/kv.mjs) and through the
// in-memory fallback, including a notification that arrives mid-clear.
import "./apiV1-stubs/install";
import assert from "node:assert/strict";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };

// The store loads its own copy of the stand-in kv module, so a command is
// intercepted through the hook every copy calls first (__kvFault), and a
// notification "arrives" by being pushed straight onto the shared list.
const g = globalThis as unknown as {
  __kvFault?: (method: string, args: unknown[]) => undefined;
  __kvStore: Map<string, unknown[]>;
  __who?: string | null;
};
function arriveBefore(method: string, uid: string, title: string) {
  g.__kvFault = (m) => {
    if (m !== method) return undefined;
    g.__kvFault = undefined;
    const list = g.__kvStore.get(`neo:notif:${uid}`) ?? [];
    list.unshift(JSON.stringify({ id: `late_${title}`, ts: Date.now(), type: "invite", title, body: "", url: "/x", read: false }));
    g.__kvStore.set(`neo:notif:${uid}`, list);
    return undefined;
  };
}

(async () => {
  // Through the stand-in Redis (installed above) from here on.
  process.env.KV_REST_API_URL = "https://kv.invalid";
  process.env.KV_REST_API_TOKEN = "stub";
  const store = await import("../notificationStore");
  const { DELETE } = await import("../../app/api/me/notifications/route");
  const add = (uid: string, title: string) =>
    store.addNotification(uid, { type: "invite", title, body: "", url: "/x" });
  const titles = async (uid: string) => (await store.listNotifications(uid)).items.map((i) => i.title);
  const del = (body: unknown) =>
    DELETE(new Request("https://neo.test/api/me/notifications", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

  console.log("redis");

  await t("one is cleared by id; the rest keep their order and the count follows", async () => {
    await add("u1", "a");
    const b = await add("u1", "b");
    await add("u1", "c");
    assert.equal(g.__kvStore.get("neo:notif:u1")?.length, 3, "stored in the stand-in Redis");
    assert.equal(await store.unreadCount("u1"), 3);
    assert.equal(await store.clearNotifications("u1", { ids: [b.id] }), 2);
    assert.deepEqual(await titles("u1"), ["c", "a"]);
    assert.equal(await store.unreadCount("u1"), 2);
  });

  await t("a read one cleared leaves the unread count alone", async () => {
    await store.clearNotifications("u1", { all: true });
    const x = await add("u1", "x");
    await add("u1", "y");
    await store.markRead("u1", { ids: [x.id] });
    assert.equal(await store.clearNotifications("u1", { ids: [x.id] }), 1);
    assert.deepEqual(await titles("u1"), ["y"]);
  });

  await t("all are cleared, and only that person's", async () => {
    await add("u2", "theirs");
    assert.equal(await store.clearNotifications("u1", { all: true }), 0);
    assert.deepEqual(await titles("u1"), []);
    assert.equal(await store.unreadCount("u1"), 0);
    assert.deepEqual(await titles("u2"), ["theirs"]);
  });

  await t("an unknown id clears nothing", async () => {
    await add("u3", "keep");
    assert.equal(await store.clearNotifications("u3", { ids: ["nope"] }), 1);
    assert.deepEqual(await titles("u3"), ["keep"]);
  });

  await t("one arriving during Clear all is kept", async () => {
    await add("u4", "old 1");
    await add("u4", "old 2");
    arriveBefore("llen", "u4", "arrived");
    await store.clearNotifications("u4", { all: true });
    assert.equal(g.__kvFault, undefined, "the arrival was injected");
    assert.deepEqual(await titles("u4"), ["arrived"]);
    assert.equal(await store.unreadCount("u4"), 1);
  });

  await t("one arriving while one is cleared shifts it; the right one still goes", async () => {
    await add("u5", "a");
    const b = await add("u5", "b");
    await add("u5", "c");
    arriveBefore("lindex", "u5", "arrived");
    await store.clearNotifications("u5", { ids: [b.id] });
    assert.equal(g.__kvFault, undefined, "the arrival was injected");
    assert.deepEqual(await titles("u5"), ["arrived", "c", "a"]);
  });

  console.log("route");

  await t("DELETE clears for whoever is signed in, and refuses a bad body", async () => {
    g.__who = null;
    assert.equal((await del({ all: true })).status, 401);
    g.__who = "u6";
    await add("u6", "a");
    const b = await add("u6", "b");
    await add("u7", "not yours");
    const one = await del({ ids: [b.id] });
    assert.equal(one.status, 200);
    assert.deepEqual(await one.json(), { ok: true, unread: 1 });
    assert.deepEqual(await titles("u6"), ["a"]);
    for (const bad of [{}, { ids: [] }, { ids: "x" }, { all: "yes" }]) {
      assert.equal((await del(bad)).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(await (await del({ all: true })).json(), { ok: true, unread: 0 });
    assert.deepEqual(await titles("u6"), []);
    assert.deepEqual(await titles("u7"), ["not yours"]);
  });

  console.log("in memory");
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  await t("one by id, then all, without Redis", async () => {
    await add("m1", "a");
    const b = await add("m1", "b");
    assert.equal(await store.clearNotifications("m1", { ids: [b.id] }), 1);
    assert.deepEqual(await titles("m1"), ["a"]);
    assert.equal(await store.clearNotifications("m1", { all: true }), 0);
    assert.deepEqual(await titles("m1"), []);
  });

  console.log(`\n${n} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
