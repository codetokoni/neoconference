// src/lib/content/reports.ts
//
// Reported content: what anyone (signed in or not) can flag on a public or
// shared page, and the moderation cases administrators work through.
//
//   neo:content:cases          hash  caseId -> ReportCase JSON
//   neo:content:case-for       hash  targetKey -> caseId (the case a new report on that target joins)
//   neo:content:rl:<who>:<win> counter, expires: report rate limit
//
// One case per target: more reports on the same replay add to its case
// rather than opening new ones. A reporter is kept as a Clerk id (or none)
// and a keyed hash of their address — never shown to the content's owner.
// The owner's warning (warnOwner) is built from the administrator's words
// and the target only.

import { createHmac, randomBytes } from "node:crypto";
import { kv } from "@/lib/kv";
import type { CaseStatus, ReportReason, ReportTargetType } from "@/lib/content/model";

const CASES = "neo:content:cases";
const CASE_FOR = "neo:content:case-for";
const rlKey = (who: string, win: number) => `neo:content:rl:${who}:${win}`;

export const RATE_WINDOW_MS = 10 * 60 * 1000;
export const RATE_PER_ADDRESS = 5;
export const RATE_PER_ACCOUNT = 10;
export const REPORTS_KEPT = 50;
export const HISTORY_KEPT = 200;

export interface Report {
  id: string;
  at: number;
  reason: ReportReason;
  details: string;
  /** Clerk user id when signed in. */
  reporterId: string | null;
  /** HMAC of the address, to spot one source filing many reports; not reversible. */
  sourceHash: string;
}

export interface CaseEvent {
  at: number;
  byId: string;
  byEmail: string;
  action: string;
  note?: string;
  before?: unknown;
  after?: unknown;
}

export interface CaseNote {
  id: string;
  at: number;
  byId: string;
  byEmail: string;
  text: string;
}

export interface ReportCase {
  id: string;
  targetType: ReportTargetType;
  /** "event:<slug>" or "file:<fileId>". */
  targetKey: string;
  eventSlug?: string;
  fileId?: string;
  /** What the queue shows: the meeting's name, the file's name. */
  label: string;
  ownerId: string | null;
  status: CaseStatus;
  createdAt: number;
  updatedAt: number;
  reportCount: number;
  /** Reports since the case was last actioned or dismissed. */
  newSinceClosed: number;
  reasons: Partial<Record<ReportReason, number>>;
  reports: Report[];
  history: CaseEvent[];
  notes: CaseNote[];
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

function hmacKey(): string {
  return process.env.ADMIN_MFA_KEY || process.env.CLERK_SECRET_KEY || "neo-content-reports";
}

export function sourceHash(ip: string): string {
  return createHmac("sha256", hmacKey()).update(`report-source:${ip || "unknown"}`).digest("base64url").slice(0, 22);
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

/* -------------------------------- rate limit ------------------------------ */

/**
 * Count one report against the sender. False when the address (5) or the
 * account (10) has filed too many in the last ten minutes.
 */
export async function takeReportSlot(who: { userId: string | null; sourceHash: string }, now = Date.now()): Promise<boolean> {
  const win = Math.floor(now / RATE_WINDOW_MS);
  const ttl = Math.ceil((RATE_WINDOW_MS * 2) / 1000);
  const byAddress = Number(await kv.incr(rlKey(`a:${who.sourceHash}`, win)));
  await kv.expire(rlKey(`a:${who.sourceHash}`, win), ttl);
  if (byAddress > RATE_PER_ADDRESS) return false;
  if (who.userId) {
    const byAccount = Number(await kv.incr(rlKey(`u:${who.userId}`, win)));
    await kv.expire(rlKey(`u:${who.userId}`, win), ttl);
    if (byAccount > RATE_PER_ACCOUNT) return false;
  }
  return true;
}

/* ---------------------------------- cases --------------------------------- */

export async function getCase(id: string): Promise<ReportCase | null> {
  if (!/^case_[a-z0-9]{6,40}$/.test(String(id || ""))) return null;
  return parse<ReportCase>(await kv.hget(CASES, id));
}

export async function saveCase(c: ReportCase): Promise<void> {
  await kv.hset(CASES, { [c.id]: JSON.stringify(c) });
}

export async function listCases(): Promise<ReportCase[]> {
  const all = ((await kv.hgetall(CASES)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map((v) => parse<ReportCase>(v))
    .filter((c): c is ReportCase => !!c)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface Target {
  targetType: ReportTargetType;
  targetKey: string;
  eventSlug?: string;
  fileId?: string;
  label: string;
  ownerId: string | null;
}

/**
 * File one report. Returns the case and whether this report was new (the
 * same reporter reporting the same target again is not counted twice).
 */
export async function fileReport(
  target: Target,
  r: { reason: ReportReason; details: string; reporterId: string | null; sourceHash: string },
  now = Date.now(),
): Promise<{ case: ReportCase; duplicate: boolean }> {
  const raw = await kv.hget(CASE_FOR, target.targetKey);
  const existingId = typeof raw === "string" ? raw : null;
  let c = existingId ? await getCase(existingId) : null;
  if (!c) {
    c = {
      id: newId("case").toLowerCase(),
      ...target,
      status: "open",
      createdAt: now,
      updatedAt: now,
      reportCount: 0,
      newSinceClosed: 0,
      reasons: {},
      reports: [],
      history: [],
      notes: [],
    };
    await kv.hset(CASE_FOR, { [target.targetKey]: c.id });
  }
  const dup = c.reports.some((x) => (r.reporterId ? x.reporterId === r.reporterId : x.sourceHash === r.sourceHash));
  if (dup) return { case: c, duplicate: true };
  const report: Report = { id: newId("rep").toLowerCase(), at: now, ...r, details: r.details.slice(0, 1000) };
  c = {
    ...c,
    label: target.label || c.label,
    ownerId: target.ownerId ?? c.ownerId,
    updatedAt: now,
    reportCount: c.reportCount + 1,
    newSinceClosed: c.status === "open" ? c.newSinceClosed : c.newSinceClosed + 1,
    reasons: { ...c.reasons, [r.reason]: (c.reasons[r.reason] ?? 0) + 1 },
    reports: [report, ...c.reports].slice(0, REPORTS_KEPT),
  };
  await saveCase(c);
  return { case: c, duplicate: false };
}

export function withEvent(c: ReportCase, e: Omit<CaseEvent, "at">, now = Date.now()): ReportCase {
  return { ...c, updatedAt: now, history: [{ at: now, ...e }, ...c.history].slice(0, HISTORY_KEPT) };
}

/**
 * What an administrator may see of a case. Reporter identities only with
 * content:moderate; the address hash never leaves the server — only how
 * many reports came from the same source.
 */
export function caseView(c: ReportCase, opts: { showReporters: boolean }) {
  const sources = new Map<string, number>();
  for (const r of c.reports) sources.set(r.sourceHash, (sources.get(r.sourceHash) ?? 0) + 1);
  return {
    ...c,
    reports: c.reports.map((r) => ({
      id: r.id,
      at: r.at,
      reason: r.reason,
      details: r.details,
      reporter: opts.showReporters ? (r.reporterId ? { userId: r.reporterId } : { anonymous: true }) : { hidden: true },
      sameSourceCount: sources.get(r.sourceHash) ?? 1,
    })),
  };
}

export type CaseView = ReturnType<typeof caseView>;
