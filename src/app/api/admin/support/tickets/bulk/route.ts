// POST /api/admin/support/tickets/bulk (support:write)
// { ids: string[] (up to 100), set: { status?, priority?, assigneeId? } }
// Applies the same change to each ticket; each change is audited on its own
// ticket with its before and after.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { applyTicketChanges, listAssignees, type TicketChanges } from "@/lib/support/admin";
import { getTicket, saveTicket } from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await requireAdmin(req, "support:write");
  if (!g.ok) return g.response;
  const b = await readJson<{ ids?: unknown; set?: Record<string, unknown> }>(req);
  const ids = Array.isArray(b?.ids) ? [...new Set(b.ids.filter((x): x is string => typeof x === "string"))] : [];
  if (!ids.length || ids.length > 100) return fail("invalid_ids", "Choose between 1 and 100 tickets.");
  const set = b?.set ?? {};
  const changes: TicketChanges = {};
  for (const k of ["status", "priority", "assigneeId"] as const) if (k in set) changes[k] = set[k];
  if (!Object.keys(changes).length) return fail("nothing_to_change", "Choose a status, priority or assignee.");

  const assignees = await listAssignees();
  const now = Date.now();
  // Check every ticket before changing any, so a bad value changes nothing.
  const tickets = [];
  for (const id of ids) {
    const t = await getTicket(id);
    if (!t) return fail("not_found", `No ticket with id ${id}.`, 404);
    const probe = applyTicketChanges({ ...t, tags: [...t.tags] }, changes, assignees, now);
    if (!probe.ok) return fail(probe.error, probe.message);
    tickets.push(t);
  }
  let changed = 0;
  for (const t of tickets) {
    const r = applyTicketChanges(t, changes, assignees, now);
    if (!r.ok || !Object.keys(r.after).length) continue;
    await saveTicket(t);
    changed++;
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "support.ticket.update",
      targetType: "ticket",
      targetId: t.id,
      targetLabel: `#${t.number} ${t.subject}`,
      before: r.before,
      after: r.after,
      note: `Bulk change of ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`,
    });
  }
  return NextResponse.json({ ok: true, changed, total: tickets.length });
}
