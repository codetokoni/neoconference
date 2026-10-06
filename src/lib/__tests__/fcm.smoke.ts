// FCM for the phone app: tokens kept per person, and every push fanned out
// to phones as well as browsers. Run: npx tsx src/lib/__tests__/fcm.smoke.ts

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  __setFcmSender, cleanFcmToken, listFcmDevices, removeFcmToken, saveFcmToken, sendFcm, serviceAccountJson, MAX_FCM_DEVICES,
  type FcmSender,
} from "@/lib/fcmStore";
import { __setPushSender, saveSubscription, sendPush, type PushPayload } from "@/lib/pushStore";

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
// As pasted into a dashboard: the key's line breaks written as "\n".
const serviceAccount = JSON.stringify({
  type: "service_account",
  project_id: "neo-test",
  client_email: "firebase-adminsdk@neo-test.iam.gserviceaccount.com",
  private_key: pem.replace(/\n/g, "\\n"),
});

const ring: PushPayload = {
  type: "ring",
  title: "Cell: Night",
  body: "Ada is calling",
  url: "/room/night?event=night&join=1",
  eventSlug: "night",
  ringId: "r1",
  expiresAt: 1_800_000_000_000,
  caller: "Ada",
};
const tok = (i: number) => `fcm-token-${i}-${"x".repeat(40)}`;

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };

