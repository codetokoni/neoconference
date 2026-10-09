// Run: npx tsx src/lib/__tests__/platformSettings.smoke.ts
//
// Platform settings and feature controls (admin phase 5), driven through
// the real /api/admin routes, the real middleware and real enforcement
// points (the developer API, the recording gate, API-key creation), with
// Clerk, KV and R2 stood in for (./apiV1-stubs):
//
//   feature precedence (global off > account > plan switch > plan default)
//   and an enforcement point refusing; maintenance mode letting the owner,
//   administrators, /admin, sign-in, cron and webhooks through and nobody
//   else, never locking the owner out, and its in-memory cache; the
//   registration rules for new accounts; no secret in any response or in
//   the audit; webhook secret rotation and its grace period; permissions
//   and step-up.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

const SENTINEL = "lk_secret_SENTINEL_value_9f8e7d";
Object.assign(process.env, {
  CLERK_SECRET_KEY: "sk_test_platform_settings",
  PLATFORM_OWNER_EMAILS: "owner@example.com",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: SENTINEL,
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  S3_ACCESS_KEY: "a",
  S3_SECRET_KEY: "b",
  S3_ENDPOINT: "https://r2.test",
  S3_BUCKET: "bkt",
});
delete process.env.ADMIN_EMAILS;
delete process.env.RESEND_API_KEY;

type U = { plan?: string; role?: string; emails?: string[]; unverified?: string[]; first?: string; createdAt?: number };
type Stubbed = typeof globalThis & {
  __users: Record<string, U>;
  __who?: string;
  __kvStore: Map<string, unknown>;
  __clerkLists?: { allow: { identifier: string }[]; block: { id: string; identifier: string }[]; restrictions: Record<string, unknown>; seq: number };
  __r2Puts?: Map<string, { type: string; bytes: number }>;
};
const g = globalThis as Stubbed;

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

g.__users = {
  user_owner: { emails: ["owner@example.com"], plan: "free", createdAt: 1 },
  user_ops: { emails: ["ops@example.com"], createdAt: 1 },
  user_analyst: { emails: ["analyst@example.com"], createdAt: 1 },
  user_support: { emails: ["support@example.com"], createdAt: 1 },
  user_pro: { emails: ["pro@example.com"], plan: "pro", createdAt: 1 },
  user_free: { emails: ["free@example.com"], createdAt: 1 },
  user_oldblocked: { emails: ["early@blocked.test"], createdAt: 1 },
};

// Webhook receivers: every fetch the app makes is recorded here.
const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? "") });
  return new Response("ok", { status: 200 });
}) as typeof fetch;

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
  await fn();
  n++;
  console.log("  ok  " + name);
};

