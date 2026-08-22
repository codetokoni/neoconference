// Run: npx tsx src/lib/__tests__/permissions.smoke.ts
// Pure-module smoke test for the permission catalog. No Clerk, no network.
import assert from "node:assert/strict";
import {
  RANK, can, resolveRole, grantsFor, canManageRole, normalizeRole,
  requiredRank, type Eventish,
} from "../permissions";

const EV: Eventish = {
  ownerUserId: "user_owner",
  ownerEmail: "owner@example.com",
  roles: [
    { identifier: "user_host", role: "host" },
    { identifier: "mod@example.com", role: "cohost" },
    { identifier: "user_speaker", role: "speaker" },
  ],
};

const actor = (userId: string | null, emails: string[] = [], admin = false) =>
  resolveRole(EV, { userId, emails, isPlatformAdmin: admin });

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("  ok  " + name); };

console.log("permission catalog");

t("owner resolves by userId", () => {
  assert.equal(actor("user_owner").role, "owner");
  assert.equal(actor("user_owner").isOwner, true);
});

t("owner resolves by snapshot email", () => {
  const a = actor("user_moved", ["owner@example.com"]);
  assert.equal(a.role, "owner");
  assert.equal(a.isOwner, true);
});

t("platform admin acts as owner but is never isOwner", () => {
  const a = actor("user_admin", ["admin@neo.app"], true);
  assert.equal(a.role, "owner");
  assert.equal(a.isOwner, false);
  assert.equal(a.reason, "platform-admin");
});

t("cohost maps to moderator, speaker maps to participant", () => {
  assert.equal(actor("x", ["mod@example.com"]).role, "moderator");
  assert.equal(actor("user_speaker").role, "participant");
  assert.equal(normalizeRole("ticket-holder"), "participant");
  assert.equal(normalizeRole("wizard"), "participant");   // unknown never elevates
});

t("anonymous holds nothing, not even participant permissions", () => {
  const a = actor(null);
  assert.equal(can(a, "media:publish"), false);
  assert.deepEqual(grantsFor(a), []);
});

t("moderator moderates (mute + muteAll) but cannot kick, dispatch captions, end, or record", () => {
  const a = actor("x", ["mod@example.com"]);
  assert.equal(can(a, "participant:mute"), true);
  assert.equal(can(a, "participant:muteAll"), true);   // FRS §5.1 is ambiguous; product decision to include moderator
  assert.equal(can(a, "waitingRoom:admit"), true);
  assert.equal(can(a, "timer:manage"), true);
  assert.equal(can(a, "participant:kick"), false);
  assert.equal(can(a, "captions:dispatch"), false);
  assert.equal(can(a, "meeting:end"), false);
  assert.equal(can(a, "recording:start"), false);
});

t("host runs the meeting but cannot delete or bill it", () => {
  const a = actor("user_host");
  assert.equal(can(a, "meeting:end"), true);
  assert.equal(can(a, "recording:start"), true);
  assert.equal(can(a, "stream:golive"), true);
  assert.equal(can(a, "participant:kick"), true);
  assert.equal(can(a, "participant:muteAll"), true);
  assert.equal(can(a, "captions:dispatch"), true);
  assert.equal(can(a, "meeting:delete"), false);
  assert.equal(can(a, "ticket:manage"), false);
});

t("participant publishes by default", () => {
  assert.equal(can(actor("user_speaker"), "media:publish"), true);
});

t("webinar override closes publishing to moderators and up", () => {
  const o = { "media:publish": RANK.moderator };
  assert.equal(can(actor("user_speaker"), "media:publish", o), false);
  assert.equal(can(actor("x", ["mod@example.com"]), "media:publish", o), true);
  assert.equal(can(actor("user_owner"), "media:publish", o), true);
});

t("overrides are clamped — a room cannot hand itself deletion", () => {
  assert.equal(requiredRank("meeting:delete", { "meeting:delete": RANK.participant }), RANK.owner);
  assert.equal(can(actor("user_speaker"), "meeting:delete", { "meeting:delete": RANK.participant }), false);
  assert.equal(requiredRank("recording:start", { "recording:start": RANK.participant }), RANK.moderator);
});

t("rank ordering blocks lateral role administration", () => {
  const mod = actor("x", ["mod@example.com"]);
  const host = actor("user_host");
  assert.equal(canManageRole(mod, "moderator", false), false);   // F-6: no peer promotion
  assert.equal(canManageRole(host, "moderator", false), true);
  assert.equal(canManageRole(host, "host", false), false);
  assert.equal(canManageRole(actor("user_owner"), "host", false), true);
  assert.equal(canManageRole(actor("user_owner"), "host", true), false); // never the owner
});

t("duplicate assignments resolve to the highest rank", () => {
  const dup: Eventish = { ownerUserId: "o", roles: [
    { identifier: "u", role: "viewer" }, { identifier: "u", role: "cohost" },
  ]};
  assert.equal(resolveRole(dup, { userId: "u", emails: [], isPlatformAdmin: false }).role, "moderator");
});

console.log(`\n${n} checks passed`);
