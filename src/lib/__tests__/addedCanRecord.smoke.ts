// Run: npx tsx src/lib/__tests__/addedCanRecord.smoke.ts
//
// People the owner added to a meeting by name may record, whatever role they
// were given (owner's decision, 2026-10-15). Speakers and viewers added on the
// meeting page used to get no Record button and a 403. Through the real
// /api/livekit/egress/start and /api/livekit/token routes with Clerk, KV, R2
// and the LiveKit server stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_added_record";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";
process.env.S3_ENDPOINT = "https://r2.test";
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY = "ak";
process.env.S3_SECRET_KEY = "sk";

type Stubbed = typeof globalThis & { __users: Record<string, { plan?: string; emails?: string[] }>; __who?: string; __objects?: unknown[] };
const g = globalThis as Stubbed;
g.__objects = [];
g.__users = {
  user_owner: { plan: "pro", emails: ["owner@example.com"] },
  user_speaker: { emails: ["speaker@example.com"] },
  user_viewer: { emails: ["viewer@example.com"] },
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
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { NextRequest } = await import("next/server");
  const { eventStore } = await import("../eventStore");
  const { RANK } = await import("../permissions");
  const R = {
    start: await import("../../app/api/livekit/egress/start/route"),
    token: await import("../../app/api/livekit/token/route"),
  };
  const now = new Date().toISOString();
  await eventStore.create({
    id: "ev_rec", slug: "rec-room", name: "Rec room", ownerUserId: "user_owner", ownerEmail: "owner@example.com",
    state: "live", visibility: "unlisted", livekitRoom: "rec-room", waitingRoomEnabled: false, waitForHost: false,
    createdAt: now, updatedAt: now,
    // As the meeting page's "Invite by email" stores them.
    roles: [
      { identifier: "speaker@example.com", role: "speaker", label: "speaker@example.com", preApproved: true },
      { identifier: "viewer@example.com", role: "viewer", label: "viewer@example.com", preApproved: true },
    ],
  } as unknown as Parameters<typeof eventStore.create>[0]);

  async function record(who: string) {
    g.__who = who;
    const res = await R.start.POST(
      new NextRequest("https://www.neoconference.app/api/livekit/egress/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: "rec-room" }),
      }) as never,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function tokenMetadata(who: string) {
    g.__who = who;
    const res = await R.token.GET(new NextRequest("https://www.neoconference.app/api/livekit/token?room=rec-room&event=rec-room&nonce=x1"));
    const body = (await res.json()) as { token?: string };
    assert.equal(res.status, 200, JSON.stringify(body));
    const claims = JSON.parse(Buffer.from(body.token!.split(".")[1], "base64url").toString());
    return JSON.parse(claims.metadata) as Record<string, unknown>;
  }

  console.log("people added to a meeting by name may record");

  await t("a speaker the owner added can start a recording", async () => {
    const r = await record("user_speaker");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.egressId);
    assert.match(String(r.body.filepath), /^recordings\/user_speaker\/rec-room\//);
  });

  await t("so can a viewer the owner added", async () => {
    assert.equal((await record("user_viewer")).status, 200);
  });

  await t("someone with only the link cannot", async () => {
    assert.equal((await record("user_stranger")).status, 403);
  });

  await t("their meeting token says they may record, so the room shows them Record", async () => {
    assert.equal((await tokenMetadata("user_speaker")).canRecord, true);
    assert.equal((await tokenMetadata("user_viewer")).canRecord, true);
    assert.equal("canRecord" in (await tokenMetadata("user_stranger")), false);
  });

  await t("if the owner set their own rule for recording (hosts only), added people follow it", async () => {
    await eventStore.update("ev_rec", (prev) => ({ ...prev, permissionOverrides: { "recording:start": RANK.host } }) as typeof prev);
    assert.equal((await record("user_speaker")).status, 403);
    await eventStore.update("ev_rec", (prev) => ({ ...prev, permissionOverrides: undefined }) as typeof prev);
    assert.equal((await record("user_speaker")).status, 200);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
