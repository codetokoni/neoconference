// Run: npx tsx src/lib/__tests__/partnerModeration.smoke.ts
//
// Muting in a partner's zone meeting (src/lib/partners/moderation.ts):
// the zone's leaders and the organisation's administrators can mute one
// person or everyone from the embed; no one else can, a guest never, and
// a leader removed mid-meeting loses it at once. Driven through the real
// join-sessions, redeem, join and moderate routes, with KV, Clerk and
// LiveKit stood in for.

import assert from "node:assert/strict";
import "./apiV1-stubs/install";

Object.assign(process.env, {
  KV_REST_API_URL: "https://kv.invalid",
  KV_REST_API_TOKEN: "t",
  LIVEKIT_API_KEY: "lk",
  LIVEKIT_API_SECRET: "lk-secret-lk-secret-lk-secret-123",
  NEXT_PUBLIC_LIVEKIT_URL: "wss://lk.test",
  CLERK_SECRET_KEY: "sk_test_partner_moderation",
  PARTNER_EMBED_SECRET: "partner-embed-secret-for-tests-0123456789",
});
delete process.env.ADMIN_EMAILS;

type Track = { sid: string; source: number; type: number; muted?: boolean };
type LkPerson = { identity: string; sid: string; joinedAt: number; kind?: number; metadata?: string; tracks: Track[] };
type G = typeof globalThis & {
  __users: Record<string, { plan?: string; emails?: string[] }>;
  __lkParticipants?: Record<string, LkPerson[]>;
  __lkMuted?: { room: string; identity: string; trackSid: string; muted: boolean }[];
};
const g = globalThis as G;
g.__users = { user_owner: { plan: "pro", emails: ["owner@example.com"] } };
g.__lkParticipants = {};

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
const MIC = 2;
const CAMERA = 1;

