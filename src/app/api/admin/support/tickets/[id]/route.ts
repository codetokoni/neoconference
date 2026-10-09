// /api/admin/support/tickets/[id]
//
// GET   (support:read)   the ticket with its SLA state, the conversation,
//                        internal notes, the account (plan, expiry, recent
//                        payments and meetings), every ticket that account
//                        has raised, and who it can be assigned to
// PATCH (support:write)  { status?, priority?, category?, assigneeId?, tags? }
//                        audited with before and after

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { accountSnapshot, applyTicketChanges, listAssignees, ticketRow, type TicketChanges } from "@/lib/support/admin";
import { STATUS_LABEL, slaFor } from "@/lib/support/model";
import {
  appendMessage,
  getSla,
  getTicket,
  listMessages,
  listNotes,
  listTickets,
  presentAttachments,
  saveTicket,
  ticketsForAccount,
} from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "support:read");
  if (!g.ok) return g.response;
  const t = await getTicket(params.id);
  if (!t) return fail("not_found", "No ticket with that id.", 404);
  const now = Date.now();
  const [sla, messages, notes, account, all, assignees] = await Promise.all([
    getSla(),
    listMessages(t.id),
    listNotes(t.id),
    accountSnapshot(t),
    listTickets(),
    listAssignees(),
  ]);
  const emails = [t.email, ...(account.found ? [account.email] : [])];
  const related = ticketsForAccount(all, account.userId ?? t.userId, emails);
  // An anonymised ticket (deleted account) matches nothing, not even itself.
  if (!related.some((x) => x.id === t.id)) related.unshift(t);
  const history = related.map((x) => ({
    id: x.id,
    number: x.number,
    subject: x.subject,
    status: x.status,
    priority: x.priority,
    createdAt: x.createdAt,
    overdue: slaFor(x, sla, now).overdue,
  }));
  return NextResponse.json(
    {
      ok: true,
      ticket: ticketRow(t, sla, now),
      messages: await Promise.all(messages.map(async (m) => ({ ...m, attachments: await presentAttachments(m.attachments ?? []) }))),
      notes,
      account,
      history,
      assignees,
      sla,
      now,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "support:write");
  if (!g.ok) return g.response;
  const t = await getTicket(params.id);
  if (!t) return fail("not_found", "No ticket with that id.", 404);
  const b = await readJson<Record<string, unknown>>(req);
  if (!b) return fail("invalid_body", "Send the changes as JSON.");
  const changes: TicketChanges = {};
  for (const k of ["status", "priority", "category", "assigneeId", "tags"] as const) if (k in b) changes[k] = b[k];
  const now = Date.now();
  const r = applyTicketChanges(t, changes, await listAssignees(), now);
  if (!r.ok) return fail(r.error, r.message);
  if (!Object.keys(r.after).length) return NextResponse.json({ ok: true, changed: false, ticket: ticketRow(t, await getSla(), now) });
  await saveTicket(t);
  // The user sees a ticket being resolved or closed in their conversation.
  if (r.after.status === "resolved" || r.after.status === "closed") {
    await appendMessage(t, { author: "system", authorName: "", body: `Support marked this ${STATUS_LABEL[t.status].toLowerCase()}.`, attachments: [] }, now);
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "support.ticket.update",
    targetType: "ticket",
    targetId: t.id,
    targetLabel: `#${t.number} ${t.subject}`,
    before: r.before,
    after: r.after,
  });
  return NextResponse.json({ ok: true, changed: true, ticket: ticketRow(t, await getSla(), now) });
}
