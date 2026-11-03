// Run: npx tsx src/lib/__tests__/deviceSessions.smoke.ts
//
// One device at a time (owner, 2026-11-03): signing in on another device
// signs the account out of the previous one, which is refused at once and
// told why; "Allow login on multiple devices" (off by default) lets several
// stay; turning it off keeps this device and signs out the rest; the device
// list signs out one device or all the others. Driven through the real
// middleware and routes, with Clerk and KV stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "t",
  CLERK_SECRET_KEY: "sk_test_devices",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
});
delete process.env.LIVEKIT_URL;

type S = { id: string; status: string; createdAt?: number; lastActiveAt?: number; actor?: unknown };
type G = typeof globalThis & {
  __users: Record<string, { emails?: string[] }>;
  __who?: string;
  __sid?: string;
  __kvTtl?: boolean;
  __clerkSessions: Record<string, S[]>;
  __clerkDown?: boolean;
  __lkParticipants?: Record<string, { identity: string; joinedAt: number }[]>;
  __lkRemoved?: { room: string; identity: string }[];
};
const g = globalThis as G;
g.__kvTtl = true;
g.__users = {
  user_ada: { emails: ["ada@example.com"] },
  user_bo: { emails: ["bo@example.com"] },
  user_cy: { emails: ["cy@example.com"] },
  user_host: { emails: ["host@example.com"] },
};
g.__clerkSessions = { user_ada: [], user_bo: [], user_cy: [] };

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
/** Past the middleware's memory of sessions it saw lately. */
const tick = (ms = 11_000) => {
  skew += ms;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const APP = "Dart/3.8 (dart:io)";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const OTHER = "This device was signed out from your account on another device.";
const OTHER_DEVICE = "You have been signed out because your account was signed in on another device.";

async function main() {
  const D = await import("../deviceSessions");
  const sessionStore = await import("../sessionStore");
  const { NextRequest } = await import("next/server");
  const middleware = (await import("../../middleware")).default as unknown as (req: InstanceType<typeof NextRequest>, ev: unknown) => Promise<Response | undefined>;
  const devicesRoute = await import("../../app/api/auth/devices/route");
  const reasonRoute = await import("../../app/api/auth/signed-out-reason/route");

  let seq = 0;
  /** A sign-in at Clerk: a new active session for the account, created `at`. */
  const signIn = (userId: string, at: number): string => {
    const id = `sess_${userId.replace(/[^A-Za-z0-9]/g, "")}${String(++seq).padStart(8, "0")}`;
    g.__clerkSessions[userId].push({ id, status: "active", createdAt: at, lastActiveAt: at });
    return id;
  };
  const statusOf = (userId: string, id: string) => g.__clerkSessions[userId].find((s) => s.id === id)?.status;
  const as = (userId: string, sid: string) => {
    g.__who = userId;
    g.__sid = sid;
  };

  // What middleware leaves running after it answers (event.waitUntil), and
  // its call to its own site, answered by the real route instead of the network.
  const deviceMeetingsRoute = await import("../../app/api/auth/device-meetings/route");
  const tokenRoute = await import("../../app/api/livekit/token/route");
  const pending: Promise<unknown>[] = [];
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // The route asks for no sign-in, so who the test is signed in as does not matter.
    if (url.endsWith("/api/auth/device-meetings")) return deviceMeetingsRoute.POST(new NextRequest(url, init as never));
    return realFetch(input, init);
  }) as typeof fetch;

  /** A request through the middleware from this device; its response, if it answered. */
  const visit = async (userId: string, sid: string, path: string, ua = CHROME_WIN) => {
    as(userId, sid);
    const res = await middleware(
      new NextRequest(`https://neolinguameet.com${path}`, { headers: { host: "neolinguameet.com", "user-agent": ua, "x-real-ip": "203.0.113.7" } }),
      { waitUntil: (p: Promise<unknown>) => pending.push(p) },
    );
    return res ?? null;
  };
  const refused = async (res: Response | null) => (res && res.status === 401 ? ((await res.json()) as J) : null);

  const devices = async (userId: string, sid: string, body?: J) => {
    as(userId, sid);
    const res = body
      ? await devicesRoute.POST(new NextRequest("https://neolinguameet.com/api/auth/devices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
      : await devicesRoute.GET();
    return { status: res.status, body: (await res.json()) as J };
  };
  const reason = async (sid: string) => {
    g.__who = undefined;
    const res = await reasonRoute.GET(new NextRequest(`https://neolinguameet.com/api/auth/signed-out-reason?session=${sid}`));
    return (await res.json()) as J;
  };

  const before = D.ONE_DEVICE_SINCE - 86_400_000;
  const after = (minutes: number) => D.ONE_DEVICE_SINCE + minutes * 60_000;

  await t("devices signed in before the rule all stay signed in when they come back", async () => {
    const laptop = signIn("user_bo", before);
    const phone = signIn("user_bo", before + 1000);
    assert.equal(await visit("user_bo", laptop, "/api/auth/devices"), null);
    assert.equal(await visit("user_bo", phone, "/api/auth/devices", APP), null);
    assert.equal(statusOf("user_bo", laptop), "active");
    assert.equal(statusOf("user_bo", phone), "active");
  });

  let laptop = "";
  let phone = "";
  await t("signing in on the phone signs the laptop out; the laptop is refused at once and told why", async () => {
    laptop = signIn("user_ada", after(1));
    assert.equal(await visit("user_ada", laptop, "/dashboard"), null);
    // The website's own device cookie, made from the laptop's Clerk session.
    const fp = await sessionStore.generateDeviceFingerprint(CHROME_WIN);
    const cookie = await sessionStore.createSession("user_ada", { ip: null, fingerprint: fp, userAgent: CHROME_WIN, clerkSessionId: laptop });

    phone = signIn("user_ada", after(5));
    assert.equal(await visit("user_ada", phone, "/api/events", APP), null);
    assert.equal(statusOf("user_ada", laptop), "revoked", "revoked at Clerk");
    assert.equal(statusOf("user_ada", phone), "active");

    // Its token would still pass Clerk for up to a minute; the server refuses it.
    const api = await refused(await visit("user_ada", laptop, "/api/events"));
    assert.deepEqual(api, { error: "signed_out", reason: "other_device", message: OTHER_DEVICE });
    const page = await visit("user_ada", laptop, "/dashboard");
    assert.equal(page?.status, 307);
    assert.equal(new URL(page!.headers.get("location")!).pathname + new URL(page!.headers.get("location")!).search, "/sign-in?signed_out=other_device");
    // Public pages too, and after any wait.
    tick(3_600_000);
    assert.equal((await refused(await visit("user_ada", laptop, "/api/app/latest")))?.reason, "other_device");
    assert.equal((await sessionStore.validateSession(cookie, null, fp, CHROME_WIN)).status, "invalid", "the device cookie went with it");

    assert.deepEqual(await reason(laptop), { reason: "other_device", message: OTHER_DEVICE });
    assert.deepEqual(await reason(phone), { reason: null, message: null });
    assert.deepEqual(await reason("not-a-session"), { reason: null, message: null });
  });

  await t("the signed-out device can still reach sign-in, sign-out and the reason", async () => {
    for (const p of ["/sign-in?signed_out=other_device", "/sign-out", "/api/auth/signed-out-reason?session=" + laptop]) {
      const res = await visit("user_ada", laptop, p);
      assert.ok(!res || (res.status !== 401 && !String(res.headers.get("location")).includes("signed_out")), p);
    }
  });

  await t("the phone stays signed in however long it is away (a hidden tab or minimised app is not a sign-out)", async () => {
    tick(6 * 3_600_000);
    assert.equal(await visit("user_ada", phone, "/api/events", APP), null);
    tick(30 * 86_400_000);
    assert.equal(await visit("user_ada", phone, "/dashboard", APP), null);
    assert.equal(statusOf("user_ada", phone), "active");
  });

  await t("the device list shows the account's devices, this one first, labelled", async () => {
    const r = await devices("user_ada", phone);
    assert.equal(r.status, 200);
    assert.equal(r.body.multiDevice, false, "off by default");
    assert.deepEqual(
      r.body.devices.map((d: J) => [d.label, d.current, d.ip]),
      [["NeoLinguaMeet app", true, "203.0.113.7"]],
    );
  });

  let tablet = "";
  await t("with multiple devices allowed, a new sign-in leaves the others signed in", async () => {
    const on = await devices("user_ada", phone, { action: "multi", on: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.multiDevice, true);
    tablet = signIn("user_ada", after(60));
    assert.equal(await visit("user_ada", tablet, "/api/events", SAFARI_IPHONE), null);
    tick();
    assert.equal(await visit("user_ada", phone, "/api/events", APP), null);
    assert.equal(statusOf("user_ada", phone), "active");
    const list = await devices("user_ada", tablet);
    assert.deepEqual(
      list.body.devices.map((d: J) => [d.label, d.current]),
      [
        ["Safari on iPhone", true],
        ["NeoLinguaMeet app", false],
      ],
    );
  });

  await t("signing out one device from the list ends it, and it is told so", async () => {
    const r = await devices("user_ada", phone, { action: "sign_out", id: tablet });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(statusOf("user_ada", tablet), "revoked");
    assert.deepEqual(r.body.devices.map((d: J) => d.label), ["NeoLinguaMeet app"]);
    tick();
    assert.deepEqual(await refused(await visit("user_ada", tablet, "/api/events", SAFARI_IPHONE)), {
      error: "signed_out",
      reason: "elsewhere",
      message: OTHER,
    });
    assert.equal((await reason(tablet)).message, OTHER);
  });

  await t("this device and other accounts' devices cannot be signed out from the list", async () => {
    assert.equal((await devices("user_ada", phone, { action: "sign_out", id: phone })).body.error, "this_device");
    const bos = g.__clerkSessions.user_bo[0].id;
    assert.equal((await devices("user_ada", phone, { action: "sign_out", id: bos })).status, 404);
    assert.equal(statusOf("user_bo", bos), "active");
    assert.equal((await devices("user_ada", phone, { action: "explode" })).status, 400);
  });

  await t("sign out all other devices keeps only this one", async () => {
    const a = signIn("user_ada", after(70));
    const b = signIn("user_ada", after(71));
    await visit("user_ada", a, "/api/events");
    await visit("user_ada", b, "/api/events");
    const r = await devices("user_ada", phone, { action: "sign_out_others" });
    assert.deepEqual(r.body.devices.map((d: J) => d.current), [true]);
    assert.equal(statusOf("user_ada", a), "revoked");
    assert.equal(statusOf("user_ada", b), "revoked");
    assert.equal(statusOf("user_ada", phone), "active");
  });

  await t("turning multiple devices off keeps this device and signs out the rest", async () => {
    const other = signIn("user_ada", after(80));
    await visit("user_ada", other, "/api/events");
    assert.equal(statusOf("user_ada", other), "active", "still allowed");
    const off = await devices("user_ada", phone, { action: "multi", on: false });
    assert.equal(off.body.multiDevice, false);
    assert.equal(statusOf("user_ada", other), "revoked");
    assert.equal(statusOf("user_ada", phone), "active");
    assert.equal((await reason(other)).reason, "elsewhere");
    // And the next sign-in is one device again.
    const next = signIn("user_ada", after(90));
    await visit("user_ada", next, "/api/events");
    assert.equal(statusOf("user_ada", phone), "revoked");
    phone = next;
  });

  await t("two devices signing in at the same moment: the later sign-in stays, whichever is seen first", async () => {
    for (const laterFirst of [true, false]) {
      const early = signIn("user_ada", after(100 + (laterFirst ? 0 : 10)));
      const late = signIn("user_ada", after(101 + (laterFirst ? 0 : 10)));
      const order = laterFirst ? [late, early] : [early, late];
      for (const sid of order) await visit("user_ada", sid, "/api/events");
      assert.equal(statusOf("user_ada", late), "active", `later first: ${laterFirst}`);
      assert.equal(statusOf("user_ada", early), "revoked", `later first: ${laterFirst}`);
      phone = late;
    }
  });

  await t("an administrator acting as the user signs nobody out", async () => {
    const id = `sess_actor${String(++seq).padStart(8, "0")}`;
    g.__clerkSessions.user_ada.push({ id, status: "active", createdAt: after(200), lastActiveAt: after(200), actor: { sub: "user_admin" } });
    await visit("user_ada", id, "/api/events");
    assert.equal(statusOf("user_ada", phone), "active");
    assert.ok(!(await devices("user_ada", phone)).body.devices.some((d: J) => d.id === id), "not listed as a device");
  });

  await t("Clerk unreachable at a sign-in lets the request through, and the next request signs the others out", async () => {
    const fresh = signIn("user_ada", after(300));
    g.__clerkDown = true;
    assert.equal(await visit("user_ada", fresh, "/api/events"), null);
    assert.equal(statusOf("user_ada", phone), "active");
    g.__clerkDown = false;
    tick();
    assert.equal(await visit("user_ada", fresh, "/api/events"), null);
    assert.equal(statusOf("user_ada", phone), "revoked");
    phone = fresh;
  });

  // Signed out elsewhere means out of the meeting too (owner, 2026-11-03).
  const { eventStore } = await import("../eventStore");
  const ROOM = "sunday-prayer";
  const at = new Date().toISOString();
  await eventStore.create({
    id: "ev_prayer", slug: ROOM, name: "Sunday prayer", ownerUserId: "user_host", ownerEmail: "host@example.com",
    visibility: "public", state: "live", startedAt: at, createdAt: at, updatedAt: at, livekitRoom: ROOM, qrSeed: "x",
    roles: [], waitingRoomEnabled: false, waitForHost: false,
  } as unknown as Parameters<typeof eventStore.create>[0]);
  /** This device asks for a meeting token, as the website and the app do, and is then in the room. */
  const join = async (userId: string, sid: string, nonce: string) => {
    as(userId, sid);
    const res = await tokenRoute.GET(new NextRequest(`https://neolinguameet.com/api/livekit/token?room=${ROOM}&event=${ROOM}&nonce=${nonce}`));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const identity = `${userId}#${nonce}`;
    ((g.__lkParticipants ??= {})[ROOM] ??= []).push({ identity, joinedAt: Math.floor(Date.now() / 1000) });
    return identity;
  };
  const inRoom = () => (g.__lkParticipants?.[ROOM] ?? []).map((p) => p.identity).sort();

  await t("a device in a meeting is taken out of it when the account signs in on another device", async () => {
    const laptop = signIn("user_cy", after(400));
    await visit("user_cy", laptop, "/dashboard");
    const onLaptop = await join("user_cy", laptop, "laptop1");
    await join("user_host", "sess_hostAAAAAAAAAA", "host1");
    tick(60_000);
    const phone = signIn("user_cy", after(401));
    assert.equal(await visit("user_cy", phone, "/api/events", APP), null);
    await settle();
    assert.deepEqual(g.__lkRemoved, [{ room: ROOM, identity: onLaptop }]);
    assert.deepEqual(inRoom(), ["user_host#host1"], "the host stays");
    // The phone joins the same meeting and is not touched by a second pass.
    const onPhone = await join("user_cy", phone, "phone1");
    assert.deepEqual((await (await deviceMeetingsRoute.POST(new NextRequest("https://neolinguameet.com/api/auth/device-meetings", { method: "POST", body: JSON.stringify({ sessions: [laptop] }) }))).json()), { removed: 0 });
    assert.deepEqual(inRoom(), [onPhone, "user_host#host1"].sort());
  });

  await t("the public route acts only on signed-out sessions: an active one is never taken out", async () => {
    const phone = g.__clerkSessions.user_cy.at(-1)!.id;
    const res = await deviceMeetingsRoute.POST(new NextRequest("https://neolinguameet.com/api/auth/device-meetings", { method: "POST", body: JSON.stringify({ sessions: [phone, "sess_hostAAAAAAAAAA", "junk"] }) }));
    assert.deepEqual(await res.json(), { removed: 0 });
    assert.equal(inRoom().length, 2);
    assert.equal((await deviceMeetingsRoute.POST(new NextRequest("https://neolinguameet.com/api/auth/device-meetings", { method: "POST", body: "{}" }))).status, 400);
  });

  await t("someone on the same identity who joined after the sign-out is a newer device and stays", async () => {
    g.__lkRemoved = [];
    const tablet = signIn("user_cy", after(410));
    const onTablet = await join("user_cy", tablet, "shared");
    tick(60_000);
    const next = signIn("user_cy", after(411));
    assert.equal(await visit("user_cy", next, "/api/events"), null);
    // Before the removal runs, the new device rejoins on the very same identity.
    for (const p of g.__lkParticipants![ROOM]) if (p.identity === onTablet) p.joinedAt = Math.floor(Date.now() / 1000) + 5;
    await settle();
    assert.ok(!g.__lkRemoved.some((r) => r.identity === onTablet), JSON.stringify(g.__lkRemoved));
    assert.ok(inRoom().includes(onTablet));
  });

  await t("signing out a device from the list takes it out of its meeting too", async () => {
    g.__lkRemoved = [];
    const cur = g.__clerkSessions.user_cy.at(-1)!.id;
    await devices("user_cy", cur, { action: "multi", on: true });
    const other = signIn("user_cy", after(420));
    await visit("user_cy", other, "/api/events");
    const onOther = await join("user_cy", other, "other1");
    tick(60_000);
    const r = await devices("user_cy", cur, { action: "sign_out", id: other });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(g.__lkRemoved, [{ room: ROOM, identity: onOther }]);
  });

  await t("erasing the account removes what was kept about its devices", async () => {
    const { kv } = await import("../kv");
    assert.ok(((await kv.smembers("neo:device-sids:user_ada")) as string[]).length > 3);
    await devices("user_ada", phone, { action: "multi", on: true });
    assert.ok((await D.forgetDevices("user_ada", true)) > 3);
    await D.forgetDevices("user_ada");
    assert.deepEqual(await kv.smembers("neo:device-sids:user_ada"), []);
    assert.equal(await kv.get("neo:device-policy:user_ada"), null);
    assert.equal(await kv.get(`neo:device-sid:${phone}`), null);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
