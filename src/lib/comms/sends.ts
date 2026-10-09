// src/lib/comms/sends.ts
//
// Announcements and service notices: drafted with a preview, confirmed, then
// delivered by a job that works through its recipients a slice at a time,
// so a send to every account never has to fit in one request.
//
//   neo:comms:sends                   list  send ids, newest first (history)
//   neo:comms:active                  set   sends with work left
//   neo:comms:send:<id>               JSON  the send: message, audience, progress, counts
//   neo:comms:send:<id>:chunk:<n>     JSON  up to 100 recipients
//   neo:comms:send:<id>:st:<n>        hash  uid -> that recipient's status per channel
//   neo:comms:send:<id>:claim:<n>     hash  "<uid>:<channel>" -> when it was claimed
//   neo:comms:send:<id>:seen          set   uids already given a chunk (no one twice)
//   neo:comms:send:<id>:fail          list  failed deliveries with reasons (capped)
//   neo:comms:send:<id>:wh:<type>     counter  delivery reports from Resend
//   neo:comms:send:<id>:lease         one worker at a time (2 min)
//
// No double sends on a retry: before anything is sent to a recipient on a
// channel, the "<uid>:<channel>" field is claimed with HSETNX. A worker that
// dies after claiming leaves the claim and no status; the next worker sees
// the claim, records "unknown" and does not send again. At most once, never
// twice.
//
// Who drives it: the confirm request runs the first slice, the admin page
// drives it while open, the scheduler's 30-second tick
// (/api/internal/dispatch) and a daily cron (/api/cron/comms) pick up the
// rest.

import { randomBytes, createHash } from "node:crypto";
import { kv } from "@/lib/kv";
import { addNotification } from "@/lib/notificationStore";
import { sendPush, topicFor, type PushPayload } from "@/lib/pushStore";
import { isMailConfigured, sendMailBatch } from "@/lib/mail";
import { escapeHtml, formatMessage, safeHref } from "@/lib/comms/format";
import { previewAudience, resolvePage, describeAudience, type Audience, type AudiencePreview, type Recipient } from "@/lib/comms/audience";
import { allows, getPrefs, oneClickUrl, unsubscribeUrl, PREF_CATEGORIES, type PrefCategory, type PrefChannel } from "@/lib/comms/prefs";
import { isBounced, rememberMessage } from "@/lib/comms/log";

export const CHUNK = 100;
/** Above this many recipients (or "everyone") confirming needs a fresh authenticator code. */
export const STEP_UP_RECIPIENTS = 500;
const LEASE_S = 120;
const FAIL_CAP = 2000;
const CONCURRENCY = 10;

export type SendKind = "announcement" | "product" | "service";
export type Severity = "info" | "warning" | "critical";
export type SendStatus = "draft" | "queued" | "sending" | "paused" | "cancelled" | "done";
export type Channel = PrefChannel;
export const CHANNELS: Channel[] = ["email", "inApp", "push"];

export type DeliveryState = "sent" | "failed" | "skipped" | "unknown" | "delivered" | "bounced" | "complained" | "delayed";
export interface ChannelState {
  s: DeliveryState;
  /** Why it failed or was skipped. */
  r?: string;
  /** Resend's message id. */
  id?: string;
  t: number;
}
export interface RecipientStatus {
  name: string;
  email: string;
  ch: Partial<Record<Channel, ChannelState>>;
}

export interface SendMessage {
  title: string;
  body: string;
  severity: Severity;
  /** Same-origin path the bell and push open; "" = the dashboard. */
  url: string;
}

type PerChannel = Record<Channel, number>;
const zero = (): PerChannel => ({ email: 0, inApp: 0, push: 0 });

export interface Send {
  id: string;
  kind: SendKind;
  message: SendMessage;
  channels: Record<Channel, boolean>;
  audience: Audience;
  audienceLabel: string;
  /** Not delivered before this (epoch ms); null = at once. */
  startsAt: number | null;
  /** Nothing more delivered after this; null = no end. */
  endsAt: number | null;
  origin: string;
  status: SendStatus;
  createdAt: number;
  createdBy: string;
  createdByEmail: string;
  updatedAt: number;
  preview: { count: number; exact: boolean; withEmail: number };
  confirmedAt?: number;
  confirmedBy?: string;
  confirmedByEmail?: string;
  pausedAt?: number;
  cancelledAt?: number;
  finishedAt?: number;
  /** "ended": the end time passed before everyone was reached. */
  stoppedReason?: "ended" | "cancelled";
  resolve: { cursor: number | null; done: boolean; scanned: number };
  chunks: number;
  nextChunk: number;
  counts: {
    recipients: number;
    sent: PerChannel;
    failed: PerChannel;
    skipped: PerChannel;
    unknown: PerChannel;
  };
  lastError?: string;
}

