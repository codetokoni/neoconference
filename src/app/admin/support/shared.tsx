"use client";

// src/app/admin/support/shared.tsx — pieces the ticket desk and ticket view share.

import { PRIORITY_LABEL, STATUS_LABEL, fmtDuration, type SlaState, type Ticket, type TicketPriority, type TicketStatus } from "@/lib/support/model";
import { Badge } from "../ui";

export type Row = Ticket & { sla: SlaState };
export type Assignee = { userId: string; email: string; name: string; isOwner: boolean };

export function StatusBadge({ status }: { status: TicketStatus }) {
  const tone = status === "new" ? "cyan" : status === "open" ? "green" : status === "pending_user" ? "amber" : "zinc";
  return <Badge tone={tone}>{STATUS_LABEL[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const tone = priority === "urgent" ? "red" : priority === "high" ? "amber" : priority === "low" ? "zinc" : "cyan";
  return <Badge tone={tone}>{PRIORITY_LABEL[priority]}</Badge>;
}

/** Overdue, due soon, or met — for one ticket at `now`. */
export function SlaBadge({ sla, now }: { sla: SlaState; now: number }) {
  if (sla.firstResponseOverdue) return <Badge tone="red">No reply · {fmtDuration(now - sla.firstResponseDue)} over</Badge>;
  if (sla.resolutionOverdue) return <Badge tone="red">Overdue · {fmtDuration(now - sla.resolutionDue)}</Badge>;
  if (sla.nextDue == null) return sla.firstResponseBreached ? <Badge tone="amber">Reply was late</Badge> : <Badge tone="green">Met</Badge>;
  const left = sla.nextDue - now;
  return <Badge tone={left < 60 * 60 * 1000 ? "amber" : "zinc"}>Due in {fmtDuration(left)}</Badge>;
}

export function assigneeLabel(id: string | null, list: Assignee[], fallbackEmail?: string | null): string {
  if (!id) return "Unassigned";
  const a = list.find((x) => x.userId === id);
  return a ? a.name || a.email : fallbackEmail || id;
}
