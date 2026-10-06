// Run: npx tsx src/lib/__tests__/groupMeetings.smoke.ts
// Group meetings against the in-memory fallback (no KV configured): who owns
// them, who hosts them, who is let in, recurrence, and the invitation email.
import assert from "node:assert/strict";
import { can, resolveRole, withAssignedRoles, type MeetingRole } from "@/lib/permissions";
import {
  createGroup, setRole, addMembers, getMember, decideGroupAccess, getGroup, listActivity,
  type GroupMember,
} from "@/lib/groupStore";
import {
  createGroupMeetings, cleanMeetingFields, materialise, isInvited, admitInvitee, addParticipants,
  listInvited, cancelGroupMeetings, updateGroupMeetings, listGroupMeetings, inviteesOf,
  LifetimeCapError, type CreateMeetingDeps,
} from "@/lib/groupMeetings";
import { getMeetingRole } from "@/lib/meeting-roles";
import { gateStatus } from "@/lib/waitingRoom";
import { eventStore } from "@/lib/eventStore";
import { notifyInvitees } from "@/lib/groupNotify";
import { localParts } from "@/lib/zonedTime";
import type { NeoEvent } from "@/types/event";

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const OWNER = "user_owner";
const HOST = "user_host";
const MOD = "user_mod";
const MEMBER = "user_member";
const person = (userId: string) => ({ userId, name: userId.replace("user_", ""), email: `${userId.replace("user_", "")}@example.com` });
const actor = (userId: string, role: MeetingRole) =>
  ({ userId, emails: [], isPlatformAdmin: false, role, isOwner: role === "owner", reason: "assignment" as const });

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };
const refuses = async (code: string, fn: () => Promise<unknown>) => {
  try { await fn(); assert.fail("expected " + code); }
  catch (e) { assert.equal((e as Error).message, code); }
};

/** Fake plan gates that record who they were asked about. */
function gates(opts: { used?: number; cap?: number } = {}) {
  const calls = { checked: [] as string[], incremented: [] as string[], recurring: [] as string[] };
  let used = opts.used ?? 0;
  const cap = opts.cap ?? 0;
  const deps: CreateMeetingDeps = {
    checkCap: async (userId) => {
      calls.checked.push(userId);
      return { blocked: cap > 0 && used >= cap, used, cap, plan: cap > 0 ? "free" : "pro" };
    },
    incrementCap: async (userId) => { calls.incremented.push(userId); used++; },
    applyRecurringRoles: async (eid, ownerId) => { calls.recurring.push(`${eid}:${ownerId}`); },
  };
  return { deps, calls };
}

const NOW = Date.now();
const inDays = (d: number, hourUtc = 9) => {
  const x = new Date(NOW + d * 86_400_000);
  x.setUTCHours(hourUtc, 0, 0, 0);
  return x.toISOString();
};