const sendKey = (id: string) => `neo:comms:send:${id}`;
const chunkKey = (id: string, n: number) => `neo:comms:send:${id}:chunk:${n}`;
const stKey = (id: string, n: number) => `neo:comms:send:${id}:st:${n}`;
const claimKey = (id: string, n: number) => `neo:comms:send:${id}:claim:${n}`;
const seenKey = (id: string) => `neo:comms:send:${id}:seen`;
const failKey = (id: string) => `neo:comms:send:${id}:fail`;
const whKey = (id: string, type: string) => `neo:comms:send:${id}:wh:${type}`;
const leaseKey = (id: string) => `neo:comms:send:${id}:lease`;
const SENDS = "neo:comms:sends";
const ACTIVE = "neo:comms:active";

export const WEBHOOK_TYPES = ["delivered", "bounced", "complained", "delayed", "failed"] as const;

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

/** The preference category a send belongs to; null = a service notice nobody can turn off. */
export function categoryOf(kind: SendKind): PrefCategory | null {
  return kind === "service" ? null : kind === "product" ? "product" : "announcements";
}

/* -------------------------------------------------------------------------- */
/*  Drafting                                                                   */
/* -------------------------------------------------------------------------- */

export interface DraftInput {
  kind: SendKind;
  message: SendMessage;
  channels: Record<Channel, boolean>;
  audience: Audience;
  startsAt: number | null;
  endsAt: number | null;
}

