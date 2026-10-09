// src/lib/admin/logs.ts
//
// One search over the app's three logs:
//
//   activity  what people did (src/lib/activity.ts; raw events kept for the
//             retention period, default 90 days)
//   admin     what administrators did (src/lib/admin/audit.ts; never trimmed)
//             — only for administrators who hold audit:read
//   meeting   every meeting/group permission decision (src/lib/auditLog.ts;
//             the newest 5000)
//
// Vercel's own runtime logs are not in the app: reading them needs a log
// drain or an API token. The logs page links to them instead.

import { listActivity, type Severity } from "@/lib/activity";
import { listAdminAudit } from "@/lib/admin/audit";
import { listRecentAuditEntries } from "@/lib/auditLog";

export type LogSource = "activity" | "admin" | "meeting";
export const LOG_SOURCES: LogSource[] = ["activity", "admin", "meeting"];

export interface LogRow {
  source: LogSource;
  id: string;
  ts: number;
  type: string;
  severity: Severity;
  /** User id, or an administrator's email. */
  user: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface LogQuery {
  sources: LogSource[];
  user?: string;
  type?: string;
  severity?: Severity;
  q?: string;
  from: number;
  to: number;
  limit: number;
  offset: number;
}

const FETCH_CAP = 5000;

function matchesText(row: LogRow, q?: string) {
  return !q || JSON.stringify(row).toLowerCase().includes(q.toLowerCase());
}

export async function searchLogs(query: LogQuery): Promise<{ items: LogRow[]; total: number; truncated: boolean }> {
  const rows: LogRow[] = [];
  let truncated = false;
  const user = query.user?.toLowerCase();

  if (query.sources.includes("activity")) {
    const r = await listActivity({
      user: query.user,
      type: query.type,
      severity: query.severity,
      q: query.q,
      from: query.from,
      to: query.to,
      limit: FETCH_CAP,
    });
    truncated ||= r.truncated || r.total > FETCH_CAP;
    for (const e of r.items) {
      rows.push({
        source: "activity",
        id: e.id,
        ts: e.ts,
        type: e.type,
        severity: e.severity,
        user: e.userId ?? "",
        summary: [e.account && e.account !== e.userId ? `account ${e.account}` : "", ...Object.entries(e.props ?? {}).map(([k, v]) => `${k}=${v}`)]
          .filter(Boolean)
          .join(" · "),
        details: { account: e.account, ...e.props },
      });
    }
  }

  if (query.sources.includes("admin")) {
    const r = await listAdminAudit({ from: query.from, to: query.to, limit: 1000, actor: query.user });
    truncated ||= r.total > 1000;
    for (const e of r.items) {
      const row: LogRow = {
        source: "admin",
        id: `admin-${e.seq}`,
        ts: e.ts,
        type: e.action,
        severity: e.outcome === "ok" ? "info" : e.outcome === "denied" ? "warn" : "error",
        user: e.actorEmail || e.actorId,
        summary: [e.targetLabel || e.targetId, e.note].filter(Boolean).join(" · "),
        details: { actorId: e.actorId, targetType: e.targetType, targetId: e.targetId, before: e.before, after: e.after, ip: e.ip },
      };
      if (query.type && !row.type.startsWith(query.type)) continue;
      if (query.severity && row.severity !== query.severity) continue;
      if (!matchesText(row, query.q)) continue;
      rows.push(row);
    }
  }

  if (query.sources.includes("meeting")) {
    const entries = await listRecentAuditEntries(FETCH_CAP);
    entries.forEach((e, i) => {
      if (e.ts < query.from || e.ts > query.to) return;
      const row: LogRow = {
        source: "meeting",
        id: `perm-${e.ts}-${i}`,
        ts: e.ts,
        type: e.permission,
        severity: e.allowed ? "info" : "warn",
        user: e.userId ?? "",
        summary: `${e.allowed ? "allowed" : "denied"} as ${e.role}${e.reason ? ` — ${e.reason}` : ""}`,
        details: { eventId: e.eventId, groupId: e.groupId, role: e.role, reason: e.reason },
      };
      if (user && !row.user.toLowerCase().includes(user)) return;
      if (query.type && !row.type.startsWith(query.type)) return;
      if (query.severity && row.severity !== query.severity) return;
      if (!matchesText(row, query.q)) return;
      rows.push(row);
    });
  }

  rows.sort((a, b) => b.ts - a.ts);
  return { items: rows.slice(query.offset, query.offset + query.limit), total: rows.length, truncated };
}
