// GET /api/admin/audit — what administrators did (audit:read).
//
// Query: actor, action (prefix), target, q (any text), outcome, from, to
// (YYYY-MM-DD or epoch ms; `to` as a date covers that whole day), limit,
// offset, format=csv (also needs reports:export).
//
// There is deliberately no POST, PATCH or DELETE: the log is append-only.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { listAdminAudit, type AdminAuditEntry } from "@/lib/admin/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function time(v: string | null, endOfDay: boolean): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) ? t + (endOfDay ? 86_400_000 - 1 : 0) : undefined;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // A leading = + - @ would run as a formula in Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(items: AdminAuditEntry[]): string {
  const cols: (keyof AdminAuditEntry)[] = [
    "seq", "ts", "actorEmail", "actorId", "action", "outcome", "targetType", "targetId", "targetLabel", "before", "after", "note", "ip", "userAgent",
  ];
  const head = ["seq", "time (UTC)", "actor email", "actor id", "action", "outcome", "target type", "target id", "target", "before", "after", "note", "ip", "user agent"];
  const lines = [head.join(",")];
  for (const e of items) {
    lines.push(cols.map((c) => csvCell(c === "ts" ? new Date(e.ts).toISOString() : e[c])).join(","));
  }
  return lines.join("\r\n");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const csv = url.searchParams.get("format") === "csv";
  const g = await requireAdmin(req, csv ? ["audit:read", "reports:export"] : "audit:read");
  if (!g.ok) return g.response;
  const p = url.searchParams;
  const outcome = p.get("outcome");
  const result = await listAdminAudit({
    actor: p.get("actor") || undefined,
    action: p.get("action") || undefined,
    target: p.get("target") || undefined,
    q: p.get("q") || undefined,
    outcome: outcome === "ok" || outcome === "denied" || outcome === "failed" ? outcome : undefined,
    from: time(p.get("from"), false),
    to: time(p.get("to"), true),
    limit: csv ? 1000 : Number(p.get("limit")) || 50,
    offset: csv ? 0 : Number(p.get("offset")) || 0,
  });
  if (csv) {
    return new NextResponse(toCsv(result.items), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="admin-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }
  return NextResponse.json({ ok: true, ...result });
}
