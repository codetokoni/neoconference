// src/lib/comms/webhook.ts
//
// Resend's delivery reports (email.delivered, email.bounced,
// email.complained, …). Resend signs them the Svix way:
//
//   svix-id, svix-timestamp, svix-signature: "v1,<base64 HMAC-SHA256>" (space-separated list)
//   signed content: "<svix-id>.<svix-timestamp>.<raw body>"
//   key: the base64 after "whsec_" in RESEND_WEBHOOK_SECRET
//
// A report older or newer than five minutes is refused (replay), and the
// same svix-id is applied once.

import { createHmac, timingSafeEqual } from "node:crypto";
import { kv } from "@/lib/kv";
import { messageRef, recordDeliveryEvent, markBounced, type DeliveryEventType } from "@/lib/comms/log";
import { applyDeliveryReport } from "@/lib/comms/sends";
import { updatePrefs } from "@/lib/comms/prefs";

const TOLERANCE_S = 5 * 60;

export function isWebhookConfigured(): boolean {
  return Boolean(process.env.RESEND_WEBHOOK_SECRET);
}

function secretBytes(secret: string): Buffer {
  return Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
}

/** Sign as Resend (Svix) does — for tests, and to check a signature. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return "v1," + createHmac("sha256", secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
}

export type VerifyFailure = "not_configured" | "missing_headers" | "stale" | "bad_signature";

export function verifyWebhook(
  headers: Headers,
  body: string,
  secret = process.env.RESEND_WEBHOOK_SECRET,
  nowMs = Date.now(),
): { ok: true; id: string } | { ok: false; why: VerifyFailure } {
  if (!secret) return { ok: false, why: "not_configured" };
  const id = headers.get("svix-id") || headers.get("webhook-id");
  const ts = headers.get("svix-timestamp") || headers.get("webhook-timestamp");
  const sigs = headers.get("svix-signature") || headers.get("webhook-signature");
  if (!id || !ts || !sigs) return { ok: false, why: "missing_headers" };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > TOLERANCE_S) return { ok: false, why: "stale" };
  const want = Buffer.from(signWebhook(secret, id, t, body).slice(3), "base64");
  for (const part of sigs.split(" ")) {
    const [v, sig] = part.split(",");
    if (v !== "v1" || !sig) continue;
    const got = Buffer.from(sig, "base64");
    if (got.length === want.length && timingSafeEqual(got, want)) return { ok: true, id };
  }
  return { ok: false, why: "bad_signature" };
}

interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    subject?: string;
    bounce?: { message?: string; type?: string; subType?: string };
    failed?: { reason?: string };
    reason?: string;
  };
}

/** Apply one verified report. Returns what it did, for the response. */
export async function ingestWebhook(eventId: string, body: string): Promise<{ applied: boolean; type?: string; duplicate?: boolean }> {
  const fresh = await kv.set(`neo:comms:wh-seen:${eventId}`, "1", { nx: true, ex: 7 * 24 * 3600 });
  if (fresh !== "OK") return { applied: false, duplicate: true };
  let ev: ResendEvent;
  try {
    ev = JSON.parse(body) as ResendEvent;
  } catch {
    return { applied: false };
  }
  const type = (ev.type || "").replace(/^email\./, "") as DeliveryEventType;
  const resendId = ev.data?.email_id || "";
  if (!type || !resendId) return { applied: false };
  const to = (Array.isArray(ev.data?.to) ? ev.data?.to : ev.data?.to ? [ev.data.to] : [])!.join(", ").toLowerCase();
  const reason =
    ev.data?.bounce?.message ||
    [ev.data?.bounce?.type, ev.data?.bounce?.subType].filter(Boolean).join(" / ") ||
    ev.data?.failed?.reason ||
    ev.data?.reason ||
    undefined;
  const ref = await messageRef(resendId);
  await recordDeliveryEvent({
    ts: Date.now(),
    eventId,
    type,
    resendId,
    to,
    ...(ev.data?.subject ? { subject: ev.data.subject } : {}),
    ...(reason ? { reason } : {}),
    ...(ref?.template ? { template: ref.template } : {}),
    ...(ref?.sendId ? { sendId: ref.sendId } : {}),
    ...(ref?.userId ? { userId: ref.userId } : {}),
  });
  if (ref?.sendId && ref.userId && typeof ref.chunk === "number") {
    await applyDeliveryReport({ sendId: ref.sendId, chunk: ref.chunk, userId: ref.userId }, type, reason);
  }
  // A permanent bounce: announcements stop trying that address.
  if (type === "bounced" && (!ev.data?.bounce?.type || /permanent|hard/i.test(ev.data.bounce.type))) {
    for (const addr of to.split(", ").filter(Boolean)) await markBounced(addr);
  }
  // Marked as spam: stop the optional email for good.
  if (type === "complained" && ref?.userId) {
    await updatePrefs(ref.userId, { announcements: { email: false }, product: { email: false }, reminders: { email: false } }, "complaint");
  }
  return { applied: true, type };
}
