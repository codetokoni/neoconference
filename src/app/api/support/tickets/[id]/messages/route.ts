// POST /api/support/tickets/[id]/messages — the ticket's owner replies.
// JSON { body } or multipart { body, file? }. A reply reopens a ticket that
// was waiting on them or resolved; a closed ticket takes no more replies
// (they open a new one).

import { NextResponse } from "next/server";
import { indexUpload } from "@/lib/content/files";
import { err, loadOwnTicket, messagesForUser, readForm, ticketForUser } from "@/lib/support/caller";
import {
  INTAKE_LIMITS,
  appendMessage,
  applyStatus,
  attachmentStorageReady,
  checkAttachment,
  hitRateLimit,
  storeAttachment,
} from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const r = await loadOwnTicket(params.id);
  if (!r.ok) return r.response;
  const { who, ticket: t } = r;
  if (t.status === "closed") return err("closed", "This ticket is closed. Open a new one from the support page.", 409);
  const form = await readForm(req);
  const body = (form?.fields.body ?? "").trim().slice(0, 5000);
  if (!body) return err("empty", "Write a reply first.");
  const rl = await hitRateLimit(`reply:${who.userId}`, INTAKE_LIMITS.repliesPerHour, 3600);
  if (!rl.ok) return err("rate_limited", "That's a lot of replies in an hour. Try again later.", 429, { retryAfter: rl.retryAfter });

  const attachments = [];
  if (form?.file) {
    const check = checkAttachment(form.file);
    if (!check.ok) return err(check.error, check.message, check.error === "too_large" ? 413 : 415);
    if (!attachmentStorageReady()) return err("storage_not_configured", "Attachments are unavailable right now. Send it without the file.", 503);
    attachments.push(await storeAttachment(t.id, check.file));
    await indexUpload({ key: attachments[0].key, type: "support_attachment", ownerId: who.userId, ticketId: t.id, name: attachments[0].name, size: attachments[0].size, contentType: attachments[0].type });
  }

  const now = Date.now();
  if (t.status === "pending_user" || t.status === "resolved") applyStatus(t, "open", now);
  const msg = await appendMessage(t, { author: "user", authorName: who.name || t.name, body, attachments }, now);
  return NextResponse.json({ ok: true, ticket: ticketForUser(t), message: (await messagesForUser([msg]))[0] }, { status: 201 });
}
