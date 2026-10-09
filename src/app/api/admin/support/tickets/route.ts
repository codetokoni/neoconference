// /api/admin/support/tickets — the ticket desk.
//
// GET  (support:read)   ?q &status (or "unresolved") &priority &category
//                       &assignee (user id, "me", "none") &overdue=1
//                       &sort (updated|created|priority|number|due) &dir &page &limit
//                       -> a page of tickets with their SLA state, the summary,
//                          who tickets can be assigned to, and the SLA targets
// POST (support:write)  open a ticket for someone — e.g. a NeoSupport chat that
//                       needs following up: { email, name?, subject, category,
//                       priority?, body, chatRef?, notifyUser? }

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { verifiedEmails, type ClerkEmailish } from "@/lib/admin/owner";
import { listAssignees } from "@/lib/support/admin";
import {
  isTicketCategory,
  isTicketPriority,
  isTicketStatus,
  summarize,
  type TicketCategory,
  type TicketPriority,
} from "@/lib/support/model";
import { notifyTicketReceived, siteOrigin } from "@/lib/support/notify";
import { SORTS, createTicket, getSla, listTickets, queryTickets, type TicketQuery, type TicketSort } from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "support:read");
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const status = p.get("status");
  const assignee = p.get("assignee") || undefined;
  const query: TicketQuery = {
    q: p.get("q")?.slice(0, 200) || undefined,
    status: status === "unresolved" || isTicketStatus(status) ? status : undefined,
    priority: isTicketPriority(p.get("priority")) ? (p.get("priority") as TicketPriority) : undefined,
    category: isTicketCategory(p.get("category")) ? (p.get("category") as TicketCategory) : undefined,
    assignee: assignee === "me" ? g.ctx.userId : assignee,
    overdue: p.get("overdue") === "1",
    sort: (SORTS as readonly string[]).includes(p.get("sort") ?? "") ? (p.get("sort") as TicketSort) : undefined,
    dir: p.get("dir") === "asc" ? "asc" : "desc",
    page: Number(p.get("page")) || 1,
    limit: Number(p.get("limit")) || 25,
  };
  const now = Date.now();
  const [all, sla, assignees] = await Promise.all([listTickets(), getSla(), listAssignees()]);
  const result = queryTickets(all, query, sla, now);
  return NextResponse.json(
    { ok: true, ...result, summary: summarize(all, sla, now), assignees, sla, now },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "support:write");
  if (!g.ok) return g.response;
  const b = await readJson<Record<string, unknown>>(req);
  const email = str(b?.email, 200).toLowerCase();
  const subject = str(b?.subject, 150);
  const body = str(b?.body, 20000);
  const chatRef = str(b?.chatRef, 200) || undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("invalid_email", "Enter the customer's email address.");
  if (subject.length < 3) return fail("invalid_subject", "Add a subject.");
  if (!body) return fail("invalid_body", "Paste the conversation or describe the request.");
  if (!isTicketCategory(b?.category)) return fail("invalid_category", "Choose a category.");
  const priority = isTicketPriority(b?.priority) ? b.priority : "normal";

  // Tie it to the account that has verified this address, if there is one.
  let userId: string | null = null;
  let name = str(b?.name, 100);
  try {
    const found = await (await clerkClient()).users.getUserList({ emailAddress: [email], limit: 1 });
    const u = found.data?.[0] as { id: string; firstName?: string | null; emailAddresses?: ClerkEmailish[] } | undefined;
    if (u && verifiedEmails(u.emailAddresses).includes(email)) {
      userId = u.id;
      name ||= u.firstName ?? "";
    }
  } catch {
    userId = null;
  }

  const t = await createTicket({
    subject,
    category: b!.category as TicketCategory,
    priority,
    body,
    userId,
    email,
    name: name || email.split("@")[0],
    source: chatRef ? "chat" : "agent",
    chatRef,
    firstAuthor: { author: "user", name: name || email },
  });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "support.ticket.create",
    targetType: "ticket",
    targetId: t.id,
    targetLabel: `#${t.number} ${t.subject}`,
    after: { status: t.status, priority: t.priority, category: t.category, email: t.email, source: t.source, chatRef: t.chatRef ?? null },
  });
  let emailed = false;
  if (b?.notifyUser === true) emailed = (await notifyTicketReceived(t, siteOrigin(req))).ok;
  return NextResponse.json({ ok: true, ticket: t, emailed }, { status: 201 });
}
