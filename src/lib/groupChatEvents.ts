// src/lib/groupChatEvents.ts
//
// Group meetings, as lines in the group's chat: scheduled, started,
// cancelled, and — when one ends — "Meeting ended · 45 min · 4/6 attended"
// with its report and AI summary.
//
// A meeting can end in three places (the LiveKit webhook, the End button,
// the meeting sweep), so the scheduler's tick is what notices: every group
// meeting not yet over sits in neo:groupmeetings:open, and each tick looks
// at those, posts "started" once one is live and the result once it is
// over, then lets it go. Each line is posted at most once, guarded by
// neo:groupchat:posted:<eid>:<what> (SET NX).
//
// Private calls are never posted: they are not the group's business.

import { kv } from "@vercel/kv";
import { eventStore } from "@/lib/eventStore";
import { postSystemMessage } from "@/lib/groupChat";
import { buildMeetingReport } from "@/lib/groupReports";
import { whenText } from "@/lib/groupNotify";
import { minutesText } from "@/lib/durationText";
import type { NeoEvent } from "@/types/event";

const OPEN = "neo:groupmeetings:open";
const postedKey = (eid: string, what: string) => `neo:groupchat:posted:${eid}:${what}`;
const POSTED_TTL_SECONDS = 400 * 24 * 60 * 60;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const memOpen = new Set<string>();
const memPosted = new Set<string>();

/** Claim the right to post this line; false if it was already posted. */
async function claim(eid: string, what: string): Promise<boolean> {
  if (!isKvConfigured()) {
    const k = postedKey(eid, what);
    if (memPosted.has(k)) return false;
    memPosted.add(k);
    return true;
  }
  return (await kv.set(postedKey(eid, what), "1", { nx: true, ex: POSTED_TTL_SECONDS })) === "OK";
}

export async function trackOpenMeeting(eid: string): Promise<void> {
  if (!isKvConfigured()) {
    memOpen.add(eid);
    return;
  }
  await kv.sadd(OPEN, eid);
}

async function untrack(eid: string): Promise<void> {
  if (!isKvConfigured()) {
    memOpen.delete(eid);
    return;
  }
  await kv.srem(OPEN, eid);
}

async function openMeetings(): Promise<string[]> {
  if (!isKvConfigured()) return Array.from(memOpen);
  return ((await kv.smembers(OPEN)) as unknown[]).map(String);
}

const joinHref = (ev: NeoEvent) => `/room/${encodeURIComponent(ev.slug)}?event=${encodeURIComponent(ev.slug)}&join=1`;

/** A meeting (or a series) was scheduled. */
export async function announceScheduled(events: NeoEvent[], byName: string): Promise<void> {
  const first = events[0];
  if (!first?.groupId || first.groupMeeting?.kind !== "scheduled") return;
  for (const ev of events) await trackOpenMeeting(ev.id);
  if (!(await claim(first.id, "scheduled"))) return;
  const many = events.length > 1 ? ` (${events.length} meetings)` : "";
  await postSystemMessage(first.groupId, `${byName} scheduled “${first.name}” · ${whenText(first)}${many}`, {
    href: `/${first.slug}`,
    label: "Open meeting",
  });
}

/** A meeting went live. Posted once, whether from Start now or the tick. */
export async function announceStarted(ev: NeoEvent): Promise<boolean> {
  if (!ev.groupId || !ev.groupMeeting || ev.groupMeeting.kind === "call") return false;
  if (!(await claim(ev.id, "started"))) return false;
  await postSystemMessage(ev.groupId, `“${ev.name}” has started`, { href: joinHref(ev), label: "Join" });
  return true;
}

/** One or more meetings were cancelled. */
export async function announceCancelled(events: NeoEvent[], byName: string): Promise<void> {
  const first = events[0];
  if (!first?.groupId || first.groupMeeting?.kind === "call") return;
  for (const ev of events) await untrack(ev.id);
  if (!(await claim(first.id, "cancelled"))) return;
  const many = events.length > 1 ? ` (${events.length} meetings)` : "";
  await postSystemMessage(first.groupId, `${byName} cancelled “${first.name}” · ${whenText(first)}${many}`);
}

/** The result line for a meeting that is over. Posted once. */
export async function announceEnded(ev: NeoEvent, now: number = Date.now()): Promise<boolean> {
  if (!ev.groupId || !ev.groupMeeting || ev.groupMeeting.kind === "call") return false;
  if (!(await claim(ev.id, "ended"))) return false;
  const report = await buildMeetingReport(ev.id, now);
  const s = report?.summary;
  const parts = ["Meeting ended", report && report.durationMin ? minutesText(report.durationMin) : null, s ? `${s.attended}/${s.invited} attended` : null];
  let text = `“${ev.name}” · ${parts.filter(Boolean).join(" · ")}`;
  if (s?.aiSummary) text += `\n\nSummary: ${s.aiSummary}`;
  await postSystemMessage(ev.groupId, text, {
    href: `/dashboard/groups/${encodeURIComponent(ev.groupId)}/reports/${encodeURIComponent(ev.id)}`,
    label: "View report",
  });
  return true;
}

/**
 * The tick's look at every group meeting not yet over: "started" once it is
 * live, the result once it has ended, and done.
 */
export async function processOpenMeetings(now: number = Date.now()): Promise<{ started: number; ended: number; open: number }> {
  const out = { started: 0, ended: 0, open: 0 };
  for (const eid of await openMeetings()) {
    const ev = await eventStore.byId(eid);
    if (!ev || !ev.groupMeeting || ev.groupMeeting.kind === "call" || ev.groupMeeting.cancelledAt || ev.state === "archived") {
      await untrack(eid);
      continue;
    }
    if (ev.state === "ended" || ev.state === "replay") {
      if (await announceEnded(ev, now)) out.ended++;
      await untrack(eid);
      continue;
    }
    if ((ev.state === "live" || ev.state === "waiting") && (await announceStarted(ev))) out.started++;
    out.open++;
  }
  return out;
}