export function cleanDraft(raw: Record<string, unknown>): { draft: Omit<DraftInput, "audience"> } | { error: string } {
  const kind = raw.kind;
  if (kind !== "announcement" && kind !== "product" && kind !== "service") return { error: "Choose the kind of message." };
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim().slice(0, 140) : "";
  const body = typeof raw.body === "string" ? raw.body.replace(/\r\n?/g, "\n").trim().slice(0, 5000) : "";
  if (!title) return { error: "Give the message a title." };
  if (!body) return { error: "Write the message." };
  const severity = raw.severity === "warning" || raw.severity === "critical" ? raw.severity : "info";
  let url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (url && !(url.startsWith("/") && !url.startsWith("//") && safeHref(url))) return { error: "The link must be a page on this site, starting with /." };
  url = url.slice(0, 300);
  const ch = (raw.channels ?? {}) as Record<string, unknown>;
  const channels = { email: ch.email === true, inApp: ch.inApp === true, push: ch.push === true };
  if (!channels.email && !channels.inApp && !channels.push) return { error: "Pick at least one channel." };
  const time = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v ? Date.parse(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const startsAt = time(raw.startsAt);
  const endsAt = time(raw.endsAt);
  if (endsAt != null && endsAt <= (startsAt ?? Date.now())) return { error: "The end time must be after the start." };
  return { draft: { kind, message: { title, body, severity, url }, channels, startsAt, endsAt } };
}

export interface ChannelPreview {
  email: { subject: string; html: string; text: string; from: string; unsubscribe: string | null } | null;
  inApp: { title: string; body: string; url: string } | null;
  push: { title: string; body: string; url: string } | null;
}

const KIND_LABEL: Record<SendKind, string> = { announcement: "Announcement", product: "Product update", service: "Service notice" };
const SEVERITY_COLOR: Record<Severity, string> = { info: "#0891b2", warning: "#d97706", critical: "#dc2626" };

/** The exact email one recipient gets. */
export function renderAnnouncementEmail(send: Pick<Send, "kind" | "message" | "origin">, to: Pick<Recipient, "uid">) {
  const { message, kind, origin } = send;
  const f = formatMessage(message.body, origin);
  const color = SEVERITY_COLOR[message.severity];
  const label = message.severity === "critical" ? `${KIND_LABEL[kind]} · important` : KIND_LABEL[kind];
  const category = categoryOf(kind);
  const unsub = category ? unsubscribeUrl(origin, to.uid, category) : null;
  const settings = `${origin.replace(/\/+$/, "")}/dashboard/settings#notifications`;
  const link = message.url ? origin.replace(/\/+$/, "") + message.url : "";
  const catLabel = category ? PREF_CATEGORIES.find((c) => c.key === category)!.label.toLowerCase() : "";
  const footerHtml = category
    ? `You get ${escapeHtml(catLabel)} because you have a NeoConference account. <a href="${escapeHtml(unsub!)}" style="color:#64748b">Unsubscribe from ${escapeHtml(catLabel)}</a> · <a href="${escapeHtml(settings)}" style="color:#64748b">Notification settings</a>`
    : `This is a service notice about NeoConference. It goes to every account it concerns and cannot be turned off.`;
  const html =
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:system-ui,sans-serif">` +
    `<div style="border-left:4px solid ${color};padding-left:12px;margin:0 0 16px">` +
    `<p style="margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${color}">${escapeHtml(label)}</p>` +
    `<h1 style="margin:4px 0 0;font-size:20px;line-height:1.3;color:#0f172a">${escapeHtml(message.title)}</h1></div>` +
    f.html +
    (link
      ? `<p style="margin:16px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#06b6d4;color:#020617;text-decoration:none;font-weight:600">Open NeoConference</a></p>`
      : "") +
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">` +
    `<p style="margin:0;font-size:12px;line-height:1.5;color:#64748b">${footerHtml}</p></div>`;
  const text =
    `${label.toUpperCase()}\n${message.title}\n\n${f.text}` +
    (link ? `\n\nOpen NeoConference: ${link}` : "") +
    (category
      ? `\n\n—\nYou get ${catLabel} because you have a NeoConference account.\nUnsubscribe: ${unsub}\nNotification settings: ${settings}`
      : `\n\n—\nThis is a service notice about NeoConference. It goes to every account it concerns and cannot be turned off.`);
  const headers: Record<string, string> = category
    ? { "List-Unsubscribe": `<${oneClickUrl(origin, to.uid, category)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : {};
  return { subject: message.title, html, text, headers, unsubscribe: unsub };
}

export function announcementPayload(send: Pick<Send, "id" | "message" | "origin">): PushPayload {
  return {
    type: "announcement",
    title: send.message.title,
    body: formatMessage(send.message.body, send.origin).short,
    url: send.message.url || "/dashboard",
  };
}

export function previewChannels(send: Send, sampleUid: string): ChannelPreview {
  const p = announcementPayload(send);
  const email = send.channels.email ? renderAnnouncementEmail(send, { uid: sampleUid }) : null;
  return {
    email: email ? { subject: email.subject, html: email.html, text: email.text, from: process.env.MAIL_FROM || "NeoConference <onboarding@resend.dev>", unsubscribe: email.unsubscribe } : null,
    inApp: send.channels.inApp ? { title: p.title, body: p.body, url: p.url } : null,
    push: send.channels.push ? { title: p.title, body: p.body, url: p.url } : null,
  };
}

function newId(): string {
  return `snd_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

async function writeSend(s: Send): Promise<void> {
  await kv.set(sendKey(s.id), JSON.stringify(s));
}

export async function getSend(id: string): Promise<Send | null> {
  if (!/^snd_[a-z0-9]+$/.test(id)) return null;
  return parse<Send>(await kv.get(sendKey(id)));
}

/** A draft and what it would do. Nothing is delivered until it is confirmed. */
export async function createDraft(
  input: DraftInput,
  actor: { userId: string; email: string },
  origin: string,
): Promise<{ send: Send; preview: AudiencePreview; channels: ChannelPreview }> {
  const preview = await previewAudience(input.audience);
  const now = Date.now();
  const send: Send = {
    id: newId(),
    ...input,
    audienceLabel: describeAudience(input.audience),
    origin,
    status: "draft",
    createdAt: now,
    createdBy: actor.userId,
    createdByEmail: actor.email,
    updatedAt: now,
    preview: { count: preview.count, exact: preview.exact, withEmail: preview.withEmail },
    resolve: { cursor: 0, done: false, scanned: 0 },
    chunks: 0,
    nextChunk: 0,
    counts: { recipients: 0, sent: zero(), failed: zero(), skipped: zero(), unknown: zero() },
  };
  await writeSend(send);
  await kv.lpush(SENDS, send.id);
  return { send, preview, channels: previewChannels(send, preview.sample[0]?.uid ?? "user_sample") };
}

/** Whether confirming this send needs a fresh authenticator code. */
export function needsStepUp(s: Pick<Send, "audience" | "preview">): boolean {
  return s.audience.kind === "everyone" || !s.preview.exact || s.preview.count > STEP_UP_RECIPIENTS;
}

export async function discardDraft(id: string): Promise<boolean> {
  const s = await getSend(id);
  if (!s || s.status !== "draft") return false;
  await kv.del(sendKey(id));
  // Leave the id in the history list: listSends() skips ids that no longer resolve.
  return true;
}

export async function confirmSend(s: Send, actor: { userId: string; email: string }): Promise<Send> {
  const now = Date.now();
  const next: Send = { ...s, status: "queued", confirmedAt: now, confirmedBy: actor.userId, confirmedByEmail: actor.email, updatedAt: now };
  await writeSend(next);
  await kv.sadd(ACTIVE, s.id);
  return next;
}

export type ControlAction = "pause" | "resume" | "cancel";

/** Pause, resume or cancel. Returns null when the action does not apply in this state. */
export async function controlSend(id: string, action: ControlAction): Promise<{ before: Send; after: Send } | null> {
  const s = await getSend(id);
  if (!s) return null;
  const now = Date.now();
  let after: Send | null = null;
  if (action === "pause" && (s.status === "queued" || s.status === "sending")) after = { ...s, status: "paused", pausedAt: now };
  if (action === "resume" && s.status === "paused") after = { ...s, status: s.nextChunk > 0 || s.chunks > 0 ? "sending" : "queued", pausedAt: undefined };
  if (action === "cancel" && (s.status === "queued" || s.status === "sending" || s.status === "paused")) {
    after = { ...s, status: "cancelled", cancelledAt: now, stoppedReason: "cancelled" };
  }
  if (!after) return null;
  after.updatedAt = now;
  await writeSend(after);
  if (after.status === "cancelled" || after.status === "paused") await kv.srem(ACTIVE, id);
  else await kv.sadd(ACTIVE, id);
  return { before: s, after };
}

/* -------------------------------------------------------------------------- */
/*  Delivering                                                                 */
/* -------------------------------------------------------------------------- */

/** Save the worker's progress without undoing a pause or cancel made meanwhile. */
async function saveProgress(s: Send): Promise<Send> {
  const cur = await getSend(s.id);
  const merged: Send = { ...s, updatedAt: Date.now() };
  if (cur && (cur.status === "paused" || cur.status === "cancelled")) {
    merged.status = cur.status;
    merged.pausedAt = cur.pausedAt;
    merged.cancelledAt = cur.cancelledAt;
    merged.stoppedReason = cur.stoppedReason;
  }
  await writeSend(merged);
  return merged;
}

async function stillRunning(id: string): Promise<boolean> {
  const cur = await getSend(id);
  return !!cur && (cur.status === "queued" || cur.status === "sending");
}

async function claim(id: string, n: number, uid: string, ch: Channel): Promise<boolean> {
  return Number(await kv.hsetnx(claimKey(id, n), `${uid}:${ch}`, Date.now())) === 1;
}

async function recordFailure(id: string, f: { uid: string; email: string; channel: Channel; reason: string }) {
  await kv.lpush(failKey(id), JSON.stringify({ ...f, ts: Date.now() }));
  await kv.ltrim(failKey(id), 0, FAIL_CAP - 1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inBatches<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Deliver one chunk on every channel. Recipients already done are left alone. */
async function deliverChunk(s: Send, n: number): Promise<void> {
  const recipients = parse<Recipient[]>(await kv.get(chunkKey(s.id, n))) ?? [];
  const statuses = ((await kv.hgetall(stKey(s.id, n))) ?? {}) as Record<string, unknown>;
  const st = new Map<string, RecipientStatus>();
  for (const r of recipients) st.set(r.uid, parse<RecipientStatus>(statuses[r.uid]) ?? { name: r.name, email: r.email, ch: {} });
  const changed = new Set<string>();
  const set = (r: Recipient, ch: Channel, state: ChannelState) => {
    st.get(r.uid)!.ch[ch] = state;
    changed.add(r.uid);
    const bucket = state.s === "sent" ? "sent" : state.s === "failed" ? "failed" : state.s === "skipped" ? "skipped" : "unknown";
    s.counts[bucket][ch]++;
  };
  const category = categoryOf(s.kind);
  const prefs = new Map<string, Awaited<ReturnType<typeof getPrefs>>>();
  await inBatches(recipients, CONCURRENCY, async (r) => {
    prefs.set(r.uid, await getPrefs(r.uid));
  });
  const payload = announcementPayload(s);
  const now = () => Date.now();

  /** Work out what to do for one recipient on one channel: null = go ahead and send. */
  const gate = async (r: Recipient, ch: Channel): Promise<"done" | null> => {
    if (st.get(r.uid)!.ch[ch]) return "done";
    if (!allows(prefs.get(r.uid)!, category, ch)) {
      set(r, ch, { s: "skipped", r: "opted_out", t: now() });
      return "done";
    }
    if (!(await claim(s.id, n, r.uid, ch))) {
      // Claimed by an earlier worker that stopped before recording what happened.
      set(r, ch, { s: "unknown", r: "interrupted_before_recorded", t: now() });
      return "done";
    }
    return null;
  };

  if (s.channels.inApp) {
    await inBatches(recipients, CONCURRENCY, async (r) => {
      if (await gate(r, "inApp")) return;
      try {
        await addNotification(r.uid, { type: "announcement", title: payload.title, body: payload.body, url: payload.url });
        set(r, "inApp", { s: "sent", t: now() });
      } catch (err) {
        set(r, "inApp", { s: "failed", r: (err as Error).message?.slice(0, 200) || "error", t: now() });
        await recordFailure(s.id, { uid: r.uid, email: r.email, channel: "inApp", reason: (err as Error).message || "error" });
      }
    });
  }

  if (s.channels.push && (await stillRunning(s.id))) {
    const opts = { ttlSec: 24 * 3600, urgency: s.message.severity === "critical" ? ("high" as const) : ("normal" as const), topic: topicFor(`announce:${s.id}`) };
    await inBatches(recipients, CONCURRENCY, async (r) => {
      if (await gate(r, "push")) return;
      try {
        const res = await sendPush(r.uid, payload, opts);
        if (!res.configured) set(r, "push", { s: "skipped", r: "push_not_configured", t: now() });
        else if (res.devices.length === 0) set(r, "push", { s: "skipped", r: "no_device", t: now() });
        else if (res.devices.some((d) => d.outcome === "sent")) set(r, "push", { s: "sent", t: now() });
        else if (res.devices.every((d) => d.outcome === "gone")) set(r, "push", { s: "skipped", r: "devices_gone", t: now() });
        else {
          set(r, "push", { s: "failed", r: "push_service_refused", t: now() });
          await recordFailure(s.id, { uid: r.uid, email: r.email, channel: "push", reason: "push_service_refused" });
        }
      } catch (err) {
        set(r, "push", { s: "failed", r: (err as Error).message?.slice(0, 200) || "error", t: now() });
        await recordFailure(s.id, { uid: r.uid, email: r.email, channel: "push", reason: (err as Error).message || "error" });
      }
    });
  }

  if (s.channels.email && (await stillRunning(s.id))) {
    const go: Recipient[] = [];
    for (const r of recipients) {
      if (st.get(r.uid)!.ch.email) continue;
      if (!r.email) {
        set(r, "email", { s: "skipped", r: "no_email", t: now() });
        continue;
      }
      if (!isMailConfigured()) {
        set(r, "email", { s: "skipped", r: "mail_not_configured", t: now() });
        continue;
      }
      if (await isBounced(r.email)) {
        set(r, "email", { s: "skipped", r: "bounced_before", t: now() });
        continue;
      }
      if (await gate(r, "email")) continue;
      go.push(r);
    }
    if (go.length) {
      const items = go.map((r) => {
        const e = renderAnnouncementEmail(s, r);
        return { to: r.email, subject: e.subject, html: e.html, text: e.text, headers: e.headers };
      });
      const idem = `comms-${s.id}-${n}-${createHash("sha256").update(go.map((r) => r.uid).join(",")).digest("hex").slice(0, 16)}`;
      let res = await sendMailBatch(items, { idempotencyKey: idem });
      if (!res.ok && res.error === "rate_limited") {
        await sleep(1_000);
        res = await sendMailBatch(items, { idempotencyKey: idem });
      }
      for (let i = 0; i < go.length; i++) {
        const r = go[i];
        if (res.ok) {
          const id = res.ids[i] || "";
          set(r, "email", { s: "sent", ...(id ? { id } : {}), t: now() });
          if (id) await rememberMessage(id, { sendId: s.id, chunk: n, userId: r.uid });
        } else {
          set(r, "email", { s: "failed", r: res.error.slice(0, 200), t: now() });
          await recordFailure(s.id, { uid: r.uid, email: r.email, channel: "email", reason: res.error });
        }
      }
      if (!res.ok) s.lastError = res.error;
    }
  }

  if (changed.size) {
    const out: Record<string, string> = {};
    for (const uid of changed) out[uid] = JSON.stringify(st.get(uid));
    await kv.hset(stKey(s.id, n), out);
  }
}

/** Resolve one more page of the audience into chunks. */
async function resolveMore(s: Send): Promise<void> {
  const page = await resolvePage(s.audience, s.resolve.cursor ?? 0);
  const fresh: Recipient[] = [];
  for (const r of page.recipients) {
    if (Number(await kv.sismember(seenKey(s.id), r.uid)) === 1) continue;
    await kv.sadd(seenKey(s.id), r.uid);
    fresh.push(r);
  }
  for (let i = 0; i < fresh.length; i += CHUNK) {
    await kv.set(chunkKey(s.id, s.chunks), JSON.stringify(fresh.slice(i, i + CHUNK)));
    s.chunks++;
  }
  s.counts.recipients += fresh.length;
  s.resolve.scanned += page.scanned;
  s.resolve.cursor = page.next;
  s.resolve.done = page.next === null;
}

export interface ProcessResult {
  id: string;
  status: SendStatus | "missing";
  locked?: boolean;
  chunks?: number;
  waiting?: "scheduled";
}

/**
 * Work on one send for up to `budgetMs` (and at most `maxSteps` steps: one
 * page of recipients listed, or one chunk delivered). Safe to call from
 * anywhere, any number of times.
 */
export async function processSend(id: string, budgetMs = 8_000, maxSteps = Infinity): Promise<ProcessResult> {
  const started = Date.now();
  // Not all digits: Upstash would read it back as a number.
  const token = `l${randomBytes(8).toString("hex")}`;
  if ((await kv.set(leaseKey(id), token, { nx: true, ex: LEASE_S })) !== "OK") {
    const cur = await getSend(id);
    return { id, status: cur?.status ?? "missing", locked: true };
  }
  let delivered = 0;
  let steps = 0;
  try {
    for (;;) {
      let s = await getSend(id);
      if (!s) return { id, status: "missing" };
      if (s.status !== "queued" && s.status !== "sending") {
        await kv.srem(ACTIVE, id);
        return { id, status: s.status, chunks: delivered };
      }
      const now = Date.now();
      if (s.startsAt && s.startsAt > now) return { id, status: s.status, waiting: "scheduled" };
      if (s.endsAt && now > s.endsAt) {
        s = await saveProgress({ ...s, status: "done", finishedAt: now, stoppedReason: "ended" });
        await kv.srem(ACTIVE, id);
        return { id, status: s.status, chunks: delivered };
      }
      if (Date.now() - started > budgetMs || steps >= maxSteps) return { id, status: s.status, chunks: delivered };
      steps++;
      s.status = "sending";
      if (s.nextChunk < s.chunks) {
        await deliverChunk(s, s.nextChunk);
        s.nextChunk++;
        delivered++;
        await saveProgress(s);
      } else if (!s.resolve.done) {
        try {
          await resolveMore(s);
        } catch (err) {
          s.lastError = `Could not list recipients: ${(err as Error).message}`;
          await saveProgress(s);
          return { id, status: s.status, chunks: delivered };
        }
        await saveProgress(s);
      } else {
        const done = await saveProgress({ ...s, status: "done", finishedAt: Date.now() });
        if (done.status === "done") await kv.srem(ACTIVE, id);
        return { id, status: done.status, chunks: delivered };
      }
    }
  } finally {
    if ((await kv.get(leaseKey(id))) === token) await kv.del(leaseKey(id));
  }
}

/** Every send with work left, for the scheduler tick and the cron. */
export async function runCommsDispatch(budgetMs = 15_000): Promise<{ processed: ProcessResult[] }> {
  const started = Date.now();
  const ids = ((await kv.smembers(ACTIVE)) ?? []).map(String);
  const processed: ProcessResult[] = [];
  for (const id of ids) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 500) break;
    processed.push(await processSend(id, left));
  }
  return { processed };
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

export async function listSends(q?: string, status?: string, limit = 100): Promise<Send[]> {
  const ids = ((await kv.lrange(SENDS, 0, 999)) ?? []).map(String);
  const needle = q?.trim().toLowerCase();
  const out: Send[] = [];
  for (const id of ids) {
    const s = await getSend(id);
    if (!s) continue;
    if (status && s.status !== status) continue;
    if (needle && !`${s.message.title} ${s.message.body} ${s.createdByEmail} ${s.confirmedByEmail ?? ""} ${s.audienceLabel} ${s.id}`.toLowerCase().includes(needle)) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export async function webhookCounts(id: string): Promise<Record<(typeof WEBHOOK_TYPES)[number], number>> {
  const out = {} as Record<(typeof WEBHOOK_TYPES)[number], number>;
  for (const t of WEBHOOK_TYPES) out[t] = Number((await kv.get(whKey(id, t))) ?? 0);
  return out;
}

export async function listFailures(id: string, limit = 200): Promise<Array<{ uid: string; email: string; channel: Channel; reason: string; ts: number }>> {
  const raw = ((await kv.lrange(failKey(id), 0, limit - 1)) ?? []) as unknown[];
  return raw.map((r) => parse<{ uid: string; email: string; channel: Channel; reason: string; ts: number }>(r)).filter((x): x is NonNullable<typeof x> => !!x);
}

/** One chunk's recipients and their status, optionally only those in `state` on any channel. */
export async function chunkStatuses(id: string, n: number): Promise<Array<{ uid: string } & RecipientStatus>> {
  const recipients = parse<Recipient[]>(await kv.get(chunkKey(id, n))) ?? [];
  const raw = ((await kv.hgetall(stKey(id, n))) ?? {}) as Record<string, unknown>;
  return recipients.map((r) => ({ uid: r.uid, ...(parse<RecipientStatus>(raw[r.uid]) ?? { name: r.name, email: r.email, ch: {} }) }));
}

/* -------------------------------------------------------------------------- */
/*  Delivery reports                                                           */
/* -------------------------------------------------------------------------- */

const REPORT_STATE: Partial<Record<string, DeliveryState>> = {
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
  delivery_delayed: "delayed",
  failed: "failed",
};

/** A Resend report about one announcement email: update that recipient and the send's counts. */
export async function applyDeliveryReport(ref: { sendId: string; chunk: number; userId: string }, type: string, reason?: string): Promise<boolean> {
  const state = REPORT_STATE[type];
  if (!state) return false;
  const raw = await kv.hget(stKey(ref.sendId, ref.chunk), ref.userId);
  const cur = parse<RecipientStatus>(raw);
  if (!cur) return false;
  const prev = cur.ch.email;
  // A late "delayed" never overwrites a final answer.
  if (state === "delayed" && prev && (prev.s === "delivered" || prev.s === "bounced" || prev.s === "complained")) return false;
  cur.ch.email = { s: state, ...(prev?.id ? { id: prev.id } : {}), ...(reason ? { r: reason.slice(0, 300) } : {}), t: Date.now() };
  await kv.hset(stKey(ref.sendId, ref.chunk), { [ref.userId]: JSON.stringify(cur) });
  await kv.incr(whKey(ref.sendId, state));
  if (state === "bounced" || state === "failed" || state === "complained") {
    await recordFailure(ref.sendId, { uid: ref.userId, email: cur.email, channel: "email", reason: reason ? `${state}: ${reason}` : state });
  }
  return true;
}
