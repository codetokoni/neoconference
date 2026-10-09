// Run: npx tsx src/lib/__tests__/adminAutomation.smoke.ts
//
// Automation rules (admin phase 10), driven through the real /api/admin and
// cron routes with Clerk, KV and Resend stood in for: schedules in a
// timezone across daylight saving; conditions found on fixed data; a dry run
// that does nothing; once per subject per period on a double run and on a
// retry; the per-rule lock; a rule that replaces a cron keeps that cron from
// also running; a failure streak raising an ops alert; pause; permissions
// and step-up; the audit trail. No real email leaves: Resend is answered
// here, and every address is @example.com.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_admin_automation";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.CRON_SECRET = "cron";
process.env.RESEND_API_KEY = "re_test_automation";
delete process.env.ADMIN_EMAILS;
delete process.env.BOOTSTRAP_BUSINESS_EMAIL;

type U = { plan?: string | null; role?: string; emails?: string[]; first?: string; metadata?: Record<string, unknown> };
type Stubbed = typeof globalThis & { __users: Record<string, U>; __who?: string; __kvStore: Map<string, unknown>; __kvTtl?: boolean };
const g = globalThis as Stubbed;
// Keys expire, on the test's clock: the replaced-cron mark must lapse when the dispatcher stops.
g.__kvTtl = true;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

g.__users = {
  user_owner: { emails: ["owner@example.com"], plan: "starter", first: "Owner" },
  user_writer: { emails: ["writer@example.com"] },
  user_viewer: { emails: ["viewer@example.com"] },
  user_plain: { emails: ["plain@example.com"] },
};
for (let i = 1; i <= 6; i++) g.__users[`user_u${i}`] = { emails: [`u${i}@example.com`], first: `U${i}` };
// Free accounts and their lifetime meetings (Free's cap is 5): m1–m3 at 80%, m4 at 60%.
for (let i = 1; i <= 4; i++) g.__users[`user_m${i}`] = { emails: [`m${i}@example.com`], metadata: { meetingsCreated: i === 4 ? 3 : 4 } };

