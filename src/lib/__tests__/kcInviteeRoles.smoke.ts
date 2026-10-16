// Run: npx tsx src/lib/__tests__/kcInviteeRoles.smoke.ts
//
// People added to a meeting by KingsChat handle (Roles > Invite by
// KingsChat, stored as kc:<handle>) hold that role on the server, not only
// in the room. The token made a KingsChat-invited host a host — End showed —
// but authorize() looked people up by account and email only, so End (and
// Mute, Record, admitting…) answered 403: "people I added on KC link can't
// end meeting". Through the real /api/events/[id]/end and
// /api/livekit/egress/start routes with Clerk and KV stood in for.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_kc_roles";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.S3_ENDPOINT = "https://r2.test";
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY = "ak";
process.env.S3_SECRET_KEY = "sk";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://lk.test";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret_that_is_long_enough_for_hs256";

type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[]; metadata?: Record<string, unknown> }>;
  __who?: string;
  __objects?: unknown[];
};
const g = globalThis as Stubbed;
g.__objects = [];
g.__users = {
  user_owner: { plan: "pro", emails: ["owner@example.com"] },
  // Signed in with KingsChat: the handle is in publicMetadata.kingschat.
  user_pastor: { emails: ["pastor@example.com"], metadata: { kingschat: { username: "pstpraiseosifo" } } },
  user_mod: { emails: ["mod@example.com"], metadata: { kingschat: { username: "hslhs-shallom" } } },
  user_stranger: { emails: ["stranger@example.com"], metadata: { kingschat: { username: "someoneelse" } } },
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
  const roles = await import("../meeting-roles");
  const R = {
    end: await import("../../app/api/events/[id]/end/route"),
    record: await import("../../app/api/livekit/egress/start/route"),
  };
  const now = new Date().toISOString();
  async function meeting(id: string) {
    await eventStore.create({
      id, slug: id, name: id, ownerUserId: "user_owner", ownerEmail: "owner@example.com",
      state: "live", visibility: "unlisted", livekitRoom: id, createdAt: now, updatedAt: now, roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
    const owner = { userId: "user_owner", emails: ["owner@example.com"], isPlatformAdmin: false, role: "owner" as const, isOwner: true, reason: "owner" as const };
    // As /api/events/[id]/invite-kc stores them.
    await roles.assignMeetingRole(id, { userId: "kc:pstpraiseosifo" }, "host", owner);
    await roles.assignMeetingRole(id, { userId: "kc:hslhs-shallom" }, "moderator", owner);
  }
  async function end(who: string, id: string) {
    g.__who = who;
    const res = await R.end.POST(
      new NextRequest(`https://www.neoconference.app/api/events/${id}/end`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      { params: Promise.resolve({ id }) },
    );
    return res.status;
  }
  async function record(who: string, room: string) {
    g.__who = who;
    const res = await R.record.POST(
      new NextRequest("https://www.neoconference.app/api/livekit/egress/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room }) }) as never,
    );
    return res.status;
  }

  console.log("people added by KingsChat handle");

  await meeting("kc-room-1");
  await t("someone with only the link cannot end the meeting", async () => {
    assert.equal(await end("user_stranger", "kc-room-1"), 403);
  });

  await t("a host added by KingsChat handle can end it", async () => {
    assert.equal(await end("user_pastor", "kc-room-1"), 200);
    assert.equal((await eventStore.byId("kc-room-1"))?.state, "ended");
  });

  await meeting("kc-room-2");
  await t("a moderator added by KingsChat handle cannot end it (only hosts end), but can record", async () => {
    assert.equal(await end("user_mod", "kc-room-2"), 403);
    assert.equal(await record("user_mod", "kc-room-2"), 200);
  });

  await t("the KingsChat-added host can record too; the stranger cannot", async () => {
    assert.equal(await record("user_pastor", "kc-room-2"), 200);
    assert.equal(await record("user_stranger", "kc-room-2"), 403);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
