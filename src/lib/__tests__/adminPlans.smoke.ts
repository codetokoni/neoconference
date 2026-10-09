// Run: npx tsx src/lib/__tests__/adminPlans.smoke.ts
//
// Plans, coupons and subscriptions (admin phase 3), driven through the real
// /api/admin, /api/billing and cron routes with Clerk, KV and the eSPees API
// stood in for: plan edits make versions and existing subscribers keep
// theirs until a previewed migration; checkout charges the catalog price
// less a coupon or offer; every subscription action, its proration, the
// scheduled change the daily job applies; the owner is refused everywhere;
// permissions and the audit trail.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_admin_plans";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ESPEES_API_KEY = "test";
process.env.ESPEES_MERCHANT_WALLET = "wallet";
process.env.ESPEES_PRODUCT_SKU = "sku";
process.env.CRON_SECRET = "cron";
delete process.env.ADMIN_EMAILS;
delete process.env.BOOTSTRAP_BUSINESS_EMAIL;
delete process.env.RESEND_API_KEY;

type U = { plan?: string | null; role?: string; emails?: string[]; first?: string; metadata?: Record<string, unknown> };
type Stubbed = typeof globalThis & { __users: Record<string, U>; __who?: string; __kvStore: Map<string, unknown> };
const g = globalThis as Stubbed;

const DAY = 86_400_000;
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

g.__users = {
  user_owner: { emails: ["owner@example.com"], plan: "starter", first: "Owner" },
  user_billing: { emails: ["billing@example.com"] },
  user_support: { emails: ["support@example.com"] },
  user_plain: { emails: ["plain@example.com"] },
  user_editor: { emails: ["editor@example.com"] },
};
for (let i = 1; i <= 12; i++) g.__users[`user_u${i}`] = { emails: [`u${i}@example.com`] };
// From before the catalog: a paid plan in Clerk, no subscription record.
g.__users.user_u4.plan = "pro";
g.__users.user_u4.metadata = { planExpiresAt: realNow() + 300 * DAY };
g.__users.user_u8.plan = "business";

