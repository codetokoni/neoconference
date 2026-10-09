// /api/support/tickets — the contact form and "My tickets".
//
// POST  JSON or multipart: { subject, category, description, file?,
//       email + name (signed out), token (signed out), website (honeypot) }
//       Signed in: the ticket is on the account; one attachment may be added.
//       Signed out: needs the form token, an email, and no attachment; rate
//       limited per IP address and per email.
// GET   the signed-in user's tickets (theirs, plus any sent signed out from an
//       address verified on their account), newest first.
//
// Public in middleware for signed-out intake; GET checks sign-in itself.

import { NextResponse } from "next/server";
import { indexUpload } from "@/lib/content/files";
import { EMAIL_RE, clientIp, err, readForm, supportCaller, ticketForUser } from "@/lib/support/caller";
import { checkFormToken } from "@/lib/support/formToken";
import { isTicketCategory } from "@/lib/support/model";
import { notifyTicketReceived, siteOrigin } from "@/lib/support/notify";
import {
  attachmentStorageReady,
  checkAttachment,
  createTicket,
  INTAKE_LIMITS,
  hitRateLimit,
  listTickets,
  newId,
  storeAttachment,
  ticketsForAccount,
} from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const who = await supportCaller();
  if (!who) return err("signed_out", "Sign in to see your tickets.", 401);
  const mine = ticketsForAccount(await listTickets(), who.userId, who.verifiedEmails);
  return NextResponse.json({ tickets: mine.map(ticketForUser) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const who = await supportCaller();
  const form = await readForm(req);
  if (!form) return err("invalid_body", "Send the form fields.");
  const f = form.fields;

  // Filled only by bots: the field is hidden from people.
  if ((f.website ?? "").trim()) return err("rejected", "Your request could not be sent.", 400);

  const subject = (f.subject ?? "").trim().slice(0, 150);
  const description = (f.description ?? "").trim().slice(0, 5000);
  const category = f.category;
  if (subject.length < 3) return err("invalid_subject", "Add a short subject.");
  if (description.length < 10) return err("invalid_description", "Describe the problem in a sentence or two.");
  if (!isTicketCategory(category)) return err("invalid_category", "Choose what this is about.");

  let userId: string | null = null;
  let email: string;
  let name: string;
  if (who) {
    const rl = await hitRateLimit(`user:${who.userId}`, INTAKE_LIMITS.userPerHour, 3600);
    if (!rl.ok) return err("rate_limited", "You've sent several requests in the last hour. Add to an open ticket instead, or try again later.", 429, { retryAfter: rl.retryAfter });
    userId = who.userId;
    email = who.email;
    name = who.name;
    if (!email) return err("no_email", "Your account has no email address to reply to.");
  } else {
    const token = checkFormToken(f.token);
    if (!token.ok) {
      return err(
        "form_check_failed",
        token.reason === "expired" ? "The form timed out. Reload the page and send it again." : "Your request could not be sent. Reload the page and try again.",
        400,
        { reason: token.reason },
      );
    }
    email = (f.email ?? "").trim().toLowerCase().slice(0, 200);
    name = (f.name ?? "").trim().slice(0, 100);
    if (!EMAIL_RE.test(email)) return err("invalid_email", "Enter the email address we should reply to.");
    if (form.file) return err("sign_in_to_attach", "Sign in to attach a file, or describe the problem in words.");
    const ip = await hitRateLimit(`ip:${clientIp(req)}`, INTAKE_LIMITS.guestPerIp, 3600);
    if (!ip.ok) return err("rate_limited", "Too many requests from your network. Try again later.", 429, { retryAfter: ip.retryAfter });
    const byMail = await hitRateLimit(`email:${email}`, INTAKE_LIMITS.guestPerEmail, 3600);
    if (!byMail.ok) return err("rate_limited", "We already have several requests from this address. We'll reply soon.", 429, { retryAfter: byMail.retryAfter });
    name ||= email.split("@")[0];
  }

  const id = newId();
  const attachments = [];
  if (form.file) {
    const check = await checkAttachment(form.file);
    if (!check.ok) return err(check.error, check.message, check.error === "too_large" ? 413 : 415);
    if (!attachmentStorageReady()) return err("storage_not_configured", "Attachments are unavailable right now. Send it without the file.", 503);
    attachments.push(await storeAttachment(id, check.file));
    await indexUpload({ key: attachments[0].key, type: "support_attachment", ownerId: userId ?? "", ticketId: id, name: attachments[0].name, size: attachments[0].size, contentType: attachments[0].type });
  }

  const ticket = await createTicket({
    id,
    subject,
    category,
    body: description,
    userId,
    email,
    name,
    source: userId ? "web" : "guest",
    attachments,
  });
  const mail = await notifyTicketReceived(ticket, siteOrigin(req));
  if (!mail.ok && mail.error !== "mail_not_configured") console.error("[support] confirmation email failed", ticket.id, mail.error);

  return NextResponse.json(
    { ok: true, ticket: { id: ticket.id, number: ticket.number }, signedIn: !!who, emailed: mail.ok },
    { status: 201 },
  );
}
