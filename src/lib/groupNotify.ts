// src/lib/groupNotify.ts
//
// Telling people about group meetings. One entry point, notifyInvitees(),
// which tries every channel for every recipient and reports what reached
// whom. Each channel is its own small function; later phases add push,
// in-app notices and ringing here as further channels.
//
// Channels today
//   email      via mail.ts (Resend). Scheduled, changed and cancelled
//              meetings carry a calendar file, so the meeting lands in — or
//              leaves — the recipient's calendar.
//   KingsChat  from the creator's own KingsChat account, when both the
//              creator and the recipient have signed in with KingsChat.
//
// A channel that cannot reach someone (no address, not linked, mail not
// configured) is skipped for that person, not treated as an error.

import { isMailConfigured, mailFromAddress, sendMail } from "@/lib/mail";
import { buildIcsCalendar } from "@/lib/ics";
import { loadKcTokens } from "@/lib/kc-tokens";
import { kcIdForClerkUser, sendKcMessage } from "@/lib/kingschat-send";
import type { Recipient } from "@/lib/groupMeetings";
import type { NeoEvent } from "@/types/event";

export type NotifyKind = "scheduled" | "updated" | "cancelled" | "started" | "added";
export type ChannelOutcome = "sent" | "failed" | "unavailable";

export interface RecipientResult {
  name: string;
  userId?: string;
  email?: string;
  channels: { email: ChannelOutcome; kingschat: ChannelOutcome };
  /** At least one channel delivered. */
  reached: boolean;
}

export interface NotifySummary {
  sent: number;
  unreachable: number;
  results: RecipientResult[];
}

export interface NotifyContext {
  /** Clerk userId of whoever caused this; KingsChat messages go from them. */
  senderUserId: string;
  senderName: string;
  /** Site origin, e.g. https://www.neoconference.app */
  origin: string;
}

/** KingsChat messages are one per person; this many at a time. */
const CONCURRENCY = 4;

/* -------------------------------------------------------------------------- */
/*  Wording                                                                    */
/* -------------------------------------------------------------------------- */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "Mon 12 Oct 2026, 10:00 (Africa/Lagos)" in the meeting's own timezone. */
export function whenText(ev: NeoEvent): string {
  const tz = ev.groupMeeting?.timezone || "UTC";
  const iso = ev.scheduledAt || ev.startedAt || ev.createdAt;
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return `${text} (${tz})`;
}

function linkOf(ev: NeoEvent, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/${ev.slug}`;
}

/** Subject line and plain sentence for one notice. */
export function wording(events: NeoEvent[], kind: NotifyKind, ctx: NotifyContext): { subject: string; line: string } {
  const first = events[0];
  const title = first.name;
  const many = events.length > 1 ? ` (${events.length} meetings from ${whenText(first)})` : ` — ${whenText(first)}`;
  switch (kind) {
    case "scheduled":
      return { subject: `Invitation: ${title}${many}`, line: `${ctx.senderName} invited you to “${title}”${many}.` };
    case "updated":
      return { subject: `Updated: ${title}${many}`, line: `${ctx.senderName} changed “${title}”. It is now ${whenText(first)}.` };
    case "cancelled":
      return {
        subject: `Cancelled: ${title}${many}`,
        line:
          events.length > 1
            ? `${ctx.senderName} cancelled ${events.length} meetings of “${title}”, from ${whenText(first)}.`
            : `${ctx.senderName} cancelled “${title}” (${whenText(first)}).`,
      };
    case "started":
      return { subject: `${ctx.senderName} started ${title} — join now`, line: `${ctx.senderName} started “${title}”. Join now.` };
    case "added":
      return { subject: `${ctx.senderName} added you to ${title}`, line: `${ctx.senderName} added you to “${title}”. Join now.` };
  }
}

/* -------------------------------------------------------------------------- */
/*  Channels                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Email, with a calendar file for scheduled, changed and cancelled meetings.
 *
 * Everyone gets the same message, so it goes out as one email per batch of
 * blind copies rather than one per person: Resend allows a couple of
 * requests a second, and a 500-member group sent one at a time would be
 * throttled part-way through. Returns the outcome for each address.
 */
async function sendEmailNotices(
  recipients: Recipient[],
  events: NeoEvent[],
  kind: NotifyKind,
  ctx: NotifyContext
): Promise<Map<string, ChannelOutcome>> {
  const outcomes = new Map<string, ChannelOutcome>();
  const addresses = Array.from(
    new Set(recipients.map((r) => r.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)))
  );
  if (addresses.length === 0 || !isMailConfigured()) return outcomes;

  const { subject, line } = wording(events, kind, ctx);
  const link = linkOf(events[0], ctx.origin);
  const calendar = kind === "scheduled" || kind === "updated" || kind === "cancelled";
  const method = kind === "cancelled" ? "CANCEL" : "REQUEST";
  const host = new URL(ctx.origin).host;
  const attachments = calendar
    ? [
        {
          filename: kind === "cancelled" ? "cancel.ics" : "invite.ics",
          contentType: `text/calendar; method=${method}`,
          content: buildIcsCalendar(
            events.map((ev) => ({
              ev,
              opts: {
                eventUrl: linkOf(ev, ctx.origin),
                host,
                durationMin: ev.groupMeeting?.durationMin,
                sequence: ev.groupMeeting?.sequence,
                organizer: { name: ctx.senderName, email: mailFromAddress() },
              },
            })),
            method
          ),
        },
      ]
    : undefined;

  const html = [
    `<p style="font-family:system-ui,sans-serif;font-size:15px;color:#0f172a">${escapeHtml(line)}</p>`,
    kind === "cancelled"
      ? ""
      : `<p style="font-family:system-ui,sans-serif"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">Open the meeting</a></p>`,
    events[0].description
      ? `<p style="font-family:system-ui,sans-serif;font-size:14px;color:#334155;white-space:pre-line">${escapeHtml(events[0].description)}</p>`
      : "",
  ].join("");
  const text = kind === "cancelled" ? line : `${line}\n\n${link}`;

  for (let i = 0; i < addresses.length; i += EMAIL_BATCH) {
    const batch = addresses.slice(i, i + EMAIL_BATCH);
    if (i > 0) await sleep(EMAIL_SPACING_MS);
    const send = () =>
      sendMail({ to: mailFromAddress(), bcc: batch, subject, html, text, ...(attachments ? { attachments } : {}) });
    let res = await send();
    if (!res.ok && res.error === "rate_limited") {
      await sleep(1_000);
      res = await send();
    }
    if (!res.ok) console.warn("[groupNotify] email failed", res.error);
    for (const a of batch) outcomes.set(a, res.ok ? "sent" : "failed");
  }
  return outcomes;
}

