// Run: npx tsx src/lib/__tests__/adminOps.smoke.ts
//
// System operations (admin phase 9), driven through the real /api/admin/ops
// and /api/cron routes with Clerk, KV, R2 and LiveKit stood in for
// (./apiV1-stubs) and every provider's HTTP API answered by a fake fetch:
// probe statuses and failures (and that no secret reaches a response), the
// job runner's lock and run history, retry only where it is safe, alert
// de-duplication and cooldown, incidents and maintenance through the site
// surface, snapshot checksums catching corruption, and restore — owner only,
// step-up, preview diff, pre-restore snapshot and undo — against the
// in-memory KV only. Never production.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

process.env.CLERK_SECRET_KEY = "sk_test_ops_smoke_secret";
process.env.PLATFORM_OWNER_EMAILS = "owner@example.com";
process.env.CRON_SECRET = "cron-secret-for-ops-smoke";
process.env.LIVEKIT_API_KEY = "lk_key_ops_smoke";
process.env.LIVEKIT_API_SECRET = "lk_secret_ops_smoke_value";
process.env.NEXT_PUBLIC_LIVEKIT_URL = "wss://livekit.test";
process.env.AMS_REST_BASE = "https://ams.test/rest/v2";
process.env.NEXT_PUBLIC_TRANSLATION_SSE = "https://tw.test";
process.env.DEEPGRAM_API_KEY = "dg_secret_key_ops_smoke";
process.env.DEEPL_API_KEY = "deepl-secret-ops-smoke:fx";
process.env.RESEND_API_KEY = "re_secret_ops_smoke";
process.env.S3_ENDPOINT = "https://r2.test";
process.env.S3_BUCKET = "bucket";
process.env.S3_ACCESS_KEY = "r2_access_ops_smoke";
process.env.S3_SECRET_KEY = "r2_secret_ops_smoke";
delete process.env.ASSEMBLYAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.ESPEES_API_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.ADMIN_EMAILS;

type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; role?: string; emails?: string[]; metadata?: Record<string, unknown> }>;
  __who?: string;
  __kvStore: Map<string, unknown>;
  __kvTtl?: boolean;
  __r2Bytes?: Map<string, Uint8Array>;
  __r2Down?: boolean;
  __livekitDown?: boolean;
  __rooms?: Array<{ name: string; numParticipants: number }>;
};
const g = globalThis as Stubbed;
g.__kvTtl = true;
g.__rooms = [{ name: "room-a", numParticipants: 3 }];
g.__users = {
  user_owner: { emails: ["owner@example.com"] },
  user_super: { emails: ["super@example.com"] },
  user_ops: { emails: ["ops@example.com"] },
  user_analyst: { emails: ["analyst@example.com"] },
  user_plain: { emails: ["plain@example.com"] },
  user_expired: { emails: ["expired@example.com"], plan: "pro", metadata: { planExpiresAt: Date.parse("2020-01-01T00:00:00Z") } },
};

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};
const MIN = 60_000;

/* ----------------------------- provider fakes ----------------------------- */

