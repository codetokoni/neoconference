// Run: npx tsx src/lib/__tests__/groupChat.smoke.ts
// Group chat against the in-memory fallback: the cheap poll, the cap, the
// rate limit, who may delete, mentions, and meetings' lines in the chat.
import assert from "node:assert/strict";
import type { MeetingRole } from "@/lib/permissions";
import { createGroup, setRole, getMember, getGroup, removeMember, listMembers } from "@/lib/groupStore";
import {
  readChat, postMessage, postSystemMessage, deleteMessage, allowMessage, parseMentions, markChatRead, unreadChatCount,
  __reads, MAX_GROUP_MESSAGES, RATE_LIMIT,
} from "@/lib/groupChat";
import { createGroupMeetings, cleanMeetingFields, cancelGroupMeetings, type CreateMeetingDeps } from "@/lib/groupMeetings";
import { processOpenMeetings, announceEnded } from "@/lib/groupChatEvents";
import { recordAttendance } from "@/lib/attendance";
import { eventStore } from "@/lib/eventStore";
import { __setReportDeps } from "@/lib/groupReports";
import { listNotifications } from "@/lib/notificationStore";
import { notifyMention } from "@/lib/groupNotify";

delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
__setReportDeps({ recording: async () => ({ recorded: false, url: null }) });

const MIN = 60_000;
const deps: CreateMeetingDeps = { checkCap: async () => ({ blocked: false, used: 0, cap: 0, plan: "pro" }), incrementCap: async () => {}, applyRecurringRoles: async () => {} };
const actor = (userId: string, role: MeetingRole) =>
  ({ userId, emails: [], isPlatformAdmin: false, role, isOwner: role === "owner", reason: "assignment" as const });

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("  ok  " + name); };

