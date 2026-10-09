// Run: npx tsx src/lib/__tests__/billingFinance.smoke.ts
//
// Admin billing and finance (phase 4), through the real routes with Clerk
// and KV stood in for (./apiV1-stubs) and Stripe / Resend answered by a
// stubbed fetch: the payments index and its backfill, failed payments from
// the eSPees fail route and Stripe, revenue per currency with the previous
// period, invoices, refunds through Stripe and recorded from outside,
// owner protection, settings that never show a secret, reminder emails that
// cannot go twice, exports, permissions and step-up, and the audit trail.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import "./apiV1-stubs/install";
import ExcelJS from "exceljs";

// install.ts removed the KV variables so stores fall back to memory. Put
// them back: every store then goes through the KV stub, as in production.
process.env.KV_REST_API_URL = "https://kv.stub";
process.env.KV_REST_API_TOKEN = "stub";
process.env.CLERK_SECRET_KEY = "sk_test_billing_finance";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.STRIPE_SECRET_KEY = "sk_test_finance_SECRET_VALUE";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_finance_SECRET_VALUE";
process.env.CRON_SECRET = "cron_SECRET_VALUE";
process.env.ESPEES_API_KEY = "espees_SECRET_VALUE";
delete process.env.ESPEES_MERCHANT_WALLET;
delete process.env.RESEND_API_KEY;
delete process.env.ADMIN_EMAILS;

type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; role?: string; emails?: string[]; first?: string; metadata?: Record<string, unknown> }>;
  __who?: string;
  __kvStore: Map<string, unknown>;
};
const g = globalThis as Stubbed;
g.__users = {
  user_owner: { emails: ["owner@example.com"], first: "Owner" },
  user_billing: { emails: ["billing@example.com"] },
  user_analyst: { emails: ["analyst@example.com"] },
  user_support: { emails: ["support@example.com"] },
  user_viewer: { emails: ["viewer@example.com"] },
  buyer1: { emails: ["one@example.com"], first: "Ada" },
  buyer2: { emails: ["two@example.com"] },
  buyer3: { emails: ["three@example.com"] },
  buyer4: { emails: ["four@example.com"] },
};

const realNow = Date.now.bind(Date);
const T0 = realNow();
let skew = 0;
Date.now = () => realNow() + skew;
const DAY = 86_400_000;
const at = (offsetMs: number) => {
  skew = offsetMs;
};
const tick = (ms = 30_000) => {
  skew += ms;
};

/* ------------------------------ fetch stub ------------------------------ */

