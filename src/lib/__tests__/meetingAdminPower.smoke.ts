// Run: npx tsx src/lib/__tests__/meetingAdminPower.smoke.ts
//
// Platform-admin power over other people's meetings follows the
// administrator's role. The admin Meetings page calls the ordinary meeting
// routes (end, rename, delete/archive); those authorize through
// getIdentity() and assertOwnerOrAdmin(), which used to treat every
// ADMIN_EMAILS address as owner of any meeting whatever its admin role.
// Driven through the real routes with Clerk and KV stood in for
// (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ADMIN_EMAILS = "legacy@example.com,demoted@example.com,paused@example.com,gone@example.com";
// No LiveKit server: the routes skip their best-effort room calls.
delete process.env.LIVEKIT_API_KEY;
delete process.env.LIVEKIT_API_SECRET;
delete process.env.LIVEKIT_URL;
delete process.env.NEXT_PUBLIC_LIVEKIT_URL;

type Stubbed = typeof globalThis & {
  __users: Record<string, { emails?: string[]; unverified?: string[] }>;
  __who?: string;
};
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { emails: ["owner@example.com"] },
  user_legacy: { emails: ["legacy@example.com"] }, // ADMIN_EMAILS, no record yet
  user_super: { emails: ["super@example.com"] }, // appointed Super admin
  user_mod: { emails: ["mod@example.com"] }, // appointed Moderator (events:write)
  user_demoted: { emails: ["demoted@example.com"] }, // ADMIN_EMAILS, record says Analyst
  user_support: { emails: ["support@example.com"] }, // appointed Support (events:read only)
  user_paused: { emails: ["paused@example.com"] }, // ADMIN_EMAILS, suspended Super admin
  user_gone: { emails: ["gone@example.com"] }, // ADMIN_EMAILS, removed
  user_host: { emails: ["host@example.com"] },
  user_plain: { emails: ["plain@example.com"] },
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const store = await import("../admin/store");
  const roles = await import("../roles");
  const authz = await import("../authz");
  const { eventStore } = await import("../eventStore");
  const R = {
    end: await import("../../app/api/events/[id]/end/route"),
    del: await import("../../app/api/events/delete/route"),
    rename: await import("../../app/api/events/rename/route"),
  };

  const now = Date.now();
  const record = (userId: string, email: string, roleId: string, status: "active" | "suspended" | "removed" = "active") =>
    store.saveMember({ userId, email, name: email, roleId, status, appointedBy: "user_owner", appointedAt: now, updatedAt: now });
  await record("user_super", "super@example.com", "super_admin");
  await record("user_mod", "mod@example.com", "moderator");
  await record("user_demoted", "demoted@example.com", "analyst");
  await record("user_support", "support@example.com", "support");
  await record("user_paused", "paused@example.com", "super_admin", "suspended");
  await record("user_gone", "gone@example.com", "super_admin", "removed");

  let seq = 0;
  /** A fresh live meeting owned by `owner`. */
  async function meeting(owner = "user_host") {
    const slug = `m-${++seq}`;
    await eventStore.create({
      id: `ev_${seq}`,
      slug,
      name: slug,
      ownerUserId: owner,
      ownerEmail: g.__users[owner].emails![0],
      visibility: "public",
      state: "live",
      startedAt: new Date(now - 60_000).toISOString(),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      livekitRoom: slug,
      qrSeed: "x",
      roles: [],
    } as unknown as Parameters<typeof eventStore.create>[0]);
    return { id: `ev_${seq}`, slug };
  }

  async function post(who: string, handler: (req: Request, ctx: never) => Promise<Response>, body?: unknown, params?: Record<string, string>) {
    g.__who = who;
    const res = await handler(
      new Request("https://www.neoconference.app/api/events/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve(params ?? {}) } as never,
    );
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
    return { status: res.status, body: json };
  }
  const end = (who: string, id: string) => post(who, R.end.POST as never, undefined, { id });
  const rename = (who: string, slug: string) => post(who, R.rename.POST as never, { slug, newSlug: `${slug}-renamed` });
  const archive = (who: string, slug: string) => post(who, R.del.POST as never, { slug, mode: "archive" });
  const remove = (who: string, slug: string) => post(who, R.del.POST as never, { slug, confirm: slug, mode: "delete" });

  /** End, rename, archive and delete each on a fresh meeting of user_host. */
  async function allFour(who: string) {
    const a = await meeting();
    const b = await meeting();
    const c = await meeting();
    const d = await meeting();
    return {
      end: { r: await end(who, a.id), ev: a },
      rename: { r: await rename(who, b.slug), ev: b },
      archive: { r: await archive(who, c.slug), ev: c },
      remove: { r: await remove(who, d.slug), ev: d },
    };
  }

  async function assertAllowed(who: string) {
    const x = await allFour(who);
    assert.equal(x.end.r.status, 200, `end: ${JSON.stringify(x.end.r.body)}`);
    assert.equal((await eventStore.byId(x.end.ev.id))?.state, "ended");
    assert.equal(x.rename.r.status, 200, `rename: ${JSON.stringify(x.rename.r.body)}`);
    assert.equal((await eventStore.byId(x.rename.ev.id))?.slug, `${x.rename.ev.slug}-renamed`);
    assert.equal(x.archive.r.status, 200, `archive: ${JSON.stringify(x.archive.r.body)}`);
    assert.equal((await eventStore.byId(x.archive.ev.id))?.state, "archived");
    assert.equal(x.remove.r.status, 200, `delete: ${JSON.stringify(x.remove.r.body)}`);
    assert.equal(await eventStore.byId(x.remove.ev.id), null);
  }

  async function assertRefused(who: string) {
    const x = await allFour(who);
    assert.equal(x.end.r.status, 403, `end: ${JSON.stringify(x.end.r.body)}`);
    assert.equal(x.end.r.body.requires, "meeting:end");
    assert.equal(x.rename.r.status, 403, `rename: ${JSON.stringify(x.rename.r.body)}`);
    assert.equal(x.archive.r.status, 403, `archive: ${JSON.stringify(x.archive.r.body)}`);
    assert.equal(x.remove.r.status, 403, `delete: ${JSON.stringify(x.remove.r.body)}`);
    // And nothing changed.
    const ended = await eventStore.byId(x.end.ev.id);
    assert.equal(ended?.state, "live");
    assert.equal((await eventStore.byId(x.rename.ev.id))?.slug, x.rename.ev.slug);
    assert.equal((await eventStore.byId(x.archive.ev.id))?.state, "live");
    assert.ok(await eventStore.byId(x.remove.ev.id), "not deleted");
  }

  console.log("who keeps owner rank on other people's meetings");
  await t("the owner ends, renames, archives and deletes anyone's meeting", () => assertAllowed("user_owner"));
  await t("an appointed Super admin does too", () => assertAllowed("user_super"));
  await t("an ADMIN_EMAILS admin with no record yet counts as the Super admin they will be adopted as", () =>
    assertAllowed("user_legacy"));
  await t("a Moderator (events:write) does too", () => assertAllowed("user_mod"));

  console.log("who loses it");
  await t("an ADMIN_EMAILS admin demoted to Analyst gets 403 on end, rename, archive and delete", () =>
    assertRefused("user_demoted"));
  await t("a Support admin (events:read only) gets 403", () => assertRefused("user_support"));
  await t("a suspended ADMIN_EMAILS admin gets 403", () => assertRefused("user_paused"));
  await t("a removed ADMIN_EMAILS admin gets 403", () => assertRefused("user_gone"));
  await t("an ordinary signed-in user gets 403", () => assertRefused("user_plain"));

  await t("a custom role follows its own permissions, and losing events:write takes the power away", async () => {
    await store.saveRole({ id: "custom_ops", name: "Ops", description: "", permissions: ["events:read", "events:write"], builtIn: false });
    await record("user_support", "support@example.com", "custom_ops");
    const a = await meeting();
    assert.equal((await end("user_support", a.id)).status, 200);
    await store.saveRole({ id: "custom_ops", name: "Ops", description: "", permissions: ["events:read"], builtIn: false });
    const b = await meeting();
    assert.equal((await end("user_support", b.id)).status, 403);
    // A record pointing at a role that no longer exists grants nothing.
    await store.deleteRole("custom_ops");
    const c = await meeting();
    assert.equal((await rename("user_support", c.slug)).status, 403);
    await record("user_support", "support@example.com", "support");
  });

  console.log("their own meetings are unaffected");
  await t("an ordinary host still ends, renames, archives and deletes their own meetings", () =>
    assertAllowed("user_host"));
  await t("an Analyst admin still runs their own meeting", async () => {
    const a = await meeting("user_demoted");
    assert.equal((await end("user_demoted", a.id)).status, 200);
    const b = await meeting("user_demoted");
    assert.equal((await rename("user_demoted", b.slug)).status, 200);
    const c = await meeting("user_demoted");
    assert.equal((await remove("user_demoted", c.slug)).status, 200);
  });

  console.log("both entry points agree");
  await t("getIdentity and assertOwnerOrAdmin give the same answer for each administrator", async () => {
    const ev = await eventStore.byId((await meeting()).id);
    const expect: Record<string, boolean> = {
      user_owner: true,
      user_super: true,
      user_legacy: true,
      user_mod: true,
      user_demoted: false,
      user_support: false,
      user_paused: false,
      user_gone: false,
      user_plain: false,
    };
    for (const [who, want] of Object.entries(expect)) {
      g.__who = who;
      assert.equal((await authz.getIdentity()).isPlatformAdmin, want, `getIdentity ${who}`);
      const check = await roles.assertOwnerOrAdmin(ev, who);
      assert.equal(check.ok && check.reason === "admin", want, `assertOwnerOrAdmin ${who}`);
    }
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
