// Run: npx tsx src/lib/__tests__/ownerRoleProtected.smoke.ts
//
// Nobody can change the meeting owner's role through POST
// /api/events/[id]/roles. The owner is never stored in the role hash, so the
// route's "target's current rank" check found nothing, the demote "succeeded",
// and the room was told the owner was now an attendee: a host could strip the
// owner's controls. Driven through the real route with Clerk and KV stood in
// for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

// No LiveKit server: the route skips its best-effort room update.
delete process.env.LIVEKIT_API_KEY;
delete process.env.LIVEKIT_API_SECRET;
delete process.env.LIVEKIT_WS_URL;
delete process.env.NEXT_PUBLIC_LIVEKIT_URL;

type Stubbed = typeof globalThis & {
  __users: Record<string, { emails?: string[] }>;
  __who?: string;
};
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { emails: ["owner@example.com", "owner.alt@example.com"] },
  user_host: { emails: ["host@example.com"] },
  user_mod: { emails: ["mod@example.com"] },
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { eventStore } = await import("../eventStore");
  const { getMeetingRole } = await import("../meeting-roles");
  const roles = await import("../../app/api/events/[id]/roles/route");
  const { NextRequest } = await import("next/server");

  const now = new Date().toISOString();
  await eventStore.create({
    id: "ev_1",
    slug: "team-sync",
    name: "Team sync",
    ownerUserId: "user_owner",
    ownerEmail: "owner@example.com",
    visibility: "public",
    state: "live",
    createdAt: now,
    updatedAt: now,
    livekitRoom: "team-sync",
    qrSeed: "x",
    roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);

  async function setRole(who: string, body: Record<string, unknown>) {
    g.__who = who;
    const res = await roles.POST(
      new NextRequest("https://www.neoconference.app/api/events/team-sync/roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: "team-sync" }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  await t("the owner appoints a host and a moderator", async () => {
    assert.equal((await setRole("user_owner", { userId: "user_host", role: "host" })).status, 200);
    assert.equal((await setRole("user_owner", { userId: "user_mod", role: "moderator" })).status, 200);
    assert.equal(await getMeetingRole("ev_1", "user_host"), "host");
  });

  await t("a host cannot demote the owner, by user id or by the owner's email", async () => {
    for (const target of [{ userId: "user_owner" }, { email: "owner@example.com" }]) {
      const r = await setRole("user_host", { ...target, role: "participant" });
      assert.equal(r.status, 403, JSON.stringify({ target, r }));
      assert.equal(r.body.error, "cannot_target_owner");
    }
  });

  await t("a host cannot make the owner a moderator either", async () => {
    const r = await setRole("user_host", { userId: "user_owner", role: "moderator" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "cannot_target_owner");
    assert.equal(await getMeetingRole("ev_1", "user_owner"), null, "the owner is never written into the role hash");
  });

  await t("a host can still demote a moderator", async () => {
    const r = await setRole("user_host", { userId: "user_mod", role: "participant" });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(await getMeetingRole("ev_1", "user_mod"), null);
  });

  await t("the owner cannot demote themselves through the route", async () => {
    const r = await setRole("user_owner", { userId: "user_owner", role: "participant" });
    assert.equal(r.status, 403);
  });

  console.log(`\n${n} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
