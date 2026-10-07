// Run: npx tsx src/lib/__tests__/groups.smoke.ts
// Exercises the real group store against the in-memory fallback (no KV
// configured), plus the attendee rules that "Create group from attendees"
// relies on.
import assert from "node:assert/strict";
import type { Actor, MeetingRole } from "@/lib/permissions";
import { recordAttendance, fetchAttendanceReport } from "@/lib/attendance";
import { eventAttendees, selectAttendees } from "@/lib/groupAttendees";
import {
  createGroup, getGroup, getMember, listMembers, listGroupsForUser, listActivity,
  addMembers, removeMember, setRole, transferOwnership, leaveGroup, updateGroup, deleteGroup,
  createInvite, getInvite, redeemInvite,
  addPendingMembers, listPendingMembers, removePendingMember, claimPendingMemberships, pendingLabel,
  canChangeGroupRole, canManageGroupMember, assignableGroupRoles, groupCapabilities, decideGroupAccess,
  GroupError, GROUP_INVITE_TTL_SECONDS, PlanMemberLimitError,
} from "@/lib/groupStore";
import type { NeoEvent } from "@/types/event";

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const actor = (userId: string, role: MeetingRole): Actor =>
  ({ userId, emails: [], isPlatformAdmin: false, role, isOwner: role === "owner", reason: "assignment" });

const OWNER = "user_owner";
const HOST = "user_host";
const MOD = "user_mod";
const MEMBER = "user_member";
const OTHER = "user_other";
const person = (userId: string) => ({ userId, name: userId.replace("user_", "") });

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };
const refuses = async (code: string, status: number, fn: () => Promise<unknown>) => {
  try { await fn(); assert.fail("expected " + code); }
  catch (e) {
    assert.ok(e instanceof GroupError, "wrong error type: " + String(e));
    assert.equal((e as GroupError).message, code);
    assert.equal((e as GroupError).status, status);
  }
};

const EVENT = {
  id: "evt_groups_1", slug: "weekly", name: "Weekly Sync", ownerUserId: OWNER,
  state: "ended", endedAt: new Date("2026-10-01T11:00:00Z").toISOString(),
} as unknown as NeoEvent;

