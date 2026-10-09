// Run: npx tsx src/lib/__tests__/adminOverview.smoke.ts
//
// Admin phase 13 — the Overview and the admin search — driven through the
// real /api/admin/overview and /api/admin/search routes, with Clerk, LiveKit
// and KV stood in for (./apiV1-stubs). KV is "configured", so every store
// the Overview reads (activity log, subscriptions, payment ledger, file
// index, ops records, audit) runs its real KV code; the data is seeded
// through those stores' own write functions wherever they have one.
//
// What it proves: every figure matches fixed seeded data, revenue is per
// currency and never summed, comparison deltas are right for the previous
// period and for the same period last year, calendar days follow the time
// zone, a failing source degrades only its own card, a role sees only the
// cards (and search categories) it may, drill-down links open lists that
// hold exactly the records counted, and the 60 s cache answers repeats.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_admin_overview";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.ADMIN_EMAILS = "";
delete process.env.RESEND_API_KEY;
process.env.KV_REST_API_URL = "https://kv.invalid";
process.env.KV_REST_API_TOKEN = "stub";
process.env.LIVEKIT_API_KEY = "lk_key";
process.env.LIVEKIT_API_SECRET = "lk_secret";
process.env.LIVEKIT_URL = "wss://livekit.invalid";

type StubUser = { emails?: string[]; first?: string; last?: string; createdAt?: number };
type Stubbed = typeof globalThis & {
  __users: Record<string, StubUser>;
  __who?: string;
  __rooms?: { name: string; numParticipants: number }[];
  __clerkCountFails?: boolean;
  __kvTtl?: boolean;
};
const g = globalThis as Stubbed;
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);

g.__users = {
  user_owner: { emails: ["owner@example.com"], first: "Owner", createdAt: at("2023-01-01T00:00:00Z") },
  user_support: { emails: ["support@example.com"], first: "Sam", createdAt: at("2023-02-01T00:00:00Z") },
  user_billing: { emails: ["billing@example.com"], first: "Bill", createdAt: at("2023-03-01T00:00:00Z") },
  user_analyst: { emails: ["analyst@example.com"], first: "Ana", createdAt: at("2023-04-01T00:00:00Z") },
  user_noov: { emails: ["noov@example.com"], first: "Nora", createdAt: at("2023-05-01T00:00:00Z") },
  // Sign-ups. Cara is the last half hour of 30 September in UTC — already
  // 1 October in Lagos (UTC+1); Eve is 31 August in UTC, 1 September there.
  user_alice: { emails: ["alice@example.com"], first: "Alice", last: "Anders", createdAt: at("2026-09-03T10:00:00Z") },
  user_bob: { emails: ["bob@example.com"], first: "Bob", createdAt: at("2026-09-15T08:00:00Z") },
  user_cara: { emails: ["cara@example.com"], first: "Cara", createdAt: at("2026-09-30T23:30:00Z") },
  user_dan: { emails: ["dan@example.com"], first: "Dan", createdAt: at("2026-08-10T12:00:00Z") },
  user_eve: { emails: ["eve@example.com"], first: "Eve", createdAt: at("2026-08-31T23:30:00Z") },
  user_fay: { emails: ["fay@example.com"], first: "Fay", createdAt: at("2025-09-20T12:00:00Z") },
};
g.__rooms = [
  { name: "alice-weekly", numParticipants: 3 },
  { name: "empty-room", numParticipants: 0 },
  { name: "bob-standup", numParticipants: 2 },
];

