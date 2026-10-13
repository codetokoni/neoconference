// Run: npx tsx src/lib/__tests__/inviteRemove.smoke.ts
//
// Someone added by email on a meeting's page (Roles > Invite by email) can be
// removed again, through the real /api/events/[id]/invite route with Clerk
// and KV stood in for (./apiV1-stubs). The owner had no way to: the list
// showed "praiseosawe20@gmail.com COHOST" with nothing to press. Removing
// takes them off the event's roles list and clears any role the same
// address holds in the roles hash, so they really join as a participant.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "";
process.env.PLATFORM_OWNER_EMAILS = "platform@example.com";
process.env.ADMIN_EMAILS = "";

type Stubbed = typeof globalThis & { __users: Record<string, { emails?: string[] }>; __who?: string };
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { emails: ["owner@example.com"] },
  user_other: { emails: ["other@example.com"] },
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
  const { eventStore } = await import("../eventStore");
  const roles = await import("../meeting-roles");
  const R = await import("../../app/api/events/[id]/invite/route");

  const now = new Date().toISOString();
  const ev = await eventStore.create({
    id: "ev_invites",
    slug: "invites-room",
    name: "Invites room",
    ownerUserId: "user_owner",
    ownerEmail: "owner@example.com",
    state: "scheduled",
    createdAt: now,
    updatedAt: now,
    roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);

  async function call(who: string | null, method: "POST" | "DELETE", body: unknown) {
    g.__who = who ?? undefined;
    const res = await (R[method] as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>)(
      new Request("https://www.neoconference.app/api/events/ev_invites/invite", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: ev.id }) },
    );
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }
  const listed = async () => ((await eventStore.byId(ev.id))?.roles ?? []).map((r) => `${r.identifier} ${r.role}`);

  console.log("remove someone invited by email");

  await t("the owner adds two cohosts by email; both are listed and hold the role", async () => {
    const r = await call("user_owner", "POST", { emails: "praiseosawe20@gmail.com, ruthuchendu@yahoo.com", role: "cohost", preApproved: true, sendEmail: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await listed(), ["praiseosawe20@gmail.com cohost", "ruthuchendu@yahoo.com cohost"]);
    assert.equal(await roles.getMeetingRoleByEmail(ev.id, "praiseosawe20@gmail.com"), "moderator");
  });

  await t("someone else cannot remove them", async () => {
    const r = await call("user_other", "DELETE", { identifier: "praiseosawe20@gmail.com" });
    assert.equal(r.status, 403);
    assert.equal((await listed()).length, 2);
  });

  await t("the owner removes one: off the list, and the address holds no role any more", async () => {
    const r = await call("user_owner", "DELETE", { identifier: "PraiseOsawe20@gmail.com " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.removed, true);
    assert.deepEqual(await listed(), ["ruthuchendu@yahoo.com cohost"]);
    assert.equal(await roles.getMeetingRoleByEmail(ev.id, "praiseosawe20@gmail.com"), null);
    assert.equal(await roles.getMeetingRoleByEmail(ev.id, "ruthuchendu@yahoo.com"), "moderator");
  });

  await t("a role the same address held in the roles hash goes too", async () => {
    const owner = { userId: "user_owner", emails: ["owner@example.com"], isPlatformAdmin: false, role: "owner" as const, isOwner: true, reason: "owner" as const };
    await roles.assignMeetingRole(ev.id, "ruthuchendu@yahoo.com", "host", owner);
    assert.equal(await roles.getMeetingRoleByEmail(ev.id, "ruthuchendu@yahoo.com"), "host");
    const r = await call("user_owner", "DELETE", { identifier: "ruthuchendu@yahoo.com" });
    assert.equal(r.status, 200);
    assert.deepEqual(await listed(), []);
    assert.equal(await roles.getMeetingRoleByEmail(ev.id, "ruthuchendu@yahoo.com"), null);
  });

  await t("removing someone not there is harmless; no address is a 400", async () => {
    const gone = await call("user_owner", "DELETE", { identifier: "nobody@example.com" });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.removed, false);
    assert.equal((await call("user_owner", "DELETE", {})).status, 400);
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
