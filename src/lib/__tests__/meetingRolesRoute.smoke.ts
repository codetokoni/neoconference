// Run: npx tsx src/lib/__tests__/meetingRolesRoute.smoke.ts
//
// Who may give and take meeting roles, through the real route the room's
// "Make Host" / "Make Moderator" / "Demote" buttons call
// (POST /api/events/[id]/roles). A host may make another host (owner's
// decision 2026-11-05: in a prayer meeting the hosts hand the meeting on),
// but taking a host's role away stays the owner's. Clerk and the stores are
// stood in for (./apiV1-stubs, in-memory fallbacks).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

// No LiveKit server: the route skips its best-effort metadata push.
delete process.env.LIVEKIT_API_KEY;
delete process.env.LIVEKIT_API_SECRET;
delete process.env.LIVEKIT_URL;
delete process.env.NEXT_PUBLIC_LIVEKIT_URL;
delete process.env.ADMIN_EMAILS;

type Stubbed = typeof globalThis & { __users: Record<string, { emails?: string[] }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = Object.fromEntries(
  ["owner", "host", "host2", "mod", "ann", "ben", "cat"].map((u) => [`user_${u}`, { emails: [`${u}@example.com`] }]),
);

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { eventStore } = await import("../eventStore");
  const { getMeetingRole } = await import("../meeting-roles");
  const route = await import("../../app/api/events/[id]/roles/route");

  const now = new Date().toISOString();
  await eventStore.create({
    id: "ev_prayer",
    slug: "prayer",
    name: "Prayer",
    ownerUserId: "user_owner",
    ownerEmail: "owner@example.com",
    visibility: "public",
    state: "live",
    createdAt: now,
    updatedAt: now,
    livekitRoom: "prayer",
    qrSeed: "x",
    roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);

  async function give(who: string, userId: string, role: string) {
    g.__who = who;
    const res = await route.POST(
      new Request("https://neolinguameet.com/api/events/prayer/roles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, role }),
      }) as never,
      { params: Promise.resolve({ id: "prayer" }) },
    );
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }
  const roleOf = (u: string) => getMeetingRole("ev_prayer", u);

  await t("the owner makes hosts and a moderator", async () => {
    assert.equal((await give("user_owner", "user_host", "host")).status, 200);
    assert.equal((await give("user_owner", "user_host2", "host")).status, 200);
    assert.equal((await give("user_owner", "user_mod", "moderator")).status, 200);
    assert.equal(await roleOf("user_host"), "host");
    assert.equal(await roleOf("user_mod"), "moderator");
  });

  await t("a host makes another host, and a moderator", async () => {
    const r = await give("user_host", "user_ann", "host");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await roleOf("user_ann"), "host");
    assert.equal((await give("user_host", "user_ben", "moderator")).status, 200);
    assert.equal(await roleOf("user_ben"), "moderator");
    // A moderator moves up to host too.
    assert.equal((await give("user_host", "user_ben", "host")).status, 200);
    assert.equal(await roleOf("user_ben"), "host");
  });

  await t("a host cannot take a host's role away; the owner can", async () => {
    for (const role of ["participant", "moderator"]) {
      const r = await give("user_host", "user_host2", role);
      assert.equal(r.status, 403, role);
      assert.equal(r.body.error, "insufficient_rank");
    }
    assert.equal(await roleOf("user_host2"), "host");
    assert.equal((await give("user_owner", "user_host2", "participant")).status, 200);
    assert.equal(await roleOf("user_host2"), null);
  });

  await t("nobody makes themselves or the owner anything; a moderator makes no one", async () => {
    assert.equal((await give("user_mod", "user_cat", "host")).status, 403);
    assert.equal((await give("user_mod", "user_cat", "moderator")).status, 403);
    assert.equal(await roleOf("user_cat"), null);
    assert.equal((await give("user_host", "user_owner", "host")).status, 403);
    assert.equal((await give("user_cat", "user_cat", "host")).status, 403);
    assert.equal(await roleOf("user_cat"), null);
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
