// src/lib/support/notify.ts
//
// Telling a user about their ticket: an email (Resend, src/lib/mail.ts) and,
// for an account, the bell in the header. The wording is the "support.*"
// email templates (Admin → Email templates; src/lib/comms/templateDefaults.ts).
//
// Replying by email is not wired: Resend inbound is not set up for this
// domain, so the emails send people back to /support/tickets to answer.
// Every send is awaited by the routes; on Vercel unawaited work is dropped.

import { sendMail, type SendMailInput, type SendMailResult } from "@/lib/mail";
import { addNotification } from "@/lib/notificationStore";
import { publicOrigin } from "@/lib/publicOrigin";
import { renderEmail } from "@/lib/comms/templates";
import { logEmail } from "@/lib/comms/log";
import type { TemplateVars } from "@/lib/comms/format";
import type { Ticket } from "@/lib/support/model";

type Mailer = (input: SendMailInput) => Promise<SendMailResult>;
let mailer: Mailer | null = null;

/** Tests record mail instead of sending it, so no real address is ever written to. */
export function __setSupportMailer(fn: Mailer | null): void {
  mailer = fn;
}

const send = (input: SendMailInput) => (mailer ?? sendMail)(input);

export function siteOrigin(req: Request): string {
  return publicOrigin(req) ?? "https://www.neoconference.app";
}

/** Fill a support template, send it (through the test seam) and log it for Communication → Email delivery. */
async function sendTicketMail(template: "support.received" | "support.reply", t: Ticket, vars: TemplateVars): Promise<SendMailResult> {
  const r = await renderEmail(template, vars);
  const res = await send({ to: t.email, subject: r.subject, ...(r.text ? { text: r.text } : {}), ...(r.html ? { html: r.html } : {}) });
  await logEmail({
    source: "template",
    template,
    templateVersion: r.version,
    to: t.email,
    recipients: 1,
    subject: r.subject,
    status: res.ok ? "sent" : res.error === "mail_not_configured" ? "skipped" : "failed",
    ...(res.ok ? { resendId: res.id } : { error: res.error }),
  });
  return res;
}

function ticketVars(t: Ticket, origin: string): TemplateVars {
  // A ticket sent signed out is read after signing in with the same address.
  return { number: t.number, subject: t.subject, ticketUrl: `${origin}/support/tickets/${t.id}`, signedIn: !!t.userId, email: t.email };
}

export async function notifyTicketReceived(t: Ticket, origin: string): Promise<SendMailResult> {
  return sendTicketMail("support.received", t, ticketVars(t, origin));
}

/** A public reply from support: email, and the bell for an account. */
export async function notifyTicketReply(t: Ticket, body: string, agentName: string, origin: string) {
  const mail = await sendTicketMail("support.reply", t, { ...ticketVars(t, origin), agentName, body });
  let bell = false;
  if (t.userId) {
    try {
      await addNotification(t.userId, {
        type: "updated",
        title: `Support replied: ${t.subject}`.slice(0, 200),
        body: body.replace(/\s+/g, " ").slice(0, 160),
        url: `/support/tickets/${t.id}`,
      });
      bell = true;
    } catch (err) {
      console.error("[support] bell notification failed", t.id, err);
    }
  }
  return { mail, bell };
}
