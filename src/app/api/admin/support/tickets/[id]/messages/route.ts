// POST /api/admin/support/tickets/[id]/messages (support:write)
//
// { kind: "reply", body, status? }  a public reply: added to the conversation,
//                                   emailed to the user and, for an account,
//                                   put in their bell. Sets the status (default
//                                   "pending_user": waiting on them).
// { kind: "note", body }            an internal note, kept apart from the
//                                   conversation; the user never sees it.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { ticketRow } from "@/lib/support/admin";
import { isTicketStatus } from "@/lib/support/model";
import { notifyTicketReply, siteOrigin } from "@/lib/support/notify";
import { addNote, appendMessage, applyStatus, getSla, getTicket, saveTicket } from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = await requireAdmin(req, "support:write");
  if (!g.ok) return g.response;
  const t = await getTicket(params.id);
  if (!t) return fail("not_found", "No ticket with that id.", 404);
  const b = await readJson<Record<string, unknown>>(req);
  const body = str(b?.body, 10000);
  if (!body) return fail("empty", "Write something first.");
  const label = `#${t.number} ${t.subject}`;
  const now = Date.now();

  if (b?.kind === "note") {
    const note = await addNote(t, actorOf(g.ctx), body, now);
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "support.ticket.note",
      targetType: "ticket",
      targetId: t.id,
      targetLabel: label,
      note: `Internal note, ${body.length} characters`,
    });
    return NextResponse.json({ ok: true, note }, { status: 201 });
  }
  if (b?.kind !== "reply") return fail("invalid_kind", "Choose a reply or an internal note.");

  const next = b.status === undefined ? "pending_user" : b.status;
  if (!isTicketStatus(next)) return fail("invalid_status", "Unknown status.");
  const before = { status: t.status, firstResponseAt: t.firstResponseAt, assigneeId: t.assigneeId };
  const message = await appendMessage(t, { author: "agent", authorName: g.ctx.name || "NeoConference support", body, attachments: [] }, now);
  applyStatus(t, next, now);
  // Whoever answers an unassigned ticket takes it.
  if (!t.assigneeId) {
    t.assigneeId = g.ctx.userId;
    t.assigneeEmail = g.ctx.email;
  }
  await saveTicket(t);
  const sent = await notifyTicketReply(t, body, g.ctx.name || "NeoConference support", siteOrigin(req));
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "support.ticket.reply",
    targetType: "ticket",
    targetId: t.id,
    targetLabel: label,
    before,
    after: { status: t.status, firstResponseAt: t.firstResponseAt, assigneeId: t.assigneeId },
    note: `Public reply, ${body.length} characters; email ${sent.mail.ok ? "sent" : `not sent (${sent.mail.error})`}${sent.bell ? "; bell notification" : ""}`,
  });
  return NextResponse.json(
    { ok: true, message, ticket: ticketRow(t, await getSla(), now), emailed: sent.mail.ok, emailError: sent.mail.ok ? null : sent.mail.error, bell: sent.bell },
    { status: 201 },
  );
}
