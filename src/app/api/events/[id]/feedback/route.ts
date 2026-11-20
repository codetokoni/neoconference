// src/app/api/events/[id]/feedback/route.ts
//
// Feedback on a meeting (src/lib/meetingFeedback.ts). Path param: id or slug.
// Public: anyone with the meeting's link, signed in or not.
//
// GET — what the form needs: the meeting's name, the kinds, a form token
// (signed out), and who is asking. For the meeting's owner or an
// administrator, also `manage`: the feedback kept, a tally, the feedback
// contact and whether their plan allows one.
//   200 { meeting: { name, slug }, kinds, token, signedIn, manage? }
//
// POST { message?, kind?, rating?, where?, name?, email?, token?, website? }
// Words or a rating (1 to 5), or both. Signed out: needs the form token and
// an empty honeypot ("website"); a rating alone may come quickly (one tap
// after leaving). Rate limited per account or address and per meeting.
//   200 { ok: true, ticket: number | null }

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";
import { getPlanForUserId } from "@/lib/plan";
import { checkFormToken, issueFormToken } from "@/lib/support/formToken";
import { hitRateLimit } from "@/lib/support/tickets";
import { EMAIL_RE, clientIp, err, supportCaller } from "@/lib/support/caller";
import {
  FEEDBACK_KINDS,
  contactAllowed,
  contactReach,
  deviceFrom,
  isFeedbackKind,
  listFeedback,
  recordFeedback,
  tally,
  type FeedbackWhere,
} from "@/lib/meetingFeedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const WHERE: readonly FeedbackWhere[] = ["link", "room", "after"];
// Per address is generous: a church's members often share one network, and
// everyone leaving a meeting is asked for stars. The meeting's own cap bounds
// a flood.
const FEEDBACK_LIMITS = { perUserHour: 10, perIpHour: 100, perMeetingHour: 2000 } as const;

async function findEvent(id: string) {
  return (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ev = await findEvent(id);
  if (!ev) return err("not_found", "There is no meeting at this link.", 404);
  const who = await supportCaller();
  let manage: Record<string, unknown> | undefined;
  if (who && (await assertOwnerOrAdmin(ev, who.userId)).ok) {
    const list = await listFeedback(ev.id);
    const plan = await getPlanForUserId(ev.ownerUserId);
    manage = {
      feedback: list.slice(0, 100),
      tally: tally(list),
      contact: ev.feedbackContact ?? null,
      contactAllowed: contactAllowed(plan),
      reach: await contactReach(ev.ownerUserId, ev.feedbackContact ?? null),
    };
  }
  return NextResponse.json(
    {
      meeting: { name: ev.name, slug: ev.slug },
      kinds: FEEDBACK_KINDS,
      token: who ? null : issueFormToken(),
      signedIn: !!who,
      ...(manage ? { manage } : {}),
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ev = await findEvent(id);
  if (!ev) return err("not_found", "There is no meeting at this link.", 404);

  let body: Record<string, unknown>;
  try {
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    body = raw as Record<string, unknown>;
  } catch {
    return err("invalid_body", "Your feedback could not be read. Try again.");
  }
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  if (str(body.website, 200)) return err("rejected", "Your feedback could not be sent.");

  const message = str(body.message, 2000);
  const kind = isFeedbackKind(body.kind) ? body.kind : undefined;
  const rating =
    typeof body.rating === "number" && Number.isInteger(body.rating) && body.rating >= 1 && body.rating <= 5 ? body.rating : undefined;
  if (body.rating != null && rating === undefined) return err("invalid_rating", "Choose 1 to 5 stars.");
  if (!message && !rating) return err("empty", "Write what happened, or choose how many stars.");
  const where = WHERE.includes(body.where as FeedbackWhere) ? (body.where as FeedbackWhere) : "link";

  const who = await supportCaller();
  let name: string;
  let email: string | undefined;
  if (who) {
    const rl = await hitRateLimit(`fb:user:${who.userId}:${ev.id}`, FEEDBACK_LIMITS.perUserHour, 3600);
    if (!rl.ok) return err("rate_limited", "You've sent several messages about this meeting in the last hour. Try again later.", 429, { retryAfter: rl.retryAfter });
    name = who.name || who.email.split("@")[0] || "Someone";
    email = who.email || undefined;
  } else {
    const token = checkFormToken(body.token);
    // One star tap right after leaving is quicker than any typing; the token
    // itself must still be real.
    const quickRating = !message && token.ok === false && token.reason === "too_fast";
    if (!token.ok && !quickRating) {
      return err(
        "form_check_failed",
        token.reason === "expired" ? "The form timed out. Reload the page and send it again." : "Your feedback could not be sent. Reload the page and try again.",
      );
    }
    const typedEmail = str(body.email, 200).toLowerCase();
    if (typedEmail && !EMAIL_RE.test(typedEmail)) return err("invalid_email", "That email address doesn't look right.");
    const ip = await hitRateLimit(`fb:ip:${clientIp(req)}:${ev.id}`, FEEDBACK_LIMITS.perIpHour, 3600);
    if (!ip.ok) return err("rate_limited", "Many messages have come from your network about this meeting. Try again later.", 429, { retryAfter: ip.retryAfter });
    name = str(body.name, 80);
    email = typedEmail || undefined;
  }
  const busy = await hitRateLimit(`fb:ev:${ev.id}`, FEEDBACK_LIMITS.perMeetingHour, 3600);
  if (!busy.ok) return err("rate_limited", "This meeting has had a great deal of feedback in the last hour. Try again later.", 429, { retryAfter: busy.retryAfter });

  const r = await recordFeedback(ev, {
    where,
    ...(kind ? { kind } : {}),
    ...(rating ? { rating } : {}),
    message,
    name,
    ...(email ? { email } : {}),
    ...(who ? { userId: who.userId } : {}),
    device: deviceFrom(req.headers.get("user-agent"), typeof body.client === "string" ? body.client : null),
  });
  return NextResponse.json({ ok: true, ticket: r.ticketNumber }, { headers: NO_STORE });
}
