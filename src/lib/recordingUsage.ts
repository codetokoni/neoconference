// src/lib/recordingUsage.ts
//
// Recording hours per month (planLimits.recordingHoursPerMonth: Pro 10,
// Business and Enterprise 50). The pricing page sold these caps and nothing
// counted them.
//
// Counted against the meeting OWNER, as recording itself is gated (billing
// is per host), per calendar month in UTC — the pricing says "hrs/mo".
// A recording's length is known when LiveKit reports it finished
// (egress_ended); egress/start remembers whose plan it counts against, so
// the webhook does not have to guess from a slug that may have changed.
//
// The cap is checked when a recording starts. One already running when the
// cap is reached finishes; the next is refused. The FAQ says so.

import { kv } from "@vercel/kv";

const USAGE_KEY = (owner: string) => `neo:rec-usage:${owner}`;
const EGRESS_KEY = (egressId: string) => `neo:rec-egress:${egressId}`;
const COUNTED_KEY = (egressId: string) => `neo:rec-counted:${egressId}`;

/** How long start remembers an egress's owner: longer than any recording. */
const EGRESS_TTL_S = 3 * 24 * 60 * 60;

/** The month a moment's usage belongs to, "2026-09", in UTC. */
export function usageMonth(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** When the month after [atMs]'s starts, for "resets on 1 October". */
export function nextMonthStart(atMs: number): Date {
  const d = new Date(atMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

function toNumber(v: unknown): number | null {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Seconds a finished egress recorded, from LiveKit's EgressInfo. Its times
 * are nanoseconds (bigint from the SDK, or strings in raw JSON). The file
 * result's own duration is preferred; start-to-end is the fallback.
 */
export function egressSeconds(info: {
  startedAt?: unknown;
  endedAt?: unknown;
  fileResults?: Array<{ duration?: unknown }>;
  file?: { duration?: unknown };
} | undefined): number {
  if (!info) return 0;
  const duration = toNumber(info.fileResults?.[0]?.duration) ?? toNumber(info.file?.duration);
  if (duration && duration > 0) return Math.round(duration / 1e9);
  const started = toNumber(info.startedAt);
  const ended = toNumber(info.endedAt);
  if (started && ended && ended > started) return Math.round((ended - started) / 1e9);
  return 0;
}

export type RecordingAllowance =
  | { allowed: true; warning?: string }
  | { allowed: false; message: string };

function hours(seconds: number): string {
  const h = seconds / 3600;
  return h >= 10 ? h.toFixed(0) : h.toFixed(1);
}

/**
 * Whether a new recording may start, given the owner's monthly cap in hours
 * (0 = unlimited) and the seconds already recorded this month. From 80%
 * of the cap it starts with a warning, so nobody meets the limit unawares.
 */
export function recordingAllowance(
  capHours: number,
  usedSeconds: number,
  planName: string,
  nowMs: number
): RecordingAllowance {
  if (capHours <= 0) return { allowed: true };
  const cap = capHours * 3600;
  const resets = nextMonthStart(nowMs).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  if (usedSeconds >= cap) {
    return {
      allowed: false,
      message:
        `This month's ${capHours} recording hours on the ${planName} plan are used up ` +
        `(${hours(usedSeconds)} hours recorded). They reset on ${resets}. ` +
        "The meeting's owner can see the plans at neoconference.app/pricing.",
    };
  }
  if (usedSeconds >= cap * 0.8) {
    return {
      allowed: true,
      warning:
        `${hours(usedSeconds)} of this month's ${capHours} recording hours are used. ` +
        `They reset on ${resets}.`,
    };
  }
  return { allowed: true };
}

function kvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// In-memory stand-in for tests and environments without KV, as
// webhookMetrics has. Per process, so not a real count in production.
const mem = {
  usage: new Map<string, number>(),
  owners: new Map<string, string>(),
  counted: new Set<string>(),
};

/** Tests only: start from nothing. */
export function resetRecordingUsageMemory(): void {
  mem.usage.clear();
  mem.owners.clear();
  mem.counted.clear();
}

/** Seconds [owner] has recorded in [month]. 0 when unknown. */
export async function recordedSeconds(owner: string, month: string): Promise<number> {
  if (!owner) return 0;
  if (!kvConfigured()) return mem.usage.get(`${owner}|${month}`) ?? 0;
  try {
    const v = await kv.hget<number | string>(USAGE_KEY(owner), month);
    return toNumber(v) ?? 0;
  } catch (err) {
    console.warn("[recording-usage] read failed", err);
    return 0;
  }
}

/** At start: whose plan this recording's length counts against. */
export async function rememberEgressOwner(egressId: string, owner: string): Promise<void> {
  if (!egressId || !owner) return;
  if (!kvConfigured()) {
    mem.owners.set(egressId, owner);
    return;
  }
  try {
    await kv.set(EGRESS_KEY(egressId), owner, { ex: EGRESS_TTL_S });
  } catch (err) {
    console.warn("[recording-usage] could not remember egress owner", err);
  }
}

/**
 * At egress_ended: add the recording's length to its owner's month, once.
 * [fallbackOwner] is for recordings started before start remembered owners.
 * Returns what it did, for the webhook's response and logs.
 */
export async function addRecordedSeconds(
  egressId: string,
  seconds: number,
  endedAtMs: number,
  fallbackOwner?: string
): Promise<{ counted: boolean; owner?: string; seconds: number; reason?: string }> {
  if (!egressId || seconds <= 0) return { counted: false, seconds, reason: "no_length" };
  if (!kvConfigured()) {
    const owner = mem.owners.get(egressId) || fallbackOwner;
    if (!owner) return { counted: false, seconds, reason: "owner_unknown" };
    if (mem.counted.has(egressId)) return { counted: false, owner, seconds, reason: "already_counted" };
    mem.counted.add(egressId);
    const key = `${owner}|${usageMonth(endedAtMs)}`;
    mem.usage.set(key, (mem.usage.get(key) ?? 0) + seconds);
    return { counted: true, owner, seconds };
  }
  try {
    const owner = (await kv.get<string>(EGRESS_KEY(egressId))) || fallbackOwner;
    if (!owner) return { counted: false, seconds, reason: "owner_unknown" };
    // LiveKit may deliver a webhook more than once; count each egress once.
    const first = await kv.set(COUNTED_KEY(egressId), "1", { nx: true, ex: 40 * 24 * 60 * 60 });
    if (first !== "OK") return { counted: false, owner, seconds, reason: "already_counted" };
    await kv.hincrby(USAGE_KEY(owner), usageMonth(endedAtMs), seconds);
    return { counted: true, owner, seconds };
  } catch (err) {
    console.warn("[recording-usage] could not count", err);
    return { counted: false, seconds, reason: "kv_failed" };
  }
}