// Resend: answered here. `mailFails` > 0 makes the next sends fail.
const mail: { to: string[]; subject: string; text?: string; attachments?: { filename: string }[] }[] = [];
let mailFails = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith("https://api.resend.com/")) {
    if (mailFails > 0) {
      mailFails--;
      return new Response(JSON.stringify({ message: "test outage" }), { status: 500 });
    }
    const body = JSON.parse(String(init?.body));
    for (const to of [...body.to, ...(body.bcc ?? [])]) assert.match(to, /@example\.com$/, "only test addresses are mailed");
    mail.push(body);
    return new Response(JSON.stringify({ id: `re_${mail.length}` }), { status: 200 });
  }
  if (u.startsWith("https://www.neoconference.app/") || u.startsWith("http://localhost")) return realFetch(url as string, init);
  throw new Error(`unexpected network call in a test: ${u}`);
}) as typeof fetch;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const mfa = await import("../admin/mfa");
  const audit = await import("../admin/audit");
  const schedule = await import("../automation/schedule");
  const store = await import("../automation/store");
  const runner = await import("../automation/runner");
  const jobs = await import("../ops/jobs");
  const alerts = await import("../ops/alerts");
  // Stores with an in-memory fallback (recording usage) use the KV stub too, as in production.
  process.env.KV_REST_API_URL = "https://kv.example.com";
  process.env.KV_REST_API_TOKEN = "test";
  const { kv } = await import("../kv");
  const comms = await import("../comms/reminders");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    team: await import("../../app/api/admin/team/route"),
    roles: await import("../../app/api/admin/roles/route"),
    plan: await import("../../app/api/admin/plans/[id]/route"),
    sub: await import("../../app/api/admin/subscriptions/[userId]/route"),
    rules: await import("../../app/api/admin/automation/route"),
    rule: await import("../../app/api/admin/automation/[id]/route"),
    status: await import("../../app/api/admin/automation/[id]/status/route"),
    run: await import("../../app/api/admin/automation/[id]/run/route"),
    preview: await import("../../app/api/admin/automation/[id]/preview/route"),
    draftPreview: await import("../../app/api/admin/automation/preview/route"),
    dispatch: await import("../../app/api/cron/automation/route"),
    downgrade: await import("../../app/api/cron/downgrade-expired-plans/route"),
    espeesFail: await import("../../app/api/billing/espees/fail/route"),
    billingCron: await import("../../app/api/cron/billing-reminders/route"),
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
    return { status: res.status, body };
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
  async function fresh(who: string) {
    tick();
    const v = await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  const stale = () => tick(11 * 60_000);
  /** Move the clock a long way; admin sessions last 12 hours, so sign the admins in again. */
  const jump = async (ms: number) => {
    tick(ms);
    for (const who of Object.keys(secrets)) await fresh(who);
  };
  const cronHeaders = { authorization: "Bearer cron" };
  const dispatch = () => call(null, R.dispatch.GET, { headers: cronHeaders });
  const ruleCall = (who: string, h: typeof R.run.POST, id: string, body?: unknown) => call(who, h, { method: "POST", params: { id }, body });
  const getRule = async (id: string) => (await call("user_owner", R.rule.GET, { params: { id } })).body;
  const runsOf = (id: string) => jobs.listRuns(runner.jobName(id), 50);
  const mailTo = (addr: string) => mail.filter((m) => m.to.includes(addr));
  const create = async (who: string, body: Record<string, unknown>) => {
    const r = await call(who, R.rules.POST, { method: "POST", body: { timezone: "UTC", schedule: { type: "every", unit: "days", n: 1, at: "09:00" }, ...body } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.rule as { id: string; name: string };
  };

  console.log("schedules");
  await t("cron and every-N schedules in a timezone: next and previous runs, a daily time held across both DST changes", async () => {
    const NY = "America/New_York";
    const iso = (x: number | null) => (x == null ? null : new Date(x).toISOString());
    // 02:30 does not exist on 8 March 2026 in New York: runs at 03:30 EDT, once.
    assert.deepEqual(schedule.upcomingRuns({ type: "cron", expr: "30 2 * * *" }, NY, Date.UTC(2026, 2, 7, 12), 3).map(iso), [
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ]);
    // 01:30 happens twice on 1 November 2026: runs at the first (EDT) only.
    assert.deepEqual(schedule.upcomingRuns({ type: "every", unit: "days", n: 1, at: "01:30" }, NY, Date.UTC(2026, 9, 31, 12), 2).map(iso), [
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
    // A daily 09:00 in London is 08:00 UTC in summer, 09:00 in winter.
    assert.deepEqual(schedule.upcomingRuns({ type: "cron", expr: "0 9 * * *" }, "Europe/London", Date.UTC(2026, 9, 24, 12), 2).map(iso), [
      "2026-10-25T09:00:00.000Z",
      "2026-10-26T09:00:00.000Z",
    ]);
    assert.equal(iso(schedule.nextRun({ type: "cron", expr: "0 7 * * 1" }, "Africa/Lagos", Date.UTC(2026, 9, 9))), "2026-10-12T06:00:00.000Z");
    assert.equal(iso(schedule.nextRun({ type: "every", unit: "minutes", n: 15 }, "Asia/Kolkata", Date.UTC(2026, 9, 9, 10, 7))), "2026-10-09T10:15:00.000Z");
    assert.equal(iso(schedule.nextRun({ type: "every", unit: "hours", n: 6, minute: 15 }, "Asia/Kolkata", Date.UTC(2026, 9, 9, 10, 7))), "2026-10-09T12:45:00.000Z");
    assert.deepEqual(
      schedule.upcomingRuns({ type: "every", unit: "days", n: 3, at: "09:00", anchorDay: "2026-10-09" }, "Africa/Lagos", Date.UTC(2026, 9, 9, 9), 2).map(iso),
      ["2026-10-12T08:00:00.000Z", "2026-10-15T08:00:00.000Z"],
    );
    assert.equal(iso(schedule.previousRun({ type: "cron", expr: "0 7 * * 1" }, "UTC", Date.UTC(2026, 9, 9))), "2026-10-05T07:00:00.000Z");
    assert.equal(schedule.nextRun({ type: "cron", expr: "0 0 30 2 *" }, "UTC", Date.UTC(2026, 0, 1)), null);
    assert.match(String(schedule.validateSchedule({ type: "cron", expr: "61 * * * *" }, "UTC")), /minute field/);
    assert.match(String(schedule.validateSchedule({ type: "every", unit: "minutes", n: 7 }, "UTC")), /Every 5, 10/);
    assert.match(String(schedule.validateSchedule({ type: "cron", expr: "* * * * *" }, "Mars/Olympus")), /not a time zone/);
  });

  console.log("setup, permissions and built-in rules");
  let writerRole = "";
  await t("the owner appoints an Analyst (ops:read) and an Automation writer; non-admins get nothing", async () => {
    await enrollAndVerify("user_owner");
    const role = await call("user_owner", R.roles.POST, { method: "POST", body: { name: "Automation", permissions: ["ops:read", "automation:write"] } });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    writerRole = role.body.role.id;
    for (const [email, roleId] of [
      ["writer@example.com", writerRole],
      ["viewer@example.com", "analyst"],
    ]) {
      assert.equal((await call("user_owner", R.team.POST, { method: "POST", body: { email, roleId } })).status, 201);
    }
    await enrollAndVerify("user_writer");
    await enrollAndVerify("user_viewer");
    assert.equal((await call("user_plain", R.rules.GET)).body.error, "not_admin");
  });

  await t("built-in rules are seeded once: trial expiry active and replacing its cron, the rest paused", async () => {
    const list = await call("user_viewer", R.rules.GET);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.canWrite, false);
    const byKey = Object.fromEntries(list.body.rules.map((r: { builtIn: string }) => [r.builtIn, r]));
    for (const k of ["trial_expiry", "trial_ending", "renewal", "failed_payment", "usage_meetings", "usage_recording", "weekly_report", "nightly_maintenance"]) assert.ok(byKey[k], k);
    assert.equal(byKey.trial_expiry.status, "active");
    assert.equal(byKey.trial_expiry.replaces, "downgrade-expired-plans");
    assert.deepEqual(byKey.renewal.condition, { kind: "renewal_due", days: [7, 3, 1] });
    assert.ok(list.body.rules.filter((r: { builtIn: string; status: string }) => r.builtIn !== "trial_expiry").every((r: { status: string }) => r.status === "paused"));
    // Seeding again changes nothing an administrator edited.
    await store.saveRule({ ...(await store.getRule("builtin_renewal"))!, name: "Renewals (edited)" });
    await call("user_viewer", R.rules.GET);
    assert.equal((await store.getRule("builtin_renewal"))!.name, "Renewals (edited)");
  });

  await t("ops:read views and previews; creating, editing, pausing and running need automation:write", async () => {
    const body = { name: "Nope", condition: { kind: "trial_ends_in", days: [3] }, action: { kind: "reminder", channels: { email: true, inApp: true } } };
    assert.equal((await call("user_viewer", R.rules.POST, { method: "POST", body })).body.error, "forbidden");
    assert.equal((await call("user_viewer", R.rule.PATCH, { method: "PATCH", params: { id: "builtin_renewal" }, body: { name: "x" } })).body.error, "forbidden");
    assert.equal((await ruleCall("user_viewer", R.status.POST, "builtin_renewal", { status: "active" })).body.error, "forbidden");
    assert.equal((await ruleCall("user_viewer", R.run.POST, "builtin_renewal")).body.error, "forbidden");
    assert.equal((await ruleCall("user_viewer", R.preview.POST, "builtin_weekly_report")).status, 200);
    assert.equal((await call("user_viewer", R.draftPreview.POST, { method: "POST", body })).body.error, "forbidden");
    assert.equal((await call("user_writer", R.rule.DELETE, { method: "DELETE", params: { id: "builtin_renewal" } })).body.error, "built_in");
    const bad = await call("user_writer", R.rules.POST, { method: "POST", body: { ...body, timezone: "UTC", schedule: { type: "cron", expr: "0 25 * * *" } } });
    assert.equal(bad.body.error, "invalid_schedule");
    const noCond = await call("user_writer", R.rules.POST, { method: "POST", body: { ...body, timezone: "UTC", schedule: { type: "cron", expr: "0 9 * * *" }, condition: null } });
    assert.equal(noCond.body.error, "invalid_action");
  });

  console.log("conditions, dry run and once per period");
  // Trials: u1 ends in 3 days, u2 in 14, u3 is a paid plan.
  await t("fixtures: two trials and a paid plan through the subscriptions admin", async () => {
    await fresh("user_owner");
    assert.equal((await call("user_owner", R.plan.PATCH, { method: "PATCH", params: { id: "business" }, body: { terms: { trialDays: 3 } } })).status, 200);
    let r = await call("user_owner", R.sub.POST, { method: "POST", params: { userId: "user_u1" }, body: { action: "assign", planId: "business", cycle: "monthly", trial: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call("user_owner", R.plan.PATCH, { method: "PATCH", params: { id: "business" }, body: { terms: { trialDays: 14 } } })).status, 200);
    r = await call("user_owner", R.sub.POST, { method: "POST", params: { userId: "user_u2" }, body: { action: "assign", planId: "business", cycle: "monthly", trial: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call("user_owner", R.sub.POST, { method: "POST", params: { userId: "user_u3" }, body: { action: "assign", planId: "pro", cycle: "monthly" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  let trialRule = "";
  await t("a 'trial ends in 3 days' rule finds exactly the trial ending in 3 days; its preview sends, claims and records nothing", async () => {
    const mailed = mail.length;
    const draft = { name: "Trial ends in 3 days", timezone: "UTC", schedule: { type: "every", unit: "hours", n: 1, minute: 0 }, condition: { kind: "trial_ends_in", days: [3] }, action: { kind: "reminder", channels: { email: true, inApp: true } } };
    const dp = await call("user_writer", R.draftPreview.POST, { method: "POST", body: draft });
    assert.equal(dp.status, 200, JSON.stringify(dp.body));
    assert.deepEqual(dp.body.preview.items.map((i: { label: string; outcome: string }) => [i.label, i.outcome]), [["u1@example.com", "would_do"]]);
    trialRule = (await create("user_writer", draft)).id;
    const p = await ruleCall("user_writer", R.preview.POST, trialRule);
    assert.equal(p.body.preview.counts.targets, 1);
    assert.equal(p.body.preview.dryRun, true);
    assert.equal(mail.length, mailed, "a preview sends nothing");
    assert.equal((await runsOf(trialRule)).length, 0, "a preview is not a run");
    assert.equal([...g.__kvStore.keys()].filter((k) => k.startsWith(`neo:auto:idem:${trialRule}:`)).length, 0, "a preview claims nothing");
    const { items } = await audit.listAdminAudit({ action: "automation.create" });
    assert.equal(items[0].targetId, trialRule);
    assert.equal((items[0].after as { condition: { kind: string } }).condition.kind, "trial_ends_in");
  });

  await t("Run now reminds the account once; a second run in the same period finds it already done", async () => {
    const r1 = await ruleCall("user_writer", R.run.POST, trialRule);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual([r1.body.detail.counts.done, r1.body.detail.counts.already], [1, 0]);
    assert.equal(mailTo("u1@example.com").length, 1);
    assert.match(mailTo("u1@example.com")[0].subject, /trial/i);
    const r2 = await ruleCall("user_writer", R.run.POST, trialRule);
    assert.deepEqual([r2.body.detail.counts.done, r2.body.detail.counts.already], [0, 1]);
    assert.equal(mailTo("u1@example.com").length, 1, "not sent twice");
    const runs = await runsOf(trialRule);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].trigger, "manual");
    assert.equal(runs[0].actor, "writer@example.com");
    const { items } = await audit.listAdminAudit({ action: "automation.run" });
    assert.equal(items.length, 2);
  });

  await t("a send that fails gives its claim back: the retry sends it, once", async () => {
    // u2's trial now ends within 3 days.
    await jump(11 * DAY + HOUR);
    mailFails = 1;
    const r1 = await ruleCall("user_writer", R.run.POST, trialRule);
    assert.equal(r1.body.detail.counts.failed, 1, JSON.stringify(r1.body.detail));
    assert.match(r1.body.detail.errors[0].message, /email not sent/);
    assert.equal(r1.body.run.outcome, "failed");
    assert.equal(mailTo("u2@example.com").length, 0);
    const r2 = await ruleCall("user_writer", R.run.POST, trialRule);
    assert.equal(r2.body.detail.counts.done, 1);
    const r3 = await ruleCall("user_writer", R.run.POST, trialRule);
    assert.equal(r3.body.detail.counts.done, 0);
    assert.equal(mailTo("u2@example.com").length, 1);
  });

  await t("the rule's lock: a run while one is going does nothing", async () => {
    const lock = `neo:ops:job:lock:${runner.jobName(trialRule)}`;
    g.__kvStore.set(lock, "run_someone_else");
    const before = (await runsOf(trialRule)).length;
    const r = await ruleCall("user_writer", R.run.POST, trialRule);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "already_running");
    assert.equal((await runsOf(trialRule)).length, before);
    g.__kvStore.delete(lock);
  });

  console.log("the dispatcher");
  await t("an active rule runs when due, on the dispatcher's tick, through the job runner; then waits for its next time", async () => {
    assert.equal((await ruleCall("user_writer", R.status.POST, trialRule, { status: "active" })).status, 200);
    const st = await store.getState(trialRule);
    assert.ok(st.nextRunAt && st.nextRunAt > Date.now() && st.nextRunAt - Date.now() <= HOUR);
    // Nothing is due yet.
    const d0 = await dispatch();
    assert.equal(d0.status, 200, JSON.stringify(d0.body));
    assert.ok(!d0.body.results.some((x: { ruleId: string }) => x.ruleId === trialRule));
    tick(HOUR);
    const d1 = await dispatch();
    const mine = d1.body.results.find((x: { ruleId: string }) => x.ruleId === trialRule);
    assert.equal(mine?.outcome, "ok", JSON.stringify(d1.body));
    const runs = await runsOf(trialRule);
    assert.equal(runs[0].trigger, "automation");
    assert.equal(runs[0].actor, "automation-dispatch");
    const after = await store.getState(trialRule);
    assert.ok(after.nextRunAt! > Date.now());
    const d2 = await dispatch();
    assert.ok(!d2.body.results.some((x: { ruleId: string }) => x.ruleId === trialRule), "not due again on the next tick");
    const own = await jobs.listRuns(runner.DISPATCH_JOB, 5);
    assert.ok(own.length >= 3, "the dispatcher's own ticks are recorded");
  });

  await t("pausing stops runs; resuming starts from now", async () => {
    assert.equal((await ruleCall("user_writer", R.status.POST, trialRule, { status: "paused" })).status, 200);
    const before = (await runsOf(trialRule)).length;
    await jump(3 * HOUR);
    await dispatch();
    assert.equal((await runsOf(trialRule)).length, before);
    assert.equal((await store.getState(trialRule)).nextRunAt, null);
    const { items } = await audit.listAdminAudit({ target: trialRule, action: "automation.pause" });
    assert.deepEqual([items[0].before, items[0].after], [{ status: "active" }, { status: "paused" }]);
  });

  await t("quiet hours hold a due sending rule until they end", async () => {
    const now = new Date(Date.now());
    const h = now.getUTCHours();
    const start = `${String(h).padStart(2, "0")}:00`;
    const end = `${String((h + 2) % 24).padStart(2, "0")}:00`;
    const id = (await create("user_writer", { name: "Quiet", status: "active", schedule: { type: "every", unit: "minutes", n: 5 }, condition: { kind: "trial_ends_in", days: [3] }, action: { kind: "reminder", channels: { email: false, inApp: true } }, options: { quietHours: { start, end } } })).id;
    tick(6 * 60_000);
    const d = await dispatch();
    assert.equal(d.body.results.find((x: { ruleId: string }) => x.ruleId === id)?.outcome, "held");
    const st = await store.getState(id);
    assert.ok(st.heldSlot != null && st.nextRunAt! > Date.now());
    assert.equal((await runsOf(id)).length, 0);
    await ruleCall("user_writer", R.status.POST, id, { status: "paused" });
  });

  console.log("replacing a cron");
  await t("while 'Trial expiry' is active its cron stands down; the rule runs the same job; paused, the cron runs again", async () => {
    // u4: a plan in Clerk that ran out yesterday; u5 likewise.
    g.__users.user_u4.plan = "pro";
    g.__users.user_u4.metadata = { planExpiresAt: Date.now() - DAY };
    await dispatch(); // a tick marks the cron as replaced
    const replaced = await call(null, R.downgrade.GET, { headers: cronHeaders });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.skipped, "replaced_by_automation");
    assert.equal(g.__users.user_u4.plan, "pro", "the replaced cron did not run");
    const r = await ruleCall("user_owner", R.run.POST, "builtin_trial_expiry");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(g.__users.user_u4.plan, "free", "the rule ran the job");
    const jobRuns = await jobs.listRuns("downgrade-expired-plans", 5);
    assert.equal(jobRuns[0].trigger, "automation");
    assert.equal(jobRuns[0].actor, runner.jobName("builtin_trial_expiry"));

    g.__users.user_u5.plan = "pro";
    g.__users.user_u5.metadata = { planExpiresAt: Date.now() - DAY };
    assert.equal((await ruleCall("user_owner", R.status.POST, "builtin_trial_expiry", { status: "paused" })).status, 200);
    const back = await call(null, R.downgrade.GET, { headers: cronHeaders });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.notEqual(back.body.skipped, "replaced_by_automation");
    assert.equal(g.__users.user_u5.plan, "free", "the cron has its job back");
    assert.equal((await ruleCall("user_owner", R.status.POST, "builtin_trial_expiry", { status: "active" })).status, 200);
  });

  await t("if the dispatcher stops, the replaced cron gets its job back by itself", async () => {
    await dispatch();
    assert.equal((await call(null, R.downgrade.GET, { headers: cronHeaders })).body.skipped, "replaced_by_automation");
    // No tick for longer than the mark lasts.
    const key = jobs.jobReplacedKey("downgrade-expired-plans");
    assert.ok(g.__kvStore.has(key));
    tick((runner.REPLACED_TTL_S + 60) * 1000);
    assert.notEqual((await call(null, R.downgrade.GET, { headers: cronHeaders })).body.skipped, "replaced_by_automation");
  });

  console.log("usage conditions and limits");
  await t("'free meeting cap at 80%' finds the Free accounts at 80% (not the owner, not 60%), at most N a run, the rest next run", async () => {
    const id = (await create("user_writer", { name: "Meetings 80%", condition: { kind: "meeting_cap", pct: 80 }, action: { kind: "reminder", channels: { email: true, inApp: true } }, options: { maxPerRun: 2 } })).id;
    const p = await ruleCall("user_writer", R.preview.POST, id);
    assert.deepEqual(p.body.preview.items.map((i: { label: string }) => i.label).sort(), ["m1@example.com", "m2@example.com", "m3@example.com"]);
    assert.equal(p.body.preview.counts.deferred, 1);
    const r1 = await ruleCall("user_writer", R.run.POST, id);
    assert.deepEqual([r1.body.detail.counts.done, r1.body.detail.counts.deferred], [2, 1], JSON.stringify(r1.body.detail));
    const r2 = await ruleCall("user_writer", R.run.POST, id);
    assert.deepEqual([r2.body.detail.counts.done, r2.body.detail.counts.already], [1, 2]);
    for (const m of ["m1", "m2", "m3"]) assert.equal(mailTo(`${m}@example.com`).length, 1, m);
    assert.equal(mailTo("m4@example.com").length, 0);
    // The usage reminder's own claim holds too: the event-driven path would not send it again.
    assert.equal(await comms.meetingCapReminder("user_m1", 4, 5, "free", { rule: { enabled: true, thresholds: [80], channels: { email: true, inApp: true } } }), "already_sent");
  });

  await t("'recording hours at 90%' reads this month's usage against the account's plan", async () => {
    const month = new Date(Date.now()).toISOString().slice(0, 7);
    // u3 is on Pro (50 h): 46 h is 92%; u6 is Free (no recording hours).
    await kv.hset("neo:rec-usage:user_u3", { [month]: 46 * 3600 });
    await kv.hset("neo:rec-usage:user_u6", { [month]: 46 * 3600 });
    const id = (await create("user_writer", { name: "Recording 90%", condition: { kind: "recording_hours", pct: 90 }, action: { kind: "reminder", channels: { email: true, inApp: false } } })).id;
    const r = await ruleCall("user_writer", R.run.POST, id);
    assert.equal(r.body.detail.counts.targets, 1, JSON.stringify(r.body.detail));
    assert.equal(r.body.detail.items[0].label, "user_u3");
    assert.equal(r.body.detail.counts.done, 1, JSON.stringify(r.body.detail));
    assert.equal(mailTo("u3@example.com").length, 1);
  });

  await t("a per-person cooldown holds a second notice from the same rule", async () => {
    await fresh("user_owner");
    assert.equal((await call("user_owner", R.plan.PATCH, { method: "PATCH", params: { id: "business" }, body: { terms: { trialDays: 3 } } })).status, 200);
    assert.equal((await call("user_owner", R.sub.POST, { method: "POST", params: { userId: "user_u5" }, body: { action: "assign", planId: "business", cycle: "monthly", trial: true } })).status, 200);
    const id = (await create("user_writer", { name: "Trial 3 and 1", condition: { kind: "trial_ends_in", days: [3, 1] }, action: { kind: "reminder", channels: { email: true, inApp: false } }, options: { cooldownHours: 72 } })).id;
    const u5 = (d: { items: { label: string; outcome: string }[] }) => d.items.find((i) => i.label === "u5@example.com")?.outcome;
    const first = await ruleCall("user_writer", R.run.POST, id);
    assert.equal(u5(first.body.detail), "done", JSON.stringify(first.body.detail));
    await jump(2 * DAY + HOUR); // the 1-day notice is due, inside the 72-hour cooldown
    const r = await ruleCall("user_writer", R.run.POST, id);
    assert.equal(u5(r.body.detail), "cooling", JSON.stringify(r.body.detail));
    assert.equal(mailTo("u5@example.com").length, 1);
  });

  await t("'payment failed' follows up through billing reminders, with billing's own claims: its cron does not send it again", async () => {
    const { createPendingPayment, generateNonce } = await import("../billingStore");
    const nonce = generateNonce();
    await createPendingPayment({ nonce, userId: "user_m4", plan: "pro", billingCycle: "monthly", paymentRef: `ESP-${nonce.slice(0, 8)}` });
    const f = await call(null, R.espeesFail.GET, { query: `?nonce=${nonce}` });
    assert.equal(f.status, 303, JSON.stringify(f.body));
    await jump(DAY + HOUR);
    const p = await ruleCall("user_owner", R.preview.POST, "builtin_failed_payment");
    assert.deepEqual(p.body.preview.items.map((i: { label: string; outcome: string }) => [i.label, i.outcome]), [["m4@example.com", "would_do"]], JSON.stringify(p.body));
    const r = await ruleCall("user_owner", R.run.POST, "builtin_failed_payment");
    assert.equal(r.body.detail.counts.done, 1, JSON.stringify(r.body.detail));
    assert.equal(mailTo("m4@example.com").length, 1);
    // Billing's own daily cron, with the same reminder switched on there: already sent.
    const { saveReminderRules, DEFAULT_RULES } = await import("../finance/reminders");
    await saveReminderRules({ ...DEFAULT_RULES, failed: { enabled: true, afterDays: [1] } });
    const cron = await call(null, R.billingCron.GET, { headers: cronHeaders });
    assert.equal(cron.status, 200, JSON.stringify(cron.body));
    assert.ok(cron.body.alreadySent >= 1, JSON.stringify(cron.body));
    assert.equal(mailTo("m4@example.com").length, 1, "one follow-up, not two");
    await saveReminderRules(DEFAULT_RULES);
  });

  console.log("failures and alerts");
  await t("a rule that fails its threshold in a row is failing and raises one ops alert; a good run clears both", async () => {
    const id = (await create("user_owner", { name: "Monday report", schedule: { type: "cron", expr: "0 7 * * 1" }, action: { kind: "report", report: { days: 7, tables: ["summary"], to: "owner" } }, options: { failureThreshold: 2 } })).id;
    mailFails = 10;
    const r1 = await ruleCall("user_owner", R.run.POST, id);
    assert.equal(r1.body.run.outcome, "failed");
    assert.equal((await store.getState(id)).failing, false, "one failure is not yet failing");
    await ruleCall("user_owner", R.run.POST, id);
    const st = await store.getState(id);
    assert.equal(st.failing, true);
    assert.match(String(st.lastError), /report email not sent/);
    const list = await call("user_owner", R.rules.GET);
    assert.equal(list.body.rules.find((r: { id: string }) => r.id === id).health, "failing");
    const open = (await alerts.listAlerts({ status: "active" })).filter((a) => a.subject === id);
    assert.equal(open.length, 1, "one alert");
    assert.match(open[0].title, /Monday report/);
    await ruleCall("user_owner", R.run.POST, id); // a third failure: still one alert
    assert.equal((await alerts.listAlerts({ status: "active" })).filter((a) => a.subject === id).length, 1);
    mailFails = 0;
    const ok = await ruleCall("user_owner", R.run.POST, id);
    assert.equal(ok.body.run.outcome, "ok", JSON.stringify(ok.body));
    assert.equal((await store.getState(id)).failing, false);
    assert.equal((await alerts.listAlerts({ status: "active" })).filter((a) => a.subject === id).length, 0);
    const last = mail[mail.length - 1];
    assert.deepEqual(last.to, ["owner@example.com"]);
    assert.ok(last.attachments?.[0].filename.endsWith(".csv"));
    // Same period: not sent again.
    assert.equal((await ruleCall("user_owner", R.run.POST, id)).body.detail.counts.already, 1);
  });

  console.log("step-up and audit");
  await t("a rule that would reach more than the threshold asks for a fresh code to create, resume or run", async () => {
    for (let i = 0; i < 520; i++) g.__users[`user_bulk${i}`] = { emails: [`bulk${i}@example.com`] };
    stale();
    const body = {
      name: "Everyone, weekly",
      timezone: "UTC",
      schedule: { type: "cron", expr: "0 10 * * 3" },
      action: { kind: "announcement", channels: { email: false, inApp: true }, message: { title: "Hello", body: "News", severity: "info", url: "" }, audience: { kind: "everyone" } },
    };
    const refused = await call("user_writer", R.rules.POST, { method: "POST", body });
    assert.equal(refused.body.error, "step_up_required", JSON.stringify(refused.body));
    assert.match(String(refused.body.reason), /reach \d+ people/);
    await fresh("user_writer");
    const ok = await call("user_writer", R.rules.POST, { method: "POST", body });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const id = ok.body.rule.id;
    stale();
    assert.equal((await ruleCall("user_writer", R.status.POST, id, { status: "active" })).body.error, "step_up_required");
    assert.equal((await ruleCall("user_writer", R.run.POST, id)).body.error, "step_up_required");
    // A small audience needs no fresh code.
    const small = await call("user_writer", R.rules.POST, { method: "POST", body: { ...body, name: "Two people", action: { ...body.action, audience: { kind: "users", users: ["u1@example.com", "u2@example.com"] } } } });
    assert.equal(small.status, 201, JSON.stringify(small.body));
    for (let i = 0; i < 520; i++) delete g.__users[`user_bulk${i}`];
  });

  await t("every create, edit, pause, resume, run and delete is audited with before and after", async () => {
    await fresh("user_writer");
    const id = (await create("user_writer", { name: "Nightly sweep", schedule: { type: "cron", expr: "15 3 * * *" }, action: { kind: "maintenance", jobs: ["meeting-sweep"] } })).id;
    const e = await call("user_writer", R.rule.PATCH, { method: "PATCH", params: { id }, body: { schedule: { type: "cron", expr: "45 3 * * *" }, timezone: "Africa/Lagos" } });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    await ruleCall("user_writer", R.status.POST, id, { status: "active" });
    await ruleCall("user_writer", R.status.POST, id, { status: "paused" });
    await ruleCall("user_writer", R.run.POST, id);
    assert.equal((await call("user_writer", R.rule.DELETE, { method: "DELETE", params: { id } })).status, 200);
    const { items } = await audit.listAdminAudit({ target: id });
    assert.deepEqual(
      items.map((i) => i.action).reverse(),
      ["automation.create", "automation.update", "automation.resume", "automation.pause", "automation.run", "automation.delete"],
    );
    const upd = items.find((i) => i.action === "automation.update")!;
    assert.deepEqual(upd.before, { schedule: { type: "cron", expr: "15 3 * * *" }, timezone: "UTC" });
    assert.deepEqual(upd.after, { schedule: { type: "cron", expr: "45 3 * * *" }, timezone: "Africa/Lagos" });
    assert.ok(items.every((i) => i.actorEmail === "writer@example.com"));
    assert.equal((await getRule(id)).error, "not_found");
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