async function main() {
  const { NextRequest } = await import("next/server");
  const mfa = await import("../admin/mfa");
  const audit = await import("../admin/audit");
  const settings = await import("../platform/settings");
  const gate = await import("../platform/gate");
  const webhooks = await import("../platform/webhooks");
  const { recordingGate } = await import("../roomRecording");
  const middleware = (await import("../../middleware")).default as unknown as (req: InstanceType<typeof NextRequest>) => Promise<Response | undefined>;
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    team: await import("../../app/api/admin/team/route"),
    member: await import("../../app/api/admin/team/[userId]/route"),
    settings: await import("../../app/api/admin/settings/route"),
    logo: await import("../../app/api/admin/settings/logo/route"),
    features: await import("../../app/api/admin/features/route"),
    accounts: await import("../../app/api/admin/features/accounts/route"),
    maintenance: await import("../../app/api/admin/maintenance/route"),
    integrations: await import("../../app/api/admin/integrations/route"),
    webhooks: await import("../../app/api/admin/webhooks/route"),
    webhook: await import("../../app/api/admin/webhooks/[id]/route"),
    rotate: await import("../../app/api/admin/webhooks/[id]/rotate/route"),
    test: await import("../../app/api/admin/webhooks/[id]/test/route"),
    keys: await import("../../app/api/admin/api-keys/route"),
    key: await import("../../app/api/admin/api-keys/[id]/route"),
    keyRotate: await import("../../app/api/admin/api-keys/[id]/rotate/route"),
    clerk: await import("../../app/api/admin/registration/clerk/route"),
    devKeys: await import("../../app/api/developers/keys/route"),
    v1events: await import("../../app/api/v1/events/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  /** Everything any response said, to look for secrets in. */
  const transcript: string[] = [];

  async function call<P = Record<string, string>>(
    who: string | null,
    handler: (req: Request, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; form?: FormData; params?: P; query?: string } = {},
  ) {
    g.__who = who ?? undefined;
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (who && jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request(`https://www.neoconference.app/api/admin/x${opts.query ?? ""}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      }),
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m && who) jar[who] = decodeURIComponent(m[1]);
    const text = await res.text();
    transcript.push(text);
    let body: Record<string, unknown> & { error?: string; message?: string };
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
  }
  async function stepUp(who: string) {
    tick();
    const v = await call(who, R.verify.POST, { method: "POST", body: { code: code(who) } });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }

  /** The real middleware, as Next runs it. undefined = let through. */
  async function visit(who: string | null, path: string, method = "GET") {
    g.__who = who ?? undefined;
    const res = await middleware(new NextRequest(`https://www.neoconference.app${path}`, { method }));
    if (!res) return { status: 0, passed: true, body: "", location: null as string | null };
    const location = res.headers.get("location");
    const passed = res.status === 200 && !location && !res.headers.get("x-middleware-rewrite") ? true : !!res.headers.get("x-middleware-next");
    return { status: res.status, passed, body: await res.text(), location };
  }
  // The middleware runs on its own copy of the settings and gate modules
  // (only the stub store is shared), so its caches are aged with the clock,
  // never cleared from here.
  const fresh = () => tick(gate.ACCOUNT_CACHE_MS + 1);

  /* ------------------------------ administrators ------------------------------ */

  await enrollAndVerify("user_owner");
  await stepUp("user_owner");
  for (const [email, roleId] of [
    ["ops@example.com", "super_admin"],
    ["analyst@example.com", "analyst"],
    ["support@example.com", "support"],
  ]) {
    const r = await call("user_owner", R.team.POST, { method: "POST", body: { email, roleId } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  await enrollAndVerify("user_ops");
  await enrollAndVerify("user_analyst");
  await enrollAndVerify("user_support");

  console.log("permissions and step-up");
  await t("only roles holding the permission reach each section; non-admins get not_admin", async () => {
    assert.equal((await call("user_pro", R.settings.GET)).body.error, "not_admin");
    assert.equal((await call("user_analyst", R.settings.GET)).body.error, "forbidden");
    assert.equal((await call("user_analyst", R.features.GET)).body.permission, "features:write");
    assert.equal((await call("user_support", R.integrations.GET)).body.permission, "integrations:write");
    assert.equal((await call("user_support", R.keys.GET)).body.error, "forbidden");
    assert.equal((await call("user_support", R.maintenance.PUT, { method: "PUT", body: { enabled: true } })).body.error, "forbidden");
    assert.equal((await call("user_analyst", R.webhooks.POST, { method: "POST", body: { url: "https://x.example.net", events: ["webhook.test"] } })).body.error, "forbidden");
    assert.equal((await call(null, R.settings.GET)).status, 401);
  });

  await t("looking needs no fresh code; changing features, maintenance and integrations does", async () => {
    tick(11 * 60_000);
    assert.equal((await call("user_ops", R.features.GET)).status, 200);
    assert.equal((await call("user_ops", R.integrations.GET)).status, 200);
    assert.equal((await call("user_ops", R.maintenance.GET)).status, 200);
    assert.equal((await call("user_ops", R.features.PATCH, { method: "PATCH", body: { global: { captions: false } } })).body.error, "step_up_required");
    assert.equal((await call("user_ops", R.maintenance.PUT, { method: "PUT", body: { enabled: true } })).body.error, "step_up_required");
    assert.equal((await call("user_ops", R.webhooks.POST, { method: "POST", body: { url: "https://x.example.net", events: ["webhook.test"] } })).body.error, "step_up_required");
    assert.equal((await call("user_ops", R.accounts.PUT, { method: "PUT", body: { user: "pro@example.com", feature: "recording", value: "deny" } })).body.error, "step_up_required");
    // settings:write is not sensitive: branding saves on an ordinary admin session.
    const s = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "branding", value: { platformName: "Acme Meet" } } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
  });

  /* --------------------------------- settings --------------------------------- */

  console.log("settings");
  await t("branding, contacts, notice and regional save, are validated, and are audited before/after", async () => {
    const bad = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "contacts", value: { supportEmail: "nope", links: [] } } });
    assert.equal(bad.body.error, "invalid_email");
    const js = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "contacts", value: { supportEmail: "help@acme.test", links: [{ label: "Status", url: "javascript:alert(1)" }] } } });
    assert.equal(js.body.error, "invalid_url");
    const ok = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "contacts", value: { supportEmail: "Help@Acme.test", supportPhone: "+234 800 000", links: [{ label: "Status", url: "https://status.acme.test" }] } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const n1 = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "notice", value: { enabled: true, level: "critical", message: "Upgrade tonight", endsAt: Date.now() + 3600_000 } } });
    const notice = (n1.body.settings as { notice: { id: string; dismissible: boolean } }).notice;
    assert.equal(notice.dismissible, false, "critical notices are not dismissible unless chosen");
    const tz = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "regional", value: { defaultTimezone: "Mars/Olympus" } } });
    assert.equal(tz.body.error, "invalid_timezone");
    const reg = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "regional", value: { defaultLanguage: "fr", defaultTimezone: "Africa/Lagos", dateStyle: "iso", numberLocale: "de-DE", adminTimezone: "Africa/Lagos" } } });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    settings.clearSettingsCache();
    const live = await settings.getPlatformSettings();
    assert.equal(live.branding.platformName, "Acme Meet");
    assert.equal(live.contacts.supportEmail, "help@acme.test");
    assert.equal(live.regional.adminTimezone, "Africa/Lagos");
    const { items } = await audit.listAdminAudit({ action: "settings.branding.update" });
    assert.deepEqual(items[0].before, { platformName: "NeoConference" });
    assert.deepEqual(items[0].after, { platformName: "Acme Meet" });
    assert.equal(items[0].actorEmail, "ops@example.com");
  });

  await t("the logo upload checks size and the file's real type, and stores it in R2", async () => {
    const form = (bytes: Uint8Array, type: string) => {
      const f = new FormData();
      f.append("logo", new Blob([bytes as BlobPart], { type }), "logo");
      return f;
    };
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal((await call("user_ops", R.logo.POST, { method: "POST", form: form(svg, "image/png") })).body.error, "unsupported_type");
    const big = new Uint8Array(600 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal((await call("user_ops", R.logo.POST, { method: "POST", form: form(big, "image/png") })).body.error, "too_large");
    const png = new Uint8Array(64);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ok = await call("user_ops", R.logo.POST, { method: "POST", form: form(png, "application/octet-stream") });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    settings.clearSettingsCache();
    const key = (await settings.getPlatformSettings()).branding.logoKey!;
    assert.match(key, /^platform\/logo-\d+\.png$/);
    assert.equal(g.__r2Puts?.get(key)?.type, "image/png");
  });

  /* --------------------------------- features --------------------------------- */

  console.log("feature controls");
  // Typed for NextRequest; a plain Request is all it reads.
  const devKeysPost = R.devKeys.POST as unknown as (req: Request) => Promise<Response>;
  const devKey = async (who: string) => {
    const r = await call(who, devKeysPost, { method: "POST", body: { name: "ci" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body.data as { key: string; id: string });
  };
  const v1 = async (raw: string) => {
    const res = await (R.v1events.GET as unknown as (req: Request) => Promise<Response>)(
      new NextRequest("https://www.neoconference.app/api/v1/events", { headers: { authorization: `Bearer ${raw}` } }),
    );
    return { status: res.status, body: (await res.json()) as { error?: { code?: string; message?: string } | string; message?: string } };
  };
  const errCode = (b: { error?: unknown }) => (typeof b.error === "object" && b.error ? (b.error as { code?: string }).code : b.error);

  const proKey = await devKey("user_pro");
  const freeKey = await devKey("user_free");

  await t("precedence through the developer API: plan switch, account allow over it, global off over everything", async () => {
    assert.equal((await v1(proKey.key)).status, 200);
    await stepUp("user_ops");
    const off = await call("user_ops", R.features.PATCH, { method: "PATCH", body: { perPlan: { developer_api: { pro: false } } } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const refused = await v1(proKey.key);
    assert.equal(refused.status, 403);
    assert.equal(errCode(refused.body), "feature_disabled");
    assert.equal((await v1(freeKey.key)).status, 200, "the free plan is untouched");

    const allow = await call("user_ops", R.accounts.PUT, { method: "PUT", body: { user: "pro@example.com", feature: "developer_api", value: "allow" } });
    assert.equal(allow.status, 200, JSON.stringify(allow.body));
    assert.equal((allow.body.decisions as Record<string, { source: string }>).developer_api.source, "account");
    assert.equal((await v1(proKey.key)).status, 200, "an account allow beats the plan switch");

    const globalOff = await call("user_ops", R.features.PATCH, { method: "PATCH", body: { global: { developer_api: false } } });
    assert.equal(globalOff.status, 200);
    const g1 = await v1(proKey.key);
    assert.equal(g1.status, 403, "global off beats the account allow");
    assert.match(String((g1.body.error as { message?: string })?.message ?? g1.body.message ?? JSON.stringify(g1.body)), /turned off on the platform/);
    const mint = await call("user_free", devKeysPost, { method: "POST", body: { name: "x" } });
    assert.equal(mint.body.error, "feature_disabled", "no new keys while the API is off");

    await call("user_ops", R.features.PATCH, { method: "PATCH", body: { global: { developer_api: true }, perPlan: { developer_api: null } } });
    await call("user_ops", R.accounts.PUT, { method: "PUT", body: { user: "pro@example.com", feature: "developer_api", value: null } });
    assert.equal((await v1(proKey.key)).status, 200, "back to the plan default");
  });

  await t("recording: plan default refuses Free, an account allow records anyway, a deny or global off refuses even the owner", async () => {
    const free = await recordingGate("user_free");
    assert.equal(free.ok, false);
    assert.equal(!free.ok && free.code, "plan_upgrade_required");
    await call("user_ops", R.accounts.PUT, { method: "PUT", body: { user: "free@example.com", feature: "recording", value: "allow" } });
    assert.equal((await recordingGate("user_free")).ok, true);
    await call("user_ops", R.accounts.PUT, { method: "PUT", body: { user: "pro@example.com", feature: "recording", value: "deny" } });
    const pro = await recordingGate("user_pro");
    assert.equal(!pro.ok && pro.code, "feature_disabled");
    assert.equal((await recordingGate("user_owner")).ok, true);
    await call("user_ops", R.features.PATCH, { method: "PATCH", body: { global: { recording: false } } });
    const owner = await recordingGate("user_owner");
    assert.equal(!owner.ok && owner.code, "feature_disabled");
    await call("user_ops", R.features.PATCH, { method: "PATCH", body: { global: { recording: true } } });
  });

  await t("catalog features cannot get per-plan switches here; the owner cannot be overridden; changes are audited", async () => {
    const r = await call("user_ops", R.features.PATCH, { method: "PATCH", body: { perPlan: { recording: { free: true } } } });
    assert.equal(r.body.error, "plan_catalog_owns");
    const o = await call("user_ops", R.accounts.PUT, { method: "PUT", body: { user: "owner@example.com", feature: "recording", value: "deny" } });
    assert.equal(o.body.error, "owner_protected");
    const { items } = await audit.listAdminAudit({ action: "feature.account_override", target: "pro@example.com" });
    assert.deepEqual(items[0].after, { recording: "deny" });
    const fx = await audit.listAdminAudit({ action: "feature.update" });
    assert.ok(fx.items.some((e) => JSON.stringify(e.after).includes('"recording":false')));
    const view = await call("user_analyst", R.features.GET);
    assert.equal(view.body.error, "forbidden");
    const ops = await call("user_ops", R.features.GET);
    assert.equal((ops.body.catalog as Record<string, Record<string, boolean>>).pro.recording, true, "per-plan values of catalog features come from the plan");
  });

  /* -------------------------------- maintenance ------------------------------- */

  console.log("maintenance mode");
  await t("off: nothing is gated", async () => {
    fresh();
    assert.equal((await visit("user_free", "/dashboard")).passed, true);
    assert.equal((await visit(null, "/")).passed, true);
  });

  await t("on: pages show the maintenance screen and the API answers 503 with the message — for everyone but staff", async () => {
    await stepUp("user_ops");
    const on = await call("user_ops", R.maintenance.PUT, { method: "PUT", body: { enabled: true, message: "Back at 22:00 <b>UTC</b>" } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const page = await visit("user_free", "/dashboard");
    assert.equal(page.status, 503);
    assert.match(page.body, /data-maintenance="on"/);
    assert.match(page.body, /Back at 22:00 &lt;b&gt;UTC&lt;\/b&gt;/, "the message is escaped");
    assert.match(page.body, /Acme Meet/);
    const api = await visit("user_free", "/api/events/mine");
    assert.equal(api.status, 503);
    assert.deepEqual(JSON.parse(api.body).error, "maintenance");
    assert.equal(JSON.parse(api.body).message, "Back at 22:00 <b>UTC</b>");
    assert.equal((await visit(null, "/")).status, 503, "signed out too");
    assert.equal((await visit(null, "/some-meeting")).status, 503, "short meeting links too");
  });

  await t("the owner and administrators use the whole site; /admin, sign-in, health, cron and webhooks stay open to all", async () => {
    assert.equal((await visit("user_owner", "/dashboard")).passed, true);
    assert.equal((await visit("user_owner", "/api/events/mine")).passed, true);
    assert.equal((await visit("user_ops", "/dashboard")).passed, true);
    assert.equal((await visit("user_analyst", "/api/events/mine")).passed, true, "any active administrator");
    for (const p of ["/admin", "/admin/features", "/api/admin/maintenance", "/sign-in", "/api/health", "/api/version", "/api/cron/downgrade-expired-plans", "/api/livekit/webhook", "/api/stripe/webhook", "/api/transcribe/deepgram", "/api/comms/resend-webhook", "/api/comms/unsubscribe"]) {
      const r = await visit(p.startsWith("/api/cron") || p.includes("webhook") || p.includes("deepgram") ? null : "user_free", p, p.includes("webhook") || p.includes("deepgram") ? "POST" : "GET");
      assert.notEqual(r.status, 503, `${p} must stay open`);
    }
  });

  await t("it cannot lock the owner out: no KV record, a broken settings store, or the admin route itself", async () => {
    // The owner is recognised from the environment, not from anything stored.
    const members = g.__kvStore.get("neo:admin:members");
    g.__kvStore.delete("neo:admin:members");
    fresh();
    assert.equal((await visit("user_owner", "/dashboard")).passed, true);
    g.__kvStore.set("neo:admin:members", members);
    // A settings store that cannot be read means maintenance is off.
    // (A value the stub cannot clone makes its get() throw, in every copy.)
    const keep = ["neo:settings:features", "neo:settings:platform"].map((k) => [k, g.__kvStore.get(k)] as const);
    for (const [k] of keep) g.__kvStore.set(k, () => "unreadable");
    fresh();
    const failOpen = await visit("user_free", "/dashboard");
    assert.equal(failOpen.passed, true, "fails open: " + JSON.stringify({ ...failOpen, body: failOpen.body.slice(0, 200) }));
    for (const [k, v] of keep) g.__kvStore.set(k, v);
    fresh();
    assert.equal((await visit("user_free", "/dashboard")).status, 503);
    // The switch lives under /api/admin, which maintenance never blocks.
    assert.notEqual((await visit("user_owner", "/api/admin/maintenance", "PUT")).status, 503);
  });

  await t("a suspended administrator is shut out like everyone else", async () => {
    await stepUp("user_owner");
    const s = await call("user_owner", R.member.PATCH, { method: "PATCH", params: { userId: "user_analyst" }, body: { status: "suspended", reason: "test" } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    fresh();
    assert.equal((await visit("user_analyst", "/dashboard")).status, 503);
    await stepUp("user_owner");
    await call("user_owner", R.member.PATCH, { method: "PATCH", params: { userId: "user_analyst" }, body: { status: "active" } });
    fresh();
  });

  await t("reads are cached for a few seconds: another instance's change lands after the window, not before", async () => {
    assert.equal((await visit("user_free", "/dashboard")).status, 503, "warm the cache");
    const stored = JSON.parse(String(g.__kvStore.get("neo:settings:features")));
    stored.maintenance.enabled = false;
    g.__kvStore.set("neo:settings:features", JSON.stringify(stored)); // as another server instance would
    assert.equal((await visit("user_free", "/dashboard")).status, 503, "still the cached value");
    tick(settings.CACHE_MS + 1);
    assert.equal((await visit("user_free", "/dashboard")).passed, true, "picked up after the window");
  });

  await t("an end time turns it off by itself; turning off is audited and sends the webhook event", async () => {
    await stepUp("user_ops");
    const r = await call("user_ops", R.maintenance.PUT, { method: "PUT", body: { enabled: true, endsAt: Date.now() + 60 * 60_000 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await visit("user_free", "/dashboard")).status, 503);
    const api = await visit("user_free", "/api/x");
    assert.ok(Number(JSON.parse(api.body).endsAt) > Date.now());
    tick(61 * 60_000);
    fresh();
    assert.equal((await visit("user_free", "/dashboard")).passed, true);
    await stepUp("user_ops");
    await call("user_ops", R.maintenance.PUT, { method: "PUT", body: { enabled: false } });
    const { items } = await audit.listAdminAudit({ action: "maintenance." });
    assert.ok(items.some((e) => e.action === "maintenance.on"));
    assert.deepEqual(items.find((e) => e.action === "maintenance.on")!.after && Object.keys(items.find((e) => e.action === "maintenance.on")!.after as object), ["enabled", "message", "endsAt"]);
  });

  /* ------------------------------- registration ------------------------------- */

  console.log("registration rules");
  const newUser = (id: string, u: U) => {
    g.__users[id] = { createdAt: Date.now() + 1000, ...u };
  };
  const saveReg = async (value: unknown) => {
    const r = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "registration", value } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    fresh();
  };

  await t("a blocked domain refuses new accounts with the reason — page and API — and leaves older accounts alone", async () => {
    await saveReg({ mode: "open", blockDomains: ["blocked.test"] });
    newUser("user_newblocked", { emails: ["late@sub.blocked.test"] });
    const page = await visit("user_newblocked", "/dashboard");
    assert.equal(page.status, 307);
    assert.match(page.location!, /\/access-blocked\?reason=domain_blocked$/);
    const api = await visit("user_newblocked", "/api/events/mine");
    assert.equal(api.status, 403);
    assert.equal(JSON.parse(api.body).reason, "domain_blocked");
    assert.equal((await visit("user_newblocked", "/access-blocked")).passed, true, "the explanation page is reachable");
    assert.equal((await visit("user_newblocked", "/sign-out")).passed, true);
    assert.equal((await visit("user_oldblocked", "/dashboard")).passed, true, "an account from before the rule");
  });

  await t("allow-list, invite-only, closed and verified-email rules; staff always pass; a passed account stays passed", async () => {
    await saveReg({ mode: "open", allowDomains: ["example.com"] });
    newUser("user_other", { emails: ["x@other.test"] });
    assert.match((await visit("user_other", "/dashboard")).location ?? "", /domain_not_allowed/);
    newUser("user_ok", { emails: ["fine@example.com"] });
    assert.equal((await visit("user_ok", "/dashboard")).passed, true);

    await saveReg({ mode: "invite_only", invited: ["invited@example.com"] });
    newUser("user_inv", { emails: ["invited@example.com"] });
    newUser("user_uninv", { emails: ["walkin@example.com"] });
    assert.equal((await visit("user_inv", "/dashboard")).passed, true);
    assert.match((await visit("user_uninv", "/dashboard")).location ?? "", /invite_only/);
    assert.equal((await visit("user_ok", "/dashboard")).passed, true, "user_ok passed under the earlier rules and keeps its access");

    await saveReg({ mode: "closed", requireVerifiedEmail: true });
    newUser("user_late", { emails: ["late@example.com"] });
    assert.match((await visit("user_late", "/dashboard")).location ?? "", /signup_closed/);
    g.__users.user_staffnew = { emails: ["staffnew@example.com"], createdAt: Date.now() + 1000 };
    await stepUp("user_owner");
    assert.equal((await call("user_owner", R.team.POST, { method: "POST", body: { email: "staffnew@example.com", roleId: "analyst" } })).status, 201);
    fresh();
    assert.equal((await visit("user_staffnew", "/dashboard")).passed, true, "an administrator passes every rule");

    await saveReg({ mode: "open", requireVerifiedEmail: true });
    newUser("user_unverified", { unverified: ["new@example.com"] });
    assert.match((await visit("user_unverified", "/dashboard")).location ?? "", /email_unverified/);
    g.__users.user_unverified.emails = ["new@example.com"];
    g.__users.user_unverified.unverified = [];
    fresh();
    assert.equal((await visit("user_unverified", "/dashboard")).passed, true, "verified now: let in, nothing sticky about a refusal");
    await saveReg({ mode: "open" });
  });

  await t("the same domain cannot be allowed and blocked; trials policy is readable for Plans", async () => {
    const r = await call("user_ops", R.settings.PATCH, { method: "PATCH", body: { section: "registration", value: { allowDomains: ["a.test"], blockDomains: ["a.test"] } } });
    assert.equal(r.body.error, "allowed_and_blocked");
    await saveReg({ mode: "open", trials: { enabled: false, defaultDays: 7 } });
    settings.clearSettingsCache();
    assert.deepEqual(await settings.getTrialPolicy(), { enabled: false, defaultDays: 7 });
  });

  await t("Clerk's blocklist gets the blocked domains — never one that would catch staff — and loses ours when unblocked", async () => {
    await saveReg({ mode: "open", blockDomains: ["example.com"] });
    assert.equal((await call("user_ops", R.clerk.POST, { method: "POST" })).body.error, "step_up_required", "pushing to Clerk needs a fresh code");
    await stepUp("user_ops");
    const clash = await call("user_ops", R.clerk.POST, { method: "POST" });
    assert.equal(clash.body.error, "would_block_staff");
    assert.equal(g.__clerkLists?.block.length ?? 0, 0);
    g.__clerkLists = { allow: [], block: [{ id: "block_manual", identifier: "manual@x.test" }], restrictions: {}, seq: 0 };
    await saveReg({ mode: "open", blockDomains: ["blocked.test", "spam.test"] });
    const ok = await call("user_ops", R.clerk.POST, { method: "POST" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(g.__clerkLists!.block.map((b) => b.identifier).sort(), ["*@blocked.test", "*@spam.test", "manual@x.test"]);
    assert.equal(g.__clerkLists!.restrictions.blocklist, true);
    await saveReg({ mode: "open", blockDomains: ["blocked.test"] });
    const again = await call("user_ops", R.clerk.POST, { method: "POST" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(g.__clerkLists!.block.map((b) => b.identifier).sort(), ["*@blocked.test", "manual@x.test"], "the dashboard's own entry is left alone");
    await saveReg({ mode: "open" });
  });

  /* --------------------------------- secrets --------------------------------- */

  console.log("integrations, webhooks and keys");
  let endpointId = "";
  let secret1 = "";
  await t("integrations show configured / not configured and a fingerprint — never a value", async () => {
    const r = await call("user_ops", R.integrations.GET);
    const list = r.body.integrations as { id: string; state: string; vars: { name: string; set: boolean; fingerprint: string | null }[] }[];
    const lk = list.find((i) => i.id === "livekit")!;
    assert.equal(lk.state, "configured");
    const v = lk.vars.find((x) => x.name === "LIVEKIT_API_SECRET")!;
    assert.match(String(v.fingerprint), /^[0-9a-f]{8}$/);
    assert.equal(list.find((i) => i.id === "stripe")!.state, "not_configured");
    assert.ok(!JSON.stringify(r.body).includes(SENTINEL));
    assert.ok((r.body.rotation as { steps: string[] }).steps.some((s) => /Vercel/.test(s)));
  });

  await t("webhooks: only public https addresses; the secret is shown once and signs deliveries", async () => {
    await stepUp("user_ops");
    for (const url of ["http://hooks.example.net/x", "https://localhost/x", "https://10.1.2.3/x", "https://192.168.1.5/x"]) {
      assert.equal((await call("user_ops", R.webhooks.POST, { method: "POST", body: { url, events: ["webhook.test"] } })).body.error, "invalid_url", url);
    }
    const c = await call("user_ops", R.webhooks.POST, { method: "POST", body: { url: "https://hooks.example.net/neo", events: ["webhook.test", "maintenance.started"] } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    secret1 = c.body.secret as string;
    endpointId = (c.body.endpoint as { id: string }).id;
    assert.match(secret1, /^whsec_[0-9a-f]{64}$/);
    const list = await call("user_ops", R.webhooks.GET);
    assert.ok(!JSON.stringify(list.body).includes(secret1), "never again after creation");
    sent.length = 0;
    const tst = await call("user_ops", R.test.POST, { method: "POST", params: { id: endpointId } });
    assert.equal((tst.body.delivery as { ok: boolean }).ok, true);
    assert.equal(sent.length, 1);
    assert.ok(webhooks.verifyWebhookSignature(sent[0].headers["x-neo-signature"], sent[0].body, secret1));
    assert.ok(!webhooks.verifyWebhookSignature(sent[0].headers["x-neo-signature"], sent[0].body.replace("test", "tset"), secret1), "a changed body fails");
  });

  await t("rotation: the old secret keeps signing through the grace period, then stops; grace 0 retires it at once", async () => {
    await stepUp("user_ops");
    const r = await call("user_ops", R.rotate.POST, { method: "POST", params: { id: endpointId }, body: { graceHours: 24 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const secret2 = r.body.secret as string;
    assert.notEqual(secret2, secret1);
    sent.length = 0;
    await stepUp("user_ops");
    await call("user_ops", R.test.POST, { method: "POST", params: { id: endpointId } });
    const h = sent[0].headers["x-neo-signature"];
    assert.ok(webhooks.verifyWebhookSignature(h, sent[0].body, secret2), "new secret signs");
    assert.ok(webhooks.verifyWebhookSignature(h, sent[0].body, secret1), "old secret still signs in the grace period");
    tick(25 * 3600_000);
    sent.length = 0;
    await stepUp("user_ops");
    await call("user_ops", R.test.POST, { method: "POST", params: { id: endpointId } });
    const h2 = sent[0].headers["x-neo-signature"];
    assert.ok(webhooks.verifyWebhookSignature(h2, sent[0].body, secret2));
    assert.ok(!webhooks.verifyWebhookSignature(h2, sent[0].body, secret1), "old secret retired after the grace period");
    await stepUp("user_ops");
    const r3 = await call("user_ops", R.rotate.POST, { method: "POST", params: { id: endpointId }, body: { graceHours: 0 } });
    const secret3 = r3.body.secret as string;
    sent.length = 0;
    await stepUp("user_ops");
    await call("user_ops", R.test.POST, { method: "POST", params: { id: endpointId } });
    assert.ok(!webhooks.verifyWebhookSignature(sent[0].headers["x-neo-signature"], sent[0].body, secret2));
    assert.ok(webhooks.verifyWebhookSignature(sent[0].headers["x-neo-signature"], sent[0].body, secret3));
    const view = await call("user_ops", R.webhooks.GET);
    assert.equal(((view.body.endpoints as { secrets: unknown[] }[])[0].secrets).length, 1);
    assert.ok((view.body.deliveries as unknown[]).length >= 4, "deliveries are logged");
    for (const s of [secret1, secret2, secret3]) assert.ok(!JSON.stringify(view.body).includes(s));
  });

  await t("API keys: listed platform-wide masked; revoke and rotate work; the new key is shown once", async () => {
    const list = await call("user_ops", R.keys.GET);
    const keys = list.body.keys as { id: string; maskedKey: string; ownerEmail: string | null }[];
    assert.ok(keys.some((k) => k.id === proKey.id && k.ownerEmail === "pro@example.com"));
    assert.ok(!JSON.stringify(list.body).includes(proKey.key) && !JSON.stringify(list.body).includes(freeKey.key));
    await stepUp("user_ops");
    assert.equal((await call("user_ops", R.key.DELETE, { method: "DELETE", params: { id: freeKey.id } })).status, 200);
    assert.equal(errCode((await v1(freeKey.key)).body), "revoked_api_key");
    await stepUp("user_ops");
    const rot = await call("user_ops", R.keyRotate.POST, { method: "POST", params: { id: proKey.id } });
    assert.equal(rot.status, 201, JSON.stringify(rot.body));
    const fresh2 = rot.body.secret as string;
    assert.match(fresh2, /^nc_live_[0-9a-f]{48}$/);
    assert.equal(errCode((await v1(proKey.key)).body), "revoked_api_key", "the old key stops at once");
    assert.equal((await v1(fresh2)).status, 200, "the new one works");
    const again = await call("user_ops", R.keys.GET);
    assert.ok(!JSON.stringify(again.body).includes(fresh2));
  });

  await t("no secret anywhere in the audit log; webhook secrets appear only as fingerprints", async () => {
    const { items } = await audit.listAdminAudit({ limit: 1000 });
    const all = JSON.stringify(items);
    assert.ok(!all.includes(SENTINEL));
    assert.ok(!/whsec_[0-9a-f]{20,}/.test(all), "no webhook secret");
    assert.ok(!/nc_live_[0-9a-f]{20,}/.test(all), "no raw API key");
    assert.ok(items.some((e) => e.action === "webhook.rotate_secret" && /"newSecretFingerprint":"[0-9a-f]{8}"/.test(JSON.stringify(e.after))));
    assert.ok(items.some((e) => e.action === "api_key.rotate"));
    // And no response other than the one-time ones carried a secret.
    const leaks = transcript.filter((x) => x.includes(SENTINEL));
    assert.equal(leaks.length, 0);
  });

  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
