// Run: npx tsx src/lib/__tests__/activity.smoke.ts
//
// The platform activity log and the admin Analytics / Logs pages, driven
// through the real routes with Clerk and KV stood in for (./apiV1-stubs):
// events recorded where they happen (sign-in, meetings, the LiveKit webhook,
// recordings, purchases, plan expiry, the developer API, failed admin codes),
// a KV outage or a hung KV unable to break or stall the request it records,
// rollups and weekly cohorts on fixed data across day boundaries, time zones
// and a DST change, log filters, CSV and Excel exports, and who may see what.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  CLERK_SECRET_KEY: "sk_test_activity",
  PLATFORM_OWNER_EMAILS: "owner@example.com",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  S3_ACCESS_KEY: "a",
  S3_SECRET_KEY: "b",
  S3_ENDPOINT: "https://r2.test",
  S3_BUCKET: "bkt",
  CRON_SECRET: "cron-secret",
});
delete process.env.ADMIN_EMAILS;
delete process.env.RESEND_API_KEY;
delete process.env.DEEPGRAM_API_KEY;

type Fault = (method: string, args: unknown[]) => "fail" | "hang" | undefined;
type Stubbed = typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[]; first?: string; createdAt?: number; metadata?: Record<string, unknown> }>;
  __who?: string;
  __kvStore: Map<string, unknown>;
  __kvFault?: Fault;
};
const g = globalThis as Stubbed;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T = (iso: string) => Date.parse(iso);

g.__users = {
  user_owner: { emails: ["owner@example.com"], first: "Owner" },
  user_an: { emails: ["analyst@example.com"] },
  user_bill: { emails: ["billing@example.com"] },
  user_view: { emails: ["viewer@example.com"] },
  user_sup: { emails: ["support@example.com"] },
  user_new: { emails: ["new@example.com"], createdAt: Date.now() - HOUR },
  user_old: { emails: ["old@example.com"], createdAt: T("2026-01-15T10:00:00Z") },
  user_pro: { emails: ["pro@example.com"], plan: "pro", first: "=SUM(1,2)" },
  user_free: { emails: ["free@example.com"], first: "Free Person" },
  user_buyer: { emails: ["buyer@example.com"] },
  user_lapsed: { emails: ["lapsed@example.com"], plan: "business", metadata: { planExpiresAt: Date.now() - DAY } },
};

// Nothing in this test may reach the network (short-link service etc.).
globalThis.fetch = (async () => {
  throw new Error("network disabled in tests");
}) as typeof fetch;

// A clock the test moves, so authenticator codes advance step by step.
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

