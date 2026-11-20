// src/lib/meetingFeedback.ts
//
// Feedback on a meeting, from the people in it, to the person who runs it and
// to the platform's support (owner, 2026-11-20). Pastors' complaints about a
// 700-person meeting reached us through a WhatsApp chain hours later; this is
// a direct line.
//
// Three ways in: the meeting's feedback link (/feedback/<slug>, which works
// for someone who could not get in), "Send feedback" inside the meeting, and
// "How was it?" after leaving. Each entry is kept on the meeting; one with
// words also goes to support and to the owner.
//
//   neo:event:<id>:feedback                  list   FeedbackEntry JSON, newest first, 1,000 kept, 180 days
//   neo:event:<id>:feedback:ticket:<day>     string support ticket id for that UTC day (one thread a day)
//   neo:event:<id>:feedback:told             string set while the owner was told in the last 10 minutes
//
// Support: one ticket per meeting per day, "Feedback: <meeting> (<day>)",
// every written entry added to it, so a busy meeting is one thread, not a
// ticket each (src/lib/support/tickets.ts).
//
// The owner: a notification here (bell and push) every time they are told;
// and, when their plan is a paid one and they set a feedback contact on the
// meeting (feedbackContact), a KingsChat message to that handle (sent from the
// owner's own KingsChat account, src/lib/kingschat-send.ts) and an email.
// Told at most once in 10 minutes per meeting, with how many came since.
// A rating with no words is counted only.

import { kv } from "@/lib/kv";
import { randomBytes } from "node:crypto";
import type { NeoEvent } from "@/types/event";
import { appendMessage, createTicket, getTicket } from "@/lib/support/tickets";
import { addNotification } from "@/lib/notificationStore";
import { sendPush, topicFor } from "@/lib/pushStore";
import { sendMail } from "@/lib/mail";
import { loadKcTokens } from "@/lib/kc-tokens";
import { clerkIdsForKcHandles, normalizeKcHandle } from "@/lib/kcHandle";
import { kcIdForClerkUser, sendKcMessage } from "@/lib/kingschat-send";
import { getPlanForUserId } from "@/lib/plan";
import { siteOrigin } from "@/lib/brand";

export const FEEDBACK_KINDS = [
  { key: "sound", label: "Sound" },
  { key: "video", label: "Video" },
  { key: "joining", label: "Getting in" },
  { key: "dropping", label: "Keeps dropping out" },
  { key: "other", label: "Something else" },
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]["key"];
export type FeedbackWhere = "link" | "room" | "after";

export interface FeedbackEntry {
  id: string;
  ts: number;
  where: FeedbackWhere;
  kind?: FeedbackKind;
  /** 1 to 5 stars, from "How was it?". */
  rating?: number;
  message: string;
  name: string;
  email?: string;
  userId?: string;
  /** The browser or app, from the request (e.g. "Chrome on Android"). */
  device?: string;
}

export interface FeedbackContact {
  kcHandle?: string;
  email?: string;
}

const KEEP = 1000;
const TTL_S = 180 * 24 * 60 * 60;
const TELL_EVERY_S = 10 * 60;
const listKey = (id: string) => `neo:event:${id}:feedback`;
const ticketKey = (id: string, day: string) => `neo:event:${id}:feedback:ticket:${day}`;
const toldKey = (id: string) => `neo:event:${id}:feedback:told`;
const sinceKey = (id: string) => `neo:event:${id}:feedback:since`;

export const isFeedbackKind = (v: unknown): v is FeedbackKind =>
  typeof v === "string" && FEEDBACK_KINDS.some((k) => k.key === v);
export const kindLabel = (k?: string) => FEEDBACK_KINDS.find((x) => x.key === k)?.label ?? "Feedback";
const whereText = (w: FeedbackWhere) => (w === "room" ? "in the meeting" : w === "after" ? "after leaving" : "the feedback link");

/** "Chrome on Android" from a user agent; the app says so itself. */
export function deviceFrom(ua: string | null | undefined): string {
  const s = ua ?? "";
  const app = /NeoLinguaMeet\/([\d.]+)/.exec(s);
  if (app) return `NeoLinguaMeet app ${app[1]}`;
  const os = /Android/.test(s) ? "Android" : /iPhone|iPad|iOS/.test(s) ? "iPhone" : /Windows/.test(s) ? "Windows" : /Mac OS X/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : "";
  const browser = /Edg\//.test(s) ? "Edge" : /SamsungBrowser/.test(s) ? "Samsung Internet" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" on ") || "unknown device";
}

