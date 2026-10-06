// src/lib/scheduler.ts
//
// A small job queue in KV, worked by POST /api/internal/dispatch, which the
// scheduler container on the droplet calls every 30 seconds.
//
// Storage (Vercel KV, in-memory fallback as elsewhere)
//   neo:sched:jobs           zset   jobId scored by when it is due (epoch ms)
//   neo:sched:job:<jobId>    JSON   { id, type, eid, attempt?, createdAt, fireAt }, 7-day TTL
//   neo:event:<eid>:jobs     set    the jobIds belonging to one meeting
//   neo:sched:lock           NX     one tick at a time (25 s)
//
// Job ids are made from the meeting and the job's purpose, so scheduling the
// same thing twice replaces it rather than doubling it. A meeting has at most
// one pending ring job: each person's attempts are counted separately (see
// ringEngine.ts), so the job is just "ring whoever is due".
//
// claimDue() takes a job by removing it from the zset; only the caller whose
// remove succeeded runs it, so overlapping ticks never run a job twice.

import { kv } from "@vercel/kv";

export type JobType = "remind60" | "remind30" | "ring";

export interface Job {
  id: string;
  type: JobType;
  eid: string;
  /** Ring jobs: which round this is, for logs. */
  attempt?: number;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms it was due. */
  fireAt: number;
}

const ZSET = "neo:sched:jobs";
const jobKey = (id: string) => `neo:sched:job:${id}`;
const eventJobsKey = (eid: string) => `neo:event:${eid}:jobs`;
const LOCK = "neo:sched:lock";
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
export const LOCK_SECONDS = 25;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

const memZ = new Map<string, number>();
const memJobs = new Map<string, Job>();
const memEventJobs = new Map<string, Set<string>>();
let memLockUntil = 0;

export function jobId(eid: string, type: JobType): string {
  return `${eid}:${type}`;
}

function parseJob(raw: unknown): Job | null {
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.eid !== "string" || typeof r.fireAt !== "number") return null;
  if (r.type !== "remind60" && r.type !== "remind30" && r.type !== "ring") return null;
  return {
    id: r.id,
    type: r.type,
    eid: r.eid,
    ...(typeof r.attempt === "number" ? { attempt: r.attempt } : {}),
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    fireAt: r.fireAt,
  };
}

/** Queue a job (or move it, if one with the same id is pending). */
export async function scheduleJob(
  eid: string,
  type: JobType,
  fireAt: number,
  opts: { attempt?: number; now?: number } = {}
): Promise<Job> {
  const job: Job = {
    id: jobId(eid, type),
    type,
    eid,
    ...(opts.attempt !== undefined ? { attempt: opts.attempt } : {}),
    createdAt: opts.now ?? Date.now(),
    fireAt,
  };
  if (!isKvConfigured()) {
    memJobs.set(job.id, job);
    memZ.set(job.id, fireAt);
    let s = memEventJobs.get(eid);
    if (!s) {
      s = new Set();
      memEventJobs.set(eid, s);
    }
    s.add(job.id);
    return job;
  }
  await kv.set(jobKey(job.id), JSON.stringify(job), { ex: JOB_TTL_SECONDS });
  await kv.zadd(ZSET, { score: fireAt, member: job.id });
  await kv.sadd(eventJobsKey(eid), job.id);
  await kv.expire(eventJobsKey(eid), JOB_TTL_SECONDS);
  return job;
}

/** Every job still pending for a meeting, soonest first. */
export async function jobsFor(eid: string): Promise<Job[]> {
  const ids = !isKvConfigured()
    ? Array.from(memEventJobs.get(eid) ?? [])
    : ((await kv.smembers(eventJobsKey(eid))) as unknown[]).map(String);
  const jobs = await Promise.all(
    ids.map(async (id) => {
      if (!isKvConfigured()) return memZ.has(id) ? memJobs.get(id) ?? null : null;
      const [raw, score] = await Promise.all([kv.get(jobKey(id)), kv.zscore(ZSET, id)]);
      return score === null ? null : parseJob(raw);
    })
  );
  return jobs.filter((j): j is Job => j !== null).sort((a, b) => a.fireAt - b.fireAt);
}

/** Drop every pending job of a meeting (cancelled, deleted, or rescheduling). */
export async function cancelMeetingJobs(eid: string): Promise<number> {
  if (!isKvConfigured()) {
    const ids = Array.from(memEventJobs.get(eid) ?? []);
    for (const id of ids) {
      memZ.delete(id);
      memJobs.delete(id);
    }
    memEventJobs.delete(eid);
    return ids.length;
  }
  const ids = ((await kv.smembers(eventJobsKey(eid))) as unknown[]).map(String);
  if (ids.length > 0) {
    await kv.zrem(ZSET, ...ids);
    await kv.del(...ids.map(jobKey));
  }
  await kv.del(eventJobsKey(eid));
  return ids.length;
}

/**
 * A scheduled meeting's reminders (an hour and half an hour ahead) and its
 * first ring (at the start), leaving out any already in the past. Replaces
 * whatever was queued for it before.
 */
export async function scheduleMeetingJobs(
  ev: { id: string; scheduledAt?: string },
  now: number = Date.now()
): Promise<Job[]> {
  await cancelMeetingJobs(ev.id);
  const start = ev.scheduledAt ? Date.parse(ev.scheduledAt) : NaN;
  if (!Number.isFinite(start)) return [];
  const plan: Array<[JobType, number]> = [
    ["remind60", start - 60 * 60_000],
    ["remind30", start - 30 * 60_000],
    ["ring", start],
  ];
  const out: Job[] = [];
  for (const [type, at] of plan) {
    if (at < now) continue;
    out.push(await scheduleJob(ev.id, type, at, { now, ...(type === "ring" ? { attempt: 1 } : {}) }));
  }
  return out;
}

/**
 * Take up to `limit` jobs that are due. A job is the caller's only if its
 * removal from the queue succeeded, so two ticks at once never share one.
 */
export async function claimDue(now: number = Date.now(), limit = 200): Promise<Job[]> {
  if (!isKvConfigured()) {
    const due = Array.from(memZ.entries())
      .filter(([, at]) => at <= now)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit);
    const out: Job[] = [];
    for (const [id] of due) {
      if (!memZ.delete(id)) continue;
      const job = memJobs.get(id);
      memJobs.delete(id);
      memEventJobs.get(job?.eid ?? "")?.delete(id);
      if (job) out.push(job);
    }
    return out;
  }
  const ids = ((await kv.zrange(ZSET, 0, now, { byScore: true, offset: 0, count: limit })) as unknown[]).map(String);
  const out: Job[] = [];
  for (const id of ids) {
    const removed = await kv.zrem(ZSET, id);
    if (removed !== 1) continue;
    const job = parseJob(await kv.get(jobKey(id)));
    await kv.del(jobKey(id));
    if (job) {
      await kv.srem(eventJobsKey(job.eid), id);
      out.push(job);
    }
  }
  return out;
}

/** One tick at a time. True if this caller holds the lock now. */
export async function acquireTickLock(now: number = Date.now()): Promise<boolean> {
  if (!isKvConfigured()) {
    if (memLockUntil > now) return false;
    memLockUntil = now + LOCK_SECONDS * 1000;
    return true;
  }
  return (await kv.set(LOCK, String(now), { nx: true, ex: LOCK_SECONDS })) === "OK";
}

export async function releaseTickLock(): Promise<void> {
  if (!isKvConfigured()) {
    memLockUntil = 0;
    return;
  }
  await kv.del(LOCK);
}
