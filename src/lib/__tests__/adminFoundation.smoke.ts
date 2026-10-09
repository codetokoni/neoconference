// Run: npx tsx src/lib/__tests__/adminFoundation.smoke.ts
//
// The owner / administrator foundation, driven through the real /api/admin
// routes with Clerk and KV stood in for (./apiV1-stubs): who the owner is,
// that the owner's plan cannot be lowered, two-factor and step-up, roles and
// the rule that nobody hands out power they do not hold, suspension and
// removal reaching the older role checks, and the append-only audit trail.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_admin_foundation";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ADMIN_EMAILS = "legacy@example.com";
delete process.env.RESEND_API_KEY;

type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; role?: string; emails?: string[]; unverified?: string[]; first?: string }>;
  __who?: string;
  __sid?: string;
  __kvStore: Map<string, unknown>;
};
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { emails: ["owner@example.com"], plan: "starter", first: "Owner" },
  user_fake: { emails: ["someone@example.com"], unverified: ["owner@example.com"] },
  user_legacy: { emails: ["legacy@example.com"] },
  user_support: { emails: ["support@example.com"] },
  user_lead: { emails: ["lead@example.com"] },
  user_help: { emails: ["help@example.com"] },
  user_plain: { emails: ["plain@example.com"] },
};

