// src/lib/auditLog.ts
//
// Persistent authz-decision sink. Every allow/deny decision that flows
// through authz.ts also lands here so promotions, demotions, mutes, kicks,
// recordings, ends, and every other permission check are queryable after
// the fact.
//
// FRS §12.4 asks for "audit logs for promotions, demotions, removals and
// meeting termination." The recordDecision() hook in authz.ts was writing
// to a Vercel log drain only, which is fine for tail -f but not for
// "who ended the meeting on the 14th."
//
// Storage: Redis list at neo:authz:log, LPUSH + LTRIM to cap size. Newest
// first. Bounded so KV doesn't grow unboundedly for popular deployments;
// entries beyond the cap fall out FIFO from the back of the list.

import { kv } from "@vercel/kv";

const KEY = "neo:authz:log";
const MAX_ENTRIES = 5000;

export interface AuditLogEntry {
  /** Epoch ms. */
  ts: number;
  permission: string;
  allowed: boolean;
  userId: string | null;
  role: string;
  reason: string;
  eventId?: string;
}

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// In-process fallback for tests and unconfigured environments. Not durable;
// mirrors the eventStore / meeting-roles pattern.
const memLog: AuditLogEntry[] = [];

/**
 * Append one decision to the log. Never throws — audit sinks should not
 * be able to break the request they audit. Fire-and-forget from callers.
 */
export async function appendAuditEntry(entry: AuditLogEntry): Promise<void> {
  const enriched: AuditLogEntry = {
    ...entry,
    ts: entry.ts && Number.isFinite(entry.ts) ? entry.ts : Date.now(),
  };
  if (!isKvConfigured()) {
    memLog.unshift(enriched);
    if (memLog.length > MAX_ENTRIES) memLog.length = MAX_ENTRIES;
    return;
  }
  try {
    await kv.lpush(KEY, JSON.stringify(enriched));
    await kv.ltrim(KEY, 0, MAX_ENTRIES - 1);
  } catch (err) {
    console.warn("[audit-log] KV write failed", err);
  }
}

/** Read back the newest-first slice. Bounded by MAX_ENTRIES. */
export async function listRecentAuditEntries(limit = 200): Promise<AuditLogEntry[]> {
  const capped = Math.max(1, Math.min(limit, MAX_ENTRIES));
  if (!isKvConfigured()) return memLog.slice(0, capped);
  try {
    const raw = (await kv.lrange(KEY, 0, capped - 1)) as unknown[];
    const out: AuditLogEntry[] = [];
    for (const r of raw) {
      try {
        if (typeof r === "string") {
          out.push(JSON.parse(r) as AuditLogEntry);
        } else if (r && typeof r === "object") {
          out.push(r as AuditLogEntry);
        }
      } catch {
        // skip malformed rows rather than fail the entire read
      }
    }
    return out;
  } catch (err) {
    console.warn("[audit-log] KV read failed", err);
    return [];
  }
}

/** Test seam. No-op when KV is configured. */
export function __resetInMemoryAuditLog(): void {
  memLog.length = 0;
}
