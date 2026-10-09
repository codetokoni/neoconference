// Run: npx tsx src/lib/__tests__/adminUsers.smoke.ts
//
// Admin phase 2 — users and groups — driven through the real /api/admin
// routes with Clerk and KV stood in for (./apiV1-stubs). KV is "configured"
// here, so every store (groups, sessions, payments, usage, events) runs its
// real KV code against the in-memory Redis, the way it runs in production.
//
// What it proves: each action needs its permission (and a fresh code where
// the catalog says so); the platform owner is refused by every action; an
// administrator cannot act on one who outranks them, or on themselves;
// every change is in the audit trail with before and after; and what is
// written is in KV, where the next request reads it.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_admin_users";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ADMIN_EMAILS = "";
delete process.env.RESEND_API_KEY;
// Stores use the stub Redis rather than their in-memory fallbacks.
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";

type StubUser = {
  plan?: string;
  role?: string;
  emails?: string[];
  unverified?: string[];
  first?: string;
  last?: string;
  banned?: boolean;
  createdAt?: number;
  lastSignInAt?: number;
  password?: boolean;
  passwordCompromised?: boolean;
  metadata?: Record<string, unknown>;
};
type Stubbed = typeof globalThis & {
  __users: Record<string, StubUser>;
  __clerkSessions: Record<string, { id: string; status: string }[]>;
  __who?: string;
  __kvStore: Map<string, unknown>;
};
const g = globalThis as Stubbed;
const day = 24 * 60 * 60 * 1000;
g.__users = {
  user_owner: { emails: ["owner@example.com"], first: "Owner", plan: "free", createdAt: Date.UTC(2023, 0, 1) },
  user_super: { emails: ["super@example.com"], first: "Sue", createdAt: Date.UTC(2023, 5, 1) },
  user_support: { emails: ["support@example.com"], first: "Sam", createdAt: Date.UTC(2023, 6, 1) },
  user_analyst: { emails: ["analyst@example.com"], first: "Ana", createdAt: Date.UTC(2023, 7, 1) },
  user_writer: { emails: ["writer@example.com"], first: "Wes", createdAt: Date.UTC(2023, 8, 1) },
  user_alice: { emails: ["alice@example.com"], first: "Alice", plan: "pro", metadata: { planExpiresAt: Date.now() + 20 * day }, createdAt: Date.UTC(2024, 0, 15), lastSignInAt: Date.UTC(2026, 9, 1) },
  user_bob: { unverified: ["bob@example.com"], first: "Bob", createdAt: Date.UTC(2024, 2, 10), password: false },
  user_carol: { emails: ["carol@example.com"], first: "Carol", plan: "business", createdAt: Date.UTC(2025, 4, 2) },
  user_dave: { emails: ["dave@example.com"], first: "Dave", createdAt: Date.UTC(2025, 6, 9) },
  user_plain: { emails: ["plain@example.com"], first: "Pat", createdAt: Date.UTC(2025, 8, 1) },
};
for (let i = 0; i < 12; i++) g.__users[`user_bulk${String(i).padStart(2, "0")}`] = { emails: [`bulk${i}@example.com`], createdAt: Date.UTC(2026, 0, 1 + i) };
g.__clerkSessions = {
  user_alice: [
    { id: "sess_a1", status: "active" },
    { id: "sess_a2", status: "active" },
  ],
  user_carol: [{ id: "sess_c1", status: "active" }],
  user_owner: [{ id: "sess_o1", status: "active" }],
};

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const audit = await import("../admin/audit");
  const store = await import("../admin/store");
  const groups = await import("../groupStore");
  const sessions = await import("../sessionStore");
  const payments = await import("../paymentsStore");
  const usage = await import("../recordingUsage");
  const meetings = await import("../userMeetings");
  const { eventStore } = await import("../eventStore");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    users: await import("../../app/api/admin/users/route"),
    user: await import("../../app/api/admin/users/[id]/route"),
    email: await import("../../app/api/admin/users/[id]/email/route"),
    suspend: await import("../../app/api/admin/users/[id]/suspend/route"),
    sessions: await import("../../app/api/admin/users/[id]/sessions/route"),
    password: await import("../../app/api/admin/users/[id]/password/route"),
    deletion: await import("../../app/api/admin/users/[id]/deletion/route"),
    purge: await import("../../app/api/admin/users/[id]/deletion/purge/route"),
    notes: await import("../../app/api/admin/users/[id]/notes/route"),
    tags: await import("../../app/api/admin/users/[id]/tags/route"),
    support: await import("../../app/api/admin/users/[id]/support/route"),
    mySupport: await import("../../app/api/admin/support/route"),
    groups: await import("../../app/api/admin/groups/route"),
    group: await import("../../app/api/admin/groups/[gid]/route"),
    groupOwner: await import("../../app/api/admin/groups/[gid]/owner/route"),
    groupMember: await import("../../app/api/admin/groups/[gid]/members/[userId]/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  type Body = Record<string, unknown> & { error?: string; message?: string };

  async function call<P = Record<string, string>>(
    who: string,
    handler: (req: Request, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; params?: P; query?: string } = {},
  ) {
    g.__who = who;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/admin/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m) jar[who] = decodeURIComponent(m[1]);
    const body = (await res.json().catch(() => ({}))) as Body;
    return { status: res.status, body };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enrollAndVerify(who: string) {
    const e = await call(who, R.enroll.POST, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    const c = await call(who, R.confirm.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  async function stepUp(who: string) {
    tick();
    const v = await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  const id = (uid: string) => ({ id: uid });
  const lastAudit = async (action: string) => (await audit.listAdminAudit({ action })).items[0];

  // Administrators, set up directly (appointing is phase 1's test).
  const now0 = Date.now();
  const appoint = (userId: string, email: string, roleId: string) =>
    store.saveMember({ userId, email, name: email, roleId, status: "active", appointedBy: "user_owner", appointedAt: now0, updatedAt: now0 });
  await store.saveRole({ id: "custom_writer", name: "Writer", description: "", permissions: ["users:read", "users:write"], builtIn: false });
  await appoint("user_super", "super@example.com", "super_admin");
  await appoint("user_support", "support@example.com", "support");
  await appoint("user_analyst", "analyst@example.com", "analyst");
  await appoint("user_writer", "writer@example.com", "custom_writer");
  for (const who of ["user_owner", "user_super", "user_support", "user_analyst", "user_writer"]) await enrollAndVerify(who);

  // Alice's world: a meeting she hosts, one she joined, recording time, a
  // payment, a group, a device session.
  await eventStore.create({
    id: "ev_alice",
    slug: "alice-weekly",
    name: "Alice weekly",
    ownerUserId: "user_alice",
    visibility: "public",
    createdAt: new Date(Date.now() - 2 * day).toISOString(),
    updatedAt: new Date().toISOString(),
    waitingRoomEnabled: true,
    livekitRoom: "alice-weekly",
    qrSeed: "x",
    roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);
  await meetings.addUserMeeting("user_alice", "ev_other", Date.now() - day);
  await usage.rememberEgressOwner("eg_1", "user_alice");
  await usage.addRecordedSeconds("eg_1", 5400, Date.now());
  await payments.recordPayment({ paymentRef: "pay_alice_1", userId: "user_alice", plan: "pro", billingCycle: "monthly", amountEsp: 10, periodStart: Date.now(), periodEnd: Date.now() + 30 * day });
  const aliceGroup = await groups.createGroup({ name: "Alice's team" }, { userId: "user_alice", name: "Alice", email: "alice@example.com" }, [
    { userId: "user_dave", name: "Dave", email: "dave@example.com" },
    { userId: "user_owner", name: "Owner", email: "owner@example.com" },
  ]);
  const ownerGroup = await groups.createGroup({ name: "Owner's circle" }, { userId: "user_owner", name: "Owner" }, [{ userId: "user_carol", name: "Carol" }]);
  await sessions.createSession("user_alice", { ip: "203.0.113.5", fingerprint: "fp1", userAgent: "Firefox" });
  await sessions.createSession("user_alice", { ip: "203.0.113.6", fingerprint: "fp2", userAgent: "Safari" });

  console.log("users list");
  await t("users:read is needed; no filter pages straight through Clerk", async () => {
    assert.equal((await call("user_plain", R.users.GET)).body.error, "not_admin");
    const r = await call("user_analyst", R.users.GET, { query: "?pageSize=10&page=2&sort=-created_at" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, Object.keys(g.__users).length);
    assert.equal(r.body.scanned, null);
    assert.equal((r.body.items as unknown[]).length, 10);
    const first = await call("user_analyst", R.users.GET, { query: "?pageSize=10&sort=-created_at" });
    assert.equal((first.body.items as { id: string }[])[0].id, "user_bulk11", "newest sign-up first");
  });

  await t("filters: plan, access, verification, sign-up dates, sort by email", async () => {
    const ids = async (q: string) => ((await call("user_analyst", R.users.GET, { query: q })).body.items as { id: string }[]).map((u) => u.id);
    assert.deepEqual(await ids("?plan=pro"), ["user_alice"]);
    assert.deepEqual(await ids("?plan=enterprise"), ["user_owner"], "the owner's plan reads as enterprise whatever is stored");
    assert.deepEqual(await ids("?access=owner"), ["user_owner"]);
    assert.deepEqual((await ids("?access=admin&sort=email_address")), ["user_analyst", "user_super", "user_support", "user_writer"]);
    assert.deepEqual(await ids("?verified=no"), ["user_bob"]);
    assert.deepEqual(await ids("?from=2024-01-01&to=2024-12-31&sort=created_at"), ["user_alice", "user_bob"]);
    const r = await call("user_analyst", R.users.GET, { query: "?verified=yes&pageSize=10" });
    assert.equal(r.body.scanned, Object.keys(g.__users).length);
    assert.equal(r.body.capped, false);
    const row = (await call("user_analyst", R.users.GET, { query: "?q=alice" })).body.items as { email: string; plan: string; planExpiresAt: number; emailVerified: boolean }[];
    assert.equal(row[0].email, "alice@example.com");
    assert.equal(row[0].emailVerified, true);
    assert.ok(row[0].planExpiresAt > Date.now());
  });

  console.log("user detail");
  await t("detail shows account, plan, usage, groups, sessions; payments need billing:read, audit needs audit:read", async () => {
    const owner = await call("user_owner", R.user.GET, { params: id("user_alice") });
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    const b = owner.body as {
      plan: { effective: string; planExpiresAt: number; recordingHoursPerMonth: number };
      usage: { meetingsHosted: number; recentHosted: { name: string }[]; attended: unknown[]; recording: { thisMonth: { seconds: number } } };
      groups: { name: string; role: string }[];
      payments: { paymentRef: string }[];
      sessions: { clerk: unknown[]; devices: unknown[] };
      audit: unknown[];
      protection: { isOwner: boolean; refusal: unknown };
    };
    assert.equal(b.plan.effective, "pro");
    assert.equal(b.plan.recordingHoursPerMonth, 10);
    assert.equal(b.usage.meetingsHosted, 1);
    assert.equal(b.usage.recentHosted[0].name, "Alice weekly");
    assert.equal(b.usage.attended.length, 1);
    assert.equal(b.usage.recording.thisMonth.seconds, 5400);
    assert.deepEqual(b.groups.map((x) => [x.name, x.role]), [["Alice's team", "owner"]]);
    assert.deepEqual(b.payments.map((p) => p.paymentRef), ["pay_alice_1"]);
    assert.equal(b.sessions.clerk.length, 2);
    assert.equal(b.sessions.devices.length, 2);
    assert.ok(Array.isArray(b.audit));
    assert.equal(b.protection.refusal, null);

    const sup = await call("user_support", R.user.GET, { params: id("user_alice") });
    assert.equal(sup.status, 200);
    assert.equal(sup.body.payments, null, "support has no billing:read");
    assert.equal(sup.body.audit, null, "support has no audit:read");
    assert.equal((await call("user_owner", R.user.GET, { params: id("user_nobody") })).status, 404);

    const ownerView = await call("user_super", R.user.GET, { params: id("user_owner") });
    assert.equal((ownerView.body.protection as { isOwner: boolean }).isOwner, true);
    assert.equal((ownerView.body.protection as { refusal: { error: string } }).refusal.error, "owner_protected");
  });

  console.log("the owner is untouchable");
  await t("every user action refuses the platform owner — even from the owner's own session — and nothing changes", async () => {
    const before = JSON.stringify(g.__users.user_owner);
    const sessionsBefore = JSON.stringify(g.__clerkSessions.user_owner);
    await stepUp("user_super");
    await stepUp("user_owner");
    // (Entering a code is audited too, so count from here.)
    const auditBefore = (await audit.listAdminAudit({})).total;
    for (const who of ["user_super", "user_owner"]) {
      const p = { params: id("user_owner") };
      const tries = [
        await call(who, R.user.PATCH, { ...p, method: "PATCH", body: { firstName: "Mallory" } }),
        await call(who, R.email.POST, { ...p, method: "POST", body: { emailId: "idn_user_owner_owner@example.com", verified: false } }),
        await call(who, R.suspend.POST, { ...p, method: "POST", body: { reason: "x" } }),
        await call(who, R.suspend.DELETE, { ...p, method: "DELETE" }),
        await call(who, R.sessions.DELETE, { ...p, method: "DELETE" }),
        await call(who, R.password.POST, { ...p, method: "POST", body: { action: "require_reset" } }),
        await call(who, R.deletion.POST, { ...p, method: "POST", body: { reason: "x" } }),
        await call(who, R.deletion.DELETE, { ...p, method: "DELETE" }),
        await call(who, R.purge.POST, { ...p, method: "POST" }),
        await call(who, R.notes.POST, { ...p, method: "POST", body: { text: "x" } }),
        await call(who, R.tags.PUT, { ...p, method: "PUT", body: { tags: ["x"] } }),
        await call(who, R.support.POST, { ...p, method: "POST", body: { reason: "x" } }),
      ];
      for (const r of tries) assert.equal(r.body.error, "owner_protected", `${who}: ${JSON.stringify(r.body)}`);
      const gp = { params: { gid: ownerGroup.id } };
      assert.equal((await call(who, R.groupOwner.POST, { ...gp, method: "POST", body: { userId: "user_carol" } })).body.error, "owner_protected");
      assert.equal(
        (await call(who, R.groupMember.DELETE, { params: { gid: aliceGroup.id, userId: "user_owner" }, method: "DELETE" })).body.error,
        "owner_protected",
      );
    }
    assert.equal(JSON.stringify(g.__users.user_owner), before);
    assert.equal(JSON.stringify(g.__clerkSessions.user_owner), sessionsBefore);
    assert.equal((await groups.getMember(ownerGroup.id, "user_owner"))?.role, "owner");
    assert.ok(await groups.getMember(aliceGroup.id, "user_owner"));
    assert.equal((await audit.listAdminAudit({})).total, auditBefore, "a refused action writes nothing");
  });

  console.log("permissions");
  await t("each action needs its permission; the refusal names it", async () => {
    const p = { params: id("user_dave") };
    const expect = async (who: string, r: Promise<{ body: Body }>, perm: string) => {
      const b = (await r).body;
      assert.equal(b.error, "forbidden", `${who} ${perm}: ${JSON.stringify(b)}`);
      assert.equal(b.permission, perm);
    };
    await expect("analyst", call("user_analyst", R.user.PATCH, { ...p, method: "PATCH", body: { firstName: "D" } }), "users:write");
    await expect("analyst", call("user_analyst", R.notes.POST, { ...p, method: "POST", body: { text: "x" } }), "users:write");
    await expect("analyst", call("user_analyst", R.tags.PUT, { ...p, method: "PUT", body: { tags: ["x"] } }), "users:write");
    await expect("analyst", call("user_analyst", R.email.POST, { ...p, method: "POST", body: { emailId: "x", verified: true } }), "users:write");
    await expect("analyst", call("user_analyst", R.suspend.POST, { ...p, method: "POST" }), "users:suspend");
    await expect("analyst", call("user_analyst", R.sessions.DELETE, { ...p, method: "DELETE" }), "users:suspend");
    await expect("analyst", call("user_analyst", R.support.POST, { ...p, method: "POST", body: { reason: "x" } }), "users:support_access");
    await expect("analyst", call("user_analyst", R.groupOwner.POST, { params: { gid: aliceGroup.id }, method: "POST", body: { userId: "user_dave" } }), "users:write");
    await expect("analyst", call("user_analyst", R.groupMember.DELETE, { params: { gid: aliceGroup.id, userId: "user_dave" }, method: "DELETE" }), "users:write");
    await expect("support", call("user_support", R.deletion.POST, { ...p, method: "POST", body: { reason: "x" } }), "users:delete");
    await expect("support", call("user_support", R.purge.POST, { ...p, method: "POST" }), "users:delete");
    await expect("writer", call("user_writer", R.password.POST, { ...p, method: "POST", body: { action: "require_reset" } }), "users:suspend");
    assert.equal(g.__users.user_dave.banned, undefined);
  });

  await t("nobody acts on themselves, or on an administrator who outranks them", async () => {
    assert.equal((await call("user_support", R.suspend.POST, { params: id("user_support"), method: "POST" })).body.error, "not_on_yourself");
    const up = await call("user_support", R.suspend.POST, { params: id("user_super"), method: "POST", body: { reason: "x" } });
    assert.equal(up.body.error, "outranks_you");
    assert.ok((up.body.permissions as string[]).includes("users:delete"));
    assert.equal(g.__users.user_super.banned, undefined);
    // The owner outranks everyone: they may act on any administrator.
    assert.equal((await call("user_owner", R.tags.PUT, { params: id("user_super"), method: "PUT", body: { tags: ["staff-account"] } })).status, 200);
  });

  console.log("actions, audit and persistence");
  await t("edit name: Clerk updated, audited with only what changed", async () => {
    const r = await call("user_support", R.user.PATCH, { params: id("user_dave"), method: "PATCH", body: { firstName: "David", lastName: "Jones" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(g.__users.user_dave.first, "David");
    assert.equal(g.__users.user_dave.last, "Jones");
    const e = await lastAudit("user.update");
    assert.deepEqual(e.before, { firstName: "Dave", lastName: null });
    assert.deepEqual(e.after, { firstName: "David", lastName: "Jones" });
    assert.equal(e.actorEmail, "support@example.com");
    assert.equal(e.targetId, "user_dave");
    assert.equal((await call("user_support", R.user.PATCH, { params: id("user_dave"), method: "PATCH", body: { firstName: "<b>" } })).body.error, "invalid_name");
  });

  await t("email verification both ways, through Clerk, audited", async () => {
    const r = await call("user_support", R.email.POST, { params: id("user_bob"), method: "POST", body: { emailId: "idn_user_bob_bob@example.com", verified: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(g.__users.user_bob.emails, ["bob@example.com"]);
    assert.deepEqual((await lastAudit("user.email.verify")).after, { address: "bob@example.com", verified: true });
    const back = await call("user_support", R.email.POST, { params: id("user_bob"), method: "POST", body: { emailId: "idn_user_bob_bob@example.com", verified: false } });
    assert.equal(back.status, 200);
    assert.deepEqual(g.__users.user_bob.unverified, ["bob@example.com"]);
    assert.equal((await call("user_support", R.email.POST, { params: id("user_bob"), method: "POST", body: { emailId: "idn_nope", verified: true } })).status, 404);
  });

  await t("suspend: Clerk ban, every session ended (Clerk's and the app's), reason kept; reactivate lifts it", async () => {
    const r = await call("user_support", R.suspend.POST, { params: id("user_alice"), method: "POST", body: { reason: "Chargeback" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.sessionsEnded, { clerk: 2, devices: 2 });
    assert.equal(g.__users.user_alice.banned, true);
    assert.ok(g.__clerkSessions.user_alice.every((s) => s.status === "revoked"));
    assert.equal((await sessions.getActiveSessions("user_alice")).length, 0);
    const e = await lastAudit("user.suspend");
    assert.equal(e.note, "Chargeback");
    assert.deepEqual(e.before, { suspended: false });
    const list = await call("user_analyst", R.users.GET, { query: "?status=suspended" });
    assert.deepEqual((list.body.items as { id: string }[]).map((u) => u.id), ["user_alice"]);
    const detail = await call("user_analyst", R.user.GET, { params: id("user_alice") });
    assert.equal((detail.body.suspension as { reason: string }).reason, "Chargeback");
    assert.equal((await call("user_support", R.suspend.DELETE, { params: id("user_alice"), method: "DELETE" })).status, 200);
    assert.equal(g.__users.user_alice.banned, false);
    assert.deepEqual((await lastAudit("user.reactivate")).before, { suspended: true, reason: "Chargeback" });
  });

  await t("sign out everywhere ends Clerk and device sessions and says how many", async () => {
    g.__clerkSessions.user_carol.push({ id: "sess_c2", status: "active" });
    await sessions.createSession("user_carol", { ip: null, fingerprint: "fpc", userAgent: "Edge" });
    const r = await call("user_support", R.sessions.DELETE, { params: id("user_carol"), method: "DELETE" });
    assert.deepEqual(r.body.sessionsEnded, { clerk: 2, devices: 1 });
    assert.equal((await sessions.getActiveSessions("user_carol")).length, 0);
    assert.deepEqual((await lastAudit("user.sessions.revoke")).before, { clerkSessions: 2, deviceSessions: 1 });
  });

  await t("password help: no reset email from Clerk; require a new password, or email instructions (no sign-in token)", async () => {
    const noPw = await call("user_support", R.password.POST, { params: id("user_bob"), method: "POST", body: { action: "require_reset" } });
    assert.equal(noPw.body.error, "no_password");
    const req = await call("user_support", R.password.POST, { params: id("user_carol"), method: "POST", body: { action: "require_reset" } });
    assert.equal(req.status, 200, JSON.stringify(req.body));
    assert.equal(g.__users.user_carol.passwordCompromised, true);
    assert.equal((await call("user_writer", R.password.POST, { params: id("user_carol"), method: "POST", body: { action: "clear_reset" } })).status, 200);
    assert.equal(g.__users.user_carol.passwordCompromised, false);
    assert.equal((await call("user_support", R.password.POST, { params: id("user_carol"), method: "POST", body: { action: "send_instructions" } })).body.error, "mail_not_configured");

    process.env.RESEND_API_KEY = "re_test";
    const realFetch = globalThis.fetch;
    const sent: { to: string[]; text: string }[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    }) as typeof fetch;
    try {
      const ok = await call("user_support", R.password.POST, { params: id("user_carol"), method: "POST", body: { action: "send_instructions" } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(sent[0].to, ["carol@example.com"]);
      assert.match(sent[0].text, /\/sign-in/);
      assert.match(sent[0].text, /Forgot password/);
      assert.doesNotMatch(sent[0].text, /ticket|token/i);
      assert.equal((await call("user_support", R.password.POST, { params: id("user_bob"), method: "POST", body: { action: "send_instructions" } })).body.error, "no_verified_email");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.RESEND_API_KEY;
    }
    assert.deepEqual((await lastAudit("user.password.instructions")).after, { sentTo: "carol@example.com" });
  });

  await t("notes and tags are kept in KV, read back by the next request, and audited", async () => {
    const add = await call("user_support", R.notes.POST, { params: id("user_dave"), method: "POST", body: { text: "Called about billing" } });
    assert.equal(add.status, 201);
    await call("user_support", R.notes.POST, { params: id("user_dave"), method: "POST", body: { text: "Second note" } });
    assert.equal((await call("user_support", R.notes.POST, { params: id("user_dave"), method: "POST", body: { text: "  " } })).body.error, "empty_note");
    const tags = await call("user_support", R.tags.PUT, { params: id("user_dave"), method: "PUT", body: { tags: ["VIP", "vip", "needs follow up", "<x>"] } });
    assert.deepEqual(tags.body.tags, ["vip", "needs-follow-up", "x"]);
    assert.ok(g.__kvStore.has("neo:admin:user:user_dave:notes"));
    assert.ok(String((g.__kvStore.get("neo:admin:user-tags") as Record<string, string>).user_dave).includes("vip"));
    const d = await call("user_analyst", R.user.GET, { params: id("user_dave") });
    assert.deepEqual((d.body.notes as { text: string }[]).map((x) => x.text), ["Second note", "Called about billing"]);
    assert.deepEqual((d.body.user as { tags: string[] }).tags, ["vip", "needs-follow-up", "x"]);
    assert.deepEqual(((await call("user_analyst", R.users.GET, { query: "?tag=vip" })).body.items as { id: string }[]).map((u) => u.id), ["user_dave"]);
    const noteId = (add.body.note as { id: string }).id;
    assert.equal((await call("user_support", R.notes.DELETE, { params: id("user_dave"), method: "DELETE", query: `?noteId=${noteId}` })).status, 200);
    assert.deepEqual((await lastAudit("user.note.remove")).before, { noteId, text: "Called about billing", by: "support@example.com" });
    const after = await call("user_analyst", R.user.GET, { params: id("user_dave") });
    assert.deepEqual((after.body.notes as { text: string }[]).map((x) => x.text), ["Second note"]);
    assert.deepEqual((await lastAudit("user.tags")).after, { tags: ["vip", "needs-follow-up", "x"] });
  });

  console.log("support access");
  await t("a support session needs a reason and a fresh code, is time-boxed, shows the workspace and audits every look", async () => {
    tick(11 * 60_000);
    const stale = await call("user_support", R.support.POST, { params: id("user_alice"), method: "POST", body: { reason: "Ticket 42" } });
    assert.equal(stale.body.error, "step_up_required");
    await stepUp("user_support");
    assert.equal((await call("user_support", R.support.POST, { params: id("user_alice"), method: "POST", body: { reason: "" } })).body.error, "reason_required");
    assert.equal((await call("user_support", R.support.GET, { params: id("user_alice") })).body.error, "support_session_required");
    const open = await call("user_support", R.support.POST, { params: id("user_alice"), method: "POST", body: { reason: "Ticket 42", minutes: 9999 } });
    assert.equal(open.status, 201, JSON.stringify(open.body));
    const s = open.body.session as { expiresAt: number; startedAt: number };
    assert.equal(s.expiresAt - s.startedAt, 120 * 60_000, "capped at 120 minutes");
    const banner = await call("user_support", R.mySupport.GET);
    assert.equal((banner.body.session as { userId: string }).userId, "user_alice");
    assert.equal((await call("user_super", R.mySupport.GET)).body.session, null, "another administrator has no session");
    const ws = await call("user_support", R.support.GET, { params: id("user_alice") });
    assert.equal(ws.status, 200, JSON.stringify(ws.body));
    assert.deepEqual((ws.body.meetings as { name: string }[]).map((m) => m.name), ["Alice weekly"]);
    assert.deepEqual((ws.body.groups as { name: string }[]).map((x) => x.name), ["Alice's team"]);
    assert.equal((await call("user_super", R.support.GET, { params: id("user_alice") })).body.error, "support_session_required");
    assert.equal((await call("user_support", R.support.GET, { params: id("user_dave") })).body.error, "support_session_required", "the session covers Alice only");
    assert.equal((await lastAudit("support.start")).note, "Ticket 42");
    assert.deepEqual((await lastAudit("support.view")).after, { supportSession: (open.body.session as { id: string }).id, viewed: "workspace" });
    const detail = await call("user_support", R.user.GET, { params: id("user_alice") });
    assert.equal(((detail.body.support as { history: unknown[] }).history).length, 1);

    // Losing the permission ends access at once.
    await store.saveMember({ ...(await store.getMember("user_support"))!, roleId: "custom_writer" });
    assert.equal((await call("user_support", R.support.GET, { params: id("user_alice") })).body.permission, "users:support_access");
    await store.saveMember({ ...(await store.getMember("user_support"))!, roleId: "support" });

    tick(121 * 60_000);
    await stepUp("user_support");
    assert.equal((await call("user_support", R.support.GET, { params: id("user_alice") })).body.error, "support_session_required", "expired");
    assert.equal((await call("user_support", R.mySupport.GET)).body.session, null);
  });

  await t("ending a support session is audited; opening another ends the first", async () => {
    await stepUp("user_support");
    await call("user_support", R.support.POST, { params: id("user_dave"), method: "POST", body: { reason: "Ticket 7" } });
    await call("user_support", R.support.POST, { params: id("user_carol"), method: "POST", body: { reason: "Ticket 8" } });
    assert.equal((await lastAudit("support.end")).note, "Replaced by a new support session");
    assert.equal((await call("user_support", R.support.DELETE, { params: id("user_dave"), method: "DELETE" })).body.error, "no_session");
    assert.equal((await call("user_support", R.support.DELETE, { params: id("user_carol"), method: "DELETE" })).status, 200);
    assert.equal((await lastAudit("support.end")).targetId, "user_carol");
    const hist = (await call("user_analyst", R.user.GET, { params: id("user_carol") })).body.support as { history: { endedBy: string }[] };
    assert.equal(hist.history[0].endedBy, "admin");
  });

  console.log("deletion");
  await t("delete is two steps: request suspends for the retention period; it needs a fresh code; cancel restores", async () => {
    tick(11 * 60_000);
    assert.equal((await call("user_super", R.deletion.POST, { params: id("user_plain"), method: "POST", body: { reason: "Asked to leave" } })).body.error, "step_up_required");
    await stepUp("user_super");
    const r = await call("user_super", R.deletion.POST, { params: id("user_plain"), method: "POST", body: { reason: "Asked to leave" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const del = r.body.deletion as { deleteAfter: number; requestedAt: number };
    assert.equal(del.deleteAfter - del.requestedAt, 30 * day);
    assert.equal(g.__users.user_plain.banned, true);
    assert.ok(g.__kvStore.has("neo:admin:deletions"));
    assert.equal((await call("user_support", R.suspend.DELETE, { params: id("user_plain"), method: "DELETE" })).body.error, "pending_deletion");
    assert.deepEqual(((await call("user_analyst", R.users.GET, { query: "?status=pending_deletion" })).body.items as { id: string }[]).map((u) => u.id), ["user_plain"]);
    const early = await call("user_super", R.purge.POST, { params: id("user_plain"), method: "POST" });
    assert.equal(early.body.error, "retention_not_over");
    assert.ok(g.__users.user_plain, "still there");
    assert.equal((await call("user_super", R.deletion.DELETE, { params: id("user_plain"), method: "DELETE" })).status, 200);
    assert.equal(g.__users.user_plain.banned, false, "was not suspended before, so cancelling reactivates");
    assert.equal((await lastAudit("user.delete.cancel")).targetId, "user_plain");
  });

  await t("after the retention period: refused while they own a group; then gone from Clerk, groups and KV, kept in the audit trail as a certificate", async () => {
    await stepUp("user_super");
    assert.equal((await call("user_super", R.purge.POST, { params: id("user_alice"), method: "POST" })).body.error, "not_requested");
    await call("user_super", R.notes.POST, { params: id("user_alice"), method: "POST", body: { text: "Leaving" } });
    assert.equal((await call("user_super", R.deletion.POST, { params: id("user_alice"), method: "POST", body: { reason: "GDPR request" } })).status, 200);
    tick(31 * day);
    await stepUp("user_super");
    const owns = await call("user_super", R.purge.POST, { params: id("user_alice"), method: "POST" });
    assert.equal(owns.body.error, "owns_groups");
    assert.deepEqual((owns.body.groups as { id: string }[]).map((x) => x.id), [aliceGroup.id]);
    // Hand the group to Dave on the Groups page.
    const tr = await call("user_super", R.groupOwner.POST, { params: { gid: aliceGroup.id }, method: "POST", body: { userId: "user_dave" } });
    assert.equal(tr.status, 200, JSON.stringify(tr.body));
    // Phase 11: the typed confirmation is checked by the server too.
    assert.equal((await call("user_super", R.purge.POST, { params: id("user_alice"), method: "POST" })).body.error, "confirmation_required");
    const gone = await call("user_super", R.purge.POST, { params: id("user_alice"), method: "POST", body: { confirm: "delete" } });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(g.__users.user_alice, undefined);
    assert.equal(await groups.getMember(aliceGroup.id, "user_alice"), null);
    assert.equal(g.__kvStore.has("neo:admin:user:user_alice:notes"), false);
    assert.equal((await call("user_super", R.user.GET, { params: id("user_alice") })).status, 404);
    // Phase 11: a deletion certificate — counts, when, by whom — with no personal data.
    const e = await lastAudit("data.deletion.certificate");
    assert.equal(e.targetId, "user_alice");
    assert.equal(e.targetLabel, "deleted account");
    assert.ok(!JSON.stringify(e).includes("alice@example.com"));
    assert.equal((e.after as { removed: { clerk: number } }).removed.clerk, 1);
  });

  console.log("groups");
  // A month has passed: everyone's admin session has ended.
  for (const who of ["user_analyst", "user_support", "user_owner"]) await stepUp(who);
  await t("every group is listed, including ones made before the index (backfilled from members' group sets)", async () => {
    const legacy = await groups.createGroup({ name: "Before the index" }, { userId: "user_carol", name: "Carol" });
    // As if created before neo:groups:all existed.
    (g.__kvStore.get("neo:groups:all") as Set<string>).delete(legacy.id);
    g.__kvStore.delete("neo:groups:all:backfilled");
    const r = await call("user_analyst", R.groups.GET);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.backfilled, true);
    const names = (r.body.items as { name: string }[]).map((x) => x.name).sort();
    assert.deepEqual(names, ["Alice's team", "Before the index", "Owner's circle"]);
    const row = (r.body.items as { name: string; ownerId: string; memberCount: number }[]).find((x) => x.name === "Alice's team")!;
    assert.equal(row.ownerId, "user_dave");
    assert.equal(row.memberCount, 2);
    assert.equal((await call("user_analyst", R.groups.GET, { query: "?q=carol" })).body.total, 1, "by the owner's name");
    assert.equal((await call("user_analyst", R.groups.GET)).body.backfilled, false, "only the first time");
    assert.equal((await call("user_analyst", R.groups.POST, { method: "POST", body: { action: "backfill" } })).body.permission, "users:write");
    const again = await call("user_support", R.groups.POST, { method: "POST", body: { action: "backfill" } });
    assert.equal(again.body.added, 0);
    // Deleting a group takes it out of the index.
    await groups.deleteGroup(legacy.id);
    assert.equal((g.__kvStore.get("neo:groups:all") as Set<string>).has(legacy.id), false);
    assert.equal((await call("user_analyst", R.groups.GET)).body.total, 2);
  });

  await t("group detail; transfer and remove are audited and written into the group's history", async () => {
    const d = await call("user_analyst", R.group.GET, { params: { gid: aliceGroup.id } });
    assert.equal(d.status, 200);
    assert.deepEqual((d.body.members as { userId: string; role: string }[]).map((m) => [m.userId, m.role]), [["user_dave", "owner"], ["user_owner", "participant"]]);
    const tr = await lastAudit("group.transfer");
    assert.deepEqual(tr.before, { ownerId: "user_alice", ownerName: "Alice" });
    assert.equal((tr.after as { ownerId: string }).ownerId, "user_dave");
    assert.equal((await call("user_support", R.groupMember.DELETE, { params: { gid: aliceGroup.id, userId: "user_dave" }, method: "DELETE" })).body.error, "cannot_target_owner");
    await groups.addMembers(aliceGroup.id, [{ userId: "user_bob", name: "Bob" }], { userId: "user_dave", emails: [], isPlatformAdmin: false, role: "owner", isOwner: true, reason: "owner" });
    const rm = await call("user_support", R.groupMember.DELETE, { params: { gid: aliceGroup.id, userId: "user_bob" }, method: "DELETE" });
    assert.equal(rm.status, 200, JSON.stringify(rm.body));
    assert.equal(await groups.getMember(aliceGroup.id, "user_bob"), null);
    assert.deepEqual((await lastAudit("group.member.remove")).before, { userId: "user_bob", name: "Bob", role: "participant" });
    const activity = await groups.listActivity(aliceGroup.id);
    assert.match(activity[0].detail, /administrator removed Bob/);
    assert.ok(activity.some((a) => /administrator made Dave the owner/.test(a.detail)));
    assert.equal((await call("user_support", R.groupOwner.POST, { params: { gid: aliceGroup.id }, method: "POST", body: { userId: "user_bob" } })).body.error, "not_member");
    assert.equal((await call("user_support", R.group.GET, { params: { gid: "nope" } })).status, 404);
  });

  await t("the user page lists the audit entries about the account", async () => {
    const d = await call("user_owner", R.user.GET, { params: id("user_dave") });
    const actions = (d.body.audit as { action: string }[]).map((e) => e.action);
    for (const a of ["user.update", "user.note.add", "user.note.remove", "user.tags", "group.transfer"]) assert.ok(actions.includes(a), `${a} in ${actions}`);
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
