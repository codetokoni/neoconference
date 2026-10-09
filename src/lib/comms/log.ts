// src/lib/comms/log.ts
//
// What email the platform sent and what became of it, for Admin →
// Communication → Delivery.
//
//   neo:comms:log               list  newest first, capped: one entry per
//                                     transactional email (or per batch of
//                                     blind copies) at the moment it was sent
//   neo:comms:events            list  newest first, capped: delivery reports
//                                     from Resend's webhook (delivered,
//                                     bounced, complained, …)
//   neo:comms:msg:<resendId>    JSON  which log entry / announcement recipient
//                                     a Resend message id belongs to (35 days)
//   neo:comms:bounced:<email>   "1"   a hard bounce: announcements skip it
//
// Announcements keep their own per-recipient status (src/lib/comms/sends.ts);
// the webhook updates both.

import { randomBytes } from "node:crypto";
import { kv } from "@/lib/kv";

const LOG = "neo:comms:log";
const EVENTS = "neo:comms:events";
const LOG_CAP = 5000;
const msgKey = (id: string) => `neo:comms:msg:${id}`;
const bouncedKey = (email: string) => `neo:comms:bounced:${email.trim().toLowerCase()}`;
const MSG_TTL_S = 35 * 24 * 3600;

export type LogStatus = "sent" | "failed" | "skipped";

export interface LogEntry {
  id: string;
  ts: number;
  /** "template" for transactional email, "test" for an admin's test send. */
  source: "template" | "test";
  template: string;
  templateVersion: number;
  /** The address, or "N recipients" for a batch of blind copies. */
  to: string;
  recipients: number;
  subject: string;
  status: LogStatus;
  error?: string;
  resendId?: string;
}

export type DeliveryEventType = "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "failed" | "opened" | "clicked";

export interface DeliveryEvent {
  ts: number;
  /** Resend's svix-id: the same report delivered twice is recorded once. */
  eventId: string;
  type: DeliveryEventType;
  resendId: string;
  to: string;
  subject?: string;
  reason?: string;
  template?: string;
  sendId?: string;
  userId?: string;
}

export interface MessageRef {
  logId?: string;
  template?: string;
  sendId?: string;
  chunk?: number;
  userId?: string;
}

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export async function logEmail(e: Omit<LogEntry, "id" | "ts">): Promise<LogEntry> {
  const entry: LogEntry = { id: randomBytes(8).toString("base64url"), ts: Date.now(), ...e };
  try {
    await kv.lpush(LOG, JSON.stringify(entry));
    await kv.ltrim(LOG, 0, LOG_CAP - 1);
    if (entry.resendId) await rememberMessage(entry.resendId, { logId: entry.id, template: entry.template });
  } catch (err) {
    console.warn("[comms/log] could not log", err);
  }
  return entry;
}

export async function rememberMessage(resendId: string, ref: MessageRef): Promise<void> {
  if (!resendId) return;
  await kv.set(msgKey(resendId), JSON.stringify(ref), { ex: MSG_TTL_S });
}

export async function messageRef(resendId: string): Promise<MessageRef | null> {
  return parse<MessageRef>(await kv.get(msgKey(resendId)));
}

export async function recordDeliveryEvent(e: DeliveryEvent): Promise<void> {
  await kv.lpush(EVENTS, JSON.stringify(e));
  await kv.ltrim(EVENTS, 0, LOG_CAP - 1);
}

export async function markBounced(email: string): Promise<void> {
  if (email) await kv.set(bouncedKey(email), "1");
}

export async function isBounced(email: string): Promise<boolean> {
  return !!email && (await kv.get(bouncedKey(email))) != null;
}

export interface LogQuery {
  q?: string;
  status?: string;
  limit?: number;
}

export async function listLog(query: LogQuery = {}): Promise<LogEntry[]> {
  const raw = ((await kv.lrange(LOG, 0, LOG_CAP - 1)) ?? []) as unknown[];
  const q = query.q?.toLowerCase();
  return raw
    .map((r) => parse<LogEntry>(r))
    .filter((e): e is LogEntry => !!e)
    .filter((e) => !query.status || e.status === query.status)
    .filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q))
    .slice(0, Math.min(query.limit ?? 200, 1000));
}

export async function listDeliveryEvents(query: LogQuery = {}): Promise<DeliveryEvent[]> {
  const raw = ((await kv.lrange(EVENTS, 0, LOG_CAP - 1)) ?? []) as unknown[];
  const q = query.q?.toLowerCase();
  return raw
    .map((r) => parse<DeliveryEvent>(r))
    .filter((e): e is DeliveryEvent => !!e)
    .filter((e) => !query.status || e.type === query.status)
    .filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q))
    .slice(0, Math.min(query.limit ?? 200, 1000));
}