type Call = { url: string; method: string; body: string; headers: Record<string, string> };
const calls: Call[] = [];
let resendFailures = 0;
let refundSeq = 0;
const sessOld = {
  id: "cs_old_1",
  payment_status: "paid",
  payment_intent: "pi_old_1",
  customer_email: "guest@example.com",
  amount_total: 1000,
  currency: "usd",
  created: Math.floor((T0 - 50 * DAY) / 1000),
  metadata: { eventId: "ev_paid", eventSlug: "gala", tierId: "vip" },
};
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? ""), headers });
  if (url === "https://api.stripe.com/v1/refunds") {
    const p = new URLSearchParams(String(init.body));
    return json({ id: `re_${++refundSeq}`, status: "succeeded", amount: Number(p.get("amount")), currency: "usd" });
  }
  if (url.startsWith("https://api.stripe.com/v1/checkout/sessions?")) return json({ data: [sessOld], has_more: false });
  if (url === "https://api.resend.com/emails") {
    if (resendFailures > 0) {
      resendFailures--;
      return json({ message: "resend is down" }, 500);
    }
    return json({ id: `em_${calls.length}` });
  }
  throw new Error("unexpected fetch " + url);
}) as typeof fetch;
const sentMail = () => calls.filter((c) => c.url === "https://api.resend.com/emails").map((c) => JSON.parse(c.body) as { to: string[]; subject: string });

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const audit = await import("../admin/audit");
  const { kv } = await import("../kv");
  const { createPendingPayment, generateNonce } = await import("../billingStore");
  const { readPayment } = await import("../paymentsStore");
  const { eventStore } = await import("../eventStore");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    team: await import("../../app/api/admin/team/route"),
    roles: await import("../../app/api/admin/roles/route"),
    payments: await import("../../app/api/admin/billing/payments/route"),
    payment: await import("../../app/api/admin/billing/payments/[id]/route"),
    invoice: await import("../../app/api/admin/billing/payments/[id]/invoice/route"),
    refund: await import("../../app/api/admin/billing/payments/[id]/refund/route"),
    customer: await import("../../app/api/admin/billing/customers/[userId]/route"),
    revenue: await import("../../app/api/admin/billing/revenue/route"),
    settings: await import("../../app/api/admin/billing/settings/route"),
    reminders: await import("../../app/api/admin/billing/reminders/route"),
    backfill: await import("../../app/api/admin/billing/backfill/route"),
    exportR: await import("../../app/api/admin/billing/export/route"),
    cron: await import("../../app/api/cron/billing-reminders/route"),
    espeesReturn: await import("../../app/api/billing/espees/return/route"),
    espeesFail: await import("../../app/api/billing/espees/fail/route"),
    webhook: await import("../../app/api/stripe/webhook/route"),
    ticketCheckout: await import("../../app/api/events/[id]/checkout/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  async function call<P = Record<string, string>>(
    who: string | null,
    handler: (req: never, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; params?: P; query?: string; headers?: Record<string, string>; raw?: boolean } = {},
  ) {
    g.__who = who ?? undefined;
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      }) as never,
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m && who) jar[who] = decodeURIComponent(m[1]);
    if (opts.raw) return { status: res.status, body: {} as Record<string, unknown> & { error?: string }, res };
    const text = await res.text();
    let body: Record<string, unknown> & { error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body, res };
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

  /** A buyer goes through an eSPees checkout and comes back to the return or fail URL. */
  async function espees(userId: string, plan: string, cycle: "monthly" | "annual", outcome: "return" | "fail", country?: string) {
    const nonce = generateNonce();
    await createPendingPayment({ nonce, userId, plan: plan as never, billingCycle: cycle, paymentRef: `ESP-${nonce.slice(0, 8)}` });
    const r = await call(null, (outcome === "return" ? R.espeesReturn.GET : R.espeesFail.GET) as never, {
      query: `?nonce=${nonce}`,
      headers: country ? { "x-vercel-ip-country": country } : {},
      raw: true,
    });
    assert.equal(r.status, 303);
    return { nonce, ref: `ESP-${nonce.slice(0, 8)}` };
  }

  function stripeEvent(type: string, object: Record<string, unknown>) {
    const body = JSON.stringify({ type, data: { object } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET!).update(`${ts}.${body}`).digest("hex");
    return call(null, R.webhook.POST as never, { method: "POST", body, headers: { "stripe-signature": `t=${ts},v1=${sig}` } });
  }

  /* ------------------------------ history ------------------------------ */
  // Payments from before the index: written straight into KV as
  // paymentsStore did, and so not listed anywhere but the buyer's own list.
  const legacy = (ref: string, userId: string, paidAt: number, amountEsp: number, plan = "starter") => ({
    paymentRef: ref,
    userId,
    plan,
    billingCycle: "monthly",
    amountEsp,
    status: "paid",
    paidAt,
    periodStart: paidAt,
    periodEnd: paidAt + 30 * DAY,
    source: "espees-redirect-unverified",
  });
  await kv.set("billing:payment:OLD1", legacy("OLD1", "buyer1", T0 - 40 * DAY, 10));
  await kv.lpush("billing:payments:buyer1", "OLD1");
  await kv.set("billing:payment:=SUM(1,2)", legacy("=SUM(1,2)", "buyer4", T0 - 45 * DAY, 10));
  await kv.lpush("billing:payments:buyer4", "=SUM(1,2)");

  await eventStore.create({ id: "ev_paid", slug: "gala", name: "Annual Gala", ownerUserId: "user_owner", roles: [], tickets: [{ id: "vip", label: "VIP", priceCents: 2500, currency: "usd", sold: 0, active: true }] } as never);

  at(-35 * DAY);
  const b2 = await espees("buyer2", "pro", "monthly", "return");
  at(-10 * DAY);
  const b1 = await espees("buyer1", "starter", "annual", "return", "GB");
  // The owner has no subscription and cannot buy through checkout (phase 3);
  // an earlier payment of theirs is in the store from before the index.
  const own = { ref: "OWN1" };
  await kv.set("billing:payment:OWN1", { ...legacy("OWN1", "user_owner", Date.now(), 30, "business"), country: "NG" });
  await kv.lpush("billing:payments:user_owner", "OWN1");
  g.__users.user_owner.plan = "business";
  g.__users.user_owner.metadata = { planExpiresAt: Date.now() + 30 * DAY };
  const b3 = await espees("buyer3", "pro", "monthly", "fail");
  at(-2 * DAY);
  const sale = {
    id: "cs_live_1",
    payment_status: "paid",
    payment_intent: "pi_live_1",
    customer_email: "one@example.com",
    customer_details: { email: "one@example.com", name: "Ada", address: { country: "US" } },
    amount_total: 2500,
    currency: "usd",
    metadata: { eventId: "ev_paid", eventSlug: "gala", tierId: "vip", buyerUserId: "buyer1" },
  };
  at(-1 * DAY);
  // The same plan again while it runs: a renewal in the subscription history.
  const b1r = await espees("buyer1", "starter", "annual", "return");
  at(-3 * 60 * 60 * 1000);
  const nonce4 = generateNonce();
  await createPendingPayment({ nonce: nonce4, userId: "buyer4", plan: "pro", billingCycle: "monthly" });
  at(0);

  console.log("recording payments");
  await t("the eSPees fail route records a failed payment, once", async () => {
    const r = await readPayment(b3.ref);
    assert.equal(r?.status, "failed");
    assert.equal(r?.amountEsp, 20);
    assert.match(String((r as { failureReason?: string }).failureReason), /Not completed at eSPees/);
    const again = await call(null, R.espeesFail.GET as never, { query: `?nonce=${b3.nonce}`, raw: true });
    assert.equal(again.status, 303);
    assert.equal(((await kv.lrange("billing:payments:buyer3", 0, -1)) as string[]).length, 1, "a repeated fail redirect adds nothing");
    assert.equal((await readPayment(b1.ref))?.status, "paid");
    assert.equal((await readPayment(b1.ref) as { country?: string })?.country, "GB", "country from the buyer's connection");
  });

  await t("the Stripe webhook records a sale with its own currency; a later async failure is recorded as failed", async () => {
    at(-2 * DAY);
    const r = await stripeEvent("checkout.session.completed", sale);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const failed = await stripeEvent("checkout.session.async_payment_failed", { ...sale, id: "cs_fail_1", payment_intent: "pi_fail_1", payment_status: "unpaid" });
    assert.equal(failed.body.recorded, "failed");
    at(0);
    const ev = await eventStore.byId("ev_paid");
    assert.equal(ev?.tickets?.[0].sold, 1, "the ticket was still granted");
    const bad = await call(null, R.webhook.POST as never, { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=00" } });
    assert.equal(bad.status, 400);
  });

  console.log("administrators");
  await enrollAndVerify("user_owner");
  await stepUp("user_owner");
  for (const [email, roleId] of [["billing@example.com", "billing"], ["analyst@example.com", "analyst"], ["support@example.com", "support"]]) {
    const r = await call("user_owner", R.team.POST, { method: "POST", body: { email, roleId } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  // Sees billing, may not export it.
  const viewerRole = await call("user_owner", R.roles.POST, { method: "POST", body: { name: "Billing viewer", permissions: ["billing:read"] } });
  assert.equal(viewerRole.status, 201, JSON.stringify(viewerRole.body));
  assert.equal((await call("user_owner", R.team.POST, { method: "POST", body: { email: "viewer@example.com", roleId: (viewerRole.body.role as { id: string }).id } })).status, 201);
  for (const u of ["user_billing", "user_analyst", "user_support", "user_viewer"]) await enrollAndVerify(u);

  console.log("payments index and backfill");
  await t("before the backfill only payments made since are listed; the backfill adds the rest, and running it again adds nothing", async () => {
    const before = await call("user_analyst", R.payments.GET, { query: "?limit=100" });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    const refs = (before.body.items as { ref: string }[]).map((i) => i.ref);
    assert.ok(refs.includes(b1.ref) && refs.includes("cs_live_1") && refs.includes(b3.ref));
    assert.ok(!refs.includes("OLD1"));
    assert.equal((await call("user_analyst", R.backfill.POST, { method: "POST" })).body.error, "forbidden");
    tick(11 * 60_000);
    assert.equal((await call("user_owner", R.backfill.POST, { method: "POST" })).body.error, "step_up_required");
    await stepUp("user_owner");
    const bf = await call("user_owner", R.backfill.POST, { method: "POST" });
    assert.equal(bf.status, 200, JSON.stringify(bf.body));
    const res = bf.body.result as { planPayments: number; ticketSales: number; stripe: string; indexSize: number };
    assert.equal(res.stripe, "imported");
    assert.equal(res.ticketSales, 1);
    assert.equal(res.planPayments, 7, "OLD1, =SUM, OWN1, buyer2, buyer1 twice, buyer3's failure");
    assert.equal(res.indexSize, 10);
    const again = await call("user_owner", R.backfill.POST, { method: "POST" });
    assert.equal((again.body.result as { indexSize: number }).indexSize, 10);
    const { items } = await audit.listAdminAudit({ action: "billing.backfill" });
    assert.equal(items.length, 2);
  });

  await t("the list: newest first, filters, search, pagination, totals per currency and never across", async () => {
    const all = await call("user_analyst", R.payments.GET, { query: "?limit=100" });
    assert.equal(all.body.total, 10);
    const totals = all.body.totals as { paid: Record<string, number>; failed: Record<string, number> };
    assert.deepEqual(totals.paid, { ESP: 270, USD: 35 });
    assert.deepEqual(totals.failed, { ESP: 20, USD: 25 });
    const items = all.body.items as { at: number; email: string; currency: string; amount: number }[];
    assert.ok(items.every((x, i) => i === 0 || items[i - 1].at >= x.at), "newest first");
    assert.equal(items.find((x) => x.email === "two@example.com")?.currency, "ESP", "emails filled in from Clerk");

    const q = async (s: string) => (await call("user_analyst", R.payments.GET, { query: s })).body as { total: number; items: { ref: string }[] };
    assert.equal((await q("?status=failed")).total, 2);
    assert.equal((await q("?provider=stripe")).total, 3);
    assert.equal((await q("?plan=pro")).total, 2);
    assert.equal((await q("?plan=ticket")).total, 3);
    assert.deepEqual((await q("?user=one@example")).items.map((i) => i.ref).sort(), ["OLD1", b1.ref, b1r.ref, "cs_live_1", "cs_fail_1"].sort());
    assert.deepEqual((await q(`?q=${b2.ref}`)).items.map((i) => i.ref), [b2.ref]);
    const from = new Date(T0 - 11 * DAY).toISOString().slice(0, 10);
    const to = new Date(T0 - 9 * DAY).toISOString().slice(0, 10);
    assert.equal((await q(`?from=${from}&to=${to}`)).total, 3);
    const p1 = await q("?limit=2&offset=0");
    const p2 = await q("?limit=2&offset=2");
    assert.equal(p1.items.length, 2);
    assert.notEqual(p1.items[0].ref, p2.items[0].ref);
    assert.equal((await call("user_support", R.payments.GET)).body.error, "forbidden");
  });

  console.log("revenue");
  await t("revenue per currency, compared with the period before; renewals, new, lapsed; MRR from active plans; outstanding", async () => {
    const r = await call("user_analyst", R.revenue.GET);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const cur = r.body.current as { gross: Record<string, number>; net: Record<string, number>; renewals: number; newCustomers: number; cancellations: { lapsed: number }; failed: { count: number; amount: Record<string, number> } };
    const prev = r.body.previous as { gross: Record<string, number> };
    assert.deepEqual(cur.gross, { ESP: 230, USD: 25 });
    assert.deepEqual(prev.gross, { ESP: 40, USD: 10 });
    assert.equal((r.body.change as Record<string, { gross: number }>).ESP.gross, 475);
    assert.equal((cur as { basis?: string }).basis, "subscriptions", "subscription records exist, so they decide");
    assert.equal(cur.renewals, 1, "buyer1 bought the same plan again while it ran");
    assert.equal(cur.newCustomers, 1, "the owner's first payment");
    assert.equal(cur.cancellations.lapsed, 1, "buyer2's subscription ran out");
    assert.deepEqual(cur.failed, { count: 2, amount: { ESP: 20, USD: 25 } });
    const rec = r.body.recurring as { mrr: Record<string, number>; arr: Record<string, number>; activePaid: number; notInClerk: number };
    assert.deepEqual(rec.mrr, { ESP: 8.33 }, "buyer1's annual subscription; the owner has none");
    assert.deepEqual(rec.arr, { ESP: 99.96 });
    assert.equal(rec.activePaid, 1);
    const pay = r.body.recurringFromPayments as typeof rec;
    assert.deepEqual(pay.mrr, { ESP: 38.33 }, "from payments the owner's paid month counts too");
    assert.equal(pay.activePaid, 2);
    const out = r.body.outstanding as { abandoned: { count: number; amount: Record<string, number> } };
    assert.equal(out.abandoned.count, 1);
    assert.deepEqual(out.abandoned.amount, { ESP: 20 });
    const series = r.body.series as { gross: Record<string, number> }[];
    assert.equal(r.body.bucket, "day");
    assert.deepEqual(series.reduce((s, p) => ({ ESP: s.ESP + (p.gross.ESP ?? 0), USD: s.USD + (p.gross.USD ?? 0) }), { ESP: 0, USD: 0 }), { ESP: 230, USD: 25 });
    // Clerk decides: an account moved to Free is not recurring revenue.
    g.__users.buyer1.plan = "free";
    const { forgetUser } = await import("../finance/ledger");
    forgetUser("buyer1");
    const r2 = await call("user_analyst", R.revenue.GET);
    assert.deepEqual((r2.body.recurringFromPayments as { mrr: Record<string, number> }).mrr, { ESP: 30 });
    assert.equal((r2.body.recurringFromPayments as { notInClerk: number }).notInClerk, 1);
    g.__users.buyer1.plan = "starter";
    forgetUser("buyer1");
  });

  console.log("invoices");
  await t("an invoice is numbered once, uses the tax rule for the buyer's country, downloads as PDF, and its issue is audited", async () => {
    await stepUp("user_billing");
    const put = await call("user_billing", R.settings.PUT, {
      method: "PUT",
      body: { tax: { rules: [{ country: "NG", rate: 7.5, inclusive: true, label: "VAT" }] }, invoice: { companyName: "Neo Ltd", address: "1 Road\nLagos", taxId: "TIN-1", footer: "Thank you" } },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const id = `pay:${own.ref}`;
    const inv = await call("user_analyst", R.invoice.GET, { params: { id: encodeURIComponent(id) } });
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    const i = inv.body.invoice as { number: string; total: number; subtotal: number; tax: { amount: number; inclusive: boolean }; seller: { companyName: string }; currency: string };
    assert.match(i.number, /^NEO-\d{6}$/);
    assert.deepEqual([i.total, i.subtotal, i.tax.amount, i.tax.inclusive, i.currency], [30, 27.91, 2.09, true, "ESP"]);
    assert.equal(i.seller.companyName, "Neo Ltd");
    const again = await call("user_analyst", R.invoice.GET, { params: { id } });
    assert.equal((again.body.invoice as { number: string }).number, i.number);
    const pdf = await call("user_analyst", R.invoice.GET, { params: { id }, query: "?format=pdf", raw: true });
    assert.equal(pdf.res.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await pdf.res.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
    const ticket = await call("user_analyst", R.invoice.GET, { params: { id: "tkt:cs_live_1" } });
    assert.equal((ticket.body.invoice as { currency: string; tax: unknown }).currency, "USD");
    assert.equal((ticket.body.invoice as { tax: unknown }).tax, null, "no rule for the US");
    assert.notEqual((ticket.body.invoice as { number: string }).number, i.number);
    assert.equal((await call("user_analyst", R.invoice.GET, { params: { id: `pay:${b3.ref}` } })).body.error, "failed_payment");
    const { items } = await audit.listAdminAudit({ action: "billing.invoice.issue" });
    assert.equal(items.filter((e) => e.targetId === id).length, 1);
  });

  console.log("refunds");
  await t("refunding needs billing:refund and a fresh code; the currency shown must be the payment's", async () => {
    const id = "tkt:cs_live_1";
    assert.equal((await call("user_analyst", R.refund.POST, { method: "POST", params: { id }, body: { currency: "USD", reason: "x" } })).body.error, "forbidden");
    tick(11 * 60_000);
    assert.equal((await call("user_billing", R.refund.POST, { method: "POST", params: { id }, body: { currency: "USD", reason: "x" } })).body.error, "step_up_required");
    await stepUp("user_billing");
    const wrong = await call("user_billing", R.refund.POST, { method: "POST", params: { id }, body: { amount: 10, currency: "ESP", reason: "Asked" } });
    assert.equal(wrong.body.error, "currency_mismatch");
    assert.equal(calls.filter((c) => c.url.endsWith("/v1/refunds")).length, 0);
  });

  await t("a Stripe sale is refunded through the Stripe API, in part and then the rest, and audited before/after", async () => {
    const id = "tkt:cs_live_1";
    const part = await call("user_billing", R.refund.POST, { method: "POST", params: { id }, body: { amount: 10, currency: "USD", reason: "Could not attend" } });
    assert.equal(part.status, 200, JSON.stringify(part.body));
    const sent = calls.filter((c) => c.url.endsWith("/v1/refunds"));
    assert.equal(sent.length, 1);
    const form = new URLSearchParams(sent[0].body);
    assert.equal(form.get("payment_intent"), "pi_live_1");
    assert.equal(form.get("amount"), "1000", "minor units");
    assert.match(sent[0].headers["idempotency-key"], /^neo-refund-cs_live_1-0-1000$/);
    assert.equal((part.body.entry as { status: string }).status, "partially_refunded");
    const over = await call("user_billing", R.refund.POST, { method: "POST", params: { id }, body: { amount: 20, currency: "USD", reason: "x" } });
    assert.equal(over.body.error, "bad_amount");
    const rest = await call("user_billing", R.refund.POST, { method: "POST", params: { id }, body: { currency: "USD", reason: "Event cancelled" } });
    assert.equal((rest.body.entry as { status: string; refundedAmount: number }).status, "refunded");
    assert.equal(new URLSearchParams(calls.filter((c) => c.url.endsWith("/v1/refunds"))[1].body).get("amount"), "1500");
    assert.equal((await call("user_billing", R.refund.POST, { method: "POST", params: { id }, body: { currency: "USD", reason: "x" } })).body.error, "not_refundable");
    const { items } = await audit.listAdminAudit({ action: "billing.refund", target: "cs_live_1" });
    assert.equal(items.length, 2);
    assert.deepEqual(items[1].before, { status: "paid", refundedAmount: 0, currency: "USD" });
    assert.equal((items[1].after as { status: string }).status, "partially_refunded");
    assert.equal(items[1].actorEmail, "billing@example.com");
  });

  await t("an eSPees payment is recorded as refunded outside NeoConference, and can end the plan — the latest payment only", async () => {
    await stepUp("user_billing");
    const id = `pay:${b1r.ref}`;
    const detail = await call("user_billing", R.payment.GET, { params: { id } });
    assert.equal((detail.body.refund as { method: string }).method, "outside");
    const noRef = await call("user_billing", R.refund.POST, { method: "POST", params: { id }, body: { currency: "ESP", reason: "Changed mind" } });
    assert.equal(noRef.body.error, "outside_ref_required");
    const older = await call("user_billing", R.refund.POST, { method: "POST", params: { id: "pay:OLD1" }, body: { currency: "ESP", reason: "x", outsideRef: "TX1", downgrade: true } });
    assert.equal(older.body.error, "not_current");
    const ok = await call("user_billing", R.refund.POST, {
      method: "POST",
      params: { id },
      body: { currency: "ESP", reason: "Changed mind", outsideRef: "ESPEES-TX-77", downgrade: true },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.downgraded, true);
    assert.equal(g.__users.buyer1.plan, "free");
    assert.equal((await readPayment(b1r.ref))?.status, "refunded", "the buyer's own billing page shows it");
    const { getSubscription } = await import("../billing/subscriptions");
    assert.equal((await getSubscription("buyer1"))?.status, "cancelled", "ended through the subscription record");
    assert.equal(g.__users.buyer1.metadata?.planLimits, null, "no limits snapshot outlives the plan");
    assert.equal(calls.filter((c) => c.url.endsWith("/v1/refunds")).length, 2, "no API was called for eSPees");
    const { items } = await audit.listAdminAudit({ action: "billing.plan.end" });
    const before = items[0].before as { plan: string; planExpiresAt: number; subscription: { status: string; periodEnd: number } };
    const after = items[0].after as { plan: string; subscription: { status: string } };
    assert.equal(before.plan, "starter");
    assert.equal(before.planExpiresAt, (await readPayment(b1r.ref))!.periodEnd);
    assert.equal(before.subscription.status, "active");
    assert.equal(after.plan, "free");
    assert.equal(after.subscription.status, "cancelled");
    const refundAudit = (await audit.listAdminAudit({ action: "billing.refund", target: b1r.ref })).items[0];
    assert.equal((refundAudit.after as { refund: { method: string; providerRef: string } }).refund.providerRef, "ESPEES-TX-77");
  });

  await t("the owner's plan is never ended by a refund, and nothing is refunded when that is asked", async () => {
    const id = `pay:${own.ref}`;
    const detail = await call("user_billing", R.payment.GET, { params: { id } });
    assert.equal((detail.body.refund as { canEndPlan: boolean }).canEndPlan, false);
    const r = await call("user_billing", R.refund.POST, { method: "POST", params: { id }, body: { currency: "ESP", reason: "x", outsideRef: "TX", downgrade: true } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "owner_protected");
    assert.equal((await readPayment(own.ref))?.status, "paid");
    assert.equal(g.__users.user_owner.plan, "business");
  });

  await t("a refund made in the Stripe dashboard is mirrored onto the sale", async () => {
    await stripeEvent("checkout.session.completed", { ...sale, id: "cs_live_2", payment_intent: "pi_live_2" });
    const r = await stripeEvent("charge.refunded", { payment_intent: "pi_live_2", amount_refunded: 500, currency: "usd", refunds: { data: [{ id: "re_dash", amount: 500, status: "succeeded" }] } });
    assert.equal(r.body.mirrored, true);
    const e = await call("user_analyst", R.payment.GET, { params: { id: "tkt:cs_live_2" } });
    assert.equal((e.body.entry as { status: string; refundedAmount: number }).refundedAmount, 5);
    assert.equal((e.body.entry as { status: string }).status, "partially_refunded");
  });

  await t("a customer's history: payments, refunds, checkouts, totals per currency", async () => {
    const c = await call("user_analyst", R.customer.GET, { params: { userId: "buyer1" } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal((c.body.user as { email: string }).email, "one@example.com");
    assert.deepEqual((c.body.totals as { paid: Record<string, number> }).paid, { ESP: 210, USD: 50 });
    assert.deepEqual((c.body.totals as { refunded: Record<string, number> }).refunded, { ESP: 100, USD: 30 });
    assert.ok((c.body.checkouts as { state: string }[]).some((x) => x.state === "paid"));
  });

  console.log("settings");
  await t("gateway status shows which variables are set, never a value; changes need billing:settings and a fresh code", async () => {
    const s = await call("user_analyst", R.settings.GET);
    assert.equal(s.status, 200);
    const text = JSON.stringify(s.body);
    assert.ok(!text.includes("SECRET_VALUE"), "no secret, nor any part of one, leaves the server");
    const gw = s.body.gateways as { id: string; configured: boolean; vars: { name: string; set: boolean }[]; capabilities: { refund: boolean } }[];
    const espees = gw.find((x) => x.id === "espees")!;
    assert.equal(espees.configured, false);
    assert.deepEqual(espees.vars.map((v) => [v.name, v.set]), [["ESPEES_API_KEY", true], ["ESPEES_MERCHANT_WALLET", false], ["ESPEES_PRODUCT_SKU", false]]);
    assert.equal(espees.capabilities.refund, false);
    assert.equal(gw.find((x) => x.id === "stripe")!.configured, true);
    assert.equal((await call("user_analyst", R.settings.PUT, { method: "PUT", body: { gateways: { stripe: { enabled: false } } } })).body.error, "forbidden");
    tick(11 * 60_000);
    assert.equal((await call("user_billing", R.settings.PUT, { method: "PUT", body: { gateways: { stripe: { enabled: false } } } })).body.error, "step_up_required");
    await stepUp("user_billing");
    const bad = await call("user_billing", R.settings.PUT, { method: "PUT", body: { tax: { rules: [{ country: "Nigeria", rate: 5 }] } } });
    assert.equal(bad.body.error, "invalid_tax");
    const off = await call("user_billing", R.settings.PUT, { method: "PUT", body: { gateways: { stripe: { enabled: false } } } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const { items } = await audit.listAdminAudit({ action: "billing.settings.update" });
    assert.deepEqual(items[0].before, { stripeEnabled: true });
    assert.deepEqual(items[0].after, { stripeEnabled: false });
    const checkout = await call(null, R.ticketCheckout.POST as never, { method: "POST", body: { tierId: "vip" }, params: Promise.resolve({ id: "ev_paid" }) as never });
    assert.equal(checkout.status, 503);
    assert.equal(checkout.body.error, "payments_paused");
  });

  console.log("reminders");
  await t("off by default; without mail nothing is claimed; with it each reminder goes once, latest step only", async () => {
    assert.equal((await call(null, R.cron.GET as never, {})).status, 401);
    const cron = () => call(null, R.cron.GET as never, { headers: { authorization: "Bearer cron_SECRET_VALUE" } });
    assert.equal((await cron()).body.skipped, "all_off");
    await stepUp("user_billing");
    const rules = { failed: { enabled: true, afterDays: [1, 3] }, abandoned: { enabled: true, afterDays: [1] }, renewal: { enabled: true, beforeDays: [30, 7] } };
    assert.equal((await call("user_analyst", R.reminders.PUT, { method: "PUT", body: rules })).body.error, "forbidden");
    const put = await call("user_billing", R.reminders.PUT, { method: "PUT", body: rules });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await audit.listAdminAudit({ action: "billing.reminders.update" })).items.length, 1);

    const noMail = await cron();
    assert.equal(noMail.body.skipped, "mail_not_configured");
    assert.equal([...g.__kvStore.keys()].filter((k) => k.startsWith("billing:reminders:sent:")).length, 0);

    process.env.RESEND_API_KEY = "re_SECRET_VALUE";
    const preview = await call("user_analyst", R.reminders.GET);
    const due = (preview.body.preview as { preview: { kind: string; email: string; step: number }[] }).preview;
    assert.deepEqual(due.map((d) => `${d.kind}:${d.email}:${d.step}`).sort(), ["failed:three@example.com:3", "renewal:owner@example.com:30"]);
    assert.equal(sentMail().length, 0, "a preview sends nothing");

    const first = await cron();
    assert.equal(first.body.sent, 2, JSON.stringify(first.body));
    assert.deepEqual(sentMail().map((m) => m.to[0]).sort(), ["owner@example.com", "three@example.com"]);
    const second = await cron();
    assert.equal(second.body.sent, 0);
    assert.equal(second.body.alreadySent, 2);
    assert.ok(g.__kvStore.has(`billing:reminders:sent:failed:${b3.ref}:1`), "the earlier step was claimed with the later one");
  });

  await t("two runs at once send once; a failed send is retried next run; the log records it", async () => {
    tick(DAY);
    const before = sentMail().length;
    resendFailures = 1;
    const failed = await call(null, R.cron.GET as never, { headers: { authorization: "Bearer cron_SECRET_VALUE" } });
    assert.equal(failed.body.failed, 1, JSON.stringify(failed.body));
    assert.equal(failed.body.sent, 0);
    const [a, b] = await Promise.all([
      call(null, R.cron.GET as never, { headers: { authorization: "Bearer cron_SECRET_VALUE" } }),
      call(null, R.cron.GET as never, { headers: { authorization: "Bearer cron_SECRET_VALUE" } }),
    ]);
    assert.equal((a.body.sent as number) + (b.body.sent as number), 1);
    assert.equal(sentMail().length, before + 2, "one failed attempt, one delivered");
    assert.equal(sentMail().at(-1)!.to[0], "four@example.com");
    assert.match(sentMail().at(-1)!.subject, /Finish upgrading/);
    // A day on, the analyst's 12-hour admin session has ended.
    await stepUp("user_analyst");
    const log = (await call("user_analyst", R.reminders.GET)).body.log as { outcome: string; kind: string }[];
    assert.deepEqual(log.slice(0, 2).map((l) => `${l.kind}:${l.outcome}`), ["abandoned:sent", "abandoned:failed"]);
    // Run now from the admin is audited and still sends nothing twice.
    await stepUp("user_billing");
    const run = await call("user_billing", R.reminders.POST, { method: "POST" });
    assert.equal((run.body.result as { sent: number }).sent, 0);
    assert.equal((await audit.listAdminAudit({ action: "billing.reminders.run" })).items.length, 1);
  });

  console.log("exports");
  await t("CSV and Excel exports need reports:export; amounts carry their currency; formulas are neutralised", async () => {
    await stepUp("user_support");
    await stepUp("user_viewer");
    const noExport = await call("user_viewer", R.exportR.GET, { query: "?type=payments" });
    assert.equal(noExport.body.error, "forbidden");
    assert.equal(noExport.body.permission, "reports:export");
    assert.equal((await call("user_support", R.exportR.GET, { query: "?type=payments" })).body.error, "forbidden");
    const csv = await call("user_analyst", R.exportR.GET, { query: "?type=payments&format=csv" });
    assert.equal(csv.status, 200);
    const text = String(csv.body.text);
    const lines = text.split("\r\n");
    assert.match(lines[0], /,amount,currency,status,/);
    assert.ok(text.includes("'=SUM(1,2)"), "a reference that looks like a formula is prefixed");
    assert.ok(!/,=SUM/.test(text));
    const rev = await call("user_analyst", R.exportR.GET, { query: "?type=revenue&format=csv&bucket=month" });
    const rows = String(rev.body.text).split("\r\n").slice(1).map((l) => l.split(","));
    assert.ok(rows.length > 0 && rows.every((r) => r[1] === "ESP" || r[1] === "USD"), "one row per period and currency");
    const refunds = await call("user_analyst", R.exportR.GET, { query: "?type=refunds&format=csv" });
    assert.equal(String(refunds.body.text).split("\r\n").length, 1 + 4, "two Stripe API refunds, one mirrored, one recorded");
    const xlsx = await call("user_analyst", R.exportR.GET, { query: "?type=payments&format=xlsx", raw: true });
    assert.match(String(xlsx.res.headers.get("content-type")), /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await xlsx.res.arrayBuffer()) as ArrayBuffer);
    const ws = wb.worksheets[0];
    assert.equal(ws.getRow(1).getCell(12).value, "currency");
    assert.equal(ws.rowCount, 1 + 11);
    assert.equal((await audit.listAdminAudit({ action: "billing.export" })).items.length, 4);
  });

  await t("every change in this file is in the audit log, unbroken", async () => {
    const integrity = await audit.checkAuditIntegrity();
    assert.deepEqual(integrity.missing, []);
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
