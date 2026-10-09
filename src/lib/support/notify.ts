// src/lib/support/notify.ts
//
// Telling a user about their ticket: an email (Resend, src/lib/mail.ts) and,
// for an account, the bell in the header. Plain sendMail for now — the
// admin's email-template store was not on main when this was written.
//
// Replying by email is not wired: Resend inbound is not set up for this
// domain, so the emails send people back to /support/tickets to answer.
// Every send is awaited by the routes; on Vercel unawaited work is dropped.

import { sendMail, type SendMailInput, type SendMailResult } from "@/lib/mail";
import { addNotification } from "@/lib/notificationStore";
import { publicOrigin } from "@/lib/publicOrigin";
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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(lines: string[], link: { href: string; label: string } | null): string {
  const p = (s: string) => `<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a;white-space:pre-line">${s}</p>`;
  return [
    ...lines.map(p),
    link
      ? `<p style="font-family:system-ui,sans-serif"><a href="${esc(link.href)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">${esc(link.label)}</a></p>`
      : "",
    `<p style="font-family:system-ui,sans-serif;font-size:12px;color:#64748b">NeoConference support · Replies to this email are not read; answer on the website.</p>`,
  ].join("");
}

function ticketLink(t: Ticket, origin: string): { href: string; label: string } | null {
  // A ticket sent signed out is read after signing in with the same address.
  return { href: `${origin}/support/tickets/${t.id}`, label: t.userId ? "Open your ticket" : "Sign in to follow it" };
}

export async function notifyTicketReceived(t: Ticket, origin: string): Promise<SendMailResult> {
  const subject = `[#${t.number}] We received your request: ${t.subject}`;
  const intro = t.userId
    ? "Thanks for getting in touch. Your request is with the NeoConference team and you can follow it on the website."
    : `Thanks for getting in touch. Your request is with the NeoConference team. We'll answer at this address. To read the conversation on the website, sign in or sign up with ${t.email}.`;
  return send({
    to: t.email,
    subject,
    text: `${intro}\n\nTicket #${t.number}: ${t.subject}\n\n${origin}/support/tickets/${t.id}`,
    html: page([esc(intro), `<b>Ticket #${t.number}:</b> ${esc(t.subject)}`], ticketLink(t, origin)),
  });
}

/** A public reply from support: email, and the bell for an account. */
export async function notifyTicketReply(t: Ticket, body: string, agentName: string, origin: string) {
  const subject = `[#${t.number}] Reply from NeoConference support: ${t.subject}`;
  const mail = await send({
    to: t.email,
    subject,
    text: `${agentName} replied to your ticket #${t.number}:\n\n${body}\n\n${origin}/support/tickets/${t.id}`,
    html: page([`<b>${esc(agentName)}</b> replied to your ticket #${t.number}:`, esc(body)], ticketLink(t, origin)),
  });
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