(async () => {
  const g = await createGroup({ name: "Ushers" }, { userId: "user_own", name: "Olu" }, [
    { userId: "user_mod", name: "Musa" },
    { userId: "user_ada", name: "Ada" },
    { userId: "user_adaobi", name: "Ada Obi" },
    { userId: "user_bo", name: "Bo" },
  ]);
  await setRole(g.id, "user_mod", "moderator", actor("user_own", "owner"));
  const member = async (id: string) => (await getMember(g.id, id))!;

  console.log("reading");

  await t("a poll with the current version costs one read and says unchanged", async () => {
    await postMessage(g.id, await member("user_ada"), { text: "hello" }, await listMembers(g.id));
    const first = await readChat(g.id);
    assert.ok(!("unchanged" in first));
    const ver = first.ver;
    __reads.count = 0;
    const again = await readChat(g.id, { sinceVer: ver });
    assert.deepEqual(again, { unchanged: true, ver });
    assert.equal(__reads.count, 1);
    await postMessage(g.id, await member("user_bo"), { text: "hi" }, await listMembers(g.id));
    const changed = await readChat(g.id, { sinceVer: ver });
    assert.ok(!("unchanged" in changed) && changed.messages.at(-1)!.text === "hi");
  });

  await t("the chat keeps the newest 500; older pages come with before=", async () => {
    const gb = await createGroup({ name: "Busy" }, { userId: "user_x", name: "X" });
    for (let i = 0; i < MAX_GROUP_MESSAGES + 20; i++) await postSystemMessage(gb.id, `line ${i}`);
    const page = await readChat(gb.id);
    assert.ok(!("unchanged" in page));
    assert.equal(page.messages.length, 50);
    assert.equal(page.messages.at(-1)!.text, `line ${MAX_GROUP_MESSAGES + 19}`);
    assert.equal(page.hasOlder, true);
    let oldest = page.messages[0];
    let total = page.messages.length;
    for (;;) {
      const older = await readChat(gb.id, { before: oldest.id });
      if ("unchanged" in older || older.messages.length === 0) break;
      total += older.messages.length;
      oldest = older.messages[0];
      if (!older.hasOlder) break;
    }
    assert.equal(total, MAX_GROUP_MESSAGES);
    assert.equal(oldest.text, "line 20");
  });

  console.log("writing");

  await t("10 messages per 10 seconds a person, then refused; the next window is open", async () => {
    const now = 1_000_000;
    for (let i = 0; i < RATE_LIMIT.messages; i++) assert.equal(await allowMessage(g.id, "user_rate", now + i), true);
    assert.equal(await allowMessage(g.id, "user_rate", now + 500), false);
    assert.equal(await allowMessage(g.id, "user_other", now + 500), true);
    assert.equal(await allowMessage(g.id, "user_rate", now + RATE_LIMIT.windowSeconds * 1000), true);
  });

  await t("a Member cannot delete someone else's message; a Moderator can; your own you can", async () => {
    const m = await postMessage(g.id, await member("user_ada"), { text: "oops" }, await listMembers(g.id));
    await assert.rejects(() => deleteMessage(g.id, m.id, { userId: "user_bo", canModerate: false }), /insufficient_rank/);
    const removed = await deleteMessage(g.id, m.id, { userId: "user_mod", canModerate: true });
    assert.equal(removed.text, "Message removed");
    assert.equal(removed.deleted, true);
    const own = await postMessage(g.id, await member("user_bo"), { text: "mine" }, await listMembers(g.id));
    assert.equal((await deleteMessage(g.id, own.id, { userId: "user_bo", canModerate: false })).deleted, true);
  });

  await t("a reply quotes what it answers; empty and over-long messages are refused", async () => {
    const original = await postMessage(g.id, await member("user_ada"), { text: "Who has the keys?" }, await listMembers(g.id));
    const reply = await postMessage(g.id, await member("user_bo"), { text: "I do", replyToId: original.id }, await listMembers(g.id));
    assert.deepEqual(reply.replyTo, { id: original.id, name: "Ada", snippet: "Who has the keys?" });
    const bo = await member("user_bo");
    await assert.rejects(() => postMessage(g.id, bo, { text: "   " }, []), /empty_message/);
    await assert.rejects(() => postMessage(g.id, bo, { text: "x".repeat(8001) }, []), /message_too_long/);
    // Only files uploaded to this group's own folder.
    await assert.rejects(() => postMessage(g.id, bo, { text: "x", attachments: [{ key: "groups/other/f.png" }] }, []), /invalid_attachments/);
  });

  await t("@mentions resolve to current members only, longest name first, never the author", async () => {
    const members = await listMembers(g.id);
    assert.deepEqual(parseMentions("hi @Ada Obi and @Bo", members, "user_own").sort(), ["user_adaobi", "user_bo"]);
    assert.deepEqual(parseMentions("@ada thanks", members), ["user_ada"]);
    assert.deepEqual(parseMentions("@Adam is not here", members), []);
    assert.deepEqual(parseMentions("@Bo", members, "user_bo"), []);
    await removeMember(g.id, "user_bo", actor("user_own", "owner"));
    const m = await postMessage(g.id, await member("user_ada"), { text: "@Bo @Musa please" }, await listMembers(g.id));
    assert.deepEqual(m.mentions, ["user_mod"]);
    await notifyMention(m.mentions!, { groupId: g.id, groupName: "Ushers", senderName: "Ada", text: m.text });
    const bell = await listNotifications("user_mod");
    assert.equal(bell.items[0].type, "mention");
    assert.equal(bell.items[0].title, "Ada mentioned you in Ushers");
    assert.equal((await listNotifications("user_bo")).items.length, 0);
  });

  await t("unread counts others' messages since the last read", async () => {
    await markChatRead(g.id, "user_ada");
    await new Promise((r) => setTimeout(r, 5));
    await postMessage(g.id, await member("user_mod"), { text: "one" }, await listMembers(g.id));
    await postMessage(g.id, await member("user_ada"), { text: "mine" }, await listMembers(g.id));
    await postMessage(g.id, await member("user_mod"), { text: "two" }, await listMembers(g.id));
    assert.equal(await unreadChatCount(g.id, "user_ada"), 2);
    await markChatRead(g.id, "user_ada");
    assert.equal(await unreadChatCount(g.id, "user_ada"), 0);
  });

  console.log("meetings in the chat");

  await t("scheduling and cancelling post a line; a private call posts nothing", async () => {
    const group = (await getGroup(g.id))!;
    const before = await readChat(g.id);
    const at = Date.now() + 2 * 24 * 60 * MIN;
    const fields = cleanMeetingFields({ title: "Drill", scheduledAt: new Date(at).toISOString(), timezone: "UTC" }, "scheduled");
    const { events } = await createGroupMeetings({ group, creator: await member("user_own"), kind: "scheduled", fields, origin: "https://neo.test" }, deps);
    await createGroupMeetings(
      { group, creator: await member("user_own"), kind: "call", fields: cleanMeetingFields({ title: "Quiet" }, "call"), callUserIds: ["user_ada"], origin: "https://neo.test" },
      deps
    );
    await cancelGroupMeetings(events[0], "this", await member("user_own"));
    const after = await readChat(g.id);
    assert.ok(!("unchanged" in before) && !("unchanged" in after));
    const lines = after.messages.slice(-2).map((m) => [m.system, m.text.split(" · ")[0]]);
    assert.deepEqual(lines, [[true, "Olu scheduled “Drill”"], [true, "Olu cancelled “Drill”"]]);
  });

  await t("a meeting that ends posts exactly one result line with its report", async () => {
    const group = (await getGroup(g.id))!;
    const { events } = await createGroupMeetings(
      { group, creator: await member("user_own"), kind: "now", fields: cleanMeetingFields({ title: "Huddle" }, "now"), origin: "https://neo.test" },
      deps
    );
    const ev = events[0];
    const start = Date.parse(ev.startedAt!);
    await recordAttendance(ev.id, { action: "join", userId: "user_own", name: "Olu", source: "webhook", ts: start });
    await recordAttendance(ev.id, { action: "join", userId: "user_ada", name: "Ada", source: "webhook", ts: start + MIN });
    await eventStore.update(ev.id, (p) => ({ ...p, state: "ended", endedAt: new Date(start + 30 * MIN).toISOString() }));

    const ticks = await Promise.all([processOpenMeetings(), processOpenMeetings()]);
    assert.equal(ticks[0].ended + ticks[1].ended, 1);
    assert.equal((await processOpenMeetings()).ended, 0);
    assert.equal(await announceEnded((await eventStore.byId(ev.id))!), false);

    const page = await readChat(g.id);
    assert.ok(!("unchanged" in page));
    const ended = page.messages.filter((m) => m.text.includes("Meeting ended"));
    assert.equal(ended.length, 1);
    assert.match(ended[0].text, /^“Huddle” · Meeting ended · 30 min · 2\/\d+ attended$/);
    assert.equal(ended[0].link!.href, `/dashboard/groups/${g.id}/reports/${ev.id}`);
    assert.equal(page.messages.filter((m) => m.text === "“Huddle” has started").length, 1);
  });

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
