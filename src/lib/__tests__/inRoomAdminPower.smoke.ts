// Run: npx tsx src/lib/__tests__/inRoomAdminPower.smoke.ts
//
// Inside someone else's room, platform-admin power follows the
// administrator's role, as it does for end, rename and delete
// (meetingAdminPower.smoke.ts). The in-room routes used to treat every
// ADMIN_EMAILS address as host of every room, so an admin demoted to
// Analyst saw host controls whose End then answered 403. Driven through
// the real routes with Clerk and KV stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ADMIN_EMAILS = "legacy@example.com,demoted@example.com,paused@example.com";
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
  user_owner: { emails: ["owner@example.com"] }, // platform owner
  user_super: { emails: ["super@example.com"] }, // appointed Super admin
  user_legacy: { emails: ["legacy@example.com"] }, // ADMIN_EMAILS, no record yet
  user_demoted: { emails: ["demoted@example.com"] }, // ADMIN_EMAILS, record says Analyst
  user_paused: { emails: ["paused@example.com"] }, // ADMIN_EMAILS, suspended Super admin
  user_host: { emails: ["host@example.com"] },
  user_guest: { emails: ["guest@example.com"] },
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const store = await import("../admin/store");
  const { eventStore } = await import("../eventStore");
  const R = {
    role: await import("../../app/api/events/role/route"),
    wr: await import("../../app/api/waiting-room/route"),
    breakouts: await import("../../app/api/breakouts/[slug]/route"),
  };

  const now = Date.now();
  const record = (userId: string, email: string, roleId: string, status: "active" | "suspended" = "active") =>
    store.saveMember({ userId, email, name: email, roleId, status, appointedBy: "user_owner", appointedAt: now, updatedAt: now });
  await record("user_super", "super@example.com", "super_admin");
  await record("user_demoted", "demoted@example.com", "analyst");
  await record("user_paused", "paused@example.com", "super_admin", "suspended");

  let seq = 0;
  /** A fresh live meeting of user_host, with its waiting room on and an End PIN. */
  async function meeting() {
    const slug = `r-${++seq}`;
    await eventStore.create({
      id: `ev_${seq}`,
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
      waitingRoomEnabled: true,
      endPin: "1234",
    } as unknown as Parameters<typeof eventStore.create>[0]);
    return { id: `ev_${seq}`, slug };
  }

  async function json(res: Response) {
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { status: res.status, body: { text } as Record<string, unknown> };
    }
  }

  async function role(who: string, slug: string) {
    g.__who = who;
    return json(await R.role.GET(new Request(`https://www.neoconference.app/api/events/role?slug=${slug}`)));
  }

  async function wr(who: string, body: Record<string, unknown>) {
    g.__who = who;
    return json(
      await R.wr.POST(
        new Request("https://www.neoconference.app/api/waiting-room", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  }

  async function putBreakouts(who: string, slug: string) {
    g.__who = who;
    const state = { active: true, groups: [{ id: "g1", name: "One" }], assignments: {}, ts: Date.now() };
    return json(
      await R.breakouts.PUT(
        new Request(`https://www.neoconference.app/api/breakouts/${slug}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(state),
        }),
        { params: { slug } },
      ),
    );
  }

  /** A guest knocks on a fresh meeting; `who` then tries to admit them. */
  async function admitAs(who: string) {
    const ev = await meeting();
    const knock = await wr("user_guest", { op: "knock", slug: ev.slug });
    assert.equal(knock.body.status, "pending", `knock: ${JSON.stringify(knock.body)}`);
    const r = await wr(who, { op: "decide", slug: ev.slug, entryId: "user_guest", decision: "admit" });
    const entry = (await eventStore.byId(ev.id))?.waitingRoom?.find((e) => e.id === "user_guest");
    return { r, entry };
  }

  async function assertHost(who: string) {
    const ev = await meeting();
    const r = await role(who, ev.slug);
    assert.equal(r.status, 200);
    assert.equal(r.body.role, "host", `role: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.isOwner, false);
    assert.equal(r.body.endPinRequired, false, "an admin with power ends without the PIN");
    const a = await admitAs(who);
    assert.equal(a.r.status, 200, `admit: ${JSON.stringify(a.r.body)}`);
    assert.equal(a.entry?.status, "admitted");
    assert.equal((await putBreakouts(who, ev.slug)).status, 200);
  }

  async function assertNotHost(who: string) {
    const ev = await meeting();
    const r = await role(who, ev.slug);
    assert.equal(r.status, 200);
    assert.equal(r.body.role, "viewer", `role: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.endPinRequired, true, "they would be asked for the PIN like anyone");
    const a = await admitAs(who);
    assert.equal(a.r.status, 403, `admit: ${JSON.stringify(a.r.body)}`);
    assert.equal(a.entry?.status, "pending", "the guest is still waiting");
    assert.equal((await putBreakouts(who, ev.slug)).status, 403);
  }

  console.log("who is host of someone else's room");
  await t("the owner is host, admits from the waiting room and runs breakouts", () => assertHost("user_owner"));
  await t("an appointed Super admin is too", () => assertHost("user_super"));
  await t("an ADMIN_EMAILS admin with no record yet is too", () => assertHost("user_legacy"));

  console.log("who is not");
  await t("an ADMIN_EMAILS admin demoted to Analyst is a viewer and cannot admit", () => assertNotHost("user_demoted"));
  await t("a suspended ADMIN_EMAILS admin is a viewer and cannot admit", () => assertNotHost("user_paused"));
  await t("a demoted admin's own knock waits like anyone's", async () => {
    const ev = await meeting();
    const knock = await wr("user_demoted", { op: "knock", slug: ev.slug });
    assert.equal(knock.body.status, "pending", JSON.stringify(knock.body));
  });

  console.log("the meeting's own host is unaffected");
  await t("the owner of the meeting is host and admits", async () => {
    const ev = await meeting();
    const r = await role("user_host", ev.slug);
    assert.equal(r.body.role, "host");
    assert.equal(r.body.isOwner, true);
    const knock = await wr("user_guest", { op: "knock", slug: ev.slug });
    assert.equal(knock.body.status, "pending");
    const d = await wr("user_host", { op: "decide", slug: ev.slug, entryId: "user_guest", decision: "admit" });
    assert.equal(d.status, 200);
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