/** Resend accepts 50 recipients a message; the sender's own address is one. */
const EMAIL_BATCH = 49;
const EMAIL_SPACING_MS = 600;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A KingsChat message from the sender's own account. */
async function sendKingsChatNotice(
  to: Recipient,
  events: NeoEvent[],
  kind: NotifyKind,
  ctx: NotifyContext,
  senderLinked: boolean
): Promise<ChannelOutcome> {
  if (!senderLinked || !to.userId) return "unavailable";
  const kcId = await kcIdForClerkUser(to.userId);
  if (!kcId) return "unavailable";
  const { line } = wording(events, kind, ctx);
  const text = kind === "cancelled" ? line : `${line}\n${linkOf(events[0], ctx.origin)}`;
  const res = await sendKcMessage(ctx.senderUserId, kcId, text);
  return res.ok ? "sent" : "failed";
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Tell `recipients` about one meeting, or several occurrences of a series at
 * once (one notice each, carrying every occurrence). Never throws: a failed
 * channel is reported in the result, so the change that caused the notice
 * stands either way.
 */
export async function notifyInvitees(
  event: NeoEvent | NeoEvent[],
  recipients: Recipient[],
  kind: NotifyKind,
  ctx: NotifyContext
): Promise<NotifySummary> {
  const events = Array.isArray(event) ? event : [event];
  if (events.length === 0 || recipients.length === 0) return { sent: 0, unreachable: 0, results: [] };

  const senderLinked = Boolean((await loadKcTokens(ctx.senderUserId).catch(() => null))?.accessToken);
  const emailed = await sendEmailNotices(recipients, events, kind, ctx).catch((err) => {
    console.warn("[groupNotify] email threw", err);
    return new Map<string, ChannelOutcome>(
      recipients.filter((r) => r.email).map((r) => [r.email!.trim().toLowerCase(), "failed" as const])
    );
  });

  const results: RecipientResult[] = [];
  for (let i = 0; i < recipients.length; i += CONCURRENCY) {
    const batch = recipients.slice(i, i + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map(async (to): Promise<RecipientResult> => {
          const email: ChannelOutcome = (to.email && emailed.get(to.email.trim().toLowerCase())) || "unavailable";
          const kingschat = await sendKingsChatNotice(to, events, kind, ctx, senderLinked).catch((err) => {
            console.warn("[groupNotify] KingsChat threw", err);
            return "failed" as const;
          });
          return {
            name: to.name,
            ...(to.userId ? { userId: to.userId } : {}),
            ...(to.email ? { email: to.email } : {}),
            channels: { email, kingschat },
            reached: email === "sent" || kingschat === "sent",
          };
        })
      ))
    );
  }
  const sent = results.filter((r) => r.reached).length;
  return { sent, unreachable: results.length - sent, results };
}