(async () => {
  console.log("tokens");

  await t("only a token-shaped string is kept", () => {
    assert.equal(cleanFcmToken(` ${tok(1)} `), tok(1));
    assert.equal(cleanFcmToken("short"), null);
    assert.equal(cleanFcmToken("has spaces in it and is long enough to pass"), null);
    assert.equal(cleanFcmToken(42), null);
  });

  await t("the same token again is one device; an 11th pushes out the oldest", async () => {
    await saveFcmToken("u_many", tok(0), 1000);
    await saveFcmToken("u_many", tok(0), 2000);
    assert.equal((await listFcmDevices("u_many")).size, 1);
    for (let i = 1; i <= MAX_FCM_DEVICES; i++) await saveFcmToken("u_many", tok(i), 1000 + i * 10);
    const left = [...(await listFcmDevices("u_many")).values()].map((d) => d.token);
    assert.equal(left.length, MAX_FCM_DEVICES);
    assert.ok(!left.includes(tok(0)));
    assert.equal(await removeFcmToken("u_many", tok(1)), true);
    assert.equal(await removeFcmToken("u_many", tok(1)), false);
  });

  await t("the key is read however it was pasted: as is, in quotes, escaped or base64; anything else is refused", () => {
    const want = JSON.parse(serviceAccount).client_email;
    const email = (s: string | null) => (s === null ? null : JSON.parse(s).client_email);
    assert.equal(email(serviceAccountJson(serviceAccount)), want);
    assert.equal(email(serviceAccountJson(`  '${serviceAccount}'\n`)), want);
    assert.equal(email(serviceAccountJson(JSON.stringify(serviceAccount).slice(1, -1))), want);
    assert.equal(email(serviceAccountJson(Buffer.from(serviceAccount).toString("base64"))), want);
    assert.equal(serviceAccountJson("C:\\Users\\me\\Downloads\\neo-firebase-adminsdk.json"), null);
    assert.equal(serviceAccountJson('{"type": "service_account", "project_id": '), null);
  });

  console.log("sending");

  const sent: Array<{ token: string; data: Record<string, string>; android: Parameters<FcmSender>[2] }> = [];
  let answer: (token: string) => { status: number; errorCode?: string } = () => ({ status: 200 });
  __setFcmSender(async (token, data, android) => {
    sent.push({ token, data, android });
    return answer(token);
  });

  await t("without FIREBASE_SERVICE_ACCOUNT nothing is sent and push still works for browsers", async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const res = await sendFcm("u1", ring);
    assert.deepEqual(res, { configured: false, devices: [] });
  });

  process.env.FIREBASE_SERVICE_ACCOUNT = serviceAccount;

  await t("a ring goes as high priority data, every value a string, held no longer than the ring", async () => {
    sent.length = 0;
    await saveFcmToken("u1", tok(1));
    const res = await sendFcm("u1", ring, { ttlSec: 45, urgency: "high", topic: "t-night" });
    assert.equal(res.devices.length, 1);
    assert.equal(res.devices[0].outcome, "sent");
    assert.ok(res.devices[0].id.startsWith("fcm:"));
    assert.deepEqual(sent[0].android, { priority: "HIGH", ttl: "45s", collapse_key: "t-night" });
    assert.equal(sent[0].data.expiresAt, "1800000000000");
    assert.equal(sent[0].data.type, "ring");
    assert.ok(Object.values(sent[0].data).every((v) => typeof v === "string"));
  });

  await t("an uninstalled app's token is dropped; a malformed-message refusal keeps it", async () => {
    await saveFcmToken("u2", tok(2));
    await saveFcmToken("u2", tok(3));
    answer = (token) => (token === tok(2) ? { status: 404, errorCode: "UNREGISTERED" } : { status: 400, errorCode: "INVALID_ARGUMENT" });
    const res = await sendFcm("u2", ring);
    assert.deepEqual(res.devices.map((d) => d.outcome).sort(), ["failed", "gone"]);
    const left = [...(await listFcmDevices("u2")).values()].map((d) => d.token);
    assert.deepEqual(left, [tok(3)]);
    answer = () => ({ status: 200 });
  });

  await t("sendPush reaches phones and browsers alike, and counts both", async () => {
    sent.length = 0;
    const browsers: string[] = [];
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
    __setPushSender(async (s) => {
      browsers.push(s.endpoint);
      return { statusCode: 201 };
    });
    await saveSubscription("u3", { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }, "test");
    await saveFcmToken("u3", tok(4));
    const res = await sendPush("u3", ring, { urgency: "high", ttlSec: 45 });
    assert.equal(res.configured, true);
    assert.equal(res.devices.length, 2);
    assert.deepEqual(browsers, ["https://push.example/abc"]);
    assert.equal(sent.length, 1);
  });

  await t("with only FCM set up, a phone still counts as a device (KingsChat waits for the second ring)", async () => {
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    await saveFcmToken("u4", tok(5));
    const res = await sendPush("u4", ring, { urgency: "high" });
    assert.equal(res.configured, true);
    assert.equal(res.devices.length, 1);
  });

  console.log("FCM itself");

  await t("signs in as the service account and sends to the project, reusing the access token", async () => {
    __setFcmSender(null);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: "projects/neo-test/messages/1" }), { status: 200 });
    }) as typeof fetch;
    try {
      await saveFcmToken("u5", tok(6));
      const first = await sendFcm("u5", ring, { urgency: "high", ttlSec: 45 });
      assert.equal(first.devices[0].outcome, "sent");
      await sendFcm("u5", ring);

      const exchanges = calls.filter((c) => c.url === "https://oauth2.googleapis.com/token");
      assert.equal(exchanges.length, 1, "the access token is reused");
      const form = new URLSearchParams(String(exchanges[0].init.body));
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const jwt = form.get("assertion")!;
      assert.equal(decodeProtectedHeader(jwt).alg, "RS256");
      const claims = decodeJwt(jwt);
      assert.equal(claims.iss, "firebase-adminsdk@neo-test.iam.gserviceaccount.com");
      assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
      assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");

      const sends = calls.filter((c) => c.url.startsWith("https://fcm.googleapis.com/"));
      assert.equal(sends.length, 2);
      assert.equal(sends[0].url, "https://fcm.googleapis.com/v1/projects/neo-test/messages:send");
      assert.equal((sends[0].init.headers as Record<string, string>).authorization, "Bearer ya29.test");
      const msg = JSON.parse(String(sends[0].init.body)).message;
      assert.equal(msg.token, tok(6));
      assert.equal(msg.android.priority, "HIGH");
      assert.equal(msg.data.ringId, "r1");
      assert.equal(msg.notification, undefined, "data only: the app draws the call screen");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
