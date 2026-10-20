// Run: npx tsx src/lib/__tests__/adminPartners.smoke.ts
//
// Admin > Integrations > Partner zones (src/app/api/admin/partners): who
// may manage partner websites, a new key shown once and only once, and that
// each change takes effect where it matters — the partner's own API
// (/api/partner/v1/join-sessions), the embed page's framing, and the zone's
// meeting — with every change in the admin audit log and no secret in any
// answer or log entry. Driven through the real routes with Clerk, KV and
// LiveKit stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "t",
  CLERK_SECRET_KEY: "sk_test_admin_partners",
  PLATFORM_OWNER_EMAILS: "owner@example.com",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  PARTNER_EMBED_SECRET: "partner-embed-secret-for-tests-0123456789",
});
delete process.env.ADMIN_EMAILS;

type G = typeof globalThis & { __users: Record<string, { plan?: string; emails?: string[] }>; __who?: string; __kvTtl?: boolean };
const g = globalThis as G;
g.__kvTtl = true;
g.__users = {
  user_owner: { emails: ["owner@example.com"] },
  user_super: { emails: ["super@example.com"] },
  user_analyst: { emails: ["analyst@example.com"] },
  user_plain: { emails: ["plain@example.com"] },
  user_church: { plan: "pro", emails: ["church@example.com"] },
  user_pastor: { plan: "business", emails: ["pastor@example.com"] },
};

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const tick = (ms = 30_000) => {
  skew += ms;
};

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
const PC = "https://herald.prayerclouds.org";