(async () => {
  const g = await createGroup({ name: "Choir" }, person(OWNER), [person(HOST), person(MOD), person(MEMBER)]);
  await setRole(g.id, HOST, "host", actor(OWNER, "owner"));
  await setRole(g.id, MOD, "moderator", actor(OWNER, "owner"));
  const group = (await getGroup(g.id))!;
  const member = async (id: string) => (await getMember(g.id, id)) as GroupMember;

  console.log("group meetings: permissions");

  await t("a Member cannot schedule, start or call (403); a Moderator can", async () => {
    const who = (id: string) => ({ userId: id, emails: [], isPlatformAdmin: false });
    for (const p of ["group:schedule", "group:start", "group:call", "group:participants:manage"] as const) {
      const m = decideGroupAccess(who(MEMBER), group, await member(MEMBER), p);
      assert.equal(!m.ok && m.status, 403, p);
      assert.equal(decideGroupAccess(who(MOD), group, await member(MOD), p).ok, true, p);
    }
  });

  console.log("group meetings: ownership and roles");

  await t("a Moderator's meeting is owned by the group Owner and the Moderator hosts it", async () => {
    const { deps, calls } = gates();
    const fields = cleanMeetingFields({ title: "Rehearsal", scheduledAt: inDays(2), durationMin: 90, timezone: "Africa/Lagos" }, "scheduled", NOW);
    const { events } = await createGroupMeetings({ group, creator: await member(MOD), kind: "scheduled", fields, origin: "https://neo.test" }, deps);
    const ev = events[0];
    assert.equal(ev.ownerUserId, OWNER);
    assert.equal(ev.groupId, g.id);
    assert.equal(ev.state, "scheduled");
    assert.equal(await getMeetingRole(ev.id, MOD), "host");
    assert.equal(await getMeetingRole(ev.id, HOST), "host");
    assert.equal(await getMeetingRole(ev.id, MEMBER), null);
    assert.deepEqual(calls.recurring, [`${ev.id}:${OWNER}`]);

    // What authorize() now sees for them: the hash role, so Start works.
    const id = { userId: MOD, emails: [], isPlatformAdmin: false };
    assert.equal(can(resolveRole(ev, id), "meeting:start"), false);    // roles[] alone, as before
    const seen = withAssignedRoles(ev, MOD, [(await getMeetingRole(ev.id, MOD))!]);
    assert.equal(can(resolveRole(seen, id), "meeting:start"), true);
    assert.equal(can(resolveRole(seen, id), "meeting:delete"), false);
  });

  await t("the lifetime cap is checked and counted against the group Owner", async () => {
    const { deps, calls } = gates({ used: 0, cap: 10 });
    const fields = cleanMeetingFields({ title: "Sectionals", scheduledAt: inDays(3), timezone: "UTC" }, "scheduled", NOW);
    await createGroupMeetings({ group, creator: await member(MOD), kind: "scheduled", fields, origin: "https://neo.test" }, deps);
    assert.deepEqual(calls.checked, [OWNER]);
    assert.deepEqual(calls.incremented, [OWNER]);

    const full = gates({ used: 2, cap: 3 });
    const weekly = cleanMeetingFields(
      { title: "Weekly", scheduledAt: inDays(1), timezone: "UTC", recurrence: { freq: "weekly", interval: 1, count: 4 } },
      "scheduled",
      NOW
    );
    const before = (await listGroupMeetings(g.id, MOD, "upcoming", { now: NOW })).items.length;
    const mod = await member(MOD);
    await assert.rejects(
      () => createGroupMeetings({ group, creator: mod, kind: "scheduled", fields: weekly, origin: "https://neo.test" }, full.deps),
      (e: unknown) => e instanceof LifetimeCapError && e.detail.needed === 4
    );
    assert.deepEqual(full.calls.checked, [OWNER]);
    assert.deepEqual(full.calls.incremented, []);
    assert.equal((await listGroupMeetings(g.id, MOD, "upcoming", { now: NOW })).items.length, before);
  });

  console.log("group meetings: admission");

  await t("someone who joins the group after scheduling is let in; a stranger waits", async () => {
    const { deps } = gates();
    const fields = cleanMeetingFields({ title: "Later joiners", scheduledAt: inDays(4), timezone: "UTC" }, "scheduled", NOW);
    const { events } = await createGroupMeetings({ group, creator: await member(HOST), kind: "scheduled", fields, origin: "https://neo.test" }, deps);
    await addMembers(g.id, [person("user_newbie")], actor(MOD, "moderator"));

    const ev = events[0];
    assert.equal(ev.waitingRoomEnabled, true);
    assert.equal(await admitInvitee(ev, { userId: "user_newbie", emails: ["newbie@example.com"], name: "Newbie" }), true);
    assert.equal(await admitInvitee(ev, { userId: "user_stranger", emails: ["stranger@example.com"], name: "Stranger" }), false);
    const after = (await eventStore.byId(ev.id))!;
    // What the LiveKit token route checks:
    assert.equal(gateStatus(after.waitingRoom.find((e) => e.id === "user_newbie"), Date.now()), "admitted");
    assert.equal(gateStatus(after.waitingRoom.find((e) => e.id === "user_stranger"), Date.now()), "not_knocked");
  });

  await t("an extra invited by email is let in under that address", async () => {
    const { deps } = gates();
    const fields = cleanMeetingFields({ title: "With a guest", scheduledAt: inDays(5), timezone: "UTC" }, "scheduled", NOW);
    const { events } = await createGroupMeetings(
      { group, creator: await member(HOST), kind: "scheduled", fields, extras: [{ email: "Guest@Example.com" }], origin: "https://neo.test" },
      deps
    );
    assert.equal(await isInvited(events[0], "user_guest", ["guest@example.com"]), true);
    assert.equal(await isInvited(events[0], "user_guest", ["other@example.com"]), false);
  });

  console.log("group meetings: private calls");

  await t("a call invites the chosen members and the caller only; adding 3 keeps the same meeting", async () => {
    await addMembers(g.id, [person("user_a"), person("user_b"), person("user_c")], actor(MOD, "moderator"));
    const { deps } = gates();
    const fields = cleanMeetingFields({ title: "Quick call" }, "call", NOW);
    const { events } = await createGroupMeetings(
      { group, creator: await member(MOD), kind: "call", fields, callUserIds: [MEMBER], origin: "https://neo.test" },
      deps
    );
    const call = events[0];
    assert.equal(call.state, "live");
    assert.deepEqual(Array.from((await listInvited(call.id)).keys()).sort(), [MEMBER, MOD].sort());
    assert.equal(await isInvited(call, HOST, []), false);              // in the group, not in the call
    assert.equal((await listGroupMeetings(g.id, HOST, "upcoming")).items.some((i) => i.id === call.id), false);

    const added = await addParticipants(call, [{ userId: "user_a" }, { userId: "user_b" }, { userId: "user_c" }, { userId: MEMBER }], await member(MOD));
    assert.equal(added.length, 3);
    const invited = await listInvited(call.id);
    assert.equal(invited.size, 5);
    assert.equal((await eventStore.byId(call.id))!.id, call.id);
    assert.equal(await isInvited(call, "user_c", []), true);
    assert.equal((await listActivity(g.id))[0].type, "participants_added");
  });

  await t("a call may only include members of the group", async () => {
    const { deps } = gates();
    await refuses("not_member", async () =>
      createGroupMeetings(
        { group, creator: await member(MOD), kind: "call", fields: cleanMeetingFields({ title: "x" }, "call", NOW), callUserIds: ["user_outsider"], origin: "https://neo.test" },
        deps
      )
    );
  });

  console.log("group meetings: recurrence");

  await t("weekly ×4 makes 4 meetings with one seriesId", async () => {
    const { deps, calls } = gates();
    const fields = cleanMeetingFields(
      { title: "Weekly sync", scheduledAt: inDays(1), durationMin: 45, timezone: "UTC", recurrence: { freq: "weekly", interval: 1, count: 4 } },
      "scheduled",
      NOW
    );
    const { events, seriesId } = await createGroupMeetings({ group, creator: await member(MOD), kind: "scheduled", fields, origin: "https://neo.test" }, deps);
    assert.equal(events.length, 4);
    assert.ok(seriesId);
    assert.ok(events.every((e) => e.seriesId === seriesId));
    assert.deepEqual(calls.incremented, [OWNER, OWNER, OWNER, OWNER]);
    for (let i = 1; i < 4; i++) assert.equal(Date.parse(events[i].scheduledAt!) - Date.parse(events[i - 1].scheduledAt!), 7 * 86_400_000);

    // "This and following" from #2 cancels #2–#4 only.
    const cancelled = await cancelGroupMeetings(events[1], "following", await member(MOD));
    assert.deepEqual(cancelled.map((e) => e.id), events.slice(1).map((e) => e.id));
    const states = await Promise.all(events.map(async (e) => (await eventStore.byId(e.id))!.state));
    assert.deepEqual(states, ["scheduled", "archived", "archived", "archived"]);
    const upcoming = (await listGroupMeetings(g.id, MOD, "upcoming", { now: NOW })).items.map((i) => i.id);
    assert.ok(upcoming.includes(events[0].id));
    assert.ok(!upcoming.includes(events[1].id));
    assert.equal(await isInvited((await eventStore.byId(events[2].id))!, MEMBER, []), false);
  });

  await t("editing \"this and following\" moves the later meetings by the same amount", async () => {
    const { deps } = gates();
    const fields = cleanMeetingFields(
      { title: "Daily", scheduledAt: inDays(1), timezone: "UTC", recurrence: { freq: "daily", interval: 1, count: 3 } },
      "scheduled",
      NOW
    );
    const { events } = await createGroupMeetings({ group, creator: await member(MOD), kind: "scheduled", fields, origin: "https://neo.test" }, deps);
    const moved = new Date(Date.parse(events[1].scheduledAt!) + 30 * 60_000).toISOString();
    const changed = await updateGroupMeetings(events[1], { scheduledAt: moved, title: "Daily standup" }, "following", await member(MOD), NOW);
    assert.equal(changed.length, 2);
    assert.equal(changed[0].scheduledAt, moved);
    assert.equal(Date.parse(changed[1].scheduledAt!) - Date.parse(events[2].scheduledAt!), 30 * 60_000);
    assert.equal((await eventStore.byId(events[0].id))!.name, "Daily");
    assert.equal(changed[1].groupMeeting!.sequence, 1);
  });

  await t("a series keeps its wall-clock time across a DST change, and stops at 12 or 90 days", () => {
    // 10:00 in London every Monday from 19 Oct 2026; the clocks go back on 25 Oct.
    const start = "2026-10-19T09:00:00.000Z";
    const occ = materialise(start, "Europe/London", { freq: "weekly", interval: 1, count: 3 });
    assert.deepEqual(occ.map((iso) => localParts(Date.parse(iso), "Europe/London").h), [10, 10, 10]);
    assert.equal(occ[1], "2026-10-26T10:00:00.000Z");
    assert.equal(materialise(start, "UTC", { freq: "daily", interval: 1, count: 52 }).length, 12);
    assert.equal(materialise(start, "UTC", { freq: "weekly", interval: 2, count: 52 }).length, 7);   // 90 days
    assert.equal(materialise(start, "UTC", { freq: "weekly", interval: 1, until: "2026-11-02" }).length, 3);
    // Mon + Thu
    assert.deepEqual(
      materialise(start, "UTC", { freq: "weekly", interval: 1, byWeekday: [1, 4], count: 4 }).map((iso) => new Date(iso).getUTCDay()),
      [1, 4, 1, 4]
    );
    // 31 Jan monthly skips the months without a 31st.
    assert.deepEqual(
      materialise("2027-01-31T12:00:00.000Z", "UTC", { freq: "monthly", interval: 1, count: 3 }).map((iso) => iso.slice(0, 10)),
      ["2027-01-31", "2027-03-31"]
    );
  });

  await t("inline rules: title, future time, duration 5–480, recurrence bounds", () => {
    const base = { title: "x", scheduledAt: inDays(1), timezone: "UTC" };
    assert.throws(() => cleanMeetingFields({ ...base, title: "  " }, "scheduled", NOW), /invalid_title/);
    assert.throws(() => cleanMeetingFields({ ...base, scheduledAt: inDays(-1) }, "scheduled", NOW), /invalid_time/);
    assert.throws(() => cleanMeetingFields({ ...base, durationMin: 4 }, "scheduled", NOW), /invalid_duration/);
    assert.throws(() => cleanMeetingFields({ ...base, durationMin: 481 }, "scheduled", NOW), /invalid_duration/);
    assert.throws(() => cleanMeetingFields({ ...base, timezone: "Mars/Olympus" }, "scheduled", NOW), /invalid_timezone/);
    assert.throws(() => cleanMeetingFields({ ...base, recurrence: { freq: "weekly", interval: 1, count: 53 } }, "scheduled", NOW), /invalid_recurrence/);
    assert.throws(() => cleanMeetingFields({ ...base, recurrence: { freq: "weekly", interval: 13, count: 2 } }, "scheduled", NOW), /invalid_recurrence/);
    assert.throws(() => cleanMeetingFields({ ...base, recurrence: { freq: "weekly", interval: 1 } }, "scheduled", NOW), /invalid_recurrence/);
    assert.throws(() => cleanMeetingFields({ ...base, recurrence: { freq: "weekly", interval: 1, until: "2020-01-01" } }, "scheduled", NOW), /invalid_recurrence/);
    assert.equal(cleanMeetingFields({ ...base, waitingRoom: false }, "now", NOW).waitingRoom, true);
  });

  console.log("group meetings: invitations");

  await t("a weekly series reaches every member in one email with the four meetings in its .ics", async () => {
    const { deps } = gates();
    const fields = cleanMeetingFields(
      { title: "Prayer meeting", scheduledAt: inDays(2), timezone: "UTC", recurrence: { freq: "weekly", interval: 1, count: 4 } },
      "scheduled",
      NOW
    );
    const { events } = await createGroupMeetings({ group, creator: await member(MOD), kind: "scheduled", fields, origin: "https://neo.test" }, deps);

    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    process.env.RESEND_API_KEY = "test-placeholder";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    }) as typeof fetch;
    try {
      const recipients = await inviteesOf(events[0], MOD);
      const summary = await notifyInvitees(events, recipients, "scheduled", { senderUserId: MOD, senderName: "Mod", origin: "https://neo.test" });
      assert.equal(sent.length, 1);
      const bcc = sent[0].bcc as string[];
      assert.ok(bcc.includes("member@example.com") && bcc.includes("owner@example.com") && bcc.includes("newbie@example.com"));
      assert.ok(!bcc.includes("mod@example.com"));
      const ics = Buffer.from((sent[0].attachments as Array<{ content: string }>)[0].content, "base64").toString("utf8");
      assert.match(ics, /METHOD:REQUEST/);
      assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 4);
      assert.equal(summary.sent, recipients.length);
      assert.equal(summary.unreachable, 0);
      for (const r of summary.results) assert.equal(r.channels.kingschat, "unavailable");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.RESEND_API_KEY;
    }
  });

  await t("with mail not configured, members are still reached in the app; email reaches no one", async () => {
    const evs = (await listGroupMeetings(g.id, MOD, "upcoming", { now: NOW })).items;
    const ev = (await eventStore.byId(evs[0].id)) as NeoEvent;
    const recipients = await inviteesOf(ev, MOD);
    const summary = await notifyInvitees(ev, recipients, "updated", { senderUserId: MOD, senderName: "Mod", origin: "https://neo.test" });
    assert.ok(summary.results.every((r) => r.channels.email === "unavailable"));
    assert.ok(summary.results.every((r) => r.channels.inApp === (r.userId ? "sent" : "unavailable")));
    assert.equal(summary.sent, recipients.filter((r) => r.userId).length);
  });

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
