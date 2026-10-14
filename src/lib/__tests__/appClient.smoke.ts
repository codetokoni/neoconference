// Run: npx tsx src/lib/__tests__/appClient.smoke.ts
//
// The mobile app says which version and phone it is when it asks for a
// meeting token, so "the app keeps closing" can be matched to a version or a
// phone in the attendance journal. Driven through the real token route and
// the real LiveKit webhook, with Clerk and KV stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
});
delete process.env.LIVEKIT_URL;
delete process.env.ADMIN_EMAILS;

type Stubbed = typeof globalThis & { __users: Record<string, { emails?: string[] }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = { user_host: { emails: ["host@example.com"] }, user_app: { emails: ["app@example.com"] } };

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
  const { AccessToken } = await import("livekit-server-sdk");
  const { eventStore } = await import("../eventStore");
  const { listAttendance } = await import("../attendance");
  const R = {
    token: await import("../../app/api/livekit/token/route"),
    webhook: await import("../../app/api/livekit/webhook/route"),
  };

  const now = Date.now();
  const slug = "app-check";
  await eventStore.create({
    id: "ev_app",
    slug,
    name: slug,
    ownerUserId: "user_host",
    ownerEmail: "host@example.com",
    visibility: "public",
    state: "live",
    startedAt: new Date(now - 60_000).toISOString(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    livekitRoom: slug,
    qrSeed: "x",
    roles: [],
    waitingRoomEnabled: false,
    waitForHost: false,
  } as unknown as Parameters<typeof eventStore.create>[0]);

  /** The token's metadata, as the app (or the web) would receive it. */
  async function tokenMetadata(who: string, client?: string) {
    g.__who = who;
    const q = new URLSearchParams({ room: slug, event: slug, nonce: "n1" });
    if (client !== undefined) q.set("client", client);
    const res = await R.token.GET(new NextRequest(`https://www.neoconference.app/api/livekit/token?${q}`));
    const body = (await res.json()) as { token?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    const claims = JSON.parse(Buffer.from(body.token!.split(".")[1], "base64url").toString());
    return JSON.parse(claims.metadata) as Record<string, unknown>;
  }

  async function webhook(event: Record<string, unknown>) {
    const body = JSON.stringify(event);
    const at = new AccessToken("lk", process.env.LIVEKIT_API_SECRET!);
    at.sha256 = createHash("sha256").update(body).digest("base64");
    const res = await R.webhook.POST(
      new NextRequest("https://www.neoconference.app/api/livekit/webhook", {
        method: "POST",
        headers: { "content-type": "application/webhook+json", authorization: await at.toJwt() },
        body,
      }),
    );
    assert.equal(res.status, 200, await res.text());
  }

  const phone = "android 1.2.4+3217 OPPO CPH2365 / Android 14";

  await t("the app's version and phone ride in its token", async () => {
    const md = await tokenMetadata("user_app", phone);
    assert.equal(md.client, phone);
    assert.equal(typeof md.role, "string");
  });

  await t("the web sends none, and its token carries none", async () => {
    const md = await tokenMetadata("user_host");
    assert.equal("client" in md, false);
  });

  await t("only plain text, at most 100 characters", async () => {
    const md = await tokenMetadata("user_app", `android 1.2.4 <script>"x"</script>${"y".repeat(200)}`);
    const client = String(md.client);
    assert.ok(client.length <= 100, String(client.length));
    assert.doesNotMatch(client, /[<>"]/);
    assert.ok(client.startsWith("android 1.2.4 script"), client);
  });

  await t("the attendance journal records the version on join and on leave", async () => {
    const md = JSON.stringify({ role: "guest", client: phone });
    const participant = { identity: "user_app#n1", name: "App Person", metadata: md };
    const ts = Math.floor(Date.now() / 1000);
    await webhook({ event: "participant_joined", room: { name: slug }, participant, createdAt: String(ts) });
    await webhook({
      event: "participant_left",
      room: { name: slug },
      participant: { ...participant, disconnectReason: 14 },
      createdAt: String(ts + 30),
    });
    // The web's join: no client.
    await webhook({
      event: "participant_joined",
      room: { name: slug },
      participant: { identity: "user_host#w", name: "Host", metadata: JSON.stringify({ role: "host" }) },
      createdAt: String(ts + 31),
    });
    const rows = await listAttendance("ev_app");
    const app = rows.filter((r) => r.userId === "user_app");
    assert.deepEqual(app.map((r) => [r.action, r.client]), [["join", phone], ["leave", phone]]);
    const web = rows.find((r) => r.userId === "user_host");
    assert.ok(web && !("client" in web), JSON.stringify(web));
  });

  console.log("old apps are asked to update");

  /** A join as the app makes it (Bearer), or as the website does (cookie). */
  async function join(opts: { app: boolean; client?: string }) {
    g.__who = "user_app";
    const q = new URLSearchParams({ room: slug, event: slug, nonce: "n2" });
    if (opts.client !== undefined) q.set("client", opts.client);
    const headers: Record<string, string> = opts.app ? { authorization: "Bearer app-session-jwt" } : {};
    const res = await R.token.GET(new NextRequest(`https://www.neoconference.app/api/livekit/token?${q}`, { headers }));
    return { status: res.status, body: (await res.json()) as { token?: string; error?: string; message?: string } };
  }

  await t("an app too old to say its version (1.2.3 and before) is told to update, with the store", async () => {
    const r = await join({ app: true });
    assert.equal(r.status, 426);
    assert.equal(r.body.error, "app_update_required");
    assert.match(String(r.body.message), /new version of NeoConference/);
    assert.match(String(r.body.message), /web\.lwappstore\.com\/share\/lW-APP-Y26-XG9328/);
    assert.equal(r.body.token, undefined);
  });

  await t("an app older than the minimum is told too; 1.2.4 and newer join", async () => {
    assert.equal((await join({ app: true, client: "android 1.2.3+5216 OPPO CPH2599 / Android 16" })).status, 426);
    assert.equal((await join({ app: true, client: "android 1.2.4+5218 OPPO CPH2599 / Android 16" })).status, 200);
    assert.equal((await join({ app: true, client: "android 1.2.10+5300 Tecno X / Android 14" })).status, 200);
  });

  await t("the website (its cookie, no app header) is never asked to update", async () => {
    assert.equal((await join({ app: false })).status, 200);
  });

  await t("APP_MIN_VERSION=0 in Vercel lets every app in again, without a code change", async () => {
    process.env.APP_MIN_VERSION = "0";
    try {
      assert.equal((await join({ app: true })).status, 200);
    } finally {
      delete process.env.APP_MIN_VERSION;
    }
  });

  await t("GET /api/app/latest says the newest version, the minimum and the store", async () => {
    const latest = await import("../../app/api/app/latest/route");
    const body = (await (await latest.GET()).json()) as Record<string, string>;
    assert.deepEqual(body, {
      latestVersion: "1.2.4",
      minVersion: "1.2.4",
      storeUrl: "https://web.lwappstore.com/share/lW-APP-Y26-XG9328",
    });
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