/** A feedback contact as typed: "@Handle" or "handle" (stored as "handle"), an email. */
export function cleanContact(raw: unknown): FeedbackContact | null | "invalid" {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return "invalid";
  const r = raw as Record<string, unknown>;
  const out: FeedbackContact = {};
  if (typeof r.kcHandle === "string" && r.kcHandle.trim()) {
    const h = normalizeKcHandle(r.kcHandle);
    if (!h) return "invalid";
    out.kcHandle = h;
  }
  if (typeof r.email === "string" && r.email.trim()) {
    const e = r.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) return "invalid";
    out.email = e;
  }
  return out.kcHandle || out.email ? out : null;
}

/** The KingsChat id of whoever signed in here with this handle, or null. */
async function kcIdForHandle(handle: string): Promise<string | null> {
  const clerkId = (await clerkIdsForKcHandles([handle]).catch(() => new Map<string, string>())).get(handle);
  return clerkId ? await kcIdForClerkUser(clerkId).catch(() => null) : null;
}

/**
 * Whether a contact can be reached, said when the owner saves it. A KingsChat
 * message goes from the owner's own KingsChat account (so they must have
 * signed in with KingsChat) to someone who has signed in here with that
 * handle (the only way to learn their KingsChat id).
 */
export async function contactReach(ownerUserId: string, c: FeedbackContact | null) {
  if (!c?.kcHandle) return { kcHandleKnown: null, ownerKcLinked: null };
  const [kcId, tokens] = await Promise.all([kcIdForHandle(c.kcHandle), loadKcTokens(ownerUserId).catch(() => null)]);
  return { kcHandleKnown: !!kcId, ownerKcLinked: !!tokens };
}

/** Plans that may set a feedback contact: any paid one. */
export const contactAllowed = (plan: string) => plan !== "free";