(async () => {
  console.log("groups: rank rules");

  await t("only roles below your own can be changed, and a moderator changes none", () => {
    const owner = actor(OWNER, "owner"), host = actor(HOST, "host"), mod = actor(MOD, "moderator"), member = actor(MEMBER, "participant");
    assert.equal(canChangeGroupRole(owner, "participant", "host"), true);
    assert.equal(canChangeGroupRole(host, "participant", "moderator"), true);
    assert.equal(canChangeGroupRole(host, "moderator", "participant"), true);
    assert.equal(canChangeGroupRole(host, "participant", "host"), false);   // not below a host
    assert.equal(canChangeGroupRole(host, "host", "participant"), false);
    assert.equal(canChangeGroupRole(mod, "participant", "moderator"), false);
    assert.equal(canChangeGroupRole(member, "participant", "moderator"), false);
    assert.equal(canChangeGroupRole(owner, "host", "owner"), false);        // ownership is transferred, not granted
  });

  await t("adding and removing follows rank: moderators manage members only", () => {
    const host = actor(HOST, "host"), mod = actor(MOD, "moderator"), member = actor(MEMBER, "participant");
    assert.equal(canManageGroupMember(mod, "participant"), true);
    assert.equal(canManageGroupMember(mod, "moderator"), false);
    assert.equal(canManageGroupMember(host, "moderator"), true);
    assert.equal(canManageGroupMember(host, "host"), false);
    assert.equal(canManageGroupMember(member, "participant"), false);
    assert.equal(canManageGroupMember(actor(OWNER, "owner"), "owner"), false);
  });

  await t("role menus offer only roles below the caller", () => {
    assert.deepEqual(assignableGroupRoles(actor(OWNER, "owner")), ["host", "moderator", "participant"]);
    assert.deepEqual(assignableGroupRoles(actor(HOST, "host")), ["moderator", "participant"]);
    assert.deepEqual(assignableGroupRoles(actor(MOD, "moderator")), []);
    const caps = groupCapabilities(actor(MEMBER, "participant"));
    assert.equal(caps.manageMembers, false);
    assert.equal(caps.editSettings, false);
    assert.equal(caps.leave, true);
    assert.equal(groupCapabilities(actor(OWNER, "owner")).leave, false);
  });

  console.log("groups: store");

  const g = await createGroup({ name: "  Weekly   Sync  " }, person(OWNER), [person(HOST), person(MOD), person(MEMBER)]);

  await t("creator is Owner, everyone else starts as a Member, name is tidied", async () => {
    assert.equal(g.name, "Weekly Sync");
    assert.deepEqual(g.settings, { retryIntervalMin: 3, maxAttempts: 5 });
    assert.equal((await getMember(g.id, OWNER))?.role, "owner");
    assert.equal((await getMember(g.id, HOST))?.role, "participant");
    assert.equal((await listGroupsForUser(MEMBER)).length, 1);
    assert.equal((await listActivity(g.id))[0].type, "created");
  });

  await t("an empty name is refused", async () => {
    await refuses("invalid_name", 400, () => createGroup({ name: "   " }, person(OWNER)));
  });

  await t("owner makes a host; host promotes a member to moderator", async () => {
    await setRole(g.id, HOST, "host", actor(OWNER, "owner"));
    await setRole(g.id, MOD, "moderator", actor(HOST, "host"));
    assert.equal((await getMember(g.id, HOST))?.role, "host");
    assert.equal((await getMember(g.id, MOD))?.role, "moderator");
  });

  await t("a moderator promoting anyone is refused with 403", async () => {
    await refuses("insufficient_rank", 403, () => setRole(g.id, MEMBER, "moderator", actor(MOD, "moderator")));
    await refuses("insufficient_rank", 403, () => setRole(g.id, MEMBER, "participant", actor(MOD, "moderator")));
  });

  await t("a host cannot touch another host or the owner, and nobody manages themselves", async () => {
    await refuses("cannot_target_owner", 403, () => setRole(g.id, OWNER, "participant", actor(HOST, "host")));
    await refuses("cannot_manage_self", 403, () => setRole(g.id, HOST, "moderator", actor(HOST, "host")));
    await refuses("use_transfer", 400, () => setRole(g.id, MEMBER, "owner", actor(OWNER, "owner")));
  });

  await t("a moderator adds a member; someone already in keeps their role", async () => {
    const res = await addMembers(g.id, [person(OTHER), person(HOST)], actor(MOD, "moderator"));
    assert.deepEqual(res.added.map((m) => m.userId), [OTHER]);
    assert.deepEqual(res.alreadyMembers, [HOST]);
    assert.equal((await getMember(g.id, HOST))?.role, "host");
    await refuses("insufficient_rank", 403, () => addMembers(g.id, [person("user_x")], actor(MEMBER, "participant")));
  });

  await t("a moderator removes a member but not another moderator", async () => {
    await removeMember(g.id, OTHER, actor(MOD, "moderator"));
    assert.equal(await getMember(g.id, OTHER), null);
    assert.equal((await listGroupsForUser(OTHER)).length, 0);
    await addMembers(g.id, [person("user_mod2")], actor(MOD, "moderator"));
    await setRole(g.id, "user_mod2", "moderator", actor(HOST, "host"));
    await refuses("insufficient_rank", 403, () => removeMember(g.id, "user_mod2", actor(MOD, "moderator")));
  });

  await t("the route gate: 401 signed out, 404 outside the group, 403 below the rank", async () => {
    const who = (userId: string | null) => ({ userId, emails: [], isPlatformAdmin: false });
    const group = await getGroup(g.id);
    const at = async (userId: string | null) => (userId ? getMember(g.id, userId) : null);
    const status = async (userId: string | null, p: Parameters<typeof decideGroupAccess>[3], gid = g.id) => {
      const d = decideGroupAccess(who(userId), gid === g.id ? group : null, await at(userId), p);
      return d.ok ? 200 : d.status;
    };
    assert.equal(await status(null, "group:read"), 401);
    assert.equal(await status("user_outsider", "group:read"), 404);            // not a member: same as missing
    assert.equal(await status(HOST, "group:read", "no-such-group"), 404);
    assert.equal(await status(MEMBER, "group:read"), 200);
    assert.equal(await status(MEMBER, "group:members:manage"), 403);
    assert.equal(await status(MOD, "group:members:manage"), 200);               // POST /members
    assert.equal(await status(MOD, "group:moderators:manage"), 403);            // PATCH /members: a moderator promotes no one
    assert.equal(await status(HOST, "group:moderators:manage"), 200);
    assert.equal(await status(HOST, "group:settings"), 403);
    assert.equal(await status(OWNER, "group:delete"), 200);
  });

  await t("the owner cannot leave until ownership is handed over", async () => {
    await refuses("owner_must_transfer", 409, () => leaveGroup(g.id, OWNER));
    await refuses("insufficient_rank", 403, () => transferOwnership(g.id, MEMBER, actor(HOST, "host")));
    await transferOwnership(g.id, HOST, actor(OWNER, "owner"));
    assert.equal((await getMember(g.id, HOST))?.role, "owner");
    assert.equal((await getMember(g.id, OWNER))?.role, "host");
    await leaveGroup(g.id, OWNER);
    assert.equal(await getMember(g.id, OWNER), null);
    assert.equal((await listMembers(g.id))[0].userId, HOST);
  });

  await t("a group can't grow past its owner's plan; the refusal says it is the plan", async () => {
    const small = await createGroup({ name: "Small plan" }, person("user_cap_owner"), [person("user_cap_1")], { cap: 3, plan: "free" });
    const owner = actor("user_cap_owner", "owner");
    await addMembers(small.id, [person("user_cap_2")], owner, { cap: 3, plan: "free" });
    await assert.rejects(
      () => addMembers(small.id, [person("user_cap_3")], owner, { cap: 3, plan: "free" }),
      (e: unknown) => e instanceof PlanMemberLimitError && e.status === 403 && e.limit.cap === 3
    );
    // The site-wide cap is not a plan limit, and says so.
    await assert.rejects(() => addMembers(small.id, [person("user_cap_3")], owner, { cap: 3 }), /too_many_members/);
  });

  await t("settings are validated and kept", async () => {
    const next = await updateGroup(g.id, { name: "007", settings: { retryIntervalMin: 5 } }, HOST);
    assert.equal(next.name, "007");
    assert.deepEqual(next.settings, { retryIntervalMin: 5, maxAttempts: 5 });
    await refuses("invalid_settings", 400, () => updateGroup(g.id, { settings: { maxAttempts: 0 } }, HOST));
    await refuses("invalid_icon", 400, () => updateGroup(g.id, { iconUrl: "javascript:alert(1)" }, HOST));
  });

  console.log("groups: attendees");

  await recordAttendance(EVENT.id, { ts: Date.parse("2026-10-01T10:00:00Z"), action: "join", userId: "user_ada", name: "Ada", email: "ada@example.com", source: "webhook" });
  await recordAttendance(EVENT.id, { ts: Date.parse("2026-10-01T10:05:00Z"), action: "join", userId: "user_bo", name: "Bo", source: "webhook" });
  await recordAttendance(EVENT.id, { ts: Date.parse("2026-10-01T10:06:00Z"), action: "leave", userId: "user_bo", name: "Bo", source: "beacon" });
  await recordAttendance(EVENT.id, { ts: Date.parse("2026-10-01T10:07:00Z"), action: "join", userId: "user_bo", name: "Bo", source: "webhook" });
  await recordAttendance(EVENT.id, { ts: Date.parse("2026-10-01T10:08:00Z"), action: "join", userId: "agent-captions-1", name: "Captions", source: "webhook" });
  await recordAttendance(EVENT.id, { ts: Date.parse("2026-10-01T10:09:00Z"), action: "join", userId: null, name: "Visitor", source: "beacon" });

  await t("attendees are deduplicated by userId; guests by name; agents left out", async () => {
    const { attendees, guests } = await eventAttendees(EVENT);
    assert.deepEqual(attendees.map((a) => a.userId), ["user_ada", "user_bo"]);
    assert.deepEqual(guests, ["Visitor"]);
  });

  await t("create-from-attendees rejects anyone who was not in the meeting", async () => {
    const { attendees } = await eventAttendees(EVENT);
    const bad = selectAttendees(attendees, ["user_ada", "user_stranger"]);
    assert.equal(bad.ok, false);
    assert.deepEqual(!bad.ok && bad.notAttendees, ["user_stranger"]);
    const good = selectAttendees(attendees, ["user_ada"]);
    assert.ok(good.ok);
    assert.deepEqual(good.ok && good.members, [{ userId: "user_ada", name: "Ada", email: "ada@example.com" }]);
  });

  await t("removing a member leaves the meeting's attendance untouched", async () => {
    const { attendees } = await eventAttendees(EVENT);
    const picked = selectAttendees(attendees, attendees.map((a) => a.userId));
    assert.ok(picked.ok);
    const fromMeeting = await createGroup({ name: EVENT.name, sourceEventId: EVENT.id }, person(OWNER), picked.ok ? picked.members : []);
    const before = await fetchAttendanceReport(EVENT);
    await removeMember(fromMeeting.id, "user_bo", actor(OWNER, "owner"));
    assert.equal(await getMember(fromMeeting.id, "user_bo"), null);
    assert.deepEqual(await fetchAttendanceReport(EVENT), before);
    assert.ok(before.some((r) => r.username === "user_bo"));
  });

  console.log("groups: invites");

  await t("an invite works for 72 hours and not after", async () => {
    const t0 = Date.parse("2026-10-01T12:00:00Z");
    const { token, expiresAt } = await createInvite(g.id, HOST, t0);
    assert.equal(expiresAt, t0 + GROUP_INVITE_TTL_SECONDS * 1000);
    assert.ok(await getInvite(token, t0 + 71 * 3600_000));
    assert.equal(await getInvite(token, t0 + 73 * 3600_000), null);
    await refuses("invite_expired", 410, () => redeemInvite(token, person("user_late"), t0 + 73 * 3600_000));
    assert.equal(await getMember(g.id, "user_late"), null);

    const joined = await redeemInvite(token, person("user_early"), t0 + 3600_000);
    assert.equal(joined.alreadyMember, false);
    assert.equal(joined.member.role, "participant");
    const again = await redeemInvite(token, person(HOST), t0 + 3600_000);
    assert.equal(again.alreadyMember, true);
    assert.equal(again.member.role, "owner");
  });

  await t("deleting a group removes members, indexes and history", async () => {
    assert.equal(await deleteGroup(g.id), true);
    assert.equal(await getGroup(g.id), null);
    assert.equal(await getMember(g.id, HOST), null);
    assert.equal((await listGroupsForUser(MEMBER)).length, 0);
    assert.deepEqual(await listActivity(g.id), []);
  });

  console.log("groups: pending members");

  const pg = await createGroup({ name: "Pending" }, person("user_p_owner"), [], { cap: 4 });
  const pOwner = actor("user_p_owner", "owner");

  await t("people with no account are kept pending, once each, by email or KingsChat handle", async () => {
    const r = await addPendingMembers(pg.id, [{ kind: "email", value: " New@Example.com " }, { kind: "kc", value: "Ada" }], pOwner, { cap: 4 });
    assert.deepEqual(r.pending.map((p) => p.key), ["email:new@example.com", "kc:ada"]);
    assert.deepEqual(r.pending.map(pendingLabel), ["new@example.com", "@ada"]);
    const again = await addPendingMembers(pg.id, [{ kind: "kc", value: "ada" }], pOwner, { cap: 4 });
    assert.deepEqual(again, { pending: [], alreadyPending: ["kc:ada"] });
    assert.equal((await listPendingMembers(pg.id)).length, 2);
    assert.ok((await listActivity(pg.id)).some((a) => a.type === "member_invited" && a.detail.includes("@ada")));
  });

  await t("a Member cannot add pending people; a Moderator can", async () => {
    await refuses("insufficient_rank", 403, () => addPendingMembers(pg.id, [{ kind: "kc", value: "x" }], actor(MEMBER, "participant")));
    await addPendingMembers(pg.id, [{ kind: "kc", value: "mo" }], actor("user_p_mod", "moderator"), { cap: 4 });
    await removePendingMember(pg.id, "kc:mo", pOwner);
  });

  await t("pending places count toward the member limit, for members and invite links too", async () => {
    // Owner + 2 pending = 3 of 4.
    await addMembers(pg.id, [person("user_p_1")], pOwner, { cap: 4 });
    await assert.rejects(() => addMembers(pg.id, [person("user_p_2")], pOwner, { cap: 4 }), /too_many_members/);
    await assert.rejects(() => addPendingMembers(pg.id, [{ kind: "email", value: "more@example.com" }], pOwner, { cap: 4 }), /too_many_members/);
    const { token } = await createInvite(pg.id, "user_p_owner");
    await assert.rejects(() => redeemInvite(token, person("user_p_3"), Date.now(), { cap: 4 }), /too_many_members/);
  });

  await t("signing in with that email or handle turns the places into memberships", async () => {
    const joined = await claimPendingMemberships({ userId: "user_new", name: "New", email: "new@example.com" }, ["email:new@example.com"]);
    assert.deepEqual(joined.map((g) => g.id), [pg.id]);
    const m = await getMember(pg.id, "user_new");
    assert.equal(m?.role, "participant");
    assert.equal(m?.addedBy, "user_p_owner");
    assert.deepEqual((await listPendingMembers(pg.id)).map((p) => p.key), ["kc:ada"]);
    // Claiming again does nothing: the place is gone.
    assert.deepEqual(await claimPendingMemberships({ userId: "user_new", name: "New" }, ["email:new@example.com"]), []);
    assert.ok((await listActivity(pg.id)).some((a) => a.type === "member_joined" && a.detail.includes("new@example.com")));
  });

  await t("someone already in the group who claims keeps their role, and the place is cleared", async () => {
    await addPendingMembers(pg.id, [{ kind: "kc", value: "owner_kc" }], pOwner, { cap: 5 });
    assert.deepEqual(await claimPendingMemberships(person("user_p_owner"), ["kc:owner_kc"]), []);
    assert.equal((await getMember(pg.id, "user_p_owner"))?.role, "owner");
    assert.ok(!(await listPendingMembers(pg.id)).some((p) => p.key === "kc:owner_kc"));
  });

  await t("a pending place can be taken back, and then nobody is waiting for it", async () => {
    await refuses("insufficient_rank", 403, () => removePendingMember(pg.id, "kc:ada", actor(MEMBER, "participant")));
    await refuses("not_found", 404, () => removePendingMember(pg.id, "kc:nobody", pOwner));
    await removePendingMember(pg.id, "kc:ada", pOwner);
    assert.deepEqual(await listPendingMembers(pg.id), []);
    assert.deepEqual(await claimPendingMemberships(person("user_ada_kc"), ["kc:ada"]), []);
    assert.equal(await getMember(pg.id, "user_ada_kc"), null);
  });

  await t("deleting a group lets go of its pending places", async () => {
    const gone = await createGroup({ name: "Gone" }, person("user_g_owner"));
    await addPendingMembers(gone.id, [{ kind: "email", value: "late@example.com" }], actor("user_g_owner", "owner"));
    await deleteGroup(gone.id);
    assert.deepEqual(await claimPendingMemberships(person("user_late_2"), ["email:late@example.com"]), []);
  });

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