async function main() {
  const mfa = await import("../admin/mfa");
  const audit = await import("../admin/audit");
  const store = await import("../admin/store");
  const S = await import("../partners/store");
  const { eventStore } = await import("../eventStore");
  const { NextRequest } = await import("next/server");
  const R = {
    enroll: await import("../../app/api/admin/mfa/enroll/route"),
    confirm: await import("../../app/api/admin/mfa/confirm/route"),
    verify: await import("../../app/api/admin/mfa/verify/route"),
    list: await import("../../app/api/admin/partners/route"),
    one: await import("../../app/api/admin/partners/[id]/route"),
    keys: await import("../../app/api/admin/partners/[id]/keys/route"),
    key: await import("../../app/api/admin/partners/[id]/keys/[keyId]/route"),
    zones: await import("../../app/api/admin/partners/[id]/zones/route"),
    zone: await import("../../app/api/admin/partners/[id]/zones/[zone]/route"),
    sessions: await import("../../app/api/partner/v1/join-sessions/route"),
  };

  const jar: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  /** Every admin answer, to sweep for secrets at the end. */
  const answers: string[] = [];
  async function call<P = Record<string, string>>(
    who: string,
    handler: (req: never, ctx: { params: P }) => Promise<Response>,
    opts: { method?: string; body?: unknown; params?: P } = {},
  ) {
    g.__who = who;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (jar[who]) headers.cookie = `neo_admin_mfa=${jar[who]}`;
    const res = await handler(
      new Request("https://neolinguameet.com/api/admin/partners", { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }) as never,
      { params: (opts.params ?? {}) as P },
    );
    const m = res.headers.get("set-cookie")?.match(/neo_admin_mfa=([^;]*)/);
    if (m) jar[who] = decodeURIComponent(m[1]);
    const text = await res.text();
    answers.push(text);
    let body: J;
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body };
  }
  const code = (who: string) => mfa.totpAt(mfa.base32Decode(secrets[who]), mfa.currentStep());
  async function enroll(who: string) {
    const e = await call(who, R.enroll.POST as never, { method: "POST" });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    secrets[who] = e.body.secret as string;
    tick();
    assert.equal((await call(who, R.confirm.POST as never, { method: "POST", body: { code: code(who) } })).status, 200);
  }
  async function stepUp(who: string) {
    tick();
    assert.equal((await call(who, R.verify.POST as never, { method: "POST", body: { code: code(who) } })).status, 200);
  }

  /** The partner's backend asking for a code, as PrayerClouds' server would. */
  let ip = 1;
  const issue = async (key: string, zoneId = "FALF", origin = PC) => {
    const res = await R.sessions.POST(
      new NextRequest("https://neolinguameet.com/api/partner/v1/join-sessions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-forwarded-for": `10.1.0.${ip++ % 250}` },
        body: JSON.stringify({ zoneId, origin, user: { id: "pc_1", displayName: "Grace" } }),
      }),
    );
    return { status: res.status, body: (await res.json()) as J };
  };

  const now = Date.now();
  for (const [userId, email, roleId] of [
    ["user_super", "super@example.com", "super_admin"],
    ["user_analyst", "analyst@example.com", "analyst"],
  ]) {
    await store.saveMember({ userId, email, name: email, roleId, status: "active", appointedBy: "user_owner", appointedAt: now, updatedAt: now });
  }
  for (const who of ["user_super", "user_analyst"]) await enroll(who);

  // A page address pasted in place of the site: only its origin is kept.
  const create = { name: "PrayerClouds", ownerEmail: "church@example.com", origins: `${PC}/zone/FALF\nhttp://localhost:3000`, titleTemplate: "{zone} Prayer Meeting" };
  let id = "";
  let firstKey = "";

  await t("only an administrator with integrations:write manages partners, and changing needs a fresh code", async () => {
    assert.equal((await call("user_plain", R.list.GET as never)).body.error, "not_admin");
    const analyst = await call("user_analyst", R.list.GET as never);
    assert.equal(analyst.body.error, "forbidden");
    assert.equal(analyst.body.permission, "integrations:write");
    assert.equal((await call("user_analyst", R.list.POST as never, { method: "POST", body: create })).body.error, "forbidden");
    // Reading needs no fresh code; making one does.
    tick(20 * 60_000);
    assert.equal((await call("user_super", R.list.GET as never)).status, 200);
    assert.equal((await call("user_super", R.list.POST as never, { method: "POST", body: create })).body.error, "step_up_required");
    assert.equal((await S.listIntegrations()).length, 0);
  });

  await t("adding a partner: checked input, the key shown once, and it works for the partner's server", async () => {
    await stepUp("user_super");
    for (const origins of ["http://herald.prayerclouds.org", "javascript:alert(1)", "herald.prayerclouds.org", "https://user:pw@herald.prayerclouds.org"]) {
      const badSite = await call("user_super", R.list.POST as never, { method: "POST", body: { ...create, origins } });
      assert.equal(badSite.status, 400, origins);
      assert.equal(badSite.body.error, "invalid_origin", origins);
    }
    const noOwner = await call("user_super", R.list.POST as never, { method: "POST", body: { ...create, ownerEmail: "nobody@example.com" } });
    assert.equal(noOwner.body.error, "owner_not_found");

    const made = await call("user_super", R.list.POST as never, { method: "POST", body: create });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    id = made.body.integration.id;
    firstKey = made.body.secret;
    assert.match(firstKey, /^nlm_pk_[0-9a-f]{8}_[0-9a-f]{48}$/);
    assert.equal(made.body.integration.ownerUserId, "user_church");
    assert.deepEqual(made.body.integration.origins, [PC, "http://localhost:3000"]);
    assert.equal(made.body.integration.autoCreateZones, true);
    assert.equal(made.body.integration.guestAccess, false);

    // Never again: neither the list nor the detail carries it.
    const list = await call("user_super", R.list.GET as never);
    assert.equal(list.body.integrations[0].activeKeys, 1);
    const detail = await call("user_super", R.one.GET as never, { params: { id } });
    assert.ok(!JSON.stringify(list.body).includes(firstKey) && !JSON.stringify(detail.body).includes(firstKey));
    assert.ok(detail.body.keys[0].masked.endsWith(firstKey.slice(-4)));

    const s = await issue(firstKey);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.meeting.title, "FALF Prayer Meeting");
  });

  await t("approved websites and switching off take effect for the partner's API and the embed's framing", async () => {
    const middleware = (await import("../../middleware")).default as unknown as (req: InstanceType<typeof NextRequest>, ev: unknown) => Promise<Response | undefined>;
    const frame = async () => (await middleware(new NextRequest("https://neolinguameet.com/embed/zone", { headers: { host: "neolinguameet.com" } }), { waitUntil() {} }))?.headers.get("content-security-policy") ?? "";
    assert.ok((await frame()).includes(PC));

    const NEW = "https://zones.prayerclouds.org";
    const up = await call("user_super", R.one.PATCH as never, { method: "PATCH", params: { id }, body: { origins: NEW, guestAccess: true } });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal((await issue(firstKey)).body.error.code, "origin_not_approved");
    assert.equal((await issue(firstKey, "FALF", NEW)).status, 201);
    // The framing cache lives a minute.
    tick(61_000);
    const csp = await frame();
    assert.ok(csp.includes(NEW) && !csp.includes(PC), csp);

    assert.equal((await call("user_super", R.one.PATCH as never, { method: "PATCH", params: { id }, body: { status: "disabled" } })).status, 200);
    assert.equal((await issue(firstKey, "FALF", NEW)).body.error.code, "integration_disabled");
    assert.equal((await call("user_super", R.one.PATCH as never, { method: "PATCH", params: { id }, body: { status: "active" } })).status, 200);
    assert.equal((await call("user_super", R.one.PATCH as never, { method: "PATCH", params: { id }, body: { origins: [PC, NEW] } })).status, 200);
    assert.equal((await call("user_super", R.one.PATCH as never, { method: "PATCH", params: { id }, body: {} })).body.error, "nothing_to_change");
  });

  let secondKey = "";
  await t("keys: a second key works alongside the first; a revoked key stops at once", async () => {
    const k = await call("user_super", R.keys.POST as never, { method: "POST", params: { id } });
    assert.equal(k.status, 201);
    secondKey = k.body.secret;
    assert.equal((await issue(secondKey)).status, 201);
    assert.equal((await issue(firstKey)).status, 201);
    const first = (await S.listPartnerKeys(id)).find((m) => firstKey.startsWith(m.masked.split("…")[0]))!;
    assert.equal((await call("user_super", R.key.DELETE as never, { method: "DELETE", params: { id, keyId: first.id } })).status, 200);
    assert.equal((await issue(firstKey)).status, 401);
    assert.equal((await issue(secondKey)).status, 201);
    assert.equal((await call("user_super", R.key.DELETE as never, { method: "DELETE", params: { id, keyId: "nope" } })).status, 404);
  });

  await t("zones: switch one off and on, give it to another owner, connect a zone to an existing meeting", async () => {
    const off = await call("user_super", R.zone.PATCH as never, { method: "PATCH", params: { id, zone: "FALF" }, body: { status: "disabled" } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal((await issue(secondKey)).body.error.code, "zone_disabled");
    assert.equal((await call("user_super", R.zone.PATCH as never, { method: "PATCH", params: { id, zone: "falf" }, body: { status: "active" } })).status, 200);
    assert.equal((await issue(secondKey)).status, 201);

    const moved = await call("user_super", R.zone.PATCH as never, { method: "PATCH", params: { id, zone: "FALF" }, body: { ownerEmail: "pastor@example.com" } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const ev = await eventStore.byId((await S.getZone(id, "FALF"))!.eventId);
    assert.equal(ev?.ownerUserId, "user_pastor");
    assert.equal((await call("user_super", R.zone.PATCH as never, { method: "PATCH", params: { id, zone: "NOPE" }, body: { status: "disabled" } })).status, 404);

    const at = new Date().toISOString();
    await eventStore.create({ id: "ev_lagos", slug: "lagos-prayer", name: "Lagos Prayer", ownerUserId: "user_pastor", state: "live", createdAt: at, updatedAt: at, roles: [] } as unknown as Parameters<typeof eventStore.create>[0]);
    const c = await call("user_super", R.zones.POST as never, { method: "POST", params: { id }, body: { zoneId: "lagos-1", meeting: "https://neolinguameet.com/lagos-prayer" } });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.zone.zoneId, "LAGOS-1");
    assert.equal(c.body.zone.eventId, "ev_lagos");
    const s = await issue(secondKey, "LAGOS-1");
    assert.equal(s.body.meeting.title, "Lagos Prayer");
    assert.equal((await call("user_super", R.zones.POST as never, { method: "POST", params: { id }, body: { zoneId: "X", meeting: "no-such-meeting" } })).body.error, "meeting_not_found");
  });

  await t("every change is in the admin audit log and the partner's own history, with no secret anywhere", async () => {
    const actions = (await audit.listAdminAudit({})).items.map((e) => e.action);
    for (const a of ["partner.create", "partner.update", "partner.disable", "partner.enable", "partner.key.create", "partner.key.revoke", "partner.zone.disable", "partner.zone.enable", "partner.zone.owner", "partner.zone.connect"]) {
      assert.ok(actions.includes(a), `${a} missing from ${actions.join(", ")}`);
    }
    const detail = await call("user_super", R.one.GET as never, { params: { id } });
    const history = (detail.body.audit as J[]).map((e) => e.action);
    assert.ok(history.includes("zone.owner") && history.includes("key.revoke"), history.join(", "));
    const logged = JSON.stringify((await audit.listAdminAudit({})).items) + JSON.stringify(await S.listAudit(id, 500));
    for (const secret of [firstKey, secondKey]) {
      assert.ok(!logged.includes(secret), "a key reached a log");
      // Only the two answers that made a key carry it.
      assert.equal(answers.filter((a) => a.includes(secret)).length, 1);
    }
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
