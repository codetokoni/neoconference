// Run: npx tsx src/lib/__tests__/meeting-roles.smoke.ts
// Exercises the real module against the in-memory fallback (no KV configured).
import assert from "node:assert/strict";
import { eventStore } from "@/lib/eventStore";
import { resolveRole, RANK, type Actor } from "@/lib/permissions";
import {
  assignMeetingRole, getMeetingRole, getMeetingRoleByEmail, removeMeetingRole,
  demoteToParticipant, getMeetingParticipants, checkMeetingRole,
  deleteAllMeetingRoles, resolveIdentity, MeetingRoleError, __resetInMemoryRoles,
} from "@/lib/meeting-roles";
import type { NeoEvent } from "@/types/event";

const EVENT_ID = "evt_test_1";
const ev = {
  id: EVENT_ID, slug: "test-room", name: "Test", ownerUserId: "user_owner",
  ownerEmail: "owner@example.com", visibility: "public", waitingRoomEnabled: false,
  livekitRoom: "test-room", qrSeed: "x", roles: [], waitingRoom: [], recordings: [],
  state: "scheduled", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
} as unknown as NeoEvent;

const actor = (userId: string, emails: string[], role: "owner" | "host" | "moderator" | "participant"): Actor =>
  ({ userId, emails, isPlatformAdmin: false, role, isOwner: role === "owner", reason: "assignment" });

const owner = actor("user_owner", ["owner@example.com"], "owner");
const host = actor("user_host", [], "host");
const mod = actor("user_mod", [], "moderator");

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };
const throws = async (code: string, fn: () => Promise<unknown>) => {
  try { await fn(); assert.fail("expected " + code); }
  catch (e) { assert.ok(e instanceof MeetingRoleError, "wrong error type"); assert.equal((e as Error).message, code); }
};

