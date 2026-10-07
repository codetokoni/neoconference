// src/lib/userMeetings.ts
//
// The group meetings a person was part of — invited to, or joined — for "My
// meeting reports".
//
//   neo:user:<uid>:meetings   zset   eid scored by the meeting's start (epoch ms)
//
// Written when someone is invited (groupMeetings.addInvited) and when their
// join is recorded (attendance.ts). It is never trimmed when someone leaves a
// group, so their history stays theirs.

import { kv } from "@/lib/kv";
import type { NeoEvent } from "@/types/event";

const key = (uid: string) => `neo:user:${uid}:meetings`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const mem = new Map<string, Map<string, number>>();

/** When a meeting starts (or started), for ordering. */
export function meetingStartMs(ev: Pick<NeoEvent, "scheduledAt" | "startedAt" | "createdAt">): number {
  return Date.parse(ev.scheduledAt || ev.startedAt || ev.createdAt) || 0;
}

export async function addUserMeeting(uid: string, eid: string, startMs: number): Promise<void> {
  if (!uid || !eid || uid.includes("@")) return;
  if (!isKvConfigured()) {
    let b = mem.get(uid);
    if (!b) {
      b = new Map();
      mem.set(uid, b);
    }
    b.set(eid, startMs);
    return;
  }
  await kv.zadd(key(uid), { score: startMs, member: eid });
}

/**
 * A page of someone's meetings, newest first. `cursor` is the start (epoch
 * ms) the next page continues below.
 */
export async function listUserMeetings(
  uid: string,
  opts: { cursor?: number; limit?: number } = {}
): Promise<{ eids: Array<{ eid: string; startMs: number }>; nextCursor: number | null }> {
  const limit = opts.limit ?? 20;
  const max = opts.cursor ?? Number.MAX_SAFE_INTEGER;
  const exclusive = opts.cursor !== undefined;
  let rows: Array<{ eid: string; startMs: number }>;
  if (!isKvConfigured()) {
    rows = Array.from(mem.get(uid) ?? [])
      .map(([eid, startMs]) => ({ eid, startMs }))
      .filter((r) => (exclusive ? r.startMs < max : r.startMs <= max))
      .sort((a, b) => b.startMs - a.startMs)
      .slice(0, limit);
  } else {
    const hi: number | `(${number}` = exclusive ? `(${max}` : max;
    const raw = (await kv.zrange(key(uid), hi, "-inf", {
      byScore: true,
      rev: true,
      offset: 0,
      count: limit,
      withScores: true,
    })) as unknown[];
    rows = [];
    for (let i = 0; i + 1 < raw.length; i += 2) rows.push({ eid: String(raw[i]), startMs: Number(raw[i + 1]) });
  }
  return { eids: rows, nextCursor: rows.length === limit ? rows[rows.length - 1].startMs : null };
}

/** Whether a meeting is already in someone's list. */
export async function hasUserMeeting(uid: string, eid: string): Promise<boolean> {
  if (!isKvConfigured()) return mem.get(uid)?.has(eid) ?? false;
  return (await kv.zscore(key(uid), eid)) !== null;
}