// A clock the test moves, so authenticator codes advance step by step.
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
  const plan = await import("../plan");
  const roles = await import("../roles");
  const audit = await import("../admin/audit");
  const R = {
    me: await import("../../app/api/admin/me/route"),
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    recovery: await import("../../app/api/admin/mfa/recovery/route"),
    team: await import("../../app/api/admin/team/route"),
    member: await import("../../app/api/admin/team/[userId]/route"),
    memberMfa: await import("../../app/api/admin/team/[userId]/mfa/route"),
    roles: await import("../../app/api/admin/roles/route"),
    role: await import("../../app/api/admin/roles/[id]/route"),
    audit: await import("../../app/api/admin/audit/route"),
    integrity: await import("../../app/api/admin/audit/integrity/route"),
    users: await import("../../app/api/admin/users/route"),
    appRole: await import("../../app/api/admin/role/route"),
  };

  const jar: Record<string, string> = {};
  let ownerRecovery: string[] = [];
  const secrets: Record<string, string> = {};

  async function call<P = Record<string, string>>(
    who: string,
    handler: (req: Request, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; params?: P; query?: string; cookie?: boolean } = {},
  ) {
    g.__who = who;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie !== false && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/admin/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
      { params: (opts.params ?? {}) as P },
    );
    const set = res.headers.get("set-cookie");
    const m = set?.match(/neo_admin_mfa=([^;]*)/);
    if (m) jar[who] = decodeURIComponent(m[1]);
    const text = await res.text();
    let body: Record<string, unknown> & { error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
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
    return c.body.recoveryCodes as string[];
  }
  async function stepUp(who: string) {
    tick();
    const v = await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }

  console.log("owner");
  await t("a verified owner email makes the owner; the same address unverified on another account does not", async () => {
    const me = await call("user_owner", R.me.GET);
    assert.equal(me.status, 200, JSON.stringify(me.body));
    const admin = me.body.admin as { isOwner: boolean; roleId: string; permissions: string[] };
    assert.equal(admin.isOwner, true);
    assert.equal(admin.roleId, "owner");
    assert.ok(admin.permissions.includes("admins:manage") && admin.permissions.includes("billing:refund"));
    const fake = await call("user_fake", R.me.GET);
    assert.equal(fake.status, 403);
    assert.equal(fake.body.error, "not_admin");
    const plain = await call("user_plain", R.me.GET);
    assert.equal(plain.body.error, "not_admin");
  });

  await t("the owner's plan is enterprise even with a cheaper plan stored on the account; never capped", async () => {
    assert.equal(await plan.getPlanForUserId("user_owner"), "enterprise");
    const cap = await plan.checkLifetimeCap("user_owner");
    assert.equal(cap.blocked, false);
    assert.equal(cap.plan, "enterprise");
    g.__who = "user_owner";
    assert.equal(await plan.getCurrentPlan(), "enterprise");
    assert.equal(await roles.getCurrentRole(), "admin");
    assert.equal(await plan.getPlanForUserId("user_fake"), "free");
  });

  console.log("two-factor");
  await t("no admin route answers before two-factor is set up, then only with this session's cookie", async () => {
    const before = await call("user_owner", R.team.GET);
    assert.equal(before.body.error, "mfa_enrollment_required");
    const e = await call("user_owner", R.enroll.POST, { method: "POST" });
    secrets.user_owner = e.body.secret as string;
    assert.match(String(e.body.qr), /^data:image\/png;base64,/);
    assert.match(String(e.body.otpauthUrl), /^otpauth:\/\/totp\/NeoConference%20Admin/);
    const wrong = await call("user_owner", R.confirm.POST, { method: "POST", body: { code: "000000" } });
    assert.equal(wrong.body.error, "invalid_code");
    tick();
    const ok = await call("user_owner", R.confirm.POST, { method: "POST", body: { code: code("user_owner") } });
    assert.equal(ok.status, 200);
    ownerRecovery = ok.body.recoveryCodes as string[];
    assert.equal(ownerRecovery.length, 10);
    assert.ok(jar.user_owner, "admin session cookie set");

    assert.equal((await call("user_owner", R.team.GET)).status, 200);
    assert.equal((await call("user_owner", R.team.GET, { cookie: false })).body.error, "mfa_required");
    g.__sid = "sess_other_device";
    assert.equal((await call("user_owner", R.team.GET)).body.error, "mfa_required", "cookie is bound to the Clerk session");
    delete g.__sid;
  });

  await t("a code cannot be used twice", async () => {
    tick();
    const c = code("user_owner");
    assert.equal((await call("user_owner", R.verify.POST, { method: "POST", body: { code: c } })).status, 200);
    assert.equal((await call("user_owner", R.verify.POST, { method: "POST", body: { code: c } })).body.error, "invalid_code");
  });

  console.log("administrators and roles");
  await t("appointing is sensitive: after 10 minutes it asks for a fresh code, then works and is audited", async () => {
    tick(11 * 60_000);
    const stale = await call("user_owner", R.team.POST, { method: "POST", body: { email: "support@example.com", roleId: "support" } });
    assert.equal(stale.body.error, "step_up_required");
    await stepUp("user_owner");
    const ok = await call("user_owner", R.team.POST, { method: "POST", body: { email: "support@example.com", roleId: "support" } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const none = await call("user_owner", R.team.POST, { method: "POST", body: { email: "nobody@example.com", roleId: "support" } });
    assert.equal(none.body.error, "no_account");
    const owner = await call("user_owner", R.team.POST, { method: "POST", body: { email: "owner@example.com", roleId: "support" } });
    assert.equal(owner.body.error, "owner_already");
    const { items } = await audit.listAdminAudit({ action: "admin.appoint" });
    assert.equal(items[0].targetLabel, "support@example.com");
    assert.deepEqual(items[0].after, { status: "active", roleId: "support" });
    assert.equal(items[0].actorEmail, "owner@example.com");
  });

  await t("a support admin reaches what Support allows and nothing else", async () => {
    await enrollAndVerify("user_support");
    assert.equal((await call("user_support", R.users.GET)).status, 200);
    const team = await call("user_support", R.team.GET);
    assert.equal(team.body.error, "forbidden");
    assert.equal(team.body.permission, "admins:read");
    assert.equal((await call("user_support", R.team.POST, { method: "POST", body: { email: "plain@example.com", roleId: "analyst" } })).body.error, "forbidden");
  });

  let leadRole = "";
  let helpRole = "";
  await t("nobody but the owner gives out, or acts on, power they do not hold", async () => {
    const lead = await call("user_owner", R.roles.POST, {
      method: "POST",
      body: { name: "Team lead", description: "Runs the helpdesk", permissions: ["admins:read", "admins:manage", "users:read", "not:a:permission"] },
    });
    assert.equal(lead.status, 201, JSON.stringify(lead.body));
    leadRole = (lead.body.role as { id: string; permissions: string[] }).id;
    assert.deepEqual((lead.body.role as { permissions: string[] }).permissions, ["admins:read", "admins:manage", "users:read"]);
    const help = await call("user_owner", R.roles.POST, { method: "POST", body: { name: "Helpdesk", permissions: ["users:read"] } });
    helpRole = (help.body.role as { id: string }).id;
    assert.equal((await call("user_owner", R.team.POST, { method: "POST", body: { email: "lead@example.com", roleId: leadRole } })).status, 201);

    await enrollAndVerify("user_lead");
    const up = await call("user_lead", R.team.POST, { method: "POST", body: { email: "plain@example.com", roleId: "super_admin" } });
    assert.equal(up.body.error, "role_exceeds_yours");
    const sus = await call("user_lead", R.member.PATCH, { method: "PATCH", params: { userId: "user_support" }, body: { status: "suspended" } });
    assert.equal(sus.body.error, "outranks_you");
    const mkRole = await call("user_lead", R.roles.POST, { method: "POST", body: { name: "Sneaky", permissions: ["billing:refund"] } });
    assert.equal(mkRole.body.error, "forbidden", "lead has no roles:manage");
    const ok = await call("user_lead", R.team.POST, { method: "POST", body: { email: "help@example.com", roleId: helpRole } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const self = await call("user_lead", R.member.PATCH, { method: "PATCH", params: { userId: "user_lead" }, body: { status: "suspended" } });
    assert.equal(self.body.error, "not_on_yourself");
  });

  await t("the owner cannot be changed through any admin route", async () => {
    const r = await call("user_owner", R.member.PATCH, { method: "PATCH", params: { userId: "user_owner" }, body: { status: "suspended" } });
    assert.equal(r.body.error, "not_on_yourself");
    const viaLead = await call("user_lead", R.member.DELETE, { method: "DELETE", params: { userId: "user_owner" } });
    assert.equal(viaLead.body.error, "not_found", "the owner has no administrator record to remove");
    tick();
    const role = await call("user_support", R.appRole.POST, { method: "POST", body: { userId: "user_owner", role: "user" } });
    assert.equal(role.body.error, "owner_protected");
    assert.equal(await plan.getPlanForUserId("user_owner"), "enterprise");
  });

  await t("a role change reaches its holders at once; a role in use cannot be deleted", async () => {
    await enrollAndVerify("user_help");
    assert.equal((await call("user_help", R.users.GET)).status, 200);
    await stepUp("user_owner");
    const edit = await call("user_owner", R.role.PATCH, { method: "PATCH", params: { id: helpRole }, body: { permissions: ["support:read"] } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal((await call("user_help", R.users.GET)).body.error, "forbidden");
    const del = await call("user_owner", R.role.DELETE, { method: "DELETE", params: { id: helpRole } });
    assert.equal(del.body.error, "role_in_use");
    const builtIn = await call("user_owner", R.role.PATCH, { method: "PATCH", params: { id: "support" }, body: { permissions: ["users:read"] } });
    assert.equal(builtIn.body.error, "built_in");
    const { items } = await audit.listAdminAudit({ action: "role.update" });
    assert.deepEqual(items[0].before, { permissions: ["users:read"] });
    assert.deepEqual(items[0].after, { permissions: ["support:read"] });
  });

  console.log("suspension, removal and older admins");
  await t("an ADMIN_EMAILS admin is recorded as Super admin on first visit", async () => {
    const me = await call("user_legacy", R.me.GET);
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal((me.body.admin as { roleId: string }).roleId, "super_admin");
    const { items } = await audit.listAdminAudit({ action: "admin.adopt" });
    assert.equal(items[0].targetLabel, "legacy@example.com");
  });

  await t("suspending takes admin away everywhere, including the older role check; reactivating gives it back", async () => {
    await stepUp("user_owner");
    const s = await call("user_owner", R.member.PATCH, { method: "PATCH", params: { userId: "user_support" }, body: { status: "suspended", reason: "Left the team" } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal((await call("user_support", R.users.GET)).body.error, "admin_suspended");
    g.__who = "user_support";
    g.__users.user_support.role = "admin";
    assert.equal(await roles.getCurrentRole(), "user", "a suspended record beats Clerk role admin");
    const back = await call("user_owner", R.member.PATCH, { method: "PATCH", params: { userId: "user_support" }, body: { status: "active" } });
    assert.equal(back.status, 200);
    assert.equal((await call("user_support", R.users.GET)).status, 200);
    const { items } = await audit.listAdminAudit({ target: "support@example.com", action: "admin.s" });
    assert.deepEqual(items[0].before, { status: "active", suspendedReason: null });
    assert.deepEqual(items[0].after, { status: "suspended", suspendedReason: "Left the team" });
  });

  await t("a removed ADMIN_EMAILS admin stays removed (not adopted again) and loses the older admin role", async () => {
    const r = await call("user_owner", R.member.DELETE, { method: "DELETE", params: { userId: "user_legacy" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call("user_legacy", R.me.GET)).body.error, "not_admin");
    g.__who = "user_legacy";
    assert.equal(await roles.getCurrentRole(), "user");
  });

  await t("five wrong codes lock verification and are audited; another admin can reset two-factor", async () => {
    let last = "";
    for (let i = 0; i < 5; i++) last = String((await call("user_help", R.verify.POST, { method: "POST", body: { code: "123456" } })).body.error);
    assert.equal(last, "locked");
    tick();
    assert.equal((await call("user_help", R.verify.POST, { method: "POST", body: { code: code("user_help") } })).body.error, "locked");
    const { items } = await audit.listAdminAudit({ actor: "help@example.com", outcome: "denied" });
    assert.ok(items.some((e) => e.action === "mfa.locked"));
    assert.ok(items.filter((e) => e.action === "mfa.verify.failed").length >= 4);
    await stepUp("user_owner");
    assert.equal((await call("user_owner", R.memberMfa.DELETE, { method: "DELETE", params: { userId: "user_help" } })).status, 200);
    const again = await call("user_help", R.users.GET);
    assert.equal(again.body.error, "mfa_enrollment_required");
  });

  await t("a recovery code gets you in once; replacing the codes needs a fresh code and retires the old ones", async () => {
    delete jar.user_owner;
    const used = await call("user_owner", R.verify.POST, { method: "POST", body: { code: ownerRecovery[0] } });
    assert.equal(used.status, 200, JSON.stringify(used.body));
    assert.equal(used.body.usedRecoveryCode, true);
    assert.equal(used.body.recoveryLeft, 9);
    delete jar.user_owner;
    assert.equal((await call("user_owner", R.verify.POST, { method: "POST", body: { code: ownerRecovery[0] } })).body.error, "invalid_code");
    await stepUp("user_owner");
    tick(11 * 60_000);
    assert.equal((await call("user_owner", R.recovery.POST, { method: "POST" })).body.error, "step_up_required");
    await stepUp("user_owner");
    const fresh = await call("user_owner", R.recovery.POST, { method: "POST" });
    assert.equal((fresh.body.recoveryCodes as string[]).length, 10);
    delete jar.user_owner;
    assert.equal((await call("user_owner", R.verify.POST, { method: "POST", body: { code: ownerRecovery[1] } })).body.error, "invalid_code");
    assert.equal((await call("user_owner", R.verify.POST, { method: "POST", body: { code: (fresh.body.recoveryCodes as string[])[0] } })).status, 200);
  });

  console.log("audit trail");
  await t("append-only: no route writes or deletes; numbers run unbroken; a removed entry is reported", async () => {
    assert.equal((R.audit as Record<string, unknown>).POST, undefined);
    assert.equal((R.audit as Record<string, unknown>).DELETE, undefined);
    assert.equal((R.audit as Record<string, unknown>).PATCH, undefined);
    const ok = await call("user_owner", R.integrity.GET);
    assert.equal(ok.body.intact, true, JSON.stringify(ok.body));
    const month = [...g.__kvStore.keys()].find((k) => /^neo:admin:audit:\d{4}-\d{2}$/.test(k))!;
    const list = g.__kvStore.get(month) as unknown[];
    const removed = list.splice(3, 1)[0];
    const bad = await call("user_owner", R.integrity.GET);
    assert.equal(bad.body.intact, false);
    assert.deepEqual(bad.body.missing, [JSON.parse(String(removed)).seq]);
    list.splice(3, 0, removed);
  });

  await t("the CSV export needs reports:export too, and neutralises spreadsheet formulas", async () => {
    assert.equal((await call("user_support", R.audit.GET, { query: "?format=csv" })).body.error, "forbidden");
    await stepUp("user_owner");
    assert.equal((await call("user_owner", R.roles.POST, { method: "POST", body: { name: "=SUM(1,2)", permissions: ["users:read"] } })).status, 201);
    const csv = await call("user_owner", R.audit.GET, { query: "?format=csv" });
    const text = String(csv.body.text);
    assert.ok(text.includes(",'=SUM(1,2),") || text.includes(",\"'=SUM(1,2)\","), "formula prefixed with a quote");
    assert.ok(!/,=SUM/.test(text));
    assert.match(text.split("\r\n")[0], /^seq,time \(UTC\),actor email/);
    assert.ok(text.includes("admin.appoint"));
    const page = await call("user_owner", R.audit.GET, { query: "?limit=2&offset=0" });
    assert.equal((page.body.items as unknown[]).length, 2);
    assert.ok((page.body.total as number) > 2);
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