// The clock: 9 October 2026, noon UTC, moved by the test where it needs to.
const NOW = at("2026-10-09T12:00:00Z");
let clock = NOW;
Date.now = () => clock;
const tick = (ms = 30_000) => {
  clock += ms;
};

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const store = await import("../admin/store");
  const audit = await import("../admin/audit");
  const { kv } = await import("../kv");
  const activity = await import("../activity");
  const payments = await import("../paymentsStore");
  const ledger = await import("../finance/ledger");
  const { indexPayment, ticketId } = await import("../finance/paymentIndex");
  const { trackCheckout } = await import("../finance/checkouts");
  const { ledgerQuery } = await import("../finance/query");
  const files = await import("../content/files");
  const incidents = await import("../ops/incidents");
  const jobs = await import("../ops/jobs");
  const tickets = await import("../support/tickets");
  const groups = await import("../groupStore");
  const { eventStore } = await import("../eventStore");
  const { overviewLinks } = await import("../admin/overview/links");
  const { resolvePeriods, readQuery } = await import("../admin/overview/period");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    overview: await import("../../app/api/admin/overview/route"),
    search: await import("../../app/api/admin/search/route"),
    users: await import("../../app/api/admin/users/route"),
    subscriptions: await import("../../app/api/admin/subscriptions/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Body = Record<string, any> & { error?: string; message?: string };
  async function call(who: string, handler: (req: Request) => Promise<Response>, query = "") {
    g.__who = who;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(new Request(`https://www.neoconference.app/api/admin/x${query}`, { method: "GET", headers }));
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m) jar[who] = decodeURIComponent(m[1]);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
  }
  async function post(who: string, handler: (req: Request) => Promise<Response>, body: unknown) {
    g.__who = who;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(new Request("https://www.neoconference.app/api/admin/x", { method: "POST", headers, body: JSON.stringify(body) }));
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m) jar[who] = decodeURIComponent(m[1]);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enrollAndVerify(who: string) {
    const e = await post(who, R.enroll.POST, {});
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    const c = await post(who, R.confirm.POST, { code: code(who) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }

  /* --------------------------------- seeding -------------------------------- */

  const appoint = (userId: string, roleId: string) =>
    store.saveMember({ userId, email: g.__users[userId].emails![0], name: userId, roleId, status: "active", appointedBy: "user_owner", appointedAt: NOW, updatedAt: NOW });
  await store.saveRole({ id: "custom_noov", name: "Lookup only", description: "", permissions: ["users:read"], builtIn: false });
  await appoint("user_support", "support");
  await appoint("user_billing", "billing");
  await appoint("user_analyst", "analyst");
  await appoint("user_noov", "custom_noov");
  for (const who of ["user_owner", "user_support", "user_billing", "user_analyst", "user_noov"]) await enrollAndVerify(who);

  // Activity log: the first event (1 August) starts the log.
  await activity.record("meeting.started", { ts: at("2026-08-01T09:00:00Z") });
  await activity.markActive("user_alice", undefined, at("2026-09-10T09:00:00Z"));
  await activity.markActive("user_bob", undefined, at("2026-09-10T15:00:00Z"));
  await activity.markActive("user_alice", undefined, at("2026-09-30T09:00:00Z"));
  await activity.markActive("user_dan", undefined, at("2026-08-20T09:00:00Z"));
  for (let i = 0; i < 4; i++) await activity.record("meeting.created", { account: "user_alice", ts: at("2026-09-12T10:00:00Z") + i });
  for (let i = 0; i < 2; i++) await activity.record("meeting.created", { account: "user_dan", ts: at("2026-08-20T10:00:00Z") + i });
  await activity.record("recording.started", { account: "user_alice", ts: at("2026-09-12T11:00:00Z") });
  // Error-level events: two in September, one in August.
  await activity.record("admin.sign_in_failed", { severity: "error", ts: at("2026-09-03T10:00:00Z") });
  await activity.record("admin.sign_in_failed", { severity: "error", ts: at("2026-09-04T10:00:00Z") });
  await activity.record("admin.sign_in_failed", { severity: "error", ts: at("2026-08-15T10:00:00Z") });
  // A failed administrator action on 5 September (the audit stamps "now").
  const resume = clock;
  clock = at("2026-09-05T10:00:00Z");
  await audit.recordAdminAction({ userId: "user_support", email: "support@example.com" }, null, {
    action: "user.suspend",
    targetType: "user",
    targetId: "user_bob",
    targetLabel: "bob@example.com",
    outcome: "failed",
    note: "Clerk refused",
  });
  clock = resume;

  // Subscription records, as src/lib/billing/subscriptions.ts keeps them.
  const sub = (userId: string, planId: string, name: string, status: string, createdAt: number, periodEnd: number | null, endedAt: number | null) => ({
    userId,
    email: g.__users[userId].emails![0],
    planId,
    baseTier: planId,
    version: 1,
    snapshot: { name, prices: {}, limits: {} },
    status,
    cycle: "monthly",
    periodStart: createdAt,
    periodEnd,
    source: "admin",
    pricePaid: null,
    addOns: [],
    custom: null,
    paused: null,
    cancelled: null,
    scheduled: null,
    endedAt,
    createdAt,
    updatedAt: createdAt,
  });
  const subs = [
    sub("user_alice", "pro", "Pro", "active", at("2026-09-05T00:00:00Z"), NOW + 10 * DAY, null),
    sub("user_bob", "pro", "Pro", "trialing", at("2026-08-10T00:00:00Z"), NOW + 40 * DAY, null),
    sub("user_cara", "business", "Business", "expired", at("2026-07-01T00:00:00Z"), at("2026-09-15T00:00:00Z"), at("2026-09-15T00:00:00Z")),
    sub("user_dan", "starter", "Starter", "cancelled", at("2026-08-20T00:00:00Z"), at("2026-08-25T00:00:00Z"), at("2026-08-25T00:00:00Z")),
  ];
  for (const s of subs) {
    await kv.set(`neo:sub:${s.userId}`, JSON.stringify(s));
    await kv.sadd("neo:subs:users", s.userId);
    if (s.endedAt) await kv.zadd("neo:subs:ended", { score: s.endedAt, member: s.userId });
    else await kv.zadd("neo:subs:by_end", { score: s.periodEnd!, member: s.userId });
  }

  // Payments, through the payments store and the ledger.
  const pay = (paymentRef: string, userId: string, amountEsp: number, paidAt: number, status: "paid" | "failed" = "paid") =>
    payments.recordPayment({ paymentRef, userId, plan: "pro", billingCycle: "monthly", amountEsp, paidAt, periodStart: paidAt, periodEnd: paidAt + 30 * DAY, status });
  await pay("ESP-BOB-JUL", "user_bob", 100, at("2026-07-10T10:00:00Z"));
  await pay("ESP-BOB-SEP", "user_bob", 100, at("2026-09-10T10:00:00Z")); // a renewal
  await pay("ESP-ALICE-SEP", "user_alice", 100, at("2026-09-04T10:00:00Z")); // a first purchase
  await pay("ESP-DAN-AUG", "user_dan", 200, at("2026-08-15T10:00:00Z"));
  await pay("ESP-CARA-FAIL", "user_cara", 30, at("2026-09-20T10:00:00Z"), "failed");
  await payments.updatePaymentRecord("ESP-DAN-AUG", {
    refunds: [{ id: "rf_1", amount: 20, currency: "ESP", at: at("2026-09-05T10:00:00Z"), method: "outside", byEmail: "billing@example.com", byUserId: "user_billing" }],
    refundedAmount: 20,
  });
  await ledger.saveTicket({
    sessionId: "cs_ticket_1",
    paymentIntent: null,
    userId: "user_alice",
    email: "alice@example.com",
    name: "Alice",
    eventId: "ev_alice",
    amountMinor: 5000,
    currency: "usd",
    status: "paid",
    at: at("2026-09-12T10:00:00Z"),
  });
  await indexPayment(ticketId("cs_ticket_1"), at("2026-09-12T10:00:00Z"));
  await trackCheckout({ nonce: "chk_1", userId: "user_cara", plan: "pro", billingCycle: "monthly", createdAt: at("2026-09-21T10:00:00Z"), amountEsp: 25 });

  // The file index.
  const file = (key: string, type: string, size: number, state = "active", name?: string) => ({
    id: files.fileId("r2", key),
    storage: "r2",
    key,
    type,
    ownerId: "user_alice",
    name,
    size,
    contentType: "video/mp4",
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    status: "ready",
    statusAt: NOW - DAY,
    visibility: "private",
    state,
    source: "upload",
  });
  await files.putFiles([
    file("recordings/user_alice/alice-weekly/1.mp4", "recording", 1000, "active", "alice-weekly-recording.mp4"),
    file("recordings/user_alice/alice-weekly/2.mp4", "recording", 3000),
    file("chat/alice-weekly/notes.pdf", "chat_upload", 500),
    file("chat/alice-weekly/old.pdf", "chat_upload", 999, "trashed"),
  ] as unknown as Parameters<typeof files.putFiles>[0]);

  // Ops: the latest health results (as the health cron writes them), an
  // open and a resolved incident, a job that works and one that keeps failing.
  const probe = (id: string, status: string) => JSON.stringify({ id, label: id.toUpperCase(), group: "x", status, latencyMs: 10, checkedAt: NOW - 60_000, detail: `${id} ${status}`, lastFailureAt: null, lastFailure: null });
  await kv.hset("neo:ops:health:latest", { r2: probe("r2", "up"), livekit: probe("livekit", "down"), stripe: probe("stripe", "not_configured") });
  await incidents.createIncident({ title: "Recordings delayed", impact: "major", status: "investigating", services: ["r2"], message: "Looking", showBanner: false, by: "owner@example.com" });
  await incidents.createIncident({ title: "Old blip", impact: "minor", status: "resolved", services: [], message: "Done", showBanner: false, by: "owner@example.com" });
  await jobs.runJob("nightly-cleanup", async () => ({ ok: true }), { trigger: "manual", actor: "test" });
  await jobs.runJob("billing-reminders", async () => ({ ok: false, error: "mail down" }), { trigger: "manual", actor: "test" });
  await jobs.runJob("billing-reminders", async () => ({ ok: false, error: "mail down" }), { trigger: "manual", actor: "test" });

  // For the search: a meeting, a group and a ticket.
  await eventStore.create({
    id: "ev_alice",
    slug: "alice-weekly",
    name: "Alice weekly",
    ownerUserId: "user_alice",
    ownerEmail: "alice@example.com",
    visibility: "public",
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    waitingRoomEnabled: true,
    livekitRoom: "alice-weekly",
    qrSeed: "x",
    roles: [],
  } as unknown as Parameters<typeof eventStore.create>[0]);
  await groups.createGroup({ name: "Alice's team" }, { userId: "user_alice", name: "Alice", email: "alice@example.com" });
  const ticket = await tickets.createTicket({ subject: "Alice cannot record", category: "billing", body: "Recording fails", userId: "user_alice", email: "alice@example.com", name: "Alice", source: "web" });

  const SEPT = "?range=custom&from=2026-09-01&to=2026-09-30&compare=previous&tz=UTC";
  const ok = <T,>(r: Body, id: string): T => {
    assert.ok(r.sources[id], `source ${id} missing`);
    assert.equal(r.sources[id].status, "ok", `${id}: ${JSON.stringify(r.sources[id])}`);
    return r.sources[id].data as T;
  };

  /* ---------------------------------- figures -------------------------------- */

  console.log("figures");
  let first: Body = {};
  await t("the owner sees every card; periods are September and the 30 days before it", async () => {
    const r = await call("user_owner", R.overview.GET, SEPT);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    first = r.body;
    assert.deepEqual(Object.keys(r.body.sources).sort(), ["activity", "errors", "health", "incidents", "jobs", "online", "revenue", "storage", "subscriptions", "users"]);
    assert.deepEqual([r.body.periods.current.from, r.body.periods.current.to], ["2026-09-01", "2026-09-30"]);
    assert.deepEqual([r.body.periods.previous.from, r.body.periods.previous.to], ["2026-08-02", "2026-08-31"]);
    assert.equal(r.body.periods.current.startMs, at("2026-09-01T00:00:00Z"));
    assert.equal(r.body.periods.current.endMs, at("2026-10-01T00:00:00Z") - 1);
  });

  await t("users: Clerk's total, sign-ups in the period against the period before, per day", async () => {
    const d = ok<Body>(first, "users");
    assert.equal(d.total, 11);
    assert.deepEqual(d.newUsers, { value: 3, previous: 2, diff: 1, pct: 50 });
    assert.equal(d.daily.length, 30);
    assert.equal(d.daily[2], 1, "3 September");
    assert.equal(d.daily[29], 1, "30 September (Cara, 23:30 UTC)");
    assert.equal(d.daily.reduce((a: number, b: number) => a + b, 0), 3);
  });

  await t("online now: participants in LiveKit's rooms, empty rooms not counted", async () => {
    const d = ok<Body>(first, "online");
    assert.deepEqual({ configured: d.configured, participants: d.participants, rooms: d.rooms }, { configured: true, participants: 5, rooms: 2 });
  });

  await t("active users: daily average, WAU, MAU and feature use from the activity log", async () => {
    const d = ok<Body>(first, "activity");
    assert.equal(d.comparable, true);
    assert.equal(d.daily[9], 2, "10 September: Alice and Bob");
    assert.equal(d.daily[29], 1, "30 September: Alice");
    assert.deepEqual(d.dailyAvg, { value: 0.1, previous: 0, diff: 0.1, pct: null });
    assert.deepEqual(d.wau, { value: 1, previous: 0, diff: 1, pct: null });
    assert.deepEqual(d.mau, { value: 2, previous: 1, diff: 1, pct: 100 });
    const created = d.features.find((f: Body) => f.type === "meeting.created");
    assert.deepEqual(created.count, { value: 4, previous: 2, diff: 2, pct: 100 });
    assert.equal(d.features[0].type, "meeting.created", "most used first");
  });

  await t("subscriptions: by plan and status, started and ended, renewals due, running per day", async () => {
    const d = ok<Body>(first, "subscriptions");
    assert.equal(d.total, 4);
    assert.equal(d.live, 2);
    assert.deepEqual(
      d.byPlan.map((p: Body) => [p.planId, p.total, p.live]),
      [
        ["pro", 2, 2],
        ["business", 1, 0],
        ["starter", 1, 0],
      ],
    );
    assert.deepEqual(Object.fromEntries(d.byStatus.map((s: Body) => [s.status, s.count])), { active: 1, trialing: 1, expired: 1, cancelled: 1 });
    assert.deepEqual(d.started, { value: 1, previous: 2, diff: -1, pct: -50 });
    assert.deepEqual(d.ended, { value: 1, previous: 1, diff: 0, pct: 0 });
    assert.equal(d.renewalsDue, 1, "Alice's period ends in 10 days; Bob's trial in 40");
    assert.equal(d.daily[0], 2, "1 September: Bob and Cara");
    assert.equal(d.daily[9], 3, "10 September: Alice, Bob, Cara");
    assert.equal(d.daily[29], 2, "30 September: Cara ended on the 15th");
  });

  await t("revenue: per currency, never summed; refunds, failures, renewals and comparison", async () => {
    const d = ok<Body>(first, "revenue");
    assert.deepEqual(Object.keys(d.gross), ["ESP", "USD"]);
    assert.deepEqual(d.gross.ESP, { value: 200, previous: 200, diff: 0, pct: 0 });
    assert.deepEqual(d.gross.USD, { value: 50, previous: 0, diff: 50, pct: null });
    assert.ok(!("total" in d.gross) && !Object.values(d.gross).some((x) => (x as Body).value === 250), "no figure adds ESP and USD");
    assert.deepEqual(d.refunds, { ESP: { value: 20, previous: 0, diff: 20, pct: null } });
    assert.deepEqual(d.net.ESP, { value: 180, previous: 200, diff: -20, pct: -10 });
    assert.deepEqual(d.failed, { count: { value: 1, previous: 0, diff: 1, pct: null }, amount: { ESP: 30 } });
    assert.deepEqual(d.renewals, { value: 1, previous: 0, diff: 1, pct: null });
    assert.deepEqual(d.newCustomers, { value: 1, previous: 1, diff: 0, pct: 0 });
    assert.deepEqual(d.payments, { value: 3, previous: 1, diff: 2, pct: 200 });
    assert.equal(d.outstanding.abandoned.count, 1);
    assert.deepEqual(d.outstanding.abandoned.amount, { ESP: 25 });
    assert.equal(d.series.bucket, "day");
    assert.equal(d.series.starts.length, 30);
    assert.equal(d.series.byCurrency.ESP[3], 100, "4 September");
    assert.equal(d.series.byCurrency.ESP[9], 100, "10 September");
    assert.equal(d.series.byCurrency.USD[11], 50, "12 September");
  });

  await t("storage: the Content section's totals (the bin still takes space), bandwidth said to be unavailable", async () => {
    const d = ok<Body>(first, "storage");
    assert.deepEqual([d.bytes, d.files], [5499, 4]);
    assert.deepEqual(d.trashed, { files: 1, bytes: 999 });
    assert.deepEqual(
      d.byType.map((x: Body) => [x.type, x.files, x.bytes, x.href]),
      [
        ["recording", 2, 4000, "/admin/content?type=recording&state=all"],
        ["chat_upload", 2, 1499, "/admin/content?type=chat_upload&state=all"],
      ],
    );
    assert.equal(d.links.storage, "/admin/content/storage");
    assert.equal(d.complete, false, "no full listing has run");
    assert.equal(d.bandwidth.available, false);
    assert.match(d.bandwidth.reason, /Cloudflare/);
  });

  await t("health, incidents and jobs from the ops records", async () => {
    const h = ok<Body>(first, "health");
    assert.deepEqual(h.counts, { up: 1, degraded: 0, down: 1, not_configured: 1 });
    assert.equal(h.services[0].id, "livekit", "a down service first");
    const i = ok<Body>(first, "incidents");
    assert.deepEqual(
      i.open.map((x: Body) => x.title),
      ["Recordings delayed"],
    );
    assert.equal(i.alerts.active, 0);
    const j = ok<Body>(first, "jobs");
    assert.equal(j.failing, 1);
    assert.deepEqual(
      j.jobs.map((x: Body) => [x.name, x.outcome, x.failingRuns]),
      [
        ["billing-reminders", "failed", 2],
        ["nightly-cleanup", "ok", 0],
      ],
    );
    assert.deepEqual(j.failedRuns, { value: 0, previous: 0, diff: 0, pct: 0 }, "the runs were in October, not September");
    const week = await call("user_owner", R.overview.GET, "?range=7d&tz=UTC&only=jobs");
    assert.equal(week.body.sources.jobs.data.failedRuns.value, 2);
  });

  await t("errors: error-level log events and failed administrator actions", async () => {
    const d = ok<Body>(first, "errors");
    assert.deepEqual({ value: d.activity.value, previous: d.activity.previous, pct: d.activity.pct }, { value: 2, previous: 1, pct: 100 });
    assert.equal(d.admin.value, 1);
  });

  /* -------------------------------- comparisons ------------------------------ */

  console.log("comparisons and days");
  await t("same period last year: September 2025, and the log cannot compare that far back", async () => {
    const r = await call("user_owner", R.overview.GET, "?range=custom&from=2026-09-01&to=2026-09-30&compare=last_year&tz=UTC");
    assert.deepEqual([r.body.periods.previous.from, r.body.periods.previous.to], ["2025-09-01", "2025-09-30"]);
    assert.deepEqual(ok<Body>(r.body, "users").newUsers, { value: 3, previous: 1, diff: 2, pct: 200 });
    assert.equal(ok<Body>(r.body, "activity").comparable, false);
    assert.deepEqual(ok<Body>(r.body, "revenue").gross.ESP, { value: 200, previous: 0, diff: 200, pct: null });
  });

  await t("days are calendar days in the chosen zone (Lagos, UTC+1)", async () => {
    const r = await call("user_owner", R.overview.GET, "?range=custom&from=2026-09-01&to=2026-09-30&tz=Africa/Lagos&only=users");
    const d = ok<Body>(r.body, "users");
    assert.equal(r.body.periods.current.startMs, at("2026-08-31T23:00:00Z"));
    assert.deepEqual(d.newUsers, { value: 3, previous: 1, diff: 2, pct: 200 }, "Eve moves into September, Cara out of it");
    assert.equal(d.daily[0], 1, "Eve on 1 September");
    assert.equal(d.daily[29], 0, "Cara is 1 October here");
  });

  await t("presets: this month, last month, today and 90 days end today in the zone", async () => {
    const p = (q: string) => resolvePeriods(readQuery(new URLSearchParams(q)), NOW);
    assert.deepEqual([p("range=this_month&tz=UTC").current.from, p("range=this_month&tz=UTC").current.to], ["2026-10-01", "2026-10-09"]);
    assert.deepEqual([p("range=last_month&tz=UTC").current.from, p("range=last_month&tz=UTC").current.to], ["2026-09-01", "2026-09-30"]);
    assert.deepEqual([p("range=last_month&tz=UTC").previous.from, p("range=last_month&tz=UTC").previous.to], ["2026-08-02", "2026-08-31"]);
    assert.deepEqual(p("range=today&tz=Pacific/Kiritimati").current.days, ["2026-10-10"], "already the 10th at UTC+14");
    assert.equal(p("range=90d&tz=UTC").current.days.length, 90);
    assert.deepEqual(p("range=custom&from=2024-02-29&to=2024-02-29&compare=last_year&tz=UTC").previous.days, ["2023-02-28"]);
    assert.equal(p("range=custom&from=2020-01-01&to=2026-10-09&tz=UTC").current.days.length, 366, "custom ranges stop at a year");
  });

  /* ------------------------------- degradation ------------------------------- */

  console.log("a failing source");
  await t("Clerk down: only the users card errs, the rest still answer, and the error is not cached", async () => {
    // A period not loaded before, so no earlier good figure is in the cache.
    const JULY = "?range=custom&from=2026-07-01&to=2026-07-31&compare=previous&tz=UTC";
    g.__clerkCountFails = true;
    const r = await call("user_owner", R.overview.GET, JULY);
    g.__clerkCountFails = false;
    assert.equal(r.status, 200);
    assert.equal(r.body.sources.users.status, "error");
    assert.match(r.body.sources.users.message, /Clerk API unavailable/);
    for (const id of ["online", "activity", "subscriptions", "revenue", "storage", "health", "incidents", "jobs", "errors"]) {
      assert.equal(r.body.sources[id].status, "ok", id);
    }
    const again = await call("user_owner", R.overview.GET, JULY);
    assert.equal(again.body.sources.users.status, "ok", "the next load tries again");
    assert.equal(again.body.sources.users.cached, false);
  });

  /* ------------------------------- permissions ------------------------------- */

  console.log("permissions");
  await t("support role: users, online and subscriptions only — no revenue figures at all", async () => {
    const r = await call("user_support", R.overview.GET, SEPT);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.sources).sort(), ["online", "subscriptions", "users"]);
    assert.ok(!JSON.stringify(r.body).includes("ESP"), "not a single amount");
  });

  await t("billing role: revenue and errors, but failed admin actions need audit:read", async () => {
    const r = await call("user_billing", R.overview.GET, SEPT);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.sources).sort(), ["activity", "errors", "online", "revenue", "subscriptions", "users"]);
    const e = ok<Body>(r.body, "errors");
    assert.equal(e.activity.value, 2);
    assert.ok(!("admin" in e), "no audit figure without audit:read");
    const a = ok<Body>((await call("user_analyst", R.overview.GET, SEPT)).body, "errors");
    assert.equal(a.admin.value, 1, "the analyst role reads the audit");
  });

  await t("a role without overview:read is refused the route", async () => {
    const r = await call("user_noov", R.overview.GET, SEPT);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
    assert.equal(r.body.permission, "overview:read");
  });

  /* -------------------------------- drill-down ------------------------------- */

  console.log("drill-down");
  const query = (href: string) => href.slice(href.indexOf("?"));
  await t("new registrations open the users list with the same days and zone, holding exactly those accounts", async () => {
    const d = ok<Body>(first, "users");
    assert.equal(d.links.newUsers, "/admin/users?from=2026-09-01&to=2026-09-30&tz=UTC");
    const list = await call("user_owner", R.users.GET, query(d.links.newUsers));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.items.map((u: Body) => u.id).sort(), ["user_alice", "user_bob", "user_cara"]);
    const lagos = await call("user_owner", R.overview.GET, "?range=custom&from=2026-09-01&to=2026-09-30&tz=Africa/Lagos&only=users");
    const lagosList = await call("user_owner", R.users.GET, query(lagos.body.sources.users.data.links.newUsers));
    assert.deepEqual(lagosList.body.items.map((u: Body) => u.id).sort(), ["user_alice", "user_bob", "user_eve"]);
  });

  await t("failed payments and refunds open the payments list filtered to the period's instants", async () => {
    const d = ok<Body>(first, "revenue");
    const p = first.periods.current;
    assert.equal(d.links.failed, `/admin/billing/payments?status=failed&from=${p.startMs}&to=${p.endMs}`);
    assert.equal(d.links.refunds, `/admin/billing/payments?status=refunds&from=${p.startMs}&to=${p.endMs}`);
    const failed = await ledger.queryLedger(ledgerQuery(new URLSearchParams(query(d.links.failed))));
    assert.deepEqual(
      failed.items.map((e) => e.ref),
      ["ESP-CARA-FAIL"],
    );
    assert.equal(failed.total, d.failed.count.value);
  });

  await t("a plan's subscriptions open the list filtered to that plan", async () => {
    const d = ok<Body>(first, "subscriptions");
    const pro = d.byPlan.find((x: Body) => x.planId === "pro");
    assert.equal(pro.href, "/admin/subscriptions?view=all&plan=pro");
    const list = await call("user_owner", R.subscriptions.GET, query(pro.href));
    assert.deepEqual(list.body.rows.map((x: Body) => x.userId).sort(), ["user_alice", "user_bob"]);
    assert.equal(d.links.renewalsDue, "/admin/subscriptions?view=upcoming&days=30");
    const due = await call("user_owner", R.subscriptions.GET, query(d.links.renewalsDue));
    assert.equal(due.body.rows.length, d.renewalsDue);
  });

  await t("errors, features, incidents and jobs link to their filtered lists", async () => {
    assert.equal(ok<Body>(first, "errors").links.errors, "/admin/logs?severity=error&from=2026-09-01&to=2026-09-30");
    const f = ok<Body>(first, "activity").features.find((x: Body) => x.type === "meeting.created");
    assert.equal(f.href, "/admin/logs?type=meeting.created&from=2026-09-01&to=2026-09-30");
    assert.equal(ok<Body>(first, "incidents").links.incidents, overviewLinks.incidents());
    assert.equal(ok<Body>(first, "jobs").jobs[0].href, "/admin/ops/jobs?job=billing-reminders");
    assert.equal(ok<Body>(first, "online").links.live, "/admin/events?state=live");
  });

  /* ---------------------------------- cache ---------------------------------- */

  console.log("cache");
  await t("a repeat within the minute is served from KV with its own time; refresh recomputes", async () => {
    g.__kvTtl = true; // the stub Redis keeps TTLs from here on
    const a = await call("user_owner", R.overview.GET, SEPT + "&only=users&refresh=1");
    const b = await call("user_owner", R.overview.GET, SEPT + "&only=users");
    assert.equal(b.body.sources.users.cached, true);
    assert.equal(b.body.sources.users.at, a.body.sources.users.at);
    assert.equal(b.body.asOf, a.body.sources.users.at);
    const [key] = (await kv.keys("neo:admin:overview:v1:users:UTC:2026-09-01:2026-09-30:*")) as string[];
    assert.ok(key, "cached under the period it was computed for");
    assert.equal(await kv.pttl(key), 60_000);

    g.__users.user_gus = { emails: ["gus@example.com"], createdAt: at("2026-09-20T12:00:00Z") };
    tick(5_000);
    const stale = await call("user_owner", R.overview.GET, SEPT + "&only=users");
    assert.equal(stale.body.sources.users.data.total, 11, "still the cached figure");
    const fresh = await call("user_owner", R.overview.GET, SEPT + "&only=users&refresh=1");
    assert.equal(fresh.body.sources.users.cached, false);
    assert.equal(fresh.body.sources.users.data.total, 12);
    assert.equal(fresh.body.sources.users.data.newUsers.value, 4);
    assert.ok(fresh.body.sources.users.at > a.body.sources.users.at);
    // The refresh wrote it again: a minute from now.
    tick(59_000);
    assert.equal((await call("user_owner", R.overview.GET, SEPT + "&only=users")).body.sources.users.cached, true, "59 s on: still cached");
    tick(2_000);
    const later = await call("user_owner", R.overview.GET, SEPT + "&only=users");
    assert.equal(later.body.sources.users.cached, false, "61 s on: expired and recomputed");
    g.__kvTtl = false;
    delete g.__users.user_gus;
  });

  /* ---------------------------------- search --------------------------------- */

  console.log("search");
  const cats = (b: Body) => Object.fromEntries((b.categories as Body[]).map((c) => [c.id, c]));
  await t("one query finds the user, group, meeting, payment, ticket, file and audit entry", async () => {
    const r = await call("user_owner", R.search.GET, "?q=alice");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = cats(r.body);
    assert.deepEqual(Object.keys(c), ["users", "groups", "meetings", "payments", "tickets", "files", "audit"]);
    assert.equal(c.users.items[0].href, "/admin/users/user_alice");
    assert.equal(c.groups.items[0].title, "Alice's team");
    assert.equal(c.meetings.items[0].href, "/admin/events?q=alice-weekly");
    assert.ok(c.payments.items.some((p: Body) => p.title.includes("ESP-ALICE-SEP")));
    assert.equal(c.tickets.items[0].href, `/admin/support/${ticket.id}`);
    assert.equal(c.files.items[0].title, "alice-weekly-recording.mp4");
    const ref = await call("user_owner", R.search.GET, "?q=ESP-CARA-FAIL");
    assert.deepEqual(
      cats(ref.body).payments.items.map((p: Body) => p.href),
      ["/admin/billing/payments?open=pay%3AESP-CARA-FAIL"],
    );
    const auditHit = await call("user_owner", R.search.GET, "?q=Clerk%20refused");
    assert.equal(cats(auditHit.body).audit.items.length, 1);
    assert.match(cats(auditHit.body).audit.items[0].href, /^\/admin\/audit-log\?q=Clerk%20refused&open=\d+$/);
    const byId = await call("user_owner", R.search.GET, "?q=user_dan");
    assert.equal(cats(byId.body).users.items[0].id, "user_dan");
  });

  await t("search covers only what the role can open", async () => {
    assert.deepEqual(Object.keys(cats((await call("user_support", R.search.GET, "?q=alice")).body)), ["users", "groups", "meetings", "tickets"]);
    assert.deepEqual(Object.keys(cats((await call("user_billing", R.search.GET, "?q=alice")).body)), ["users", "groups", "payments"]);
    assert.deepEqual(Object.keys(cats((await call("user_noov", R.search.GET, "?q=alice")).body)), ["users", "groups"]);
    const tooShort = await call("user_owner", R.search.GET, "?q=a");
    assert.deepEqual(tooShort.body.categories, []);
  });

  await t("a failing category errs on its own", async () => {
    (g as { __clerkListFails?: boolean }).__clerkListFails = true;
    const r = await call("user_owner", R.search.GET, "?q=alice");
    (g as { __clerkListFails?: boolean }).__clerkListFails = false;
    const c = cats(r.body);
    assert.equal(c.users.status, "error");
    assert.match(c.users.message, /unavailable/);
    for (const id of ["groups", "meetings", "payments", "tickets", "files", "audit"]) assert.equal(c[id].status, "ok", id);
  });

  console.log(`\n${n} checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
