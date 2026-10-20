// Run: npx tsx src/lib/__tests__/partnerZones.smoke.ts
//
// Partner zone widgets (src/lib/partners): a partner's backend asks for a
// one-time join code for a visitor in one of its zones (/zone/FALF on
// PrayerClouds), the embed page redeems it from the partner's page and
// joins the zone's one meeting. Driven through the real routes, with KV,
// Clerk and LiveKit stood in for (./apiV1-stubs).

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "t",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  CLERK_SECRET_KEY: "sk_test_partner_zones",
  PARTNER_EMBED_SECRET: "partner-embed-secret-for-tests-0123456789",
});
delete process.env.ADMIN_EMAILS;

type G = typeof globalThis & { __users: Record<string, { plan?: string; emails?: string[] }>; __lkParticipants?: Record<string, { identity: string }[]>; __kvTtl?: boolean };
const g = globalThis as G;
g.__users = { user_owner: { plan: "pro", emails: ["owner@example.com"] }, user_other: { plan: "pro", emails: ["other@example.com"] } };
g.__kvTtl = true;

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

// Route answers, read loosely: the checks below say what each must hold.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

const PC = "https://herald.prayerclouds.org";
const OTHER_SITE = "https://other-church.example";

function claims(jwt: string): { sub: string; name: string; metadata: string; video: { room: string; roomAdmin?: boolean } } {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
}