export async function listFeedback(eventId: string, limit = 200): Promise<FeedbackEntry[]> {
  const raw = ((await kv.lrange(listKey(eventId), 0, limit - 1)) ?? []) as unknown[];
  return raw
    .map((r) => {
      try {
        return (typeof r === "string" ? JSON.parse(r) : r) as FeedbackEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is FeedbackEntry => !!x && typeof x.id === "string");
}

/** Stars given, and how many entries of each kind, over what is kept. */
export function tally(list: FeedbackEntry[]) {
  const stars = [0, 0, 0, 0, 0];
  const kinds: Record<string, number> = {};
  for (const e of list) {
    if (e.rating && e.rating >= 1 && e.rating <= 5) stars[e.rating - 1]++;
    if (e.kind) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  }
  const rated = stars.reduce((a, b) => a + b, 0);
  const average = rated ? stars.reduce((a, n, i) => a + n * (i + 1), 0) / rated : null;
  return { stars, rated, average, kinds, written: list.filter((e) => e.message.trim()).length };
}

function entryText(ev: NeoEvent, e: FeedbackEntry): string {
  const head = [e.kind ? `[${kindLabel(e.kind)}]` : null, e.rating ? `${e.rating}/5` : null].filter(Boolean).join(" ");
  const who = [e.name, e.email].filter(Boolean).join(" · ") || "Someone";
  return `${head ? head + " " : ""}${e.message}\n\n— ${who}, ${whereText(e.where)}, ${e.device ?? "unknown device"}, ${new Date(e.ts).toISOString().slice(0, 16).replace("T", " ")} UTC · meeting ${ev.name} (/${ev.slug})`;
}

export type Senders = {
  kc: (fromClerkId: string, toKcId: string, text: string) => Promise<{ ok: boolean }>;
  mail: (to: string, subject: string, text: string) => Promise<{ ok: boolean }>;
};
const realSenders: Senders = {
  kc: (from, to, text) => sendKcMessage(from, to, text),
  mail: (to, subject, text) => sendMail({ to, subject, text }),
};
let senders = realSenders;
/** Tests: record instead of sending. */
export function __setFeedbackSenders(s: Senders | null) {
  senders = s ?? realSenders;
}

export interface RecordResult {
  entry: FeedbackEntry;
  ticketNumber: number | null;
  toldOwner: boolean;
  /** Which of the owner's contacts the message went to. */
  sent: { kc: boolean; email: boolean };
}

/** Keep an entry; one with words goes to support and, now and then, to the owner. */
export async function recordFeedback(
  ev: NeoEvent,
  input: Omit<FeedbackEntry, "id" | "ts">,
  now = Date.now(),
): Promise<RecordResult> {
  const entry: FeedbackEntry = { ...input, id: randomBytes(8).toString("base64url"), ts: now };
  await kv.lpush(listKey(ev.id), JSON.stringify(entry));
  await kv.ltrim(listKey(ev.id), 0, KEEP - 1);
  await kv.expire(listKey(ev.id), TTL_S);
  const result: RecordResult = { entry, ticketNumber: null, toldOwner: false, sent: { kc: false, email: false } };
  if (!entry.message.trim()) return result;

  // Support: the day's thread for this meeting.
  const day = new Date(now).toISOString().slice(0, 10);
  const text = entryText(ev, entry);
  const existing = (await kv.get(ticketKey(ev.id, day))) as string | null;
  const ticket = existing ? await getTicket(String(existing)) : null;
  if (ticket) {
    await appendMessage(ticket, { author: "user", authorName: entry.name || "Someone", body: text, attachments: [] }, now);
    result.ticketNumber = ticket.number;
  } else {
    const t = await createTicket(
      {
        subject: `Feedback: ${ev.name} (${day})`.slice(0, 150),
        category: "meetings",
        body: text,
        // Nobody's ticket: it gathers many people's messages, and a ticket on
        // the first sender's account or email would show them everyone
        // else's. Who wrote each one is in its text.
        userId: null,
        email: "",
        name: "Meeting feedback",
        source: "web",
        firstAuthor: { author: "user", name: entry.name || "Someone" },
      },
      now,
    );
    await kv.set(ticketKey(ev.id, day), t.id, { ex: 2 * 24 * 60 * 60 });
    result.ticketNumber = t.number;
  }

  // The owner, at most once in 10 minutes, with how many came meanwhile.
  const since = Number(await kv.incr(sinceKey(ev.id)));
  await kv.expire(sinceKey(ev.id), TTL_S);
  const fresh = (await kv.set(toldKey(ev.id), String(now), { nx: true, ex: TELL_EVERY_S })) === "OK";
  if (!fresh || !ev.ownerUserId) return result;
  await kv.set(sinceKey(ev.id), "0", { ex: TTL_S });
  const more = since > 1 ? ` (${since} messages since the last notice)` : "";
  const link = `${siteOrigin()}/dashboard/e/${encodeURIComponent(ev.slug)}#feedback`;
  const title = `Feedback on ${ev.name}${more}`;
  const body = `${kindLabel(entry.kind)}: ${entry.message.slice(0, 200)}`;
  const url = `/dashboard/e/${encodeURIComponent(ev.slug)}#feedback`;
  await addNotification(ev.ownerUserId, { type: "feedback", title, body, url }, now);
  await sendPush(ev.ownerUserId, { type: "feedback", title, body, url, eventSlug: ev.slug }, { urgency: "normal", topic: topicFor(`feedback:${ev.id}`) }).catch(
    (err) => console.warn("[feedback] push failed", (err as Error).message),
  );
  result.toldOwner = true;

  const contact = ev.feedbackContact;
  if (!contact || !contactAllowed(await getPlanForUserId(ev.ownerUserId))) return result;
  const message = `${title}\n\n${text}\n\nAll feedback: ${link}`;
  if (contact.kcHandle) {
    const kcId = await kcIdForHandle(contact.kcHandle);
    if (kcId) result.sent.kc = (await senders.kc(ev.ownerUserId, kcId, message).catch(() => ({ ok: false }))).ok;
    else console.warn("[feedback] no KingsChat account has signed in with the feedback handle of", ev.id);
  }
  if (contact.email) result.sent.email = (await senders.mail(contact.email, title, message).catch(() => ({ ok: false }))).ok;
  return result;
}