const fake = {
  deepgram: "ok" as "ok" | "401" | "500leak",
  amsDown: false,
  translationErrors: 0,
  emails: [] as Array<{ to: string[]; bcc?: string[]; subject: string }>,
  hits: [] as string[],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  fake.hits.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
  const host = url.host;
  if (host === "api.deepgram.com") {
    if (url.pathname.endsWith("/balances")) return json({ balances: [{ amount: 12.5 }] });
    if (fake.deepgram === "401") return json({ err: "INVALID_AUTH" }, 401);
    if (fake.deepgram === "500leak") return new Response(`upstream rejected token ${process.env.DEEPGRAM_API_KEY}`, { status: 500 });
    return json({ projects: [{ project_id: "proj_1" }] });
  }
  if (host === "api-free.deepl.com") return json({ character_count: 1000, character_limit: 500000 });
  if (host === "ams.test") {
    if (fake.amsDown) return new Response("bad gateway", { status: 502 });
    if (url.pathname.endsWith("/active-live-stream-count")) return json({ number: 2 });
    return json({ status: "broadcasting" });
  }
  if (host === "tw.test") {
    if (url.pathname === "/healthz") return new Response("ok\n");
    return json({ ok: true, rooms: [{ room: "neoconf", charsTotal: 900, errorsTotal: fake.translationErrors, errorsWindow: fake.translationErrors, lastErrorAt: null, lastErrorMessage: fake.translationErrors ? "DeepL 429" : null }] });
  }
  if (host === "api.resend.com") {
    if (url.pathname === "/domains") return json({ data: [{ name: "neoconference.app", status: "verified" }] });
    if (url.pathname === "/emails") {
      fake.emails.push(JSON.parse(String(init?.body)));
      return json({ id: `email_${fake.emails.length}` });
    }
  }
  throw new Error(`unexpected fetch ${url}`);
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
  const store = await import("../admin/store");
  const jobs = await import("../ops/jobs");
  const media = await import("../ops/media");
  const surface = await import("../ops/siteSurface");
  const backup = await import("../ops/backup");
  const notif = await import("../notificationStore");
  const { kv } = await import("../kv");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    health: await import("../../app/api/admin/ops/health/route"),
    jobs: await import("../../app/api/admin/ops/jobs/route"),
    job: await import("../../app/api/admin/ops/jobs/[name]/route"),
    media: await import("../../app/api/admin/ops/media/route"),
    alerts: await import("../../app/api/admin/ops/alerts/route"),
    rules: await import("../../app/api/admin/ops/alerts/rules/route"),
    alert: await import("../../app/api/admin/ops/alerts/[id]/route"),
    incidents: await import("../../app/api/admin/ops/incidents/route"),
    incident: await import("../../app/api/admin/ops/incidents/[id]/route"),
    maint: await import("../../app/api/admin/ops/maintenance/route"),
    maintOne: await import("../../app/api/admin/ops/maintenance/[id]/route"),
    backups: await import("../../app/api/admin/ops/backups/route"),
    verifyBackup: await import("../../app/api/admin/ops/backups/[id]/verify/route"),
    restore: await import("../../app/api/admin/ops/backups/restore/route"),
    cronHealth: await import("../../app/api/cron/ops-health/route"),
    cronBackup: await import("../../app/api/cron/ops-backup/route"),
    cronDowngrade: await import("../../app/api/cron/downgrade-expired-plans/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  type Body = Record<string, unknown> & { error?: string; message?: string };
  async function call<P = Record<string, string>>(
    who: string,
    handler: (req: never, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; params?: P; query?: string } = {},
  ) {
    g.__who = who;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/admin/ops/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }) as never,
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m) jar[who] = decodeURIComponent(m[1]);
    const text = await res.text();
    let body: Body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body, text };
  }
  const { NextRequest } = await import("next/server");
  async function cron(handler: (req: never) => Promise<Response>, headers: Record<string, string> = { authorization: `Bearer ${process.env.CRON_SECRET}` }) {
    const res = await handler(new NextRequest("https://www.neoconference.app/api/cron/x", { headers }) as never);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Body, run: res.headers.get("x-neo-job-run") };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enroll(who: string) {
    const e = await call(who, R.enroll.POST as never, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    const c = await call(who, R.confirm.POST as never, { method: "POST", body: { code: code(who) } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  async function stepUp(who: string) {
    tick();
    const v = await call(who, R.verify.POST as never, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  const auditOf = async (action: string) => (await audit.listAdminAudit({ action })).items;
  const SECRET_VALUES = [
    process.env.CLERK_SECRET_KEY!,
    process.env.CRON_SECRET!,
    process.env.LIVEKIT_API_SECRET!,
    process.env.LIVEKIT_API_KEY!,
    process.env.DEEPGRAM_API_KEY!,
    process.env.DEEPL_API_KEY!,
    process.env.RESEND_API_KEY!,
    process.env.S3_ACCESS_KEY!,
    process.env.S3_SECRET_KEY!,
  ];
  const noSecrets = (text: string, where: string) => {
    for (const s of SECRET_VALUES) assert.ok(!text.includes(s), `${where} carries a secret (${s.slice(0, 6)}…)`);
  };

  // Administrators: the owner; a Super admin (everything, but not the
  // owner); an ops role (ops:read + ops:write); the read-only Analyst.
  const now = Date.now();
  await store.saveRole({ id: "custom_ops", name: "Ops", description: "", permissions: ["ops:read", "ops:write"], builtIn: false });
  for (const [userId, email, roleId] of [
    ["user_super", "super@example.com", "super_admin"],
    ["user_ops", "ops@example.com", "custom_ops"],
    ["user_analyst", "analyst@example.com", "analyst"],
  ]) {
    await store.saveMember({ userId, email, name: email, roleId, status: "active", appointedBy: "user_owner", appointedAt: now, updatedAt: now });
  }
  for (const who of ["user_owner", "user_super", "user_ops", "user_analyst"]) await enroll(who);

  console.log("permissions");
  await t("ops:read sees health; changing anything needs ops:write; a non-admin gets nothing", async () => {
    assert.equal((await call("user_analyst", R.health.GET as never)).status, 200);
    const run = await call("user_analyst", R.job.POST as never, { method: "POST", params: { name: "ops-health" }, body: { action: "run" } });
    assert.equal(run.body.error, "forbidden");
    assert.equal(run.body.permission, "ops:write");
    assert.equal((await call("user_analyst", R.rules.POST as never, { method: "POST", body: { kind: "service_down", threshold: 5, cooldownMinutes: 5 } })).body.error, "forbidden");
    assert.equal((await call("user_analyst", R.backups.POST as never, { method: "POST" })).body.error, "forbidden");
    assert.equal((await call("user_plain", R.health.GET as never)).body.error, "not_admin");
    assert.equal((await call("user_plain", R.jobs.GET as never)).body.error, "not_admin");
  });

  console.log("service health");
  await t("every probe answers up / degraded / down / not configured, with latency and detail, and no secret", async () => {
    const r = await call("user_analyst", R.health.POST as never, { method: "POST", body: {} });
    assert.equal(r.status, 200, r.text);
    const by = Object.fromEntries((r.body.results as Array<{ id: string; status: string; detail: string; latencyMs: number | null }>).map((x) => [x.id, x]));
    for (const id of ["kv", "r2", "livekit", "ams", "translation", "deepgram", "deepl", "resend", "clerk"]) assert.equal(by[id].status, "up", `${id}: ${by[id].detail}`);
    for (const id of ["assemblyai", "stripe", "espees", "firebase"]) {
      assert.equal(by[id].status, "not_configured", id);
      assert.equal(by[id].latencyMs, null);
      assert.match(by[id].detail, /^needs /);
    }
    assert.match(by.livekit.detail, /1 active room, 3 participants/);
    assert.match(by.ams.detail, /2 live streams; neoconf-video broadcasting/);
    assert.match(by.deepgram.detail, /balance 12\.50/);
    assert.match(by.deepl.detail, /1,000 of 500,000/);
    noSecrets(r.text, "POST health");
    // Read-only: only GETs went to providers (Resend's email endpoint is not touched by a probe).
    assert.ok(!fake.hits.some((h) => h.startsWith("POST ")), fake.hits.filter((h) => h.startsWith("POST ")).join(", "));
    const [entry] = await auditOf("ops.health.check");
    assert.equal(entry.actorEmail, "analyst@example.com");
  });

  await t("failures read as down, with the last failure kept after recovery; a provider's echoed key is redacted", async () => {
    fake.deepgram = "500leak";
    fake.amsDown = true;
    g.__livekitDown = true;
    g.__r2Down = true;
    fake.translationErrors = 4;
    tick();
    const r = await call("user_analyst", R.health.POST as never, { method: "POST", body: {} });
    const by = Object.fromEntries((r.body.results as Array<{ id: string; status: string; detail: string; lastFailure: string | null }>).map((x) => [x.id, x]));
    assert.equal(by.deepgram.status, "down");
    assert.match(by.deepgram.detail, /\[DEEPGRAM_API_KEY\]/);
    assert.equal(by.ams.status, "down");
    assert.equal(by.livekit.status, "down");
    assert.match(by.livekit.detail, /unavailable/);
    assert.equal(by.r2.status, "down");
    assert.equal(by.translation.status, "degraded");
    noSecrets(r.text, "failing health");
    fake.deepgram = "ok";
    fake.amsDown = false;
    g.__livekitDown = false;
    g.__r2Down = false;
    fake.translationErrors = 0;
    tick();
    await call("user_analyst", R.health.POST as never, { method: "POST", body: {} });
    const h = await call("user_analyst", R.health.GET as never);
    const latest = h.body.latest as Record<string, { status: string; lastFailureAt: number | null; lastFailure: string | null }>;
    assert.equal(latest.ams.status, "up");
    assert.ok(latest.ams.lastFailureAt, "last failure remembered");
    assert.match(String(latest.ams.lastFailure), /HTTP 502/);
    const hist = (h.body.history as Record<string, Array<{ s: string }>>).ams;
    assert.deepEqual(hist.slice(0, 3).map((p) => p.s), ["up", "down", "up"]);
    noSecrets(h.text, "GET health");
  });

  console.log("job runner");
  await t("a cron run is locked: while the job runs, a second request gets 409 and changes nothing", async () => {
    assert.ok(await jobs.acquireJobLock("downgrade-expired-plans", "run_elsewhere"));
    const busy = await cron(R.cronDowngrade.GET as never);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.skipped, "already_running");
    assert.equal(g.__users.user_expired.plan, "pro", "the handler did not run");
    await jobs.releaseJobLock("downgrade-expired-plans", "run_elsewhere");
    const ok = await cron(R.cronDowngrade.GET as never);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.downgraded, 1, "same behaviour as before: the expired plan is downgraded");
    assert.equal(g.__users.user_expired.plan, "free");
    const run = await jobs.getRun(ok.run!);
    assert.equal(run?.outcome, "ok");
    assert.equal(run?.trigger, "schedule");
    assert.equal(run?.actor, "vercel-cron");
    assert.ok(typeof run?.durationMs === "number");
    assert.match(String(run?.summary), /"downgraded":1/);
  });

  await t("two runs started together: exactly one runs", async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = () => jobs.runJob("smoke-slow", async () => { entered++; await gate; return { ok: true }; }, { trigger: "manual" });
    const a = slow();
    await new Promise((r) => setTimeout(r, 10));
    const b = await slow();
    assert.equal(b.status, "locked");
    release();
    const ra = await a;
    assert.equal(ra.status, "ran");
    assert.equal(entered, 1);
    assert.equal((await slow()).status, "ran", "the lock is released after the run");
  });

  await t("unauthenticated cron calls are refused as before and not recorded; Vercel's refused call is recorded as a failure", async () => {
    const before = (await jobs.listRuns("downgrade-expired-plans")).length;
    const anon = await cron(R.cronDowngrade.GET as never, {});
    assert.equal(anon.status, 401);
    assert.equal((await jobs.listRuns("downgrade-expired-plans")).length, before);
    const vercel = await cron(R.cronDowngrade.GET as never, { "user-agent": "vercel-cron/1.0" });
    assert.equal(vercel.status, 401);
    const [last] = await jobs.listRuns("downgrade-expired-plans", 1);
    assert.equal(last.outcome, "failed");
    assert.match(String(last.error), /CRON_SECRET/);
  });

  await t("run history lists each job's runs, newest first, with who started them", async () => {
    const r = await call("user_analyst", R.jobs.GET as never);
    assert.equal(r.status, 200, r.text);
    const list = r.body.jobs as Array<{ name: string; retrySafe: boolean; runs: Array<{ outcome: string }> }>;
    const dg = list.find((j) => j.name === "downgrade-expired-plans")!;
    assert.deepEqual(dg.runs.map((x) => x.outcome).slice(0, 2), ["failed", "ok"]);
    assert.equal(list.find((j) => j.name === "redemption-digest")!.retrySafe, false);
    assert.equal(list.find((j) => j.name === "comms")!.retrySafe, true, "announcement delivery claims each recipient before sending");
    assert.equal(list.find((j) => j.name === "billing-reminders")!.retrySafe, true, "each reminder is sent at most once");
    assert.deepEqual((r.body.queues as { sends: { open: number } }).sends.open, 0);
    assert.ok(list.some((j) => j.name === "smoke-slow"), "unregistered jobs that ran are listed too");
    noSecrets(r.text, "GET jobs");
  });

  await t("retry only where safe: the email digest is refused; a failed snapshot is retried and linked", async () => {
    const digest = await call("user_ops", R.job.POST as never, { method: "POST", params: { name: "redemption-digest" }, body: { action: "run" } });
    assert.equal(digest.status, 409);
    assert.equal(digest.body.error, "not_retry_safe");
    const [denied] = await auditOf("ops.job.run");
    assert.equal(denied.outcome, "denied");
    assert.equal(denied.targetId, "redemption-digest");

    g.__r2Down = true;
    const failed = await call("user_ops", R.job.POST as never, { method: "POST", params: { name: "ops-backup" }, body: { action: "run" } });
    assert.equal(failed.status, 200, failed.text);
    const failedRun = failed.body.run as { id: string; outcome: string; error: string; trigger: string; actor: string };
    assert.equal(failedRun.outcome, "failed");
    assert.equal(failedRun.trigger, "manual");
    assert.equal(failedRun.actor, "ops@example.com");
    assert.match(failedRun.error, /R2 unavailable/);
    g.__r2Down = false;
    const okRun = await call("user_ops", R.job.POST as never, { method: "POST", params: { name: "ops-backup" }, body: { action: "run" } });
    const okId = (okRun.body.run as { id: string }).id;
    assert.equal((await call("user_ops", R.job.POST as never, { method: "POST", params: { name: "ops-backup" }, body: { action: "retry", runId: okId } })).body.error, "not_failed");
    const retried = await call("user_ops", R.job.POST as never, { method: "POST", params: { name: "ops-backup" }, body: { action: "retry", runId: failedRun.id } });
    const rr = retried.body.run as { outcome: string; retryOf: string; trigger: string };
    assert.equal(rr.outcome, "ok", retried.text);
    assert.equal(rr.trigger, "retry");
    assert.equal(rr.retryOf, failedRun.id);
    const [a] = await auditOf("ops.job.retry");
    assert.equal(a.outcome, "ok");
    assert.equal((a.after as { retryOf: string }).retryOf, failedRun.id);
    const failedList = (await call("user_analyst", R.jobs.GET as never)).body.failed as Array<{ id: string }>;
    assert.ok(failedList.some((f) => f.id === failedRun.id));
  });

  console.log("alerts");
  await t("down for N minutes opens one alert and notifies once; repeats only count up", async () => {
    fake.deepgram = "401";
    fake.emails.length = 0;
    tick(5 * MIN);
    let c = await cron(R.cronHealth.GET as never);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    type A = { subject: string; ruleId: string; notified: boolean; occurrences: number; notifyResult: { recipients: number; emailed: number; inApp: number } };
    let active = (await call("user_analyst", R.alerts.GET as never, { query: "?status=active" })).body.alerts as A[];
    assert.ok(!active.some((a) => a.subject === "deepgram"), "not yet: down for less than 10 minutes");
    tick(11 * MIN);
    c = await cron(R.cronHealth.GET as never);
    active = (await call("user_analyst", R.alerts.GET as never, { query: "?status=active" })).body.alerts as A[];
    const dg = active.filter((a) => a.subject === "deepgram" && a.ruleId === "default_down");
    assert.equal(dg.length, 1);
    assert.equal(dg[0].notified, true);
    // The owner and the three administrators whose roles hold ops:read.
    assert.equal(dg[0].notifyResult.recipients, 4);
    assert.equal(dg[0].notifyResult.inApp, 4);
    assert.equal(fake.emails.filter((e) => /Deepgram/.test(e.subject)).length, 1);
    const sent = fake.emails.find((e) => /Deepgram/.test(e.subject))!;
    assert.deepEqual([...sent.to, ...(sent.bcc ?? [])].sort(), ["analyst@example.com", "ops@example.com", "owner@example.com", "super@example.com"]);
    assert.equal((await notif.listNotifications("user_owner")).items[0].url, "/admin/ops/alerts");
    assert.equal((await notif.listNotifications("user_plain")).items.length, 0);
    tick(5 * MIN);
    await cron(R.cronHealth.GET as never);
    active = (await call("user_analyst", R.alerts.GET as never, { query: "?status=active" })).body.alerts as typeof active;
    const again = active.filter((a) => a.subject === "deepgram" && a.ruleId === "default_down");
    assert.equal(again.length, 1, "de-duplicated");
    assert.equal(again[0].occurrences, 2);
    assert.equal(fake.emails.filter((e) => /Deepgram/.test(e.subject)).length, 1, "no second email");
  });

  await t("cooldown: resolved and down again within the hour opens a new alert but notifies nobody; after it, notifies", async () => {
    const list = async () => (await call("user_analyst", R.alerts.GET as never)).body.alerts as Array<{ id: string; subject: string; ruleId: string; status: string; notified: boolean; suppressed?: string }>;
    const open = (await list()).find((a) => a.subject === "deepgram" && a.ruleId === "default_down" && a.status !== "resolved")!;
    assert.equal((await call("user_analyst", R.alert.PATCH as never, { method: "PATCH", params: { id: open.id }, body: { action: "resolve" } })).body.error, "forbidden");
    const ack = await call("user_ops", R.alert.PATCH as never, { method: "PATCH", params: { id: open.id }, body: { action: "acknowledge" } });
    assert.equal((ack.body.alert as { status: string }).status, "acknowledged");
    const res = await call("user_ops", R.alert.PATCH as never, { method: "PATCH", params: { id: open.id }, body: { action: "resolve", note: "key rotated" } });
    assert.equal((res.body.alert as { status: string }).status, "resolved");
    tick(5 * MIN);
    await cron(R.cronHealth.GET as never);
    const second = (await list()).find((a) => a.subject === "deepgram" && a.ruleId === "default_down" && a.status === "open")!;
    assert.ok(second && second.id !== open.id);
    assert.equal(second.notified, false);
    assert.equal(second.suppressed, "cooldown");
    assert.equal(fake.emails.filter((e) => /Deepgram/.test(e.subject)).length, 1);
    await call("user_ops", R.alert.PATCH as never, { method: "PATCH", params: { id: second.id }, body: { action: "resolve" } });
    tick(61 * MIN);
    await cron(R.cronHealth.GET as never);
    const third = (await list()).find((a) => a.subject === "deepgram" && a.ruleId === "default_down" && a.status === "open")!;
    assert.equal(third.notified, true);
    assert.equal(fake.emails.filter((e) => /Deepgram/.test(e.subject)).length, 2);
    // Down for over an hour, past the degraded rule's 30 minutes: still only the down rule speaks.
    assert.ok(!(await list()).some((a) => a.subject === "deepgram" && a.ruleId === "default_degraded"), "a down service is not also reported as degraded");
    // Recovery resolves it by itself.
    fake.deepgram = "ok";
    tick(5 * MIN);
    await cron(R.cronHealth.GET as never);
    const after = (await list()).find((a) => a.id === third.id)!;
    assert.equal(after.status, "resolved");
    const [a1] = await auditOf("ops.alert.acknowledge");
    assert.equal(a1.actorEmail, "ops@example.com");
  });

  await t("rules: created and edited with ops:write and audited; job and payment failures raise alerts", async () => {
    const bad = await call("user_ops", R.rules.POST as never, { method: "POST", body: { kind: "service_down", target: "nope", threshold: 1, cooldownMinutes: 1 } });
    assert.equal(bad.body.error, "bad_target");
    const made = await call("user_ops", R.rules.POST as never, { method: "POST", body: { kind: "payment_failures", threshold: 2, cooldownMinutes: 30, email: false } });
    assert.equal(made.status, 201, made.text);
    const [created] = await auditOf("ops.alert_rule.create");
    assert.equal((created.after as { threshold: number }).threshold, 2);
    const rules = (await call("user_analyst", R.alerts.GET as never)).body.rules as Array<{ id: string }>;
    assert.ok(rules.some((r) => r.id === "default_down"), "editing kept the default rules");
    for (const nonce of ["n1", "n2"]) {
      await kv.set(`billing:pending:${nonce}`, { nonce, userId: "user_plain", plan: "pro", billingCycle: "monthly", status: "failed", paymentRef: "", createdAt: Date.now() });
    }
    g.__r2Down = true;
    await call("user_ops", R.job.POST as never, { method: "POST", params: { name: "ops-backup" }, body: { action: "run" } });
    await call("user_ops", R.job.POST as never, { method: "POST", params: { name: "ops-backup" }, body: { action: "run" } });
    g.__r2Down = false;
    const emailsBefore = fake.emails.length;
    tick(5 * MIN);
    await cron(R.cronHealth.GET as never);
    const active = (await call("user_analyst", R.alerts.GET as never, { query: "?status=active" })).body.alerts as Array<{ kind: string; subject: string; notifyResult?: { emailed: number; emailSkipped?: string } }>;
    const pay = active.find((a) => a.kind === "payment_failures")!;
    assert.ok(pay, "payment failure alert");
    assert.equal(pay.notifyResult?.emailed, 0, "email off for this rule");
    assert.equal(pay.notifyResult?.emailSkipped, "email_off_for_rule");
    assert.ok(active.some((a) => a.kind === "job_failures" && a.subject === "ops-backup"));
    assert.ok(fake.emails.length > emailsBefore, "the job-failure rule emails");
  });

  console.log("incidents and maintenance");
  await t("an incident's banner is the site notice (Settings); it comes down on resolve; an administrator's own notice is never replaced", async () => {
    const settings = await import("../platform/settings");
    const notice = async () => {
      settings.clearSettingsCache();
      return (await settings.getPlatformSettings()).notice;
    };
    const r = await call("user_ops", R.incidents.POST as never, { method: "POST", body: { title: "Captions delayed", impact: "minor", message: "Looking into it", showBanner: true, services: ["deepl", "bogus"] } });
    assert.equal(r.status, 201, r.text);
    const inc = r.body.incident as { id: string; services: string[]; banner: { ok: boolean; detail: string } };
    assert.deepEqual(inc.services, ["deepl"]);
    assert.equal(inc.banner.ok, true, inc.banner.detail);
    const shown = await notice();
    assert.equal(shown.enabled, true);
    assert.equal(shown.message, "Captions delayed: Looking into it");
    await call("user_ops", R.incident.PATCH as never, { method: "PATCH", params: { id: inc.id }, body: { status: "resolved", message: "Fixed" } });
    assert.equal((await notice()).enabled, false, "resolving takes the notice down");

    const s = await settings.getPlatformSettings();
    await settings.savePlatformSettings({ ...s, notice: { ...s.notice, id: "n_admin", enabled: true, message: "Admin's own notice", startsAt: null, endsAt: null } });
    const other = await call("user_ops", R.incidents.POST as never, { method: "POST", body: { title: "Slow joins", impact: "major", message: "Investigating", showBanner: true } });
    const blocked = (other.body.incident as { banner: { ok: boolean; detail: string } }).banner;
    assert.equal(blocked.ok, false);
    assert.match(blocked.detail, /in use by an administrator/);
    assert.equal((await notice()).message, "Admin's own notice");
    const cleared = await settings.getPlatformSettings();
    await settings.savePlatformSettings({ ...cleared, notice: { ...cleared.notice, enabled: false } });
  });

  const calls: string[] = [];
  surface.__setSiteSurface({
    showNotice: async (o, nn) => (calls.push(`show ${o} ${nn.level}`), { ok: true, detail: "notice shown" }),
    clearNotice: async (o) => (calls.push(`clear ${o}`), { ok: true, detail: "notice cleared" }),
    startMaintenance: async (o) => (calls.push(`start ${o}`), { ok: true, detail: "maintenance on" }),
    endMaintenance: async (o) => (calls.push(`end ${o}`), { ok: true, detail: "maintenance off" }),
  });

  await t("an incident's updates go to the site notice; resolving takes it down; all audited", async () => {
    const r = await call("user_ops", R.incidents.POST as never, { method: "POST", body: { title: "Video outage", impact: "critical", status: "investigating", message: "Streams failing", showBanner: true } });
    const id = (r.body.incident as { id: string }).id;
    assert.deepEqual(calls.splice(0), [`show incident:${id} critical`]);
    const u = await call("user_ops", R.incident.PATCH as never, { method: "PATCH", params: { id }, body: { status: "identified", message: "Encoder down" } });
    assert.equal((u.body.incident as { updates: unknown[] }).updates.length, 2);
    await call("user_ops", R.incident.PATCH as never, { method: "PATCH", params: { id }, body: { status: "resolved", message: "Back" } });
    assert.deepEqual(calls.splice(0), [`show incident:${id} critical`, `clear incident:${id}`]);
    const [created] = await auditOf("ops.incident.create");
    assert.equal(created.targetId, id);
    assert.equal((await auditOf("ops.incident.update")).filter((e) => e.targetId === id).length, 2);
    assert.equal((await call("user_analyst", R.incidents.POST as never, { method: "POST", body: { title: "x", message: "y" } })).body.error, "forbidden");
  });

  await t("a maintenance window that turns on maintenance mode needs features:write with a fresh code, and ends itself", async () => {
    const start = Date.now() - 1000;
    const body = { title: "Database upgrade", message: "Back soon", startsAt: start, endsAt: start + 30 * MIN, maintenanceMode: true };
    const ops = await call("user_ops", R.maint.POST as never, { method: "POST", body });
    assert.equal(ops.body.error, "forbidden");
    assert.equal(ops.body.permission, "features:write");
    tick(11 * MIN);
    const stale = await call("user_owner", R.maint.POST as never, { method: "POST", body: { ...body, startsAt: Date.now() - 1000, endsAt: Date.now() + 30 * MIN } });
    assert.equal(stale.body.error, "step_up_required");
    await stepUp("user_owner");
    const ok = await call("user_owner", R.maint.POST as never, { method: "POST", body: { ...body, startsAt: Date.now() - 1000, endsAt: Date.now() + 30 * MIN } });
    assert.equal(ok.status, 201, ok.text);
    const w = ok.body.window as { id: string; state: string };
    assert.equal(w.state, "active");
    assert.deepEqual(calls.splice(0), [`show maintenance:${w.id} warning`, `start maintenance:${w.id}`]);
    tick(31 * MIN);
    await cron(R.cronHealth.GET as never);
    assert.deepEqual(calls.splice(0), [`clear maintenance:${w.id}`, `end maintenance:${w.id}`]);
    const list = (await call("user_analyst", R.incidents.GET as never)).body.maintenance as Array<{ id: string; state: string }>;
    assert.equal(list.find((x) => x.id === w.id)!.state, "completed");
    const notice = await call("user_ops", R.maint.POST as never, { method: "POST", body: { title: "Notice only", message: "Brief blip", startsAt: Date.now() + 60 * MIN, endsAt: Date.now() + 90 * MIN, announceMinutes: 120 } });
    assert.equal(notice.status, 201, notice.text);
    const nid = (notice.body.window as { id: string }).id;
    assert.deepEqual(calls.splice(0), [`show maintenance:${nid} info`], "announced ahead of the start");
    const cancelled = await call("user_ops", R.maintOne.DELETE as never, { method: "DELETE", params: { id: nid } });
    assert.equal((cancelled.body.window as { state: string }).state, "cancelled");
    assert.equal((await auditOf("ops.maintenance.schedule")).length, 2);
    surface.__setSiteSurface(null);
  });

  console.log("media pipeline");
  await t("uploads, egress and transcription outcomes are counted with their recent failures", async () => {
    await media.recordMediaEvent("upload", true, "chat/u/a.png");
    await media.recordMediaEvent("upload", false, "chat/u/b.png", `PUT failed for ${process.env.S3_SECRET_KEY}`);
    const egress = media.egressOutcome(4, "Start signal not received");
    assert.deepEqual(egress, { ok: false, label: "EGRESS_FAILED" });
    assert.equal(media.egressOutcome("EGRESS_COMPLETE").ok, true);
    await media.recordMediaEvent("recording", egress.ok, "room-a EG_1", `${egress.label}: Start signal not received`);
    await kv.set("neo:transcribe:job1", { id: "job1", provider: "deepgram", status: "done", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await kv.set("neo:transcribe:job2", { id: "job2", provider: "deepgram", status: "error", error: "Deepgram 402", recordingKey: "recordings/x.mp4", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await kv.set("neo:transcribe:key:abc", "job2");
    const r = await call("user_analyst", R.media.GET as never);
    assert.equal(r.status, 200, r.text);
    const today = (r.body.days as Array<{ upload: { ok: number; failed: number }; recording: { ok: number; failed: number } }>).at(-1)!;
    assert.deepEqual(today.upload, { ok: 1, failed: 1 });
    assert.deepEqual(today.recording, { ok: 0, failed: 1 });
    const tr = r.body.transcription as { total: number; failureRate: number; recentFailures: Array<{ detail: string }> };
    assert.equal(tr.total, 2);
    assert.equal(tr.failureRate, 0.5);
    assert.equal(tr.recentFailures[0].detail, "Deepgram 402");
    assert.match(JSON.stringify(r.body.uploadFailures), /\[S3_SECRET_KEY\]/);
    const streaming = r.body.streaming as { reachable: boolean; liveStreams: number; expected: Array<{ streamId: string; live: boolean }> };
    assert.equal(streaming.liveStreams, 2);
    assert.equal(streaming.expected[0].streamId, "neoconf-video");
    noSecrets(r.text, "GET media");
  });

  console.log("backups");
  const seed = async () => {
    await kv.set("neo:event:1", { id: "1", name: "Original" });
    await kv.set("neo:event:2", { id: "2", name: "Second" });
    await kv.hset("neo:event:h", { a: "one", b: "two" });
    await kv.rpush("neo:event:l", "x", "y", "z");
    await kv.sadd("neo:event:s", "m1", "m2");
    await kv.zadd("neo:event:z", { score: 1, member: "first" }, { score: 2, member: "second" });
    await kv.set("neo:event:ttl", "short-lived", { ex: 3600 });
    await kv.set("neo:other:1", "untouched-original");
    await kv.set("ratelimit:abc:1", 5);
    await kv.set("neo:event:gone", { id: "gone", ownerUserId: "user_gone" });
    await kv.set("neo:event:by:user_gone", "x");
    await kv.set("neo:event:shared", { members: ["user_gone", "user_b"] });
  };
  let snapId = "";
  await t("a snapshot is compressed, checksummed, verified after writing, and leaves rate limits out", async () => {
    await seed();
    const r = await call("user_ops", R.backups.POST as never, { method: "POST" });
    assert.equal(r.status, 200, r.text);
    const list = (await call("user_analyst", R.backups.GET as never)).body.backups as Array<{ id: string; kind: string; keyCount: number; sha256: string; verify: { ok: boolean }; createdBy: string; bytes: number; rawBytes: number }>;
    const b = list[0];
    snapId = b.id;
    assert.equal(b.kind, "manual");
    assert.equal(b.createdBy, "ops@example.com");
    assert.equal(b.verify.ok, true);
    assert.match(b.sha256, /^[0-9a-f]{64}$/);
    assert.ok(b.bytes < b.rawBytes, "compressed");
    const { gunzipSync } = await import("node:zlib");
    const file = JSON.parse(gunzipSync(g.__r2Bytes!.get(`ops-backups/kv/${b.id}.json.gz`)!).toString()) as { entries: Array<{ k: string; t: string; x?: number }> };
    const keys = file.entries.map((e) => e.k);
    assert.ok(keys.includes("neo:event:h") && keys.includes("neo:other:1"));
    assert.ok(!keys.includes("ratelimit:abc:1"), "rate limits excluded");
    assert.equal(file.entries.find((e) => e.k === "neo:event:z")!.t, "zset");
    assert.ok((file.entries.find((e) => e.k === "neo:event:ttl")!.x ?? 0) > 0, "TTL kept");
    assert.equal(b.keyCount, file.entries.length);
    assert.equal((await auditOf("ops.backup.create"))[0].actorEmail, "ops@example.com");
  });

  await t("verify catches a corrupted snapshot, and a corrupted snapshot cannot be restored", async () => {
    const corrupt = (await call("user_ops", R.backups.POST as never, { method: "POST" })).body.backups as Array<{ id: string }>;
    const cid = corrupt[0].id;
    const k = `ops-backups/kv/${cid}.json.gz`;
    const bytes = g.__r2Bytes!.get(k)!;
    bytes[bytes.length - 5] ^= 0xff;
    const v = await call("user_ops", R.verifyBackup.POST as never, { method: "POST", params: { id: cid } });
    const verify = (v.body.backup as { verify: { ok: boolean; detail: string } }).verify;
    assert.equal(verify.ok, false);
    assert.match(verify.detail, /checksum mismatch/);
    assert.equal((await auditOf("ops.backup.verify"))[0].outcome, "failed");
    await stepUp("user_owner");
    const p = await call("user_owner", R.restore.POST as never, { method: "POST", body: { snapshotId: cid, prefixes: ["neo:event:"], mode: "preview" } });
    assert.equal(p.body.error, "snapshot_invalid");
  });

  await t("restore is the owner's alone, needs a fresh code, and refuses protected or whole-store prefixes", async () => {
    await stepUp("user_super");
    const sup = await call("user_super", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes: ["neo:event:"], mode: "preview" } });
    assert.equal(sup.status, 403);
    assert.equal(sup.body.error, "owner_only");
    const [denied] = await auditOf("ops.restore.preview");
    assert.equal(denied.outcome, "denied");
    assert.equal(denied.actorEmail, "super@example.com");
    assert.equal((await call("user_analyst", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes: ["neo:event:"] } })).body.error, "forbidden");
    tick(11 * MIN);
    assert.equal((await call("user_owner", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes: ["neo:event:"] } })).body.error, "step_up_required");
    await stepUp("user_owner");
    for (const prefixes of [[], [""], ["ne"], ["neo:admin:audit:"], ["neo:admin:mfa:"], ["neo:data:erased"]]) {
      assert.equal((await call("user_owner", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes } })).body.error, "bad_prefixes", JSON.stringify(prefixes));
    }
  });

  await t("preview shows added / changed / removed for the chosen prefixes only, and changes nothing", async () => {
    await kv.set("neo:event:1", { id: "1", name: "Edited later" });
    await kv.del("neo:event:2");
    await kv.set("neo:event:new", { id: "new" });
    await kv.del("neo:event:h");
    await kv.del("neo:event:l");
    await kv.del("neo:event:s");
    await kv.del("neo:event:z");
    await kv.set("neo:other:1", "changed-and-out-of-scope");
    // user_gone's deletion completes after the snapshot (data governance's tombstone).
    await kv.del("neo:event:gone", "neo:event:by:user_gone");
    await kv.sadd("neo:data:erased", "user_gone");
    await kv.set("neo:event:shared", { members: ["user_b"] });
    const p = await call("user_owner", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes: ["neo:event:"], mode: "preview" } });
    assert.equal(p.status, 200, p.text);
    const pv = p.body.preview as { added: string[]; changed: string[]; removed: string[]; counts: Record<string, number> };
    assert.deepEqual(pv.added, ["neo:event:2", "neo:event:h", "neo:event:l", "neo:event:s", "neo:event:z"]);
    assert.deepEqual(pv.changed, ["neo:event:1"]);
    assert.deepEqual(pv.removed, ["neo:event:new"]);
    assert.deepEqual((p.body.preview as { erasedSkipped: string[] }).erasedSkipped, ["neo:event:by:user_gone", "neo:event:gone", "neo:event:shared"], "an erased account is not brought back");
    assert.equal(p.body.confirmPhrase, `RESTORE ${snapId}`);
    assert.deepEqual(await kv.get("neo:event:1"), { id: "1", name: "Edited later" }, "preview wrote nothing");
  });

  await t("apply needs the typed phrase, saves a pre-restore snapshot first, restores every type, and can be undone", async () => {
    const wrong = await call("user_owner", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes: ["neo:event:"], mode: "apply", confirm: "restore" } });
    assert.equal(wrong.body.error, "confirmation_mismatch");
    assert.equal((await kv.get("neo:event:2")), null);
    const ok = await call("user_owner", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes: ["neo:event:"], mode: "apply", confirm: `RESTORE ${snapId}` } });
    assert.equal(ok.status, 200, ok.text);
    const result = ok.body.result as { preRestoreId: string; written: number; removed: number };
    assert.equal(result.removed, 1);
    assert.deepEqual(await kv.get("neo:event:1"), { id: "1", name: "Original" });
    assert.deepEqual(await kv.get("neo:event:2"), { id: "2", name: "Second" });
    assert.equal(await kv.get("neo:event:new"), null);
    assert.deepEqual(await kv.hgetall("neo:event:h"), { a: "one", b: "two" });
    assert.deepEqual(await kv.lrange("neo:event:l", 0, -1), ["x", "y", "z"]);
    assert.deepEqual((await kv.smembers("neo:event:s")).sort(), ["m1", "m2"]);
    assert.deepEqual(await kv.zrange("neo:event:z", 0, -1), ["first", "second"]);
    assert.ok(Number(await kv.pttl("neo:event:ttl")) > 0, "TTL restored");
    assert.equal(await kv.get("neo:other:1"), "changed-and-out-of-scope", "other prefixes untouched");
    assert.equal(await kv.get("neo:event:gone"), null, "the erased account stays erased");
    assert.equal(await kv.get("neo:event:by:user_gone"), null);
    assert.deepEqual(await kv.get("neo:event:shared"), { members: ["user_b"] }, "a key that held the erased id keeps its current value");
    const pre = (await backup.listBackups()).find((b) => b.id === result.preRestoreId)!;
    assert.equal(pre.kind, "pre-restore");
    assert.equal(pre.restoreOf, snapId);
    assert.deepEqual(pre.prefixes, ["neo:event:"]);
    assert.equal(pre.verify?.ok, true);
    const [applied] = await auditOf("ops.restore.apply");
    assert.equal(applied.outcome, "ok");
    assert.equal((applied.after as { preRestoreId: string }).preRestoreId, result.preRestoreId);

    // Undo = restore the pre-restore snapshot.
    const undo = ok.body.undo as { snapshotId: string; prefixes: string[]; confirmPhrase: string };
    const back = await call("user_owner", R.restore.POST as never, { method: "POST", body: { ...undo, mode: "apply", confirm: undo.confirmPhrase } });
    assert.equal(back.status, 200, back.text);
    assert.deepEqual(await kv.get("neo:event:1"), { id: "1", name: "Edited later" });
    assert.equal(await kv.get("neo:event:2"), null);
    assert.deepEqual(await kv.get("neo:event:new"), { id: "new" });
    assert.equal(await kv.hgetall("neo:event:h"), null);
  });

  await t("if the pre-restore snapshot cannot be taken and verified, nothing is restored", async () => {
    const g2 = g as Stubbed & { __r2CorruptPrefix?: string };
    const body = { snapshotId: snapId, prefixes: ["neo:event:"], mode: "apply", confirm: `RESTORE ${snapId}` };
    g2.__r2CorruptPrefix = "ops-backups/kv/pre_";
    const bad = await call("user_owner", R.restore.POST as never, { method: "POST", body });
    g2.__r2CorruptPrefix = undefined;
    assert.equal(bad.body.error, "pre_restore_failed", bad.text);
    assert.deepEqual(await kv.get("neo:event:1"), { id: "1", name: "Edited later" }, "nothing written");
    assert.deepEqual(await kv.get("neo:event:new"), { id: "new" });
    g.__r2Down = true;
    const down = await call("user_owner", R.restore.POST as never, { method: "POST", body });
    g.__r2Down = false;
    assert.equal(down.status, 409);
    assert.deepEqual(await kv.get("neo:event:1"), { id: "1", name: "Edited later" }, "nothing written");
    const failures = (await auditOf("ops.restore.apply")).filter((e) => e.outcome === "failed");
    assert.equal(failures.length, 2);
  });

  await t("a restore cannot run twice at once, and never writes over the audit trail", async () => {
    assert.ok(await jobs.acquireJobLock("ops-restore", "run_other"));
    const busy = await call("user_owner", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes: ["neo:event:"], mode: "apply", confirm: `RESTORE ${snapId}` } });
    assert.equal(busy.body.error, "already_running");
    await jobs.releaseJobLock("ops-restore", "run_other");
    const broad = await call("user_owner", R.restore.POST as never, { method: "POST", body: { snapshotId: snapId, prefixes: ["neo:admin:"], mode: "preview" } });
    assert.equal(broad.status, 200, broad.text);
    const pv = broad.body.preview as { added: string[]; changed: string[]; removed: string[]; protectedSkipped: number };
    assert.ok(![...pv.added, ...pv.changed, ...pv.removed].some((k) => k.startsWith("neo:admin:audit:") || k.startsWith("neo:admin:mfa")));
    assert.ok(pv.protectedSkipped > 0);
  });

  await t("retention keeps the newest snapshots and removes the rest from R2", async () => {
    for (let i = 0; i < backup.KEEP_SNAPSHOTS + 2; i++) await backup.createSnapshot({ kind: "scheduled", by: "test", prefixes: ["neo:other:"] });
    const removed = await backup.applyRetention();
    assert.ok(removed.length >= 2);
    const left = await backup.listBackups();
    assert.equal(left.filter((b) => b.kind !== "pre-restore").length, backup.KEEP_SNAPSHOTS);
    for (const id of removed) assert.ok(!g.__r2Bytes!.has(`ops-backups/kv/${id}.json.gz`));
    // One at a time, for data governance's age-based retention.
    const one = left[left.length - 1];
    assert.equal(await backup.deleteBackup(one.id), true);
    assert.equal(await backup.getBackup(one.id), null);
    assert.ok(!g.__r2Bytes!.has(one.r2Key));
    assert.equal(await backup.deleteBackup(one.id), false);
  });

  await t("the scheduled backup cron is a recorded job like the others", async () => {
    const c = await cron(R.cronBackup.GET as never);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.verified, true);
    const run = await jobs.getRun(c.run!);
    assert.equal(run?.job, "ops-backup");
    assert.equal(run?.trigger, "schedule");
    assert.equal((await backup.getBackup(String(c.body.id)))?.kind, "scheduled");
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
