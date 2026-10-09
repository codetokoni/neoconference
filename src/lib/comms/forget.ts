// src/lib/comms/forget.ts
//
// Data governance for communication records: what account deletion removes
// and what a "notification history" retention setting trims.
//
// forgetCommsUser(uid, emails)
//   deletes  neo:comms:prefs:<uid>, neo:comms:rem:<uid>:*, neo:comms:bounced:<email>
//   anonymises (keeps the row, drops who it was): their entries in the
//   transactional log and delivery reports, their place in every send's
//   recipient blocks, statuses and failure list. Counts stay right; the
//   person is gone. Resend message refs (neo:comms:msg:<id>) name the user
//   id and expire by themselves after 35 days.
//
// purgeCommsLogBefore(ts)
//   removes log entries and delivery reports older than ts, and finished,
//   cancelled or never-confirmed sends created before ts with all their keys.
//   Sends still running or paused are kept whatever their age.
//
// Lists are rewritten whole (read, filter, replace). A line appended in the
// moment between read and write can be lost; both run rarely and by hand or
// on a daily job, which is acceptable for a log.

import { kv } from "@/lib/kv";

const LOG = "neo:comms:log";
const EVENTS = "neo:comms:events";
const SENDS = "neo:comms:sends";
const DELETED = "Deleted account";

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

/** Replace a list's contents (newest first, as LPUSH builds it). */
async function rewriteList(key: string, items: string[]): Promise<void> {
  await kv.del(key);
  for (let i = items.length - 1; i >= 0; i--) await kv.lpush(key, items[i]);
}

async function readList(key: string): Promise<unknown[]> {
  return ((await kv.lrange(key, 0, -1)) ?? []) as unknown[];
}

async function scanKeys(match: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | number = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const [next, keys] = (await kv.scan(cursor, { match, count: 500 })) as [string | number, string[]];
    out.push(...keys);
    if (String(next) === "0") break;
    cursor = next;
  }
  return out;
}

export async function forgetCommsUser(uid: string, emails: string[]): Promise<{ removed: number }> {
  if (!uid) return { removed: 0 };
  const addrs = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const names = (s: string | undefined) => !!s && [...addrs].some((a) => s.toLowerCase().includes(a));
  let removed = 0;

  removed += Number(await kv.del(`neo:comms:prefs:${uid}`));
  for (const k of await scanKeys(`neo:comms:rem:${uid}:*`)) removed += Number(await kv.del(k));
  for (const a of addrs) removed += Number(await kv.del(`neo:comms:bounced:${a}`));

  // Transactional log and delivery reports.
  for (const key of [LOG, EVENTS]) {
    const raw = await readList(key);
    let changed = 0;
    const next = raw.map((r) => {
      const e = parse<Record<string, unknown>>(r);
      if (!e || !(e.userId === uid || names(e.to as string | undefined))) return typeof r === "string" ? r : JSON.stringify(r);
      changed++;
      return JSON.stringify({ ...e, to: DELETED, userId: e.userId ? "deleted" : undefined });
    });
    if (changed) {
      await rewriteList(key, next);
      removed += changed;
    }
  }

  // Every send's blocks, statuses, failures and seen-set.
  const ids = ((await kv.lrange(SENDS, 0, 999)) ?? []).map(String);
  for (const id of ids) {
    const send = parse<{ chunks: number }>(await kv.get(`neo:comms:send:${id}`));
    if (!send) continue;
    removed += Number(await kv.srem(`neo:comms:send:${id}:seen`, uid)) ? 1 : 0;
    for (let n = 0; n < send.chunks; n++) {
      const chunkKey = `neo:comms:send:${id}:chunk:${n}`;
      const chunk = parse<Array<Record<string, unknown>>>(await kv.get(chunkKey));
      if (!chunk || !chunk.some((r) => r.uid === uid)) continue;
      await kv.set(chunkKey, JSON.stringify(chunk.map((r) => (r.uid === uid ? { ...r, name: DELETED, firstName: "", email: "" } : r))));
      const st = parse<Record<string, unknown>>(await kv.hget(`neo:comms:send:${id}:st:${n}`, uid));
      if (st) await kv.hset(`neo:comms:send:${id}:st:${n}`, { [uid]: JSON.stringify({ ...st, name: DELETED, email: "" }) });
      removed++;
    }
    const failKey = `neo:comms:send:${id}:fail`;
    const fails = await readList(failKey);
    let changed = false;
    const next = fails.map((r) => {
      const f = parse<Record<string, unknown>>(r);
      if (!f || !(f.uid === uid || names(f.email as string | undefined))) return typeof r === "string" ? r : JSON.stringify(r);
      changed = true;
      return JSON.stringify({ ...f, email: "", uid: "deleted" });
    });
    if (changed) await rewriteList(failKey, next);
  }
  return { removed };
}

export async function purgeCommsLogBefore(ts: number): Promise<{ removed: number }> {
  let removed = 0;
  for (const key of [LOG, EVENTS]) {
    const raw = await readList(key);
    const keep = raw.filter((r) => (parse<{ ts?: number }>(r)?.ts ?? 0) >= ts);
    if (keep.length !== raw.length) {
      await rewriteList(key, keep.map((r) => (typeof r === "string" ? r : JSON.stringify(r))));
      removed += raw.length - keep.length;
    }
  }
  const ids = ((await kv.lrange(SENDS, 0, -1)) ?? []).map(String);
  const kept: string[] = [];
  for (const id of ids) {
    const send = parse<{ createdAt: number; status: string; chunks: number }>(await kv.get(`neo:comms:send:${id}`));
    if (!send) continue; // a discarded draft: drop the dangling id
    const finished = send.status === "done" || send.status === "cancelled" || send.status === "draft";
    if (!finished || send.createdAt >= ts) {
      kept.push(id);
      continue;
    }
    const keys = [`neo:comms:send:${id}`, `neo:comms:send:${id}:seen`, `neo:comms:send:${id}:fail`, `neo:comms:send:${id}:lease`];
    for (let n = 0; n < send.chunks; n++) keys.push(`neo:comms:send:${id}:chunk:${n}`, `neo:comms:send:${id}:st:${n}`, `neo:comms:send:${id}:claim:${n}`);
    for (const t of ["delivered", "bounced", "complained", "delayed", "failed"]) keys.push(`neo:comms:send:${id}:wh:${t}`);
    for (const k of keys) await kv.del(k);
    await kv.srem("neo:comms:active", id);
    removed++;
  }
  if (kept.length !== ids.length) await rewriteList(SENDS, kept);
  return { removed };
}