// eSPees: hand back a payment ref and remember where to return.
const espees: { body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).startsWith("https://api.espees.org/")) {
    espees.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ statusCode: 200, payment_ref: `ref_${espees.length}` }), { status: 200 });
  }
  return realFetch(url as string, init);
}) as typeof fetch;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const plan = await import("../plan");
  const audit = await import("../admin/audit");
  const subs = await import("../billing/subscriptions");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    team: await import("../../app/api/admin/team/route"),
    roles: await import("../../app/api/admin/roles/route"),
    plans: await import("../../app/api/admin/plans/route"),
    plan: await import("../../app/api/admin/plans/[id]/route"),
    reorder: await import("../../app/api/admin/plans/reorder/route"),
    migrate: await import("../../app/api/admin/plans/[id]/migrate/route"),
    coupons: await import("../../app/api/admin/coupons/route"),
    coupon: await import("../../app/api/admin/coupons/[code]/route"),
    offers: await import("../../app/api/admin/offers/route"),
    addons: await import("../../app/api/admin/addons/route"),
    subs: await import("../../app/api/admin/subscriptions/route"),
    sub: await import("../../app/api/admin/subscriptions/[userId]/route"),
    lookup: await import("../../app/api/admin/subscriptions/lookup/route"),
    backfill: await import("../../app/api/admin/subscriptions/backfill/route"),
    publicPlans: await import("../../app/api/billing/plans/route"),
    checkout: await import("../../app/api/billing/espees/checkout/route"),
    ret: await import("../../app/api/billing/espees/return/route"),
    cron: await import("../../app/api/cron/downgrade-expired-plans/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  async function call<P = Record<string, string>>(
    who: string | null,
    handler: (req: never, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; params?: P; query?: string; headers?: Record<string, string> } = {},
  ) {
    g.__who = who ?? undefined;
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }) as never,
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m && who) jar[who] = decodeURIComponent(m[1]);
    const text = await res.text();
    let body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body, location: res.headers.get("location") };
  }

  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enrollAndVerify(who: string) {
    const e = await call(who, R.enroll.POST, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret;
    tick();
    const c = await call(who, R.confirm.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  /** A fresh code: a new admin session and a fresh step-up. */
  async function fresh(who: string) {
    tick();
    const v = await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  const meta = (id: string) => ({ plan: g.__users[id].plan, ...(g.__users[id].metadata ?? {}) }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const limitsOf = async (id: string) => (await plan.getPlanLimitsForUserId(id)).limits;

  /** Checkout and the eSPees return, as a buyer's browser makes them. */
  async function buy(who: string, planId: string, billingCycle: "monthly" | "annual", coupon?: string) {
    const c = await call(who, R.checkout.POST, { method: "POST", body: { plan: planId, billingCycle, ...(coupon ? { coupon } : {}) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const nonce = new URL(String(espees[espees.length - 1].body.success_url)).searchParams.get("nonce")!;
    const r = await call(null, R.ret.GET, { query: `?nonce=${nonce}` });
    assert.equal(r.status, 303);
    assert.match(String(r.location), /\/dashboard\?upgraded=/, String(r.location));
    return c.body;
  }
  const act = (who: string, userId: string, body: Record<string, unknown>) => call(who, R.sub.POST, { method: "POST", params: { userId }, body });
  const cron = () => call(null, R.cron.GET, { headers: { authorization: "Bearer cron" } });

  console.log("setup and permissions");
  await t("the owner appoints a Billing and a Support administrator, each with two-factor", async () => {
    await enrollAndVerify("user_owner");
    for (const [email, roleId] of [
      ["billing@example.com", "billing"],
      ["support@example.com", "support"],
    ]) {
      const r = await call("user_owner", R.team.POST, { method: "POST", body: { email, roleId } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    await enrollAndVerify("user_billing");
    await enrollAndVerify("user_support");
  });

  await t("plans:read sees the catalog; changing anything needs plans:write or subscriptions:write; non-admins get nothing", async () => {
    const list = await call("user_support", R.plans.GET);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(
      list.body.plans.map((p: { id: string }) => p.id),
      ["free", "starter", "pro", "business", "enterprise"],
    );
    const pro = list.body.plans.find((p: { id: string }) => p.id === "pro");
    assert.deepEqual(pro.current.prices.ESP, { monthly: 20, annual: 200 }, "version 1 is what /pricing charged");
    assert.equal(pro.current.limits.maxParticipants, 200);
    assert.equal((await call("user_support", R.plan.PATCH, { method: "PATCH", params: { id: "pro" }, body: { terms: { trialDays: 3 } } })).body.error, "forbidden");
    assert.equal((await call("user_support", R.coupons.POST, { method: "POST", body: { code: "NOPE", kind: "percent", value: 5 } })).body.error, "forbidden");
    assert.equal((await act("user_support", "user_u1", { action: "comp", planId: "pro", days: 5 })).body.error, "forbidden");
    assert.equal((await act("user_support", "user_u1", { action: "comp", planId: "pro", preview: true })).body.error, "forbidden", "even a preview");
    assert.equal((await call("user_support", R.migrate.POST, { method: "POST", params: { id: "pro" }, body: { toVersion: 1 } })).body.error, "forbidden");
    assert.equal((await call("user_plain", R.plans.GET)).body.error, "not_admin");
    assert.equal((await call(null, R.subs.GET)).status, 401);
  });

  await t("plan edits are sensitive: a stale admin session is asked for a fresh code", async () => {
    tick(11 * 60_000);
    const r = await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "pro" }, body: { terms: { trialDays: 3 } } });
    assert.equal(r.body.error, "step_up_required");
  });

  console.log("plan catalog and versions");
  await t("checkout charges the catalog price; an edit makes version 2 and checkout follows it", async () => {
    const q1 = await call("user_u1", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", quote: true } });
    assert.equal(q1.body.amountEspees, 20, JSON.stringify(q1.body));
    await fresh("user_billing");
    const e = await call("user_billing", R.plan.PATCH, {
      method: "PATCH",
      params: { id: "pro" },
      body: { terms: { prices: { ESP: { monthly: 25, annual: 250 }, USD: { monthly: 9, annual: 90 } }, limits: { maxParticipants: 250 } }, note: "Price rise" },
    });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(e.body.newVersion, 2);
    const q2 = await call("user_u1", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", quote: true } });
    assert.equal(q2.body.amountEspees, 25);
    const v = await call("user_billing", R.plan.GET, { params: { id: "pro" } });
    assert.deepEqual(
      v.body.versions.map((x: { version: number }) => x.version),
      [2, 1],
      "version 1 kept as history",
    );
    const { items } = await audit.listAdminAudit({ action: "plan.version" });
    assert.equal(items[0].targetId, "pro");
    assert.deepEqual((items[0].before as Record<string, unknown>)["limits.maxParticipants"], 200);
    assert.deepEqual((items[0].after as Record<string, unknown>)["limits.maxParticipants"], 250);
    assert.equal((items[0].after as Record<string, unknown>).version, 2);
    assert.equal(items[0].note, "Price rise");
  });

  await t("settings are not terms: switching highlight makes no version; a plan on sale needs an ESP price", async () => {
    const s = await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "pro" }, body: { settings: { highlight: false } } });
    assert.equal(s.body.newVersion, null);
    const bad = await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "enterprise" }, body: { settings: { selfServe: true } } });
    assert.equal(bad.body.error, "needs_esp_price");
    const free = await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "free" }, body: { settings: { archived: true } } });
    assert.equal(free.body.error, "free_is_fixed");
  });

  await t("buying writes a subscription and Clerk together, with the limits of the version bought", async () => {
    const b = await buy("user_u1", "pro", "monthly");
    assert.equal(b.amountEspees, 25);
    assert.equal(espees[espees.length - 1].body.price, 25, "eSPees was asked for the catalog price");
    const m = meta("user_u1");
    assert.equal(m.plan, "pro");
    assert.equal(m.planVersion, 2);
    assert.equal(m.planLimits.maxParticipants, 250);
    const s = await subs.getSubscription("user_u1");
    assert.equal(s?.status, "active");
    assert.equal(s?.source, "espees");
    assert.equal(s?.pricePaid?.amount, 25);
    assert.equal(m.planExpiresAt, s?.periodEnd);
    assert.equal((await limitsOf("user_u1")).maxParticipants, 250);
    await buy("user_u2", "pro", "monthly");
  });

  await t("a later edit (v3) reaches new buyers only; v2 buyers and pre-catalog accounts keep what they bought", async () => {
    await fresh("user_billing");
    const e = await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "pro" }, body: { terms: { limits: { maxParticipants: 300 } } } });
    assert.equal(e.body.newVersion, 3);
    await buy("user_u3", "pro", "monthly");
    assert.equal((await limitsOf("user_u3")).maxParticipants, 300);
    assert.equal((await limitsOf("user_u1")).maxParticipants, 250);
    assert.equal((await limitsOf("user_u2")).maxParticipants, 250);
    assert.equal((await limitsOf("user_u4")).maxParticipants, 200, "no snapshot: the built-in v1");
    const v = await call("user_billing", R.plan.GET, { params: { id: "pro" } });
    assert.deepEqual(v.body.subscribers.byVersion, { "2": 2, "3": 1 });
  });

  await t("migrating needs subscriptions:write as well as plans:write", async () => {
    await fresh("user_owner");
    const role = await call("user_owner", R.roles.POST, { method: "POST", body: { name: "Catalog editor", permissions: ["plans:read", "plans:write"] } });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    assert.equal((await call("user_owner", R.team.POST, { method: "POST", body: { email: "editor@example.com", roleId: role.body.role.id } })).status, 201);
    await enrollAndVerify("user_editor");
    const e = await call("user_editor", R.plan.PATCH, { method: "PATCH", params: { id: "starter" }, body: { settings: { highlight: false } } });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    const m = await call("user_editor", R.migrate.POST, { method: "POST", params: { id: "pro" }, body: { toVersion: 3 } });
    assert.equal(m.body.error, "forbidden");
    assert.equal(m.body.permission, "subscriptions:write");
  });

  await t("migration is previewed first, changes nothing until confirmed, then moves v2 to v3", async () => {
    await fresh("user_billing");
    const p = await call("user_billing", R.migrate.POST, { method: "POST", params: { id: "pro" }, body: { toVersion: 3 } });
    assert.equal(p.body.preview, true);
    assert.deepEqual(p.body.rows.map((r: { userId: string }) => r.userId).sort(), ["user_u1", "user_u2"]);
    assert.deepEqual(p.body.rows[0].changes.maxParticipants, [250, 300]);
    assert.equal((await limitsOf("user_u1")).maxParticipants, 250, "a preview writes nothing");
    const c = await call("user_billing", R.migrate.POST, { method: "POST", params: { id: "pro" }, body: { toVersion: 3, confirm: true, reason: "Everyone gets 300" } });
    assert.equal(c.body.applied, 2, JSON.stringify(c.body));
    assert.equal((await limitsOf("user_u1")).maxParticipants, 300);
    assert.equal(meta("user_u2").planVersion, 3);
    assert.equal((await subs.getHistory("user_u1"))[0].action, "migrate");
    const { items } = await audit.listAdminAudit({ action: "plan.migrate" });
    assert.deepEqual((items[0].after as { applied: number }).applied, 2);
    assert.equal(items[0].note, "Everyone gets 300");
  });

  await t("the Free plan's edits reach every account without a plan at once", async () => {
    await fresh("user_billing");
    const e = await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "free" }, body: { terms: { limits: { meetingMinutes: 45 } } } });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal((await limitsOf("user_plain")).meetingMinutes, 45);
    const priced = await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "free" }, body: { terms: { prices: { ESP: { monthly: 5, annual: null } } } } });
    assert.equal(priced.body.error, "free_is_free");
  });

  await t("a new plan names its base tier; archived plans are neither sold nor assignable; order is saved", async () => {
    await fresh("user_billing");
    const c = await call("user_billing", R.plans.POST, {
      method: "POST",
      body: { name: "Schools", baseTier: "enterprise", description: "For schools", prices: { ESP: { monthly: 100, annual: 1000 } }, limits: { maxParticipants: 1000 }, selfServe: true, public: true },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.plan.id, "schools");
    assert.equal((await call("user_billing", R.plans.POST, { method: "POST", body: { name: "Pro", id: "pro", baseTier: "pro" } })).body.error, "id_taken");
    assert.equal((await call("user_billing", R.plans.POST, { method: "POST", body: { name: "Free plus", baseTier: "free" } })).body.error, "bad_base_tier");
    const pub = await call(null, R.publicPlans.GET);
    assert.ok(pub.body.plans.some((p: { id: string }) => p.id === "schools"));
    assert.equal(pub.body.currencies.find((x: { code: string }) => x.code === "USD").note, "not connected to a payment gateway");
    await buy("user_u9", "schools", "monthly");
    assert.equal(meta("user_u9").plan, "enterprise", "Clerk holds the base tier");
    assert.equal(meta("user_u9").planId, "schools");
    assert.equal(await plan.getPlanForUserId("user_u9"), "enterprise");
    assert.equal((await limitsOf("user_u9")).maxParticipants, 1000);
    const arch = await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "schools" }, body: { settings: { archived: true } } });
    assert.equal(arch.status, 200);
    assert.equal((await call("user_u10", R.checkout.POST, { method: "POST", body: { plan: "schools", billingCycle: "monthly" } })).body.error, "invalid_plan");
    assert.equal((await act("user_billing", "user_u10", { action: "assign", planId: "schools", cycle: "monthly" })).body.error, "plan_archived");
    assert.equal((await limitsOf("user_u9")).maxParticipants, 1000, "a subscriber keeps an archived plan");
    const o = await call("user_billing", R.reorder.POST, { method: "POST", body: { ids: ["free", "pro", "starter"] } });
    assert.deepEqual(o.body.order.slice(0, 3), ["free", "pro", "starter"]);
  });

  console.log("coupons and offers at checkout");
  await t("a coupon takes its discount off at checkout and is counted once its payment returns paid", async () => {
    await fresh("user_billing");
    const c = await call("user_billing", R.coupons.POST, {
      method: "POST",
      body: { code: "save10", kind: "percent", value: 10, planIds: ["pro"], cycles: ["monthly"], maxRedemptions: 1, oncePerUser: true },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.coupon.code, "SAVE10");
    const q = await call("user_u5", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", coupon: "save10", quote: true } });
    assert.equal(q.body.amountEspees, 22.5, JSON.stringify(q.body));
    assert.equal(q.body.discountEspees, 2.5);
    assert.equal((await call("user_u5", R.checkout.POST, { method: "POST", body: { plan: "business", billingCycle: "monthly", coupon: "SAVE10" } })).body.message, "This coupon is not for this plan.");
    assert.equal((await call("user_u5", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "annual", coupon: "SAVE10" } })).body.message, "This coupon is not for annual billing.");
    assert.equal((await call("user_u5", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", coupon: "NOSUCH" } })).body.error, "invalid_coupon");
    // Starting checkout does not use it up; paying does.
    await call("user_u6", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", coupon: "SAVE10" } });
    const b = await buy("user_u5", "pro", "monthly", "SAVE10");
    assert.equal(espees[espees.length - 1].body.price, 22.5);
    assert.equal(b.coupon, "SAVE10");
    const list = await call("user_billing", R.coupons.GET);
    assert.equal(list.body.coupons[0].redemptions, 1);
    assert.equal((await call("user_u7", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", coupon: "SAVE10", quote: true } })).body.message, "This coupon has been used up.");
    assert.equal((await subs.getSubscription("user_u5"))?.couponCode, "SAVE10");
    const used = await call("user_billing", R.coupon.DELETE, { method: "DELETE", params: { code: "SAVE10" } });
    assert.equal(used.body.error, "coupon_used");
  });

  await t("expiry, once per account, the 1 ESP floor, and an offer beating a smaller coupon", async () => {
    await fresh("user_billing");
    await call("user_billing", R.coupons.POST, { method: "POST", body: { code: "OLD", kind: "percent", value: 50, expiresAt: Date.now() - 1000 } });
    assert.equal((await call("user_u7", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", coupon: "OLD", quote: true } })).body.message, "This coupon has expired.");
    await call("user_billing", R.coupons.POST, { method: "POST", body: { code: "ONCE", kind: "fixed", value: 5, oncePerUser: true } });
    await buy("user_u7", "pro", "monthly", "ONCE");
    assert.equal(espees[espees.length - 1].body.price, 20);
    assert.equal((await call("user_u7", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", coupon: "ONCE", quote: true } })).body.message, "You have already used this coupon.");
    await call("user_billing", R.coupons.POST, { method: "POST", body: { code: "ALLFREE", kind: "percent", value: 100 } });
    assert.equal((await call("user_u7", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly", coupon: "ALLFREE", quote: true } })).body.error, "below_minimum");
    const o = await call("user_billing", R.offers.POST, { method: "POST", body: { name: "Annual promo", label: "20% off annual", kind: "percent", value: 20, planIds: ["pro"], cycles: ["annual"] } });
    assert.equal(o.status, 201, JSON.stringify(o.body));
    await call("user_billing", R.coupons.POST, { method: "POST", body: { code: "TINY", kind: "percent", value: 5 } });
    const q = await call("user_u7", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "annual", coupon: "TINY", quote: true } });
    assert.equal(q.body.amountEspees, 200, "250 less the offer's 20%, not the coupon's 5%");
    assert.equal(q.body.offer.label, "20% off annual");
    assert.equal(q.body.coupon, null);
    const pub = await call(null, R.publicPlans.GET);
    assert.equal(pub.body.plans.find((p: { id: string }) => p.id === "pro").offers[0].label, "20% off annual");
    assert.equal(JSON.stringify(pub.body).includes("Annual promo"), false, "an offer's admin name stays private");
  });

  console.log("subscriptions");
  const sub = async (id: string) => (await subs.getSubscription(id))!;
  await t("assign, extend, pause and resume keep Clerk in step; preview writes nothing", async () => {
    const pre = await act("user_billing", "user_u10", { action: "assign", planId: "business", cycle: "monthly", preview: true });
    assert.equal(pre.body.preview, true, JSON.stringify(pre.body));
    assert.equal(await subs.getSubscription("user_u10"), null);
    const a = await act("user_billing", "user_u10", { action: "assign", planId: "business", cycle: "monthly", reason: "Partner" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(meta("user_u10").plan, "business");
    const end0 = (await sub("user_u10")).periodEnd!;
    assert.ok(Math.abs(end0 - (Date.now() + 30 * DAY)) < 60_000);
    assert.equal((await act("user_billing", "user_u10", { action: "assign", planId: "pro", cycle: "monthly" })).body.error, "already_subscribed");
    await act("user_billing", "user_u10", { action: "extend", days: 10 });
    assert.equal((await sub("user_u10")).periodEnd, end0 + 10 * DAY);
    assert.equal(meta("user_u10").planExpiresAt, end0 + 10 * DAY);
    await act("user_billing", "user_u10", { action: "pause" });
    assert.equal((await sub("user_u10")).status, "paused");
    assert.equal(meta("user_u10").plan, "free", "paused = Free until resumed");
    assert.equal(await plan.getPlanForUserId("user_u10"), "free");
    tick(5 * DAY);
    await fresh("user_billing");
    const r = await act("user_billing", "user_u10", { action: "resume" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await sub("user_u10");
    assert.equal(s.status, "active");
    assert.ok(Math.abs(s.periodEnd! - (end0 + 15 * DAY)) < 120_000, "the paused days were kept");
    assert.equal(meta("user_u10").plan, "business");
    const { items } = await audit.listAdminAudit({ action: "subscription.assign" });
    assert.equal(items[0].before, null);
    assert.equal((items[0].after as { planId: string }).planId, "business");
    assert.match(String(items[0].note), /Partner/);
  });

  await t("an upgrade applies now and converts the unused days at the old price (the proration rule)", async () => {
    // u7 bought Pro monthly for 20 ESP (coupon ONCE) a while ago; 10 more days pass.
    tick(10 * DAY);
    await fresh("user_billing");
    const before = await sub("user_u7");
    const remaining = before.periodEnd! - Date.now();
    const p = await act("user_billing", "user_u7", { action: "change", planId: "business", cycle: "monthly", preview: true });
    assert.equal(p.body.proration.direction, "upgrade", JSON.stringify(p.body));
    assert.ok(p.body.lines.some((l: string) => /converted|ESP\/day/.test(l)));
    const c = await act("user_billing", "user_u7", { action: "change", planId: "business", cycle: "monthly" });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const after = await sub("user_u7");
    const expected = Date.now() + (remaining * (20 / 30)) / (30 / 30);
    assert.ok(Math.abs(after.periodEnd! - expected) < 120_000, `${after.periodEnd} vs ${expected}`);
    assert.equal(meta("user_u7").plan, "business");
  });

  await t("a downgrade waits for the period end; the daily job applies it with a new period", async () => {
    const p = await act("user_billing", "user_u10", { action: "change", planId: "starter", cycle: "monthly", preview: true });
    assert.equal(p.body.proration.direction, "downgrade");
    await act("user_billing", "user_u10", { action: "change", planId: "starter", cycle: "monthly" });
    const s = await sub("user_u10");
    assert.equal(s.scheduled?.planId, "starter");
    assert.equal(meta("user_u10").plan, "business", "still business until the period end");
    const up = await call("user_billing", R.subs.GET, { query: "?view=upcoming&days=60" });
    assert.ok(up.body.rows.some((r: { userId: string; scheduled: unknown }) => r.userId === "user_u10" && r.scheduled));
    skew += s.periodEnd! - Date.now() + 1000;
    // The preview of the daily job names the change and writes nothing.
    const due = await subs.planDue();
    assert.ok(due.some((d) => d.userId === "user_u10" && d.action === "apply_scheduled"), JSON.stringify(due));
    assert.equal((await sub("user_u10")).scheduled?.planId, "starter", "planDue changed nothing");
    const c = await cron();
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.ok(c.body.subscriptions.changed >= 1, JSON.stringify(c.body));
    const s2 = await sub("user_u10");
    assert.equal(s2.planId, "starter");
    assert.equal(s2.periodStart, s.periodEnd);
    assert.equal(s2.periodEnd, s.periodEnd! + 30 * DAY);
    assert.equal(meta("user_u10").plan, "starter");
    assert.equal((await subs.getHistory("user_u10"))[0].action, "scheduled.apply");
  });

  await t("renewing the same plan starts the new period when the current one ends", async () => {
    await buy("user_u3", "starter", "monthly");
    const s = await sub("user_u3");
    tick(3 * DAY);
    await buy("user_u3", "starter", "monthly");
    const s2 = await sub("user_u3");
    assert.equal(s2.periodEnd, s.periodEnd! + 30 * DAY, "no paid day lost");
    assert.equal(meta("user_u3").planExpiresAt, s2.periodEnd);
    assert.equal((await subs.getHistory("user_u3"))[0].action, "purchase.renew");
  });

  await t("cancel at period end keeps the plan until then; the daily job ends it; cancel now ends it at once", async () => {
    await fresh("user_billing");
    await buy("user_u11", "starter", "monthly");
    const c = await act("user_billing", "user_u11", { action: "cancel", when: "period_end" });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(meta("user_u11").plan, "starter");
    const end = (await sub("user_u11")).periodEnd!;
    const now = await act("user_billing", "user_u12", { action: "comp", planId: "pro", days: null });
    assert.equal(now.status, 200);
    assert.equal(meta("user_u12").planExpiresAt, null, "complimentary with no end");
    assert.equal((await sub("user_u12")).status, "complimentary");
    const cn = await act("user_billing", "user_u12", { action: "cancel", when: "now" });
    assert.ok(cn.body.lines.some((l: string) => /No refund/.test(l)));
    assert.equal(meta("user_u12").plan, "free");
    skew += end - Date.now() + 1000;
    await fresh("user_billing");
    await cron();
    assert.equal((await sub("user_u11")).status, "expired");
    assert.equal(meta("user_u11").plan, "free");
    const ended = await call("user_billing", R.subs.GET, { query: "?view=ended&days=60" });
    const ids = ended.body.rows.map((r: { userId: string }) => r.userId);
    assert.ok(ids.includes("user_u11") && ids.includes("user_u12"), JSON.stringify(ids));
  });

  await t("a trial ends by itself; custom arrangements and add-ons set the limits enforced", async () => {
    await fresh("user_billing");
    await call("user_billing", R.plan.PATCH, { method: "PATCH", params: { id: "business" }, body: { terms: { trialDays: 14 } } });
    const tr = await act("user_billing", "user_u6", { action: "assign", planId: "business", cycle: "monthly", trial: true });
    assert.equal(tr.status, 200, JSON.stringify(tr.body));
    assert.equal((await sub("user_u6")).status, "trialing");
    const custom = await act("user_billing", "user_u8", {
      action: "custom",
      planId: "enterprise",
      days: 365,
      limits: { maxParticipants: 1234, livestream: true },
      price: { amount: 500, currency: "USD", cycle: "annual" },
      notes: "Signed contract 2026-10",
    });
    assert.equal(custom.status, 200, JSON.stringify(custom.body));
    assert.ok(custom.body.lines.some((l: string) => /not connected to a payment gateway/.test(l)));
    assert.equal((await limitsOf("user_u8")).maxParticipants, 1234);
    const ad = await call("user_billing", R.addons.POST, { method: "POST", body: { name: "Big rooms", grants: { maxParticipants: 50, recording: true }, planIds: ["starter"] } });
    assert.equal(ad.status, 201, JSON.stringify(ad.body));
    const addOnId = ad.body.addOn.id;
    assert.equal((await act("user_billing", "user_u8", { action: "addons", addOnIds: [addOnId] })).body.error, "addon_not_for_plan");
    const at = await act("user_billing", "user_u3", { action: "addons", addOnIds: [addOnId] });
    assert.equal(at.status, 200, JSON.stringify(at.body));
    const l = await limitsOf("user_u3");
    assert.equal(l.maxParticipants, 150, "starter 100 + 50");
    assert.equal(l.recording, true);
    skew += 15 * DAY;
    await fresh("user_billing");
    await cron();
    assert.equal((await sub("user_u6")).status, "expired");
    assert.equal(meta("user_u6").plan, "free");
  });

  console.log("the owner");
  await t("every subscription action refuses the owner, who stays enterprise; checkout refuses too", async () => {
    await fresh("user_owner");
    for (const body of [
      { action: "assign", planId: "pro", cycle: "monthly" },
      { action: "comp", planId: "starter", days: 3 },
      { action: "cancel", when: "now" },
      { action: "custom", planId: "enterprise", days: 1 },
      { action: "pause" },
    ]) {
      const r = await act("user_owner", "user_owner", body);
      assert.equal(r.status, 403);
      assert.equal(r.body.error, "owner_protected", JSON.stringify(body));
      assert.equal((await act("user_billing", "user_owner", { ...body, preview: true })).body.error, "owner_protected");
    }
    assert.equal(meta("user_owner").plan, "starter", "Clerk untouched");
    assert.equal(await plan.getPlanForUserId("user_owner"), "enterprise");
    assert.equal((await limitsOf("user_owner")).maxParticipants, 0, "unlimited");
    assert.equal((await call("user_owner", R.checkout.POST, { method: "POST", body: { plan: "pro", billingCycle: "monthly" } })).body.error, "owner_protected");
    const { items } = await audit.listAdminAudit({ action: "subscription.refused", outcome: "denied" });
    assert.ok(items.length >= 5);
    // The layer under the route refuses too.
    const fake = { ...(await sub("user_u1")), userId: "user_owner" };
    await assert.rejects(subs.syncClerk(fake), subs.OwnerProtected);
    assert.equal(await subs.getSubscription("user_owner"), null);
  });

  console.log("backfill and views");
  await t("the backfill records pre-catalog paid accounts once, on version 1, and skips the owner", async () => {
    const b = await call("user_billing", R.backfill.POST, { method: "POST" });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.created, 1, JSON.stringify(b.body));
    assert.equal(b.body.owner, 1);
    const s = await sub("user_u4");
    assert.equal(s.version, 1);
    assert.equal(s.source, "backfill");
    assert.equal(s.periodEnd, g.__users.user_u4.metadata!.planExpiresAt);
    assert.equal((await limitsOf("user_u4")).maxParticipants, 200);
    assert.equal(await subs.getSubscription("user_owner"), null);
    assert.equal((await call("user_billing", R.backfill.POST, { method: "POST" })).body.created, 0, "idempotent");
    await fresh("user_support");
    const all = await call("user_support", R.subs.GET, { query: "?view=all" });
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.ok(all.body.total >= 10);
    assert.ok(all.body.counts.expired >= 2);
    const one = await call("user_support", R.sub.GET, { params: { userId: "user_u10" } });
    assert.ok(one.body.history.length >= 6);
    assert.equal(one.body.payments, null, "Support has no billing:read");
    const owner = await call("user_support", R.sub.GET, { params: { userId: "user_owner" } });
    assert.equal(owner.body.user.isOwner, true);
    const found = await call("user_support", R.lookup.GET, { query: "?q=u10@" });
    assert.equal(found.body.users[0].userId, "user_u10");
  });

  console.log("entry points for other phases");
  await t("endSubscriptionNow (a refund) ends a record or a pre-catalog Clerk plan, and refuses the owner", async () => {
    const actor = { userId: "user_billing", email: "billing@example.com" };
    assert.ok((await limitsOf("user_u8")).maxParticipants === 1234);
    const a = await subs.endSubscriptionNow("user_u8", { actor, reason: "refund ref_9" });
    assert.equal(a.ended, "subscription");
    assert.equal((await sub("user_u8")).status, "cancelled");
    assert.equal(meta("user_u8").plan, "free");
    assert.equal(meta("user_u8").planLimits, null);
    const h = (await subs.getHistory("user_u8"))[0];
    assert.equal(h.note, "refund ref_9");
    assert.equal(h.by.email, "billing@example.com");
    g.__users.user_plain.plan = "starter";
    const b = await subs.endSubscriptionNow("user_plain", { actor, reason: "refund" });
    assert.equal(b.ended, "clerk_only");
    assert.equal(meta("user_plain").plan, "free");
    assert.equal((await subs.endSubscriptionNow("user_plain", { actor, reason: "again" })).ended, "nothing");
    await assert.rejects(subs.endSubscriptionNow("user_owner", { actor, reason: "refund" }), subs.OwnerProtected);
    assert.equal(meta("user_owner").plan, "starter");
  });

  await t("forgetSubscriptionUser removes the record, indexes and coupon use; history stays, detached", async () => {
    const before = await subs.getHistory("user_u5");
    assert.ok(before.some((e) => e.by.userId === "user_u5"), "a self-serve purchase names the buyer");
    assert.ok((await call("user_billing", R.subs.GET, { query: "?view=all" })).body.rows.some((r: { userId: string }) => r.userId === "user_u5"));
    const r = await subs.forgetSubscriptionUser("user_u5");
    assert.ok(r.removed >= 3, JSON.stringify(r));
    assert.equal(await subs.getSubscription("user_u5"), null);
    assert.deepEqual(await subs.getHistory("user_u5"), []);
    assert.equal((g.__kvStore.get("neo:coupon:u:SAVE10") as Set<string>).has("user_u5"), false);
    const kept = (g.__kvStore.get(r.historyKey!) as string[]).map((x) => (typeof x === "string" ? JSON.parse(x) : x));
    assert.equal(kept.length, before.length);
    assert.equal(JSON.stringify(kept).includes("user_u5"), false);
    assert.equal(JSON.stringify(kept).includes("u5@example.com"), false);
    assert.equal(kept[0].ts, before[0].ts, "newest first, as before");
    assert.ok(!(await call("user_billing", R.subs.GET, { query: "?view=all" })).body.rows.some((r: { userId: string }) => r.userId === "user_u5"));
    assert.equal((await subs.forgetSubscriptionUser("user_u5")).removed, 0, "nothing left to remove");
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