async function main() {
  const { NextRequest } = await import("next/server");
  const S = await import("../partners/store");
  const { eventStore } = await import("../eventStore");
  const R = {
    sessions: await import("../../app/api/partner/v1/join-sessions/route"),
    redeem: await import("../../app/api/partner/embed/redeem/route"),
    join: await import("../../app/api/partner/embed/join/route"),
    handoff: await import("../../app/api/partner/embed/handoff/route"),
  };

  // Two partners: PrayerClouds and another church, each with its own key.
  const pc = await S.createIntegration({ name: "PrayerClouds", ownerUserId: "user_owner", origins: [PC], titleTemplate: "{zone} Prayer Meeting" });
  const pcKey = (await S.mintPartnerKey(pc.id)).raw;
  /** PrayerClouds' key in use: rotated part-way through. */
  let pcLive = pcKey;
  const other = await S.createIntegration({ name: "Other church", ownerUserId: "user_other", origins: [OTHER_SITE] });
  const otherKey = (await S.mintPartnerKey(other.id)).raw;

  let ip = 1;
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${ip++ % 250}`, ...headers },
      body: JSON.stringify(body),
    });

  /** The partner backend's call. */
  async function issue(key: string | null, body: Record<string, unknown>) {
    const res = await R.sessions.POST(post("https://neolinguameet.com/api/partner/v1/join-sessions", body, key ? { authorization: `Bearer ${key}` } : {}));
    return { status: res.status, body: (await res.json()) as J };
  }
  /** The embed page: redeem the code handed over from `parentOrigin`. */
  async function redeem(code: string, parentOrigin: string, headers: Record<string, string> = {}) {
    const res = await R.redeem.POST(post("https://neolinguameet.com/api/partner/embed/redeem", { code, parentOrigin }, headers));
    return { status: res.status, body: (await res.json()) as J };
  }
  async function join(session: string) {
    const res = await R.join.POST(post("https://neolinguameet.com/api/partner/embed/join", { session }));
    return { status: res.status, body: (await res.json()) as J };
  }
  /** A visitor from page to meeting, as the widget does it. */
  async function visit(key: string, zoneId: string, user: Record<string, unknown>, origin = PC) {
    const s = await issue(key, { zoneId, user, origin });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const r = await redeem(s.body.code, origin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const j = await join(r.body.session);
    assert.equal(j.status, 200, JSON.stringify(j.body));
    return { issued: s.body, redeemed: r.body, joined: j.body };
  }

  await t("two FALF visitors join the same room, each under their own name", async () => {
    const a = await visit(pcKey, "FALF", { id: "pc_1", displayName: "Victor Agbasa" });
    const b = await visit(pcKey, "falf", { id: "pc_2", displayName: "Grace Okafor" });
    assert.equal(a.issued.meeting.title, "FALF Prayer Meeting");
    assert.equal(a.joined.status, "ready");
    const ca = claims(a.joined.token);
    const cb = claims(b.joined.token);
    assert.equal(ca.video.room, cb.video.room);
    assert.equal(ca.name, "Victor Agbasa");
    assert.equal(cb.name, "Grace Okafor");
    assert.notEqual(ca.sub, cb.sub);
    // The name never reaches the address of anything.
    assert.doesNotMatch(ca.sub, /victor|grace/i);
    // One mapping, one meeting.
    const zones = await S.listZones(pc.id);
    assert.deepEqual(zones.map((z) => z.zoneId), ["FALF"]);
    const ev = await eventStore.byId(zones[0].eventId);
    assert.equal(ev?.isPermanent, true);
    assert.equal(ev?.ownerUserId, "user_owner");
  });

  await t("the same visitor again (reload, second tab) is the same participant, not a duplicate", async () => {
    const a = await visit(pcKey, "FALF", { id: "pc_1", displayName: "Victor Agbasa" });
    const b = await visit(pcKey, "FALF", { id: "pc_1", displayName: "Victor Agbasa" });
    assert.equal(claims(a.joined.token).sub, claims(b.joined.token).sub);
  });

  await t("another zone is another room", async () => {
    const f = await visit(pcKey, "FALF", { id: "pc_1", displayName: "Victor" });
    const p = await visit(pcKey, "LAGOS-1", { id: "pc_1", displayName: "Victor" });
    assert.notEqual(claims(f.joined.token).video.room, claims(p.joined.token).video.room);
    assert.equal(p.issued.meeting.title, "LAGOS-1 Prayer Meeting");
  });

  await t("twelve first visits at once make one mapping and one meeting", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => issue(pcKey, { zoneId: "RUSH", user: { id: `r_${i}`, displayName: `Person ${i}` }, origin: PC })),
    );
    for (const r of results) assert.equal(r.status, 201, JSON.stringify(r.body));
    const zone = await S.getZone(pc.id, "RUSH");
    assert.ok(zone);
    const events = (await eventStore.listAll()).filter((e) => (e as { partner?: { zoneId: string } }).partner?.zoneId === "RUSH");
    assert.equal(events.length, 1, `meetings for RUSH: ${events.length}`);
    assert.equal(events[0].id, zone!.eventId);
  });

  await t("the browser cannot make anyone a host, or change who they are", async () => {
    const s = await issue(pcKey, {
      zoneId: "FALF",
      user: { id: "pc_9", displayName: "Mallory", role: "host", owner: true },
      role: "host",
      origin: PC,
    });
    assert.equal(s.status, 201);
    // The redeem body is all the browser controls: extra fields do nothing.
    const res = await R.redeem.POST(
      post("https://neolinguameet.com/api/partner/embed/redeem", { code: s.body.code, parentOrigin: PC, displayName: "Pastor", role: "host", verified: true }),
    );
    const r = (await res.json()) as J;
    assert.equal(r.participant.name, "Mallory");
    const j = await join(r.session);
    const md = JSON.parse(claims(j.body.token).metadata);
    assert.equal(md.role, "attendee");
    assert.equal(md.owner, undefined);
    assert.equal(claims(j.body.token).video.roomAdmin, undefined);
    assert.equal(claims(j.body.token).name, "Mallory");
    // A session the browser rewrote is refused.
    const [body, mac] = r.session.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), displayName: "Pastor" })).toString("base64url");
    assert.equal((await join(`${forged}.${mac}`)).body.error.code, "invalid_session");
    // No key, a wrong key, or a key in the body: refused.
    assert.equal((await issue(null, { zoneId: "FALF", user: { id: "x", displayName: "X" }, origin: PC })).status, 401);
    assert.equal((await issue("nlm_pk_deadbeef_" + "0".repeat(48), { zoneId: "FALF", user: { id: "x", displayName: "X" }, origin: PC })).status, 401);
  });

  await t("another organisation's key, code or site never reaches PrayerClouds' meeting", async () => {
    const mine = await visit(pcKey, "FALF", { id: "pc_1", displayName: "Victor" });
    const theirs = await visit(otherKey, "FALF", { id: "o_1", displayName: "Someone" }, OTHER_SITE);
    // "FALF" is a zone of each partner's own: different meetings.
    assert.notEqual(claims(mine.joined.token).video.room, claims(theirs.joined.token).video.room);
    // The other partner cannot ask for PrayerClouds' site...
    const s = await issue(otherKey, { zoneId: "FALF", user: { id: "o_1", displayName: "S" }, origin: PC });
    assert.equal(s.status, 403);
    assert.equal(s.body.error.code, "origin_not_approved");
    // ...and its code does not open on PrayerClouds' page.
    const c = await issue(otherKey, { zoneId: "FALF", user: { id: "o_1", displayName: "S" }, origin: OTHER_SITE });
    const r = await redeem(c.body.code, PC);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "origin_mismatch");
  });

  await t("an unapproved website is refused, at issue and at redeem", async () => {
    const s = await issue(pcKey, { zoneId: "FALF", user: { id: "pc_1", displayName: "V" }, origin: "https://evil.example" });
    assert.equal(s.status, 403);
    assert.equal(s.body.error.code, "origin_not_approved");
    assert.equal((await issue(pcKey, { zoneId: "FALF", user: { id: "pc_1", displayName: "V" }, origin: "http://herald.prayerclouds.org" })).status, 400);
    const ok = await issue(pcKey, { zoneId: "FALF", user: { id: "pc_1", displayName: "V" }, origin: PC });
    const r = await redeem(ok.body.code, "https://evil.example");
    assert.equal(r.body.error.code, "origin_mismatch");
  });

  await t("a code works once, and not after two minutes", async () => {
    const s = await issue(pcKey, { zoneId: "FALF", user: { id: "pc_1", displayName: "V" }, origin: PC });
    assert.equal((await redeem(s.body.code, PC)).status, 200);
    const again = await redeem(s.body.code, PC);
    assert.equal(again.status, 410);
    assert.equal(again.body.error.code, "code_used");
    const late = await issue(pcKey, { zoneId: "FALF", user: { id: "pc_1", displayName: "V" }, origin: PC });
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60_000;
    try {
      const r = await redeem(late.body.code, PC);
      assert.equal(r.status, 410);
      assert.equal(r.body.error.code, "code_expired");
    } finally {
      Date.now = realNow;
    }
    assert.equal((await redeem("not-a-code", PC)).body.error.code, "invalid_code");
  });

  await t("open in a new tab: a one-minute code that only this site's own page can use", async () => {
    const v = await visit(pcKey, "FALF", { id: "pc_1", displayName: "Victor" });
    const h = await R.handoff.POST(post("https://neolinguameet.com/api/partner/embed/handoff", { session: v.redeemed.session }));
    const code = ((await h.json()) as { code: string }).code;
    // From the partner's page (or anywhere else) it does not open.
    assert.equal((await redeem(code, PC, { origin: PC })).body.error.code, "origin_mismatch");
    const h2 = await R.handoff.POST(post("https://neolinguameet.com/api/partner/embed/handoff", { session: v.redeemed.session }));
    const code2 = ((await h2.json()) as { code: string }).code;
    const r = await redeem(code2, "self", { origin: "https://neolinguameet.com" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.participant.name, "Victor");
    const j = await join(r.body.session);
    assert.equal(claims(j.body.token).sub, claims(v.joined.token).sub);
  });

  await t("guests only where allowed, and marked as guests", async () => {
    const no = await issue(pcKey, { zoneId: "FALF", user: { guest: true, displayName: "Visitor" }, origin: PC });
    assert.equal(no.status, 403);
    assert.equal(no.body.error.code, "guests_not_allowed");
    await S.updateIntegration(pc.id, { guestAccess: true });
    const yes = await visit(pcKey, "FALF", { guest: true, displayName: "Visitor" });
    assert.equal(yes.redeemed.participant.verified, false);
    assert.equal(claims(yes.joined.token).name, "Visitor (guest)");
    assert.equal(JSON.parse(claims(yes.joined.token).metadata).partner.verified, false);
    await S.updateIntegration(pc.id, { guestAccess: false });
  });

  await t("the waiting room, a locked meeting and a full room apply as to anyone", async () => {
    const zone = (await S.getZone(pc.id, "FALF"))!;
    await eventStore.update(zone.eventId, { waitingRoomEnabled: true });
    const s = await issue(pcKey, { zoneId: "FALF", user: { id: "pc_wait", displayName: "Waiting Wendy" }, origin: PC });
    const r = await redeem(s.body.code, PC);
    const first = await join(r.body.session);
    assert.equal(first.body.status, "waiting_room");
    // The host sees her in the usual list, by name, and admits her.
    let ev = (await eventStore.byId(zone.eventId))!;
    const entry = ev.waitingRoom.find((e) => e.name === "Waiting Wendy");
    assert.ok(entry && entry.status === "pending");
    await eventStore.update(zone.eventId, (prev) => ({ ...prev, waitingRoom: prev.waitingRoom.map((e) => (e.id === entry!.id ? { ...e, status: "admitted" as const } : e)) }));
    assert.equal((await join(r.body.session)).body.status, "ready");
    await eventStore.update(zone.eventId, { waitingRoomEnabled: false, isLocked: true });
    assert.equal((await join(r.body.session)).body.error.code, "meeting_locked");
    await eventStore.update(zone.eventId, { isLocked: false, waitForHost: true });
    // Nobody in yet and the meeting waits for a host.
    ev = (await eventStore.byId(zone.eventId))!;
    g.__lkParticipants = { [ev.livekitRoom]: [] };
    assert.equal((await join(r.body.session)).body.status, "wait_for_host");
    g.__lkParticipants = { [ev.livekitRoom]: Array.from({ length: 300 }, (_, i) => ({ identity: `p${i}` })) };
    assert.equal((await join(r.body.session)).body.error.code, "room_full");
    delete g.__lkParticipants;
    await eventStore.update(zone.eventId, { waitForHost: false });
  });

  await t("a finished session of the zone's permanent room opens again for the next visitor", async () => {
    const zone = (await S.getZone(pc.id, "FALF"))!;
    await eventStore.update(zone.eventId, { state: "ended", endedBy: "room_empty" });
    const v = await visit(pcKey, "FALF", { id: "pc_1", displayName: "Victor" });
    assert.equal(v.joined.status, "ready");
    assert.equal((await eventStore.byId(zone.eventId))?.state, "live");
  });

  await t("a disabled zone, a disabled integration and a revoked key are refused", async () => {
    await S.setZoneStatus(pc.id, "LAGOS-1", "disabled");
    const z = await issue(pcKey, { zoneId: "LAGOS-1", user: { id: "pc_1", displayName: "V" }, origin: PC });
    assert.equal(z.body.error.code, "zone_disabled");
    await S.setZoneStatus(pc.id, "LAGOS-1", "active");

    const s = await issue(pcKey, { zoneId: "FALF", user: { id: "pc_1", displayName: "V" }, origin: PC });
    const r = await redeem(s.body.code, PC);
    await S.updateIntegration(pc.id, { status: "disabled" });
    assert.equal((await issue(pcKey, { zoneId: "FALF", user: { id: "pc_1", displayName: "V" }, origin: PC })).body.error.code, "integration_disabled");
    // A session already in the page stops too.
    assert.equal((await join(r.body.session)).body.error.code, "integration_disabled");
    await S.updateIntegration(pc.id, { status: "active" });

    // Rotating: a new key works, the old one is refused, the zone keeps its meeting.
    const before = (await S.getZone(pc.id, "FALF"))!.eventId;
    const fresh = (await S.mintPartnerKey(pc.id)).raw;
    const oldMeta = (await S.listPartnerKeys(pc.id)).find((k) => pcKey.startsWith(k.masked.split("…")[0]))!;
    await S.revokePartnerKey(pc.id, oldMeta.id);
    assert.equal((await issue(pcKey, { zoneId: "FALF", user: { id: "pc_1", displayName: "V" }, origin: PC })).status, 401);
    pcLive = fresh;
    const after = await visit(fresh, "FALF", { id: "pc_1", displayName: "V" });
    assert.equal((await S.getZone(pc.id, "FALF"))!.eventId, before);
    assert.equal(after.joined.status, "ready");
  });

  await t("automatic zones off: an unknown zone is refused until an administrator connects it", async () => {
    await S.updateIntegration(other.id, { autoCreateZones: false });
    const s = await issue(otherKey, { zoneId: "NEWONE", user: { id: "o_1", displayName: "S" }, origin: OTHER_SITE });
    assert.equal(s.status, 404);
    assert.equal(s.body.error.code, "zone_not_found");
  });

  await t("the zone embed page may be framed only by approved sites; other pages are untouched", async () => {
    const middleware = (await import("../../middleware")).default as unknown as (req: InstanceType<typeof NextRequest>, ev: unknown) => Promise<Response | undefined>;
    const res = await middleware(new NextRequest("https://neolinguameet.com/embed/zone", { headers: { host: "neolinguameet.com" } }), { waitUntil() {} });
    const csp = res?.headers.get("content-security-policy") || "";
    assert.match(csp, /^frame-ancestors 'self' /);
    assert.ok(csp.includes(PC) && csp.includes(OTHER_SITE), csp);
    assert.ok(!csp.includes("evil.example"));
    const other = await middleware(new NextRequest("https://neolinguameet.com/pricing", { headers: { host: "neolinguameet.com" } }), { waitUntil() {} });
    assert.equal(other?.headers.get("content-security-policy") ?? null, null);
  });

  await t("an embedded visitor translates in their own meeting only, through the embed session", async () => {
    process.env.DEEPL_API_KEY = "deepl-test:fx";
    const realFetch = globalThis.fetch;
    let deepl = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).startsWith("https://api-free.deepl.com/")) {
        deepl++;
        return Response.json({ translations: [{ text: "Bonjour à tous.", detected_source_language: "EN" }] });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const T = await import("../../app/api/translate/route");
      const V = await import("../../app/api/voice/speak/route");
      const v = await visit(pcLive, "FALF", { id: "pc_tr", displayName: "Tola" });
      const room: string = v.joined.room;
      const hdr = { "x-neo-embed-session": v.redeemed.session as string };
      const tr = (body: unknown, headers: Record<string, string> = {}) => T.POST(post("https://neolinguameet.com/api/translate", body, headers));
      const speak = (body: unknown, headers: Record<string, string> = {}) => V.POST(post("https://neolinguameet.com/api/voice/speak", body, headers));
      const caption = { text: "Hello everyone.", targetLang: "fr", room };

      // No account and no session, or a tampered one: refused as before.
      assert.equal((await tr(caption)).status, 401);
      assert.equal((await tr(caption, { "x-neo-embed-session": hdr["x-neo-embed-session"].slice(0, -3) + "AAA" })).status, 401);
      assert.equal((await speak({ room, identity: "x", lang: "fr", text: "Hi" })).status, 401);

      // Their own meeting: translated.
      const ok = await tr(caption, hdr);
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as J).translated, "Bonjour à tous.");
      assert.equal(deepl, 1);

      // Another meeting, or none named: refused, and DeepL is not asked.
      const elsewhere = (await visit(pcLive, "LAGOS-1", { id: "pc_tr", displayName: "Tola" })).joined.room as string;
      assert.notEqual(elsewhere, room);
      assert.equal((await tr({ ...caption, room: elsewhere }, hdr)).status, 403);
      assert.equal((await tr({ text: "Hello", targetLang: "fr" }, hdr)).status, 403);
      assert.equal((await speak({ room: elsewhere, identity: "x", lang: "fr", text: "Hi" }, hdr)).status, 403);
      assert.notEqual((await speak({ room, identity: "x", lang: "fr", text: "Hi" }, hdr)).status, 401);
      assert.equal(deepl, 1);

      // The zone switched off: the session stops working here too.
      await S.setZoneStatus(pc.id, "FALF", "disabled");
      assert.equal((await tr(caption, hdr)).status, 401);
      await S.setZoneStatus(pc.id, "FALF", "active");

      // Middleware: signed out, these routes need sign-in unless the request carries the session.
      const middleware = (await import("../../middleware")).default as unknown as (req: InstanceType<typeof NextRequest>, ev: unknown) => Promise<Response | undefined>;
      const at = (headers: Record<string, string>) =>
        new NextRequest("https://neolinguameet.com/api/translate", { method: "POST", headers: { host: "neolinguameet.com", ...headers } });
      await assert.rejects(middleware(at({}), { waitUntil() {} }), /protect/);
      await middleware(at(hdr), { waitUntil() {} });
      await assert.rejects(
        middleware(new NextRequest("https://neolinguameet.com/api/meetings", { method: "POST", headers: { host: "neolinguameet.com", ...hdr } }), { waitUntil() {} }),
        /protect/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t("validation: zone ids, names and user ids", async () => {
    for (const zoneId of ["", "../x", "a b", "x".repeat(41), 42]) {
      assert.equal((await issue(pcLive, { zoneId, user: { id: "pc_1", displayName: "V" }, origin: PC })).body.error.code, "invalid_zone", String(zoneId));
    }
    assert.equal((await issue(pcLive, { zoneId: "FALF", user: { id: "pc_1", displayName: "" }, origin: PC })).body.error.code, "invalid_name");
    assert.equal((await issue(pcLive, { zoneId: "FALF", user: { id: "<script>", displayName: "V" }, origin: PC })).body.error.code, "invalid_user");
    // Control characters are dropped; HTML stays text (escaped wherever it is shown).
    const v = await visit(pcLive, "FALF", { id: "pc_x", displayName: "<b>Ann</b>\u0000‮" });
    assert.equal(claims(v.joined.token).name, "<b>Ann</b>");
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