async function main() {
  const { NextRequest } = await import("next/server");
  const S = await import("../partners/store");
  const R = {
    sessions: await import("../../app/api/partner/v1/join-sessions/route"),
    redeem: await import("../../app/api/partner/embed/redeem/route"),
    join: await import("../../app/api/partner/embed/join/route"),
    moderate: await import("../../app/api/partner/embed/moderate/route"),
  };

  const pc = await S.createIntegration({ name: "PrayerClouds", ownerUserId: "user_owner", origins: [PC], guestAccess: true });
  const key = (await S.mintPartnerKey(pc.id)).raw;

  let ip = 1;
  const post = async (handler: (req: InstanceType<typeof NextRequest>) => Promise<Response>, url: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await handler(
      new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.3.0.${ip++ % 250}`, ...headers }, body: JSON.stringify(body) }),
    );
    return { status: res.status, body: (await res.json().catch(() => ({}))) as J };
  };

  /** A PrayerClouds visitor through to a participant token, then in the LiveKit room with their mic (and camera) on. */
  async function visitor(zoneId: string, user: J) {
    const s = await post(R.sessions.POST, "https://neolinguameet.com/api/partner/v1/join-sessions", { zoneId, origin: PC, user }, { authorization: `Bearer ${key}` });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const r = await post(R.redeem.POST, "https://neolinguameet.com/api/partner/embed/redeem", { code: s.body.code, parentOrigin: PC });
    const j = await post(R.join.POST, "https://neolinguameet.com/api/partner/embed/join", { session: r.body.session });
    assert.equal(j.body.status, "ready", JSON.stringify(j.body));
    const claims = JSON.parse(Buffer.from(String(j.body.token).split(".")[1], "base64url").toString()) as { sub: string; metadata: string };
    const v = { session: r.body.session as string, room: j.body.room as string, identity: claims.sub, moderator: j.body.moderator as boolean, role: JSON.parse(claims.metadata).role as string };
    const sid = `PA_${v.identity.slice(-6)}`;
    g.__lkParticipants![v.room] = [
      ...(g.__lkParticipants![v.room] ?? []).filter((p) => p.identity !== v.identity),
      { identity: v.identity, sid, joinedAt: 1, metadata: claims.metadata, tracks: [{ sid: `${sid}_mic`, source: MIC, type: 0 }, { sid: `${sid}_cam`, source: CAMERA, type: 1 }] },
    ];
    return v;
  }
  const moderate = (v: { session: string }, body: J) => post(R.moderate.POST, "https://neolinguameet.com/api/partner/embed/moderate", { session: v.session, ...body });
  const mutedSince = (from: number) => g.__lkMuted!.slice(from).map((m) => m.trackSid).sort();

  g.__lkMuted = [];
  const ann = await visitor("FALF", { id: "pc_ann", displayName: "Ann" });
  const bob = await visitor("FALF", { id: "pc_bob", displayName: "Bob" });

  await t("an ordinary visitor is not a leader: no controls, and the server refuses their mutes", async () => {
    assert.equal(ann.moderator, false);
    assert.equal(ann.role, "attendee");
    const r = await moderate(ann, { action: "mute", identity: bob.identity });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "not_a_leader");
    assert.equal((await moderate(ann, { action: "mute-all" })).body.error.code, "not_a_leader");
    assert.equal(g.__lkMuted!.length, 0);
  });

  await S.setZoneLeaders(pc.id, "FALF", ["pc_lead"]);
  const lead = await visitor("FALF", { id: "pc_lead", displayName: "Leader" });

  await t("a zone leader joins as one: the page shows the controls, and LiveKit has them as a moderator", async () => {
    assert.equal(lead.moderator, true);
    assert.equal(lead.role, "cohost");
  });

  await t("a leader mutes one person's microphone, not their camera", async () => {
    const from = g.__lkMuted!.length;
    const r = await moderate(lead, { action: "mute", identity: bob.identity });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.muted, 1);
    const m = g.__lkMuted!.slice(from);
    assert.deepEqual(m, [{ room: bob.room, identity: bob.identity, trackSid: `PA_${bob.identity.slice(-6)}_mic`, muted: true }]);
  });

  await t("a leader cannot mute themselves, the host, or someone who has left", async () => {
    assert.equal((await moderate(lead, { action: "mute", identity: lead.identity })).body.error.code, "cannot_mute_self");
    g.__lkParticipants![lead.room].push({ identity: "user_owner", sid: "PA_host", joinedAt: 1, metadata: JSON.stringify({ role: "host" }), tracks: [{ sid: "PA_host_mic", source: MIC, type: 0 }] });
    const host = await moderate(lead, { action: "mute", identity: "user_owner" });
    assert.equal(host.status, 403);
    assert.equal(host.body.error.code, "cannot_mute_host");
    const gone = await moderate(lead, { action: "mute", identity: "pz-nobody" });
    assert.equal(gone.status, 404);
    assert.equal((await moderate(lead, { action: "shout" })).body.error.code, "invalid_action");
  });

  await t("Mute all mutes everyone else's microphone, keeping the leader, other leaders, the host and agents", async () => {
    await S.setZoneLeaders(pc.id, "FALF", ["pc_lead", "pc_lead2"]);
    const lead2 = await visitor("FALF", { id: "pc_lead2", displayName: "Leader Two" });
    g.__lkParticipants![lead.room].push({ identity: "agent-translator", sid: "PA_agent", joinedAt: 1, kind: 4, tracks: [{ sid: "PA_agent_mic", source: MIC, type: 0 }] });
    // Bob was muted already: his mic is not muted again.
    g.__lkParticipants![lead.room].find((p) => p.identity === bob.identity)!.tracks[0].muted = true;
    const from = g.__lkMuted!.length;
    const r = await moderate(lead, { action: "mute-all" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mutedSince(from), [`PA_${ann.identity.slice(-6)}_mic`]);
    assert.equal(r.body.muted, 1);
    assert.equal(r.body.skipped, 4, "self, the other leader, the host and the agent");
    void lead2;
  });

  await t("a leader removed mid-meeting loses it at once", async () => {
    await S.setZoneLeaders(pc.id, "FALF", ["pc_lead2"]);
    assert.equal((await moderate(lead, { action: "mute", identity: ann.identity })).body.error.code, "not_a_leader");
  });

  await t("an organisation administrator may mute in every zone; a zone's leader only in their own", async () => {
    await S.setOrgAdmins(pc.id, ["pc_admin"]);
    await S.setZoneLeaders(pc.id, "FALF", ["pc_lead"]);
    const admin = await visitor("UTURNGRP", { id: "pc_admin", displayName: "Admin" });
    const leadElsewhere = await visitor("UTURNGRP", { id: "pc_lead", displayName: "Leader" });
    const carol = await visitor("UTURNGRP", { id: "pc_carol", displayName: "Carol" });
    assert.equal(admin.moderator, true);
    assert.equal(leadElsewhere.moderator, false);
    assert.equal((await moderate(leadElsewhere, { action: "mute", identity: carol.identity })).body.error.code, "not_a_leader");
    assert.equal((await moderate(admin, { action: "mute", identity: carol.identity })).body.muted, 1);
  });

  await t("a guest is never a leader, even with a leader's id", async () => {
    await S.setZoneLeaders(pc.id, "FALF", ["pc_lead", "guest:pc_lead"]);
    const guest = await visitor("FALF", { guest: true, id: "pc_lead", displayName: "Visitor" });
    assert.equal(guest.moderator, false);
    assert.equal((await moderate(guest, { action: "mute", identity: ann.identity })).body.error.code, "not_a_leader");
  });

  await t("the moderate route needs a valid session for an active zone", async () => {
    assert.equal((await post(R.moderate.POST, "https://neolinguameet.com/api/partner/embed/moderate", { session: "nope.nope", action: "mute-all" })).status, 401);
    await S.setZoneStatus(pc.id, "FALF", "disabled");
    assert.equal((await moderate(lead, { action: "mute-all" })).body.error.code, "zone_disabled");
    await S.setZoneStatus(pc.id, "FALF", "active");
  });

  finished = true;
  console.log(`\n${n} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
