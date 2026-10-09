// src/lib/support/caller.ts — who is using the support pages, and the
// helpers the user-facing /api/support routes share.

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { verifiedEmails, type ClerkEmailish } from "@/lib/admin/owner";
import { getClientIp } from "@/lib/sessionStore";
import { getTicket, presentAttachments, userOwnsTicket } from "@/lib/support/tickets";
import type { Ticket, TicketMessage } from "@/lib/support/model";

export interface SupportCaller {
  userId: string;
  email: string;
  name: string;
  verifiedEmails: string[];
}

export async function supportCaller(): Promise<SupportCaller | null> {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
  } catch {
    return null;
  }
  if (!userId) return null;
  try {
    const user = await (await clerkClient()).users.getUser(userId);
    const list = (user.emailAddresses ?? []) as ClerkEmailish[];
    const verified = verifiedEmails(list);
    const primary = (user as { primaryEmailAddress?: { emailAddress?: string } | null }).primaryEmailAddress?.emailAddress?.toLowerCase();
    const email = primary || verified[0] || list[0]?.emailAddress?.toLowerCase() || "";
    const u = user as { firstName?: string | null; lastName?: string | null; username?: string | null };
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email.split("@")[0] || "";
    return { userId, email, name, verifiedEmails: verified };
  } catch {
    return { userId, email: "", name: "", verifiedEmails: [] };
  }
}

/** The caller's own ticket, or the response to send instead (someone else's reads as not found). */
export async function loadOwnTicket(id: string) {
  const who = await supportCaller();
  if (!who) return { ok: false as const, response: err("signed_out", "Sign in to see your tickets.", 401) };
  const t = await getTicket(id);
  if (!t || !userOwnsTicket(t, who.userId, who.verifiedEmails)) {
    return { ok: false as const, response: err("not_found", "No ticket of yours has that number.", 404) };
  }
  return { ok: true as const, who, ticket: t };
}

export function clientIp(req: Request): string {
  return getClientIp(req.headers) ?? "unknown";
}

export function err(error: string, message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, message, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/** The ticket as its owner sees it: no assignee, tags or internal fields. */
export function ticketForUser(t: Ticket) {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    category: t.category,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    messageCount: t.messageCount,
    awaitingYou: t.status === "pending_user",
  };
}

export async function messagesForUser(list: TicketMessage[]) {
  return Promise.all(
    list.map(async (m) => ({
      id: m.id,
      ts: m.ts,
      author: m.author,
      authorName: m.authorName,
      body: m.body,
      attachments: await presentAttachments(m.attachments ?? []),
    })),
  );
}

/** Fields and an optional file from a JSON or multipart body. */
export async function readForm(req: Request): Promise<{ fields: Record<string, string>; file: File | null } | null> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const fields: Record<string, string> = {};
      let file: File | null = null;
      form.forEach((v, k) => {
        if (typeof v === "string") fields[k] = v;
        else if (k === "file" && v.size > 0) file = v as File;
      });
      return { fields, file };
    }
    const json = (await req.json()) as unknown;
    if (!json || typeof json !== "object") return null;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) if (typeof v === "string") fields[k] = v;
    return { fields, file: null };
  } catch {
    return null;
  }
}