(async () => {
  await eventStore.create(ev);
  __resetInMemoryRoles();
  console.log("meeting-roles");

  await t("identity resolution splits ids from emails", () => {
    assert.deepEqual(resolveIdentity("user_a").keys, ["user_a"]);
    assert.deepEqual(resolveIdentity("A@Example.com ").keys, ["a@example.com"]);
    assert.deepEqual(resolveIdentity({ userId: "u", emails: ["X@y.z"] }).keys, ["u", "x@y.z"]);
    assert.deepEqual(resolveIdentity({ emails: [] }).keys, []);
  });

  await t("owner assigns a moderator, role reads back", async () => {
    await assignMeetingRole(EVENT_ID, "user_alice", "moderator", owner);
    assert.equal(await getMeetingRole(EVENT_ID, "user_alice"), "moderator");
  });

  await t("assignment by email is readable by email", async () => {
    await assignMeetingRole(EVENT_ID, { emails: ["Bob@Example.com"] }, "host", owner);
    assert.equal(await getMeetingRoleByEmail(EVENT_ID, "bob@example.com"), "host");
    assert.equal(await getMeetingRoleByEmail(EVENT_ID, "BOB@EXAMPLE.COM"), "host");
  });

  await t("both keys written when identity has id and email", async () => {
    await assignMeetingRole(EVENT_ID, { userId: "user_carol", emails: ["carol@example.com"] }, "moderator", owner);
    assert.equal(await getMeetingRole(EVENT_ID, "user_carol"), "moderator");
    assert.equal(await getMeetingRoleByEmail(EVENT_ID, "carol@example.com"), "moderator");
  });

  await t("moderator cannot mint a peer (F-6)", async () => {
    await throws("insufficient_rank", () => assignMeetingRole(EVENT_ID, "user_dave", "moderator", mod));
    await throws("insufficient_rank", () => assignMeetingRole(EVENT_ID, "user_dave", "host", mod));
  });

  await t("host may make a moderator but not another host", async () => {
    await assignMeetingRole(EVENT_ID, "user_erin", "moderator", host);
    assert.equal(await getMeetingRole(EVENT_ID, "user_erin"), "moderator");
    await throws("insufficient_rank", () => assignMeetingRole(EVENT_ID, "user_frank", "host", host));
  });

  await t("nobody promotes themselves", async () => {
    await throws("cannot_manage_self", () => assignMeetingRole(EVENT_ID, "user_host", "moderator", host));
    // matched on a shared email rather than the userId
    const host2 = actor("user_host2", ["host2@example.com"], "host");
    await throws("cannot_manage_self", () => assignMeetingRole(EVENT_ID, { emails: ["host2@example.com"] }, "moderator", host2));
  });

  await t("the owner is untouchable and ownership is not grantable", async () => {
    await throws("cannot_target_owner", () => assignMeetingRole(EVENT_ID, "user_owner", "participant", owner));
    await throws("cannot_target_owner", () => assignMeetingRole(EVENT_ID, { emails: ["owner@example.com"] }, "host", host));
    await throws("cannot_assign_owner", () => assignMeetingRole(EVENT_ID, "user_grace", "owner", owner));
  });

  await t("unknown event and empty identity are rejected", async () => {
    await throws("event_not_found", () => assignMeetingRole("evt_nope", "user_x", "host", owner));
    await throws("empty_identity", () => assignMeetingRole(EVENT_ID, { emails: [] }, "host", owner));
  });

  await t("checkMeetingRole uses RANK, not its own ordering", async () => {
    assert.equal(await checkMeetingRole(EVENT_ID, "user_alice", "participant"), true);
    assert.equal(await checkMeetingRole(EVENT_ID, "user_alice", "moderator"), true);
    assert.equal(await checkMeetingRole(EVENT_ID, "user_alice", "host"), false);
    assert.equal(await checkMeetingRole(EVENT_ID, { emails: ["bob@example.com"] }, "host"), true);
  });

  await t("an unassigned user is not a member — the test that never existed", async () => {
    assert.equal(await getMeetingRole(EVENT_ID, "user_stranger"), null);
    assert.equal(await checkMeetingRole(EVENT_ID, "user_stranger", "participant"), false);
    // and resolveRole still calls any signed-in user a participant, which is why
    // membership had to become its own question
    const a = resolveRole(ev, { userId: "user_stranger", emails: [], isPlatformAdmin: false });
    assert.equal(a.role, "participant");
  });

  await t("participants list merges the owner and sorts by rank", async () => {
    const list = await getMeetingParticipants(EVENT_ID, ev);
    assert.equal(list[0].role, "owner");
    assert.equal(list[0].userId, "user_owner");
    const ranks = list.map((p) => RANK[p.role]);
    assert.deepEqual(ranks, [...ranks].sort((x, y) => y - x), "not sorted by rank");
    assert.ok(list.some((p) => p.userId === "user_alice" && p.role === "moderator"));
    assert.ok(!list.some((p, i) => i > 0 && p.role === "owner"), "owner duplicated");
  });

  await t("remove and demote clear the assignment", async () => {
    await removeMeetingRole(EVENT_ID, "user_alice");
    assert.equal(await getMeetingRole(EVENT_ID, "user_alice"), null);
    await demoteToParticipant(EVENT_ID, { userId: "user_carol", emails: ["carol@example.com"] });
    assert.equal(await getMeetingRole(EVENT_ID, "user_carol"), null);
    assert.equal(await getMeetingRoleByEmail(EVENT_ID, "carol@example.com"), null);
  });

  await t("removing a role nobody holds is a no-op", async () => {
    await removeMeetingRole(EVENT_ID, "user_nobody");
    await removeMeetingRole(EVENT_ID, { emails: [] });
  });

  await t("legacy roles[] is still read as a fallback", async () => {
    const legacyId = "evt_legacy";
    await eventStore.create({ ...ev, id: legacyId, slug: "legacy-room",
      roles: [{ identifier: "user_old", role: "cohost" }] } as unknown as NeoEvent);
    assert.equal(await getMeetingRole(legacyId, "user_old"), "moderator");  // cohost -> moderator
    assert.equal(await checkMeetingRole(legacyId, "user_old", "moderator"), true);
  });

  await t("deleting the event drops the hash", async () => {
    await deleteAllMeetingRoles(EVENT_ID);
    assert.equal(await getMeetingRole(EVENT_ID, "user_erin"), null);
    const list = await getMeetingParticipants(EVENT_ID, ev);
    assert.equal(list.length, 1);
    assert.equal(list[0].role, "owner");
  });

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