// A promise that never settles lets Node exit early with code 0, which would
// read as a pass. Only reaching the end counts.
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
  const { NextRequest } = await import("next/server");
  const { AccessToken } = await import("livekit-server-sdk");
  const ExcelJS = (await import("exceljs")).default;
  const mfa = await import("../admin/mfa");
  const act = await import("../activity");
  const rep = await import("../activityReports");
  const { eventStore } = await import("../eventStore");
  const { kv } = await import("../kv");
  const { appendAuditEntry } = await import("../auditLog");
  const { createPendingPayment } = await import("../billingStore");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    team: await import("../../app/api/admin/team/route"),
    roles: await import("../../app/api/admin/roles/route"),
    analytics: await import("../../app/api/admin/analytics/route"),
    records: await import("../../app/api/admin/analytics/records/route"),
    logs: await import("../../app/api/admin/logs/route"),
    session: await import("../../app/api/auth/create-session/route"),
    instant: await import("../../app/api/events/instant/route"),
    egress: await import("../../app/api/livekit/egress/start/route"),
    webhook: await import("../../app/api/livekit/webhook/route"),
    v1events: await import("../../app/api/v1/events/route"),
    espees: await import("../../app/api/billing/espees/return/route"),
    downgrade: await import("../../app/api/cron/downgrade-expired-plans/route"),
    subscription: await import("../../app/api/admin/subscriptions/[userId]/route"),
    userPage: await import("../../app/api/admin/users/[id]/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  type Handler = (req: never, ctx: { params: Record<string, string> }) => Promise<Response>;
  async function raw(
    who: string | null,
    handler: unknown,
    opts: { method?: string; body?: unknown; rawBody?: string; query?: string; headers?: Record<string, string>; path?: string; params?: Record<string, string> } = {},
  ): Promise<Response> {
    g.__who = who ?? undefined;
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const req = new NextRequest(`https://www.neoconference.app${opts.path ?? "/api/x"}${opts.query ?? ""}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const res = await (handler as Handler)(req as never, { params: opts.params ?? {} });
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (who && m) jar[who] = decodeURIComponent(m[1]);
    return res;
  }
  async function call(who: string | null, handler: unknown, opts: Parameters<typeof raw>[2] = {}) {
    const res = await raw(who, handler, opts);
    const text = await res.text();
    let body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body, headers: res.headers };
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
  async function webhook(event: Record<string, unknown>) {
    const body = JSON.stringify(event);
    const at = new AccessToken("lk", process.env.LIVEKIT_API_SECRET!);
    at.sha256 = createHash("sha256").update(body).digest("base64");
    return call(null, R.webhook.POST, { method: "POST", rawBody: body, headers: { authorization: await at.toJwt() } });
  }
  const today = () => act.utcDay(Date.now());
  const counter = async (day: string, field: string) => Number(((await kv.hgetall(act.K.hourly(day))) as Record<string, number> | null)?.[field] ?? 0);
  const dayCount = async (day: string, type: string) => {
    const h = ((await kv.hgetall(act.K.hourly(day))) ?? {}) as Record<string, number>;
    return Object.entries(h).filter(([k]) => /^[^|#]+\|\d\d$/.test(k) && k.startsWith(type + "|")).reduce((s, [, v]) => s + Number(v), 0);
  };

  console.log("setup: owner, analyst, billing, a viewer role, support");
  await enrollAndVerify("user_owner");
  const viewer = await call("user_owner", R.roles.POST, { method: "POST", body: { name: "Viewer", permissions: ["analytics:read"] } });
  assert.equal(viewer.status, 201, JSON.stringify(viewer.body));
  for (const [email, roleId] of [
    ["analyst@example.com", "analyst"],
    ["billing@example.com", "billing"],
    ["viewer@example.com", viewer.body.role.id],
    ["support@example.com", "support"],
  ]) {
    const r = await call("user_owner", R.team.POST, { method: "POST", body: { email, roleId } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  for (const who of ["user_an", "user_bill", "user_view", "user_sup"]) await enrollAndVerify(who);

  console.log("instrumented: sign-in and sign-up");
  await t("a new device session records a sign-in; the first ever also a sign-up, on the account's creation day", async () => {
    const ua = { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36", "accept-language": "en" };
    const r = await call("user_new", R.session.POST, { method: "POST", headers: ua });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await call("user_new", R.session.POST, { method: "POST", headers: { ...ua, "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130.0" } });
    assert.equal(again.status, 201);
    const mine = await act.listUserActivity("user_new");
    assert.deepEqual(mine.map((e) => e.type), ["auth.sign_in", "auth.sign_in", "auth.sign_up"]);
    assert.equal(mine[2].props?.device ?? mine[1].props?.device, "Chrome on Windows");
    assert.equal(mine[0].props?.device, "Chrome on Android");
    assert.equal(await dayCount(today(), "auth.sign_up"), 1);
    assert.equal(await dayCount(today(), "auth.sign_in"), 2);
    assert.ok(((await kv.smembers(act.K.newUsers(act.utcDay(g.__users.user_new.createdAt!)))) as string[]).includes("user_new"));
    assert.ok(((await kv.smembers(act.K.dau(today()))) as string[]).includes("user_new"));
  });

  await t("an account older than the log, seen for the first time, joins its real sign-up week but is not a new sign-up", async () => {
    assert.equal((await call("user_old", R.session.POST, { method: "POST", headers: { "user-agent": "x" } })).status, 201);
    assert.ok(((await kv.smembers(act.K.newUsers("2026-01-15"))) as string[]).includes("user_old"));
    assert.equal(await dayCount(today(), "auth.sign_up"), 1, "still only user_new");
    assert.deepEqual((await act.listUserActivity("user_old")).map((e) => e.type), ["auth.sign_in"]);
  });

  await t("middleware's daily mark: one KV round trip per person per day, first sight noted once", async () => {
    let calls = 0;
    g.__kvFault = () => {
      calls++;
      return undefined;
    };
    await act.markActive("user_mobile", async () => T("2026-02-02T08:00:00Z"));
    const first = calls;
    await act.markActive("user_mobile", async () => T("2026-02-02T08:00:00Z"));
    g.__kvFault = undefined;
    assert.ok(first >= 2, "SADD dau + SADD users");
    assert.equal(calls, first, "memoised: the second request made no KV call");
    assert.ok(((await kv.smembers(act.K.dau(today()))) as string[]).includes("user_mobile"));
    assert.ok(((await kv.smembers(act.K.newUsers("2026-02-02"))) as string[]).includes("user_mobile"));
  });

  console.log("a failing or hung log cannot break the request");
  await t("KV refusing every activity write: sign-in still succeeds and sets its cookie", async () => {
    g.__kvFault = (_m, args) => (String(args[0]).startsWith("neo:act:") ? "fail" : undefined);
    const r = await raw("user_free", R.session.POST, { method: "POST", headers: { "user-agent": "y" } });
    g.__kvFault = undefined;
    assert.equal(r.status, 201);
    assert.match(r.headers.get("set-cookie") ?? "", /neoconf-session=/);
  });

  await t("KV never answering: sign-in still answers, within the write budget", async () => {
    g.__kvFault = (_m, args) => (String(args[0]).startsWith("neo:act:") ? "hang" : undefined);
    const started = realNow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([
      raw("user_buyer", R.session.POST, { method: "POST", headers: { "user-agent": "z" } }),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("sign-in waited on a hung KV")), 6000))),
    ]);
    clearTimeout(timer);
    g.__kvFault = undefined;
    assert.equal(r.status, 201);
    const took = realNow() - started;
    assert.ok(took < 5000, `took ${took} ms`);
  });

  await t("record() itself never throws, returns null, and logs why", async () => {
    g.__kvFault = () => "fail";
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    const r = await act.record("meeting.created", { userId: "user_x" });
    console.error = orig;
    g.__kvFault = undefined;
    assert.equal(r, null);
    assert.match(String((errors[0] as unknown[])[0]), /\[activity\] record failed/);
  });

  console.log("instrumented: meetings, the LiveKit webhook, recordings, API, billing, admin codes");
  let slug = "";
  await t("an instant meeting records meeting.created for its owner", async () => {
    const r = await call("user_pro", R.instant.POST, { method: "POST", body: { name: "Standup" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    slug = r.body.slug;
    const [s, e] = await act.listUserActivity("user_pro");
    assert.equal(s.type, "meeting.started", "an instant meeting is live from the start");
    assert.equal(e.type, "meeting.created");
    assert.equal(e.props?.kind, "instant");
    assert.equal(e.props?.eventId, (await eventStore.bySlug(slug))!.id);
  });

  await t("Record records recording.started, charged to the meeting's owner", async () => {
    const r = await call("user_pro", R.egress.POST, { method: "POST", body: { room: slug } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [e] = await act.listUserActivity("user_pro");
    assert.equal(e.type, "recording.started");
    assert.equal(e.account, "user_pro");
  });

  await t("webhook: room_started, a join (owner's participant count), the recording's seconds, room_finished with minutes", async () => {
    const created = BigInt(Math.floor(Date.now() / 1000));
    assert.equal((await webhook({ event: "room_started", room: { name: slug }, createdAt: String(created) })).body.ok, true);
    const j = await webhook({ event: "participant_joined", room: { name: slug }, participant: { identity: "user_free#web", name: "Free Person" }, createdAt: String(created) });
    assert.equal(j.body.recorded, "participant_joined", JSON.stringify(j.body));
    await webhook({ event: "participant_joined", room: { name: slug }, participant: { identity: "guest-123", name: "Guest" }, createdAt: String(created) });
    const egressId = (globalThis as { __egress?: { active: Array<{ egressId: string }> } }).__egress!.active[0].egressId;
    const rec = await webhook({
      event: "egress_ended",
      egressInfo: { egressId, roomName: slug, fileResults: [{ filename: `recordings/user_pro/${slug}/2026-10-09-10-00-00.mp4`, duration: "90000000000" }] },
    });
    assert.equal(rec.body.ok, true, JSON.stringify(rec.body));
    await webhook({ event: "egress_ended", egressInfo: { egressId, roomName: slug, fileResults: [{ filename: `recordings/user_pro/${slug}/2026-10-09-10-00-00.mp4`, duration: "90000000000" }] } });
    tick(5 * 60_000);
    const fin = await webhook({ event: "room_finished", room: { name: slug }, createdAt: String(BigInt(Math.floor(Date.now() / 1000))) });
    assert.equal(fin.body.transitioned, true, JSON.stringify(fin.body));

    const free = await act.listUserActivity("user_free");
    assert.equal(free[0].type, "meeting.joined");
    assert.equal(free[0].account, "user_pro");
    assert.equal(await dayCount(today(), "meeting.joined"), 2, "the guest's join counts too");
    assert.equal(await dayCount(today(), "recording.finished"), 1, "a repeated webhook counts once");
    const pro = await act.listUserActivity("user_pro");
    assert.deepEqual(pro.slice(0, 3).map((e) => e.type), ["meeting.ended", "recording.finished", "recording.started"]);
    assert.equal(await dayCount(today(), "meeting.started"), 1, "room_started for a meeting already live is not a second start");
    assert.equal(pro[1].props?.seconds, 90);
    const stored = (await eventStore.bySlug(slug))!;
    assert.equal(pro[0].props?.minutes, Math.round((Date.parse(stored.endedAt!) - Date.parse(stored.startedAt!)) / 60_000));
    const acct = (await kv.hgetall(act.K.accounts(today()))) as Record<string, number>;
    assert.equal(Number(acct["user_pro|participants"]), 2);
    assert.equal(Number(acct["user_pro|recordingSeconds"]), 90);
  });

  await t("developer API calls are counted for the key's owner without a log line each", async () => {
    const raw = "nc_live_activity_0123456789abcdef";
    const hash = createHash("sha256").update(raw).digest("hex");
    await kv.set(`apikey:${hash}`, { id: "k1", ownerUserId: "user_pro", name: "t", plan: "free", createdAt: 0, lastUsedAt: null, revoked: false });
    for (let i = 0; i < 3; i++) assert.equal((await call(null, R.v1events.GET, { headers: { authorization: `Bearer ${raw}` } })).status, 200);
    assert.equal(await dayCount(today(), "api.call"), 3);
    assert.equal(Number(((await kv.hgetall(act.K.accounts(today()))) as Record<string, number>)["user_pro|apiCalls"]), 3);
    const log = (await kv.lrange(act.K.log(today()), 0, -1)) as string[];
    assert.ok(!log.some((l) => String(l).includes('"api.call"')));
  });

  await t("a purchase records plan.purchased with the plan it came from; expiry records plan.downgraded", async () => {
    await createPendingPayment({ nonce: "n1", userId: "user_buyer", plan: "pro", billingCycle: "monthly", paymentRef: "ref-1" });
    const r = await raw(null, R.espees.GET, { query: "?nonce=n1" });
    assert.equal(r.status, 303);
    const [p] = await act.listUserActivity("user_buyer");
    assert.equal(p.type, "plan.purchased");
    assert.deepEqual([p.props?.from, p.props?.to, p.props?.cycle], ["free", "pro", "monthly"]);
    assert.equal(await counter(today(), `plan.purchased#free|${new Date(p.ts).toISOString().slice(11, 13)}`), 1);
    const d = await call(null, R.downgrade.GET, { headers: { authorization: "Bearer cron-secret" } });
    assert.equal(d.body.downgraded, 1, JSON.stringify(d.body));
    const [x] = await act.listUserActivity("user_lapsed");
    assert.deepEqual([x.type, x.props?.from, x.props?.reason], ["plan.downgraded", "business", "expired"]);
  });

  await t("subscription records: an administrator's cancellation, then the daily sweep ending the plan", async () => {
    const c = await call("user_owner", R.subscription.POST, { method: "POST", params: { userId: "user_buyer" }, body: { action: "cancel", when: "period_end" } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const [x] = await act.listUserActivity("user_buyer");
    assert.deepEqual([x.type, x.props?.from, x.props?.ends, x.props?.by], ["plan.cancelled", "pro", "period_end", "owner@example.com"]);
    const { sweepDue } = await import("../billing/subscriptions");
    const swept = await sweepDue(Date.now() + 40 * DAY);
    assert.ok(swept.expired >= 1, JSON.stringify(swept));
    const [y] = await act.listUserActivity("user_buyer");
    assert.deepEqual([y.type, y.props?.from, y.props?.reason], ["plan.downgraded", "pro", "cancelled"]);
  });

  await t("a wrong authenticator code is a failed admin sign-in (warning) in the activity log", async () => {
    tick();
    assert.equal((await call("user_view", R.verify.POST, { method: "POST", body: { code: "000000" } })).body.error, "invalid_code");
    const [e] = await act.listUserActivity("user_view");
    assert.deepEqual([e.type, e.severity, e.props?.action], ["admin.sign_in_failed", "warn", "mfa.verify.failed"]);
  });

  console.log("rollups, time zones and cohorts on fixed data");
  // Two joins either side of midnight UTC on 3/4 Aug, one in the period before.
  await act.record("meeting.joined", { userId: "user_j1", account: "user_fix", ts: T("2026-08-03T23:30:00Z") });
  await act.record("meeting.joined", { userId: "user_j2", account: "user_fix", ts: T("2026-08-04T00:30:00Z") });
  await act.record("meeting.joined", { userId: "user_j0", account: "user_fix", ts: T("2026-07-20T12:00:00Z") });
  await act.record("recording.finished", { userId: "user_fix", account: "user_fix", ts: T("2026-08-04T09:00:00Z"), props: { seconds: 5400 } });
  // Cohorts: four sign up in the week of Mon 3 Aug; c5 on Sunday 16 Aug at
  // 23:59 (week of 10 Aug); c6 at 00:00 on Monday 17 Aug (week of 17 Aug).
  // Sign-ups are Clerk accounts; each one seen by the app is also noted in the
  // log's own sets (the fallback). c9 signs up and is never seen again.
  const signUp = async (id: string, iso: string, seen = true) => {
    g.__users[id] = { emails: [`${id}@example.com`], createdAt: T(iso) };
    if (seen) await act.noteUser(id, T(iso));
  };
  const active = (id: string, iso: string) => act.markActive(id, undefined, T(iso));
  await signUp("c1", "2026-08-03T09:00:00Z");
  await signUp("c2", "2026-08-04T09:00:00Z");
  await signUp("c3", "2026-08-05T09:00:00Z");
  await signUp("c4", "2026-08-06T09:00:00Z");
  await signUp("c5", "2026-08-16T23:59:00Z");
  await signUp("c6", "2026-08-17T00:00:00Z");
  await signUp("c9", "2026-08-04T15:00:00Z", false);
  // Before the log began: a sign-up, but no cohort to follow.
  await signUp("c0", "2026-07-22T10:00:00Z", false);
  // The log began on Saturday 1 Aug; its first full week starts Monday 3 Aug.
  await kv.set(act.K.since, T("2026-08-01T00:00:00Z"));
  for (const [id, iso] of [
    ["c1", "2026-08-03T10:00:00Z"], ["c1", "2026-08-11T10:00:00Z"], ["c1", "2026-08-18T10:00:00Z"],
    ["c2", "2026-08-04T10:00:00Z"], ["c2", "2026-08-12T10:00:00Z"],
    ["c3", "2026-08-05T10:00:00Z"],
    ["c4", "2026-08-09T23:00:00Z"],
    ["c5", "2026-08-16T23:59:30Z"], ["c5", "2026-08-17T08:00:00Z"],
    ["c6", "2026-08-17T00:00:00Z"],
    // Active only the day before the last 7: outside WAU, inside MAU.
    ["c8", "2026-08-16T12:00:00Z"],
  ])
    await active(id, iso);
  const ev = (e: Record<string, unknown>) => eventStore.create({ roles: [], visibility: "private", ...e } as never);
  await ev({ id: "ev_p1", slug: "pro-one", name: "Board meeting", ownerUserId: "user_pro", state: "ended", createdAt: "2026-08-04T10:00:00Z", startedAt: "2026-08-04T10:00:00Z", endedAt: "2026-08-04T11:30:00Z" });
  await ev({ id: "ev_p2", slug: "pro-two", name: "Pro two", ownerUserId: "user_pro", state: "scheduled", createdAt: "2026-08-05T10:00:00Z" });
  await ev({ id: "ev_f1", slug: "free-one", name: "Free one", ownerUserId: "user_free", state: "ended", createdAt: "2026-08-05T12:00:00Z", startedAt: "2026-08-05T12:00:00Z", endedAt: "2026-08-05T12:30:00Z" });
  await ev({ id: "ev_old", slug: "old-one", name: "Old one", ownerUserId: "user_free", state: "ended", createdAt: "2026-07-20T12:00:00Z" });

  const analytics = async (who: string, q: string) => {
    const r = await call(who, R.analytics.GET, { query: "?" + q });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as import("../admin/analytics").AnalyticsReport;
  };

  await t("hourly counters fold into the viewer's calendar days: UTC, Tokyo, New York", async () => {
    const day = (tz: string) => analytics("user_an", `from=2026-08-03&to=2026-08-04&tz=${encodeURIComponent(tz)}`).then((r) => r.daily.joins);
    assert.deepEqual(await day("UTC"), [1, 1]);
    assert.deepEqual(await day("Asia/Tokyo"), [0, 2]);
    assert.deepEqual(await day("America/New_York"), [2, 0]);
  });

  await t("a DST day is 23 hours, and an event is placed by the local clock", () => {
    const p = rep.period("2026-03-08", "2026-03-08", "America/New_York");
    assert.equal(p.startMs, T("2026-03-08T05:00:00Z"));
    assert.equal(p.endMs + 1, T("2026-03-09T04:00:00Z"));
    const f = rep.foldHourly({ "2026-03-08": { "meeting.joined|04": 1 }, "2026-03-09": { "meeting.joined|03": 1 } }, p);
    assert.deepEqual(f.counts["meeting.joined"], { "2026-03-08": 1 }, "03:30Z on the 9th is 23:30 EDT on the 8th; 04:30Z on the 8th is the 7th");
    assert.equal(rep.dayInZone(T("2026-03-09T03:30:00Z"), "America/New_York"), "2026-03-08");
    return Promise.resolve();
  });

  await t("figures compare with the period before; meetings and minutes come from the store with history", async () => {
    const r = await analytics("user_an", "from=2026-08-03&to=2026-08-23&tz=UTC");
    const f = Object.fromEntries(r.figures.map((x) => [x.key, x]));
    assert.deepEqual([f.joins.value, f.joins.previous, f.joins.change], [2, 1, 100]);
    assert.deepEqual([f.meetings.value, f.meetings.previous, f.meetings.change], [3, 1, 200]);
    assert.equal(f.meetingMinutes.value, 120);
    assert.equal(f.recordingHours.value, 1.5);
    assert.equal(f.meetings.source, "store");
    assert.deepEqual(f.meetings.drill, { kind: "records", metric: "meetings" });
    assert.deepEqual(f.joins.drill, { kind: "logs", type: "meeting.joined" });
    assert.equal(r.previous.from, "2026-07-13");
    assert.equal(r.previous.to, "2026-08-02");
  });

  await t("weekly cohorts: Monday-start UTC weeks, a Sunday 23:59 and a Monday 00:00 sign-up land in different weeks", async () => {
    const r = await analytics("user_an", "from=2026-08-03&to=2026-08-23&tz=UTC");
    assert.deepEqual(
      r.retention.map((c) => [c.week, c.size, c.retained]),
      [
        ["2026-08-03", 5, [4, 2, 1, 0, 0, 0, 0, 0]],
        ["2026-08-10", 1, [1, 1, 0, 0, 0, 0, 0, 0]],
        ["2026-08-17", 1, [1, 0, 0, 0, 0, 0, 0, 0]],
      ],
      "c9 never came back: in the cohort, not retained",
    );
    assert.equal(r.cohortsFrom, "2026-08-03");
    const late = await analytics("user_an", "from=2026-07-20&to=2026-08-23&tz=UTC");
    assert.equal(late.retention[0].week, "2026-08-03", "no cohort from before the log saw a whole week");
  });

  await t("sign-ups come from Clerk with their history; the records list them; the log's sets stand in if Clerk fails", async () => {
    const r = await analytics("user_an", "from=2026-08-03&to=2026-08-23&tz=UTC");
    const s = r.figures.find((f) => f.key === "signUps")!;
    assert.deepEqual([s.value, s.previous, s.source], [7, 1, "store"]);
    assert.deepEqual(s.drill, { kind: "records", metric: "signUps" });
    assert.equal(r.daily.signUps[0], 1);
    assert.equal(r.daily.signUps[13], 1, "c5 at 23:59 on Sunday 16 Aug");
    assert.equal(r.daily.signUps[14], 1, "c6 at 00:00 on Monday 17 Aug");
    const tokyo = await analytics("user_an", "from=2026-08-03&to=2026-08-23&tz=Asia%2FTokyo");
    assert.equal(tokyo.daily.signUps[14], 2, "in Tokyo both are on Monday 17 Aug");
    const list = await call("user_view", R.records.GET, { query: "?metric=signUps&from=2026-08-03&to=2026-08-23&tz=UTC" });
    assert.deepEqual(list.body.items.map((u: { id: string }) => u.id), ["c6", "c5", "c4", "c3", "c9", "c2", "c1"]);
    // Past one page of Clerk's list (500): every account in range, none outside.
    const many = Array.from({ length: 1200 }, (_, i) => `bulk_${i}`);
    many.forEach((id, i) => (g.__users[id] = { emails: [`${id}@example.com`], createdAt: T("2025-03-01T00:00:00Z") + i * 60_000 }));
    const { clerkSignUps } = await import("../admin/analytics");
    assert.equal((await clerkSignUps(T("2025-03-01T00:00:00Z"), T("2025-03-01T23:59:59Z")))!.length, 1200);
    assert.equal((await clerkSignUps(T("2025-03-01T10:00:00Z"), T("2025-03-01T10:59:59Z")))!.length, 60);
    many.forEach((id) => delete g.__users[id]);
    (globalThis as { __clerkListFails?: boolean }).__clerkListFails = true;
    const fb = await analytics("user_an", "from=2026-08-03&to=2026-08-23&tz=UTC");
    (globalThis as { __clerkListFails?: boolean }).__clerkListFails = false;
    assert.equal(fb.figures.find((f) => f.key === "signUps")!.source, "log");
    assert.equal(fb.retention[0].size, 4, "the log only knows the people it saw");
  });

  await t("daily, weekly and monthly active users from the UTC day sets", async () => {
    const r = await analytics("user_an", "from=2026-08-03&to=2026-08-23&tz=UTC");
    const f = Object.fromEntries(r.figures.map((x) => [x.key, x.value]));
    assert.equal(f.wau, 3, "c1, c5, c6 in 17–23 Aug");
    assert.equal(f.mau, 10, "c1–c6, c8, the two joiners and the recording's owner in 25 Jul–23 Aug");
    assert.equal(f.activeDaily, 0.7, "14 person-days over 21 days");
    assert.deepEqual(r.daily.activeDaily.slice(0, 3), [2, 3, 1]);
  });

  await t("real plans from the accounts (not guessed); top accounts with their consumption", async () => {
    const r = await analytics("user_an", "from=2026-08-03&to=2026-08-23&tz=UTC");
    assert.deepEqual(r.plans, [
      { plan: "pro", owners: 1, meetings: 2 },
      { plan: "free", owners: 1, meetings: 1 },
    ]);
    const pro = r.accounts.find((a) => a.id === "user_pro")!;
    assert.deepEqual([pro.meetings, pro.meetingMinutes, pro.plan, pro.label], [2, 90, "pro", "=SUM(1,2)"]);
    const fix = r.accounts.find((a) => a.id === "user_fix")!;
    assert.deepEqual([fix.participants, fix.recordingHours], [2, 1.5]);
    assert.match(fix.href, /user_fix/);
  });

  await t("meeting records behind a figure: titles only for administrators who can view meetings", async () => {
    const an = await call("user_an", R.records.GET, { query: "?metric=meetings&from=2026-08-03&to=2026-08-23&tz=UTC" });
    assert.deepEqual(an.body.items.map((i: { title: string }) => i.title).sort(), ["Board meeting", "Free one", "Pro two"]);
    const v = await call("user_view", R.records.GET, { query: "?metric=meetingMinutes&from=2026-08-03&to=2026-08-23&tz=UTC" });
    assert.equal(v.body.withTitles, false);
    assert.deepEqual(v.body.items.map((i: { title?: string; minutes: number }) => [i.title, i.minutes]), [[undefined, 30], [undefined, 90]]);
  });

  console.log("logs");
  await appendAuditEntry({ ts: Date.now(), permission: "meeting:end", allowed: false, userId: "user_free", role: "attendee", reason: "not host", eventId: "ev_p1" });
  const logs = async (who: string, q: string) => call(who, R.logs.GET, { query: "?" + q });

  await t("one search over activity, admin audit and meeting permissions, newest first", async () => {
    const r = await logs("user_an", "");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sources, ["activity", "admin", "meeting"]);
    const srcs = new Set(r.body.items.map((i: { source: string }) => i.source));
    assert.ok(srcs.has("activity") && srcs.has("admin") && srcs.has("meeting"), [...srcs].join());
    const ts = r.body.items.map((i: { ts: number }) => i.ts);
    assert.deepEqual(ts, [...ts].sort((a: number, b: number) => b - a));
  });

  await t("filters: user, type prefix, severity, text, date range, source; pages do not overlap", async () => {
    const byUser = await logs("user_an", "source=activity&user=user_pro&type=meeting.");
    assert.ok(byUser.body.items.length >= 3);
    assert.ok(byUser.body.items.every((i: { type: string; user: string; details: { account?: string } }) => i.type.startsWith("meeting.") && (i.user === "user_pro" || i.details.account === "user_pro")));
    const warn = await logs("user_an", "severity=warn");
    assert.ok(warn.body.items.some((i: { type: string }) => i.type === "admin.sign_in_failed"));
    assert.ok(warn.body.items.some((i: { source: string; type: string }) => i.source === "meeting" && i.type === "meeting:end"));
    assert.ok(warn.body.items.every((i: { severity: string }) => i.severity === "warn"));
    const free = await logs("user_an", "source=activity&user=user_free");
    assert.ok(free.body.items.length >= 1);
    assert.ok(free.body.items.every((i: { user: string; details: { account?: string } }) => i.user === "user_free" || i.details.account === "user_free"));
    const text = await logs("user_an", "source=activity&q=Chrome%20on%20Android");
    assert.deepEqual(text.body.items.map((i: { user: string }) => i.user), ["user_new"]);
    const aug = await logs("user_an", "source=activity&from=2026-08-03&to=2026-08-04&tz=UTC&type=meeting.joined");
    assert.deepEqual(aug.body.items.map((i: { user: string }) => i.user), ["user_j2", "user_j1"]);
    const tokyo = await logs("user_an", "source=activity&from=2026-08-03&to=2026-08-03&tz=Asia%2FTokyo&type=meeting.joined");
    assert.equal(tokyo.body.items.length, 0, "both joins are on the 4th in Tokyo");
    const p1 = await logs("user_an", "source=activity&limit=2&offset=0");
    const p2 = await logs("user_an", "source=activity&limit=2&offset=2");
    assert.equal(p1.body.items.length, 2);
    assert.equal(p1.body.total, p2.body.total);
    assert.ok(!p1.body.items.some((a: { id: string }) => p2.body.items.some((b: { id: string }) => a.id === b.id)));
  });

  await t("the admin audit is left out for an administrator without audit:read", async () => {
    const r = await logs("user_bill", "");
    assert.deepEqual(r.body.sources, ["activity", "meeting"]);
    assert.equal(r.body.adminAuditHidden, true);
    assert.ok(!r.body.items.some((i: { source: string }) => i.source === "admin"));
    assert.deepEqual((await logs("user_bill", "source=admin")).body.items, []);
  });

  console.log("exports and permissions");
  await t("analytics CSV: one report, BOM, zone in the header, formulas made inert", async () => {
    const r = await raw("user_an", R.analytics.GET, { query: "?from=2026-08-03&to=2026-08-23&tz=UTC&format=csv&report=accounts" });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(r.headers.get("content-disposition") ?? "", /neoconference-analytics-2026-08-03-to-2026-08-23-accounts\.csv/);
    // Response.text() drops a BOM, so look at the bytes.
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM so Excel reads names right");
    const text = bytes.subarray(3).toString("utf8");
    assert.match(text.split("\r\n")[0], /^Account,Email,User id,Plan,Meetings/);
    assert.ok(text.includes("'=SUM(1,2)"), "formula prefixed");
    assert.ok(!/(^|,)=SUM/m.test(text));
    const daily = await (await raw("user_an", R.analytics.GET, { query: "?from=2026-08-03&to=2026-08-04&tz=Asia%2FTokyo&format=csv&report=daily" })).text();
    assert.match(daily, /Day \(Asia\/Tokyo; active users by UTC day\)/);
  });

  await t("analytics Excel: every report as a sheet, with the cohort numbers", async () => {
    const r = await raw("user_an", R.analytics.GET, { query: "?from=2026-08-03&to=2026-08-23&tz=UTC&format=xlsx" });
    assert.match(r.headers.get("content-type") ?? "", /spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()) as never);
    assert.deepEqual(wb.worksheets.map((s) => s.name), ["Summary", "Daily", "Features", "Retention", "Accounts", "Plans"]);
    const row = wb.getWorksheet("Retention")!.getRow(2).values as unknown[];
    assert.deepEqual(row.slice(1, 6), ["2026-08-03", 5, 4, 2, 1]);
    const acct = wb.getWorksheet("Accounts")!;
    const labels: unknown[] = [];
    acct.eachRow((rw) => labels.push((rw.values as unknown[])[1]));
    assert.ok(labels.includes("'=SUM(1,2)"));
  });

  await t("log search export: CSV and Excel with local and UTC times", async () => {
    const csv = await (await raw("user_an", R.logs.GET, { query: "?source=activity&type=meeting.joined&from=2026-08-03&to=2026-08-04&tz=America%2FNew_York&format=csv" })).text();
    const lines = csv.split("\r\n");
    assert.match(lines[0], /^Time \(America\/New_York\),Time \(UTC\),Log,Event/);
    assert.ok(lines[1].startsWith("2026-08-03 20:30:00,2026-08-04T00:30:00.000Z,activity,meeting.joined"), lines[1]);
    const x = await raw("user_an", R.logs.GET, { query: "?format=xlsx" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()) as never);
    assert.equal(wb.worksheets[0].name, "Logs");
    assert.ok(wb.worksheets[0].rowCount > 5);
  });

  await t("permissions: analytics:read to look, reports:export to download, neither for Support", async () => {
    for (const h of [R.analytics.GET, R.logs.GET, R.records.GET]) {
      const s = await call("user_sup", h);
      assert.equal(s.body.error, "forbidden");
      assert.equal(s.body.permission, "analytics:read");
      assert.equal((await call("user_view", h)).status, 200);
      const ex = await call("user_view", h, { query: "?format=csv" });
      assert.equal(ex.body.error, "forbidden");
      assert.equal(ex.body.permission, "reports:export");
      assert.equal((await call("user_bill", h, { query: "?format=csv" })).status, 200);
    }
    delete jar.user_an;
    assert.equal((await call("user_an", R.analytics.GET)).body.error, "mfa_required");
    assert.equal((await call(null, R.logs.GET)).body.error, "signed_out");
  });

  console.log("contract for the account page (phase 2)");
  await t("the account page lists the person's activity, for administrators with analytics:read", async () => {
    const an = await call("user_owner", R.userPage.GET, { params: { id: "user_pro" } });
    assert.equal(an.status, 200, JSON.stringify(an.body));
    assert.ok(an.body.activity.some((e: { type: string }) => e.type === "meeting.created"));
    const sup = await call("user_sup", R.userPage.GET, { params: { id: "user_pro" } });
    assert.equal(sup.status, 200);
    assert.equal(sup.body.activity, null, "Support has users:read but not analytics:read");
  });
  await t("listUserActivity: newest first, limit and before", async () => {
    const all = await act.listUserActivity("user_pro");
    assert.ok(all.length >= 5);
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].ts >= all[i].ts);
    assert.equal((await act.listUserActivity("user_pro", { limit: 2 })).length, 2);
    const older = await act.listUserActivity("user_pro", { before: all[1].ts });
    assert.ok(older.every((e) => e.ts < all[1].ts));
  });

  finished = true;
  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
