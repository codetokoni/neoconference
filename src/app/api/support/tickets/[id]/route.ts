// /api/support/tickets/[id] — one of the signed-in user's own tickets.
//
// GET    the ticket and its conversation (never support's internal notes,
//        which are stored apart and only read by /api/admin/support)
// PATCH  { status: "resolved" }   the user says it is solved
//
// Someone else's ticket answers 404, the same as one that does not exist.

import { NextResponse } from "next/server";
import { err, loadOwnTicket, messagesForUser, readForm, ticketForUser } from "@/lib/support/caller";
import { isUnresolved } from "@/lib/support/model";
import { appendMessage, applyStatus, listMessages } from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const r = await loadOwnTicket(params.id);
  if (!r.ok) return r.response;
  return NextResponse.json(
    { ticket: ticketForUser(r.ticket), messages: await messagesForUser(await listMessages(r.ticket.id)) },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const r = await loadOwnTicket(params.id);
  if (!r.ok) return r.response;
  const form = await readForm(req);
  if (form?.fields.status !== "resolved") return err("invalid_status", "You can mark your ticket as solved.");
  const t = r.ticket;
  if (!isUnresolved(t.status)) return err("already_resolved", "This ticket is already resolved.", 409);
  const now = Date.now();
  applyStatus(t, "resolved", now);
  await appendMessage(t, { author: "system", authorName: "", body: `${r.who.name || "You"} marked this as solved.`, attachments: [] }, now);
  return NextResponse.json({ ok: true, ticket: ticketForUser(t) });
}
