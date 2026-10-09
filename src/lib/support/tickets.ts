// src/lib/support/tickets.ts
//
// Support tickets in KV. Native rather than read from NeoSupport: the chat
// widget's service has no documented API or credentials this app could read
// conversations with, so a chat that needs following up is copied into a
// ticket by an agent (source "chat").
//
//   neo:support:tickets        hash  id -> Ticket JSON
//   neo:support:msgs:<id>      list  TicketMessage JSON, newest first (LPUSH)
//   neo:support:notes:<id>     list  InternalNote JSON, newest first
//   neo:support:seq            counter for ticket numbers
//   neo:support:sla            SlaConfig JSON
//   neo:support:rl:<bucket>    counter with an expiry (intake rate limits)
//
// Internal notes live under their own key on purpose: the user-facing routes
// only ever read the conversation list, so no filter has to remember to drop
// a note.

import { randomBytes } from "node:crypto";
import { kv } from "@/lib/kv";
import { deleteObject, isR2Configured, putObject, signGetUrl } from "@/lib/r2";
import { DEFAULT_UPLOAD_RULES, checkUpload } from "@/lib/content/model";
import { uploadRule } from "@/lib/content/limits";
import { indexDeleted } from "@/lib/content/files";
import {
  DEFAULT_SLA,
  cleanSla,
  isUnresolved,
  slaFor,
  type InternalNote,
  type SlaConfig,
  type SupportAttachment,
  type Ticket,
  type TicketCategory,
  type TicketMessage,
  type TicketPriority,
  type TicketSource,
  type TicketStatus,
} from "@/lib/support/model";

const TICKETS = "neo:support:tickets";
const SEQ = "neo:support:seq";
const SLA = "neo:support:sla";
const msgsKey = (id: string) => `neo:support:msgs:${id}`;
const notesKey = (id: string) => `neo:support:notes:${id}`;
const rlKey = (bucket: string) => `neo:support:rl:${bucket}`;

/** Ticket numbers start here so the first one does not read as "#1". */
const FIRST_NUMBER = 1000;

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export function newId(bytes = 9): string {
  return randomBytes(bytes).toString("base64url");
}

/* --------------------------------- tickets --------------------------------- */

export async function getTicket(id: string): Promise<Ticket | null> {
  if (!id || id.length > 40) return null;
  return parse<Ticket>(await kv.hget(TICKETS, id));
}

export async function saveTicket(t: Ticket): Promise<void> {
  await kv.hset(TICKETS, { [t.id]: JSON.stringify(t) });
}

export async function listTickets(): Promise<Ticket[]> {
  const all = ((await kv.hgetall(TICKETS)) ?? {}) as Record<string, unknown>;
  return Object.values(all)
    .map((v) => parse<Ticket>(v))
    .filter((t): t is Ticket => !!t);
}

/** Everything one account has raised: by user id, and by email for tickets sent before signing in. */
export function ticketsForAccount(all: Ticket[], userId: string | null, emails: string[]): Ticket[] {
  const mail = new Set(emails.map((e) => e.toLowerCase()).filter(Boolean));
  return all
    .filter((t) => (userId && t.userId === userId) || (!t.userId && mail.has(t.email)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Whether a signed-in user may read this ticket: it is theirs, or it was sent
 * signed out from an address Clerk has verified on their account.
 */
export function userOwnsTicket(t: Ticket, userId: string, verifiedEmails: string[]): boolean {
  if (t.userId) return t.userId === userId;
  return verifiedEmails.map((e) => e.toLowerCase()).includes(t.email);
}

export interface CreateTicketInput {
  subject: string;
  category: TicketCategory;
  priority?: TicketPriority;
  body: string;
  userId: string | null;
  email: string;
  name: string;
  source: TicketSource;
  chatRef?: string;
  attachments?: SupportAttachment[];
  /** Pre-uploaded under this id (attachments are keyed by ticket). */
  id?: string;
  /** Who wrote the first message, when an agent opens it for someone. */
  firstAuthor?: { author: TicketMessage["author"]; name: string };
}

export async function createTicket(input: CreateTicketInput, now = Date.now()): Promise<Ticket> {
  const number = FIRST_NUMBER + Number(await kv.incr(SEQ));
  const t: Ticket = {
    id: input.id ?? newId(),
    number,
    subject: input.subject,
    category: input.category,
    priority: input.priority ?? "normal",
    status: "new",
    userId: input.userId,
    email: input.email.toLowerCase(),
    name: input.name,
    source: input.source,
    ...(input.chatRef ? { chatRef: input.chatRef } : {}),
    assigneeId: null,
    assigneeEmail: null,
    tags: [],
    preview: input.body.slice(0, 300),
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    firstResponseAt: null,
    resolvedAt: null,
    closedAt: null,
    lastUserMessageAt: now,
    lastAgentMessageAt: null,
  };
  await saveTicket(t);
  await appendMessage(t, {
    author: input.firstAuthor?.author ?? "user",
    authorName: input.firstAuthor?.name ?? input.name,
    body: input.body,
    attachments: input.attachments ?? [],
  }, now);
  return t;
}

/** The conversation, oldest first. Never includes internal notes. */
export async function listMessages(id: string): Promise<TicketMessage[]> {
  const raw = ((await kv.lrange(msgsKey(id), 0, -1)) ?? []) as unknown[];
  return raw
    .map((r) => parse<TicketMessage>(r))
    .filter((m): m is TicketMessage => !!m)
    .reverse();
}

/** Adds to the conversation and saves the ticket's counters. */
export async function appendMessage(
  t: Ticket,
  m: Omit<TicketMessage, "id" | "ts">,
  now = Date.now(),
): Promise<TicketMessage> {
  const msg: TicketMessage = { id: newId(), ts: now, ...m };
  await kv.lpush(msgsKey(t.id), JSON.stringify(msg));
  t.messageCount += 1;
  t.updatedAt = now;
  if (m.author === "user") t.lastUserMessageAt = now;
  if (m.author === "agent") {
    t.lastAgentMessageAt = now;
    if (t.firstResponseAt == null) t.firstResponseAt = now;
  }
  await saveTicket(t);
  return msg;
}

export async function listNotes(id: string): Promise<InternalNote[]> {
  const raw = ((await kv.lrange(notesKey(id), 0, -1)) ?? []) as unknown[];
  return raw
    .map((r) => parse<InternalNote>(r))
    .filter((n): n is InternalNote => !!n)
    .reverse();
}

export async function addNote(t: Ticket, author: { userId: string; email: string }, body: string, now = Date.now()): Promise<InternalNote> {
  const note: InternalNote = { id: newId(), ts: now, authorId: author.userId, authorEmail: author.email, body };
  await kv.lpush(notesKey(t.id), JSON.stringify(note));
  t.updatedAt = now;
  await saveTicket(t);
  return note;
}

/** Moves a ticket to `status`, keeping the resolved / closed timestamps true. Does not save. */
export function applyStatus(t: Ticket, status: TicketStatus, now = Date.now()): void {
  if (t.status === status) return;
  t.status = status;
  t.updatedAt = now;
  if (status === "resolved") t.resolvedAt = now;
  if (status === "closed") {
    t.closedAt = now;
    t.resolvedAt ??= now;
  }
  if (isUnresolved(status)) {
    t.resolvedAt = null;
    t.closedAt = null;
  }
}

/* ------------------------------- response times ------------------------------ */

export async function getSla(): Promise<SlaConfig> {
  const raw = parse<SlaConfig>(await kv.get(SLA));
  return raw ? cleanSla(raw) : DEFAULT_SLA;
}

export async function saveSla(config: SlaConfig): Promise<void> {
  await kv.set(SLA, JSON.stringify(config));
}

/* ------------------------------ the desk's query ------------------------------ */

export const SORTS = ["updated", "created", "priority", "number", "due"] as const;
export type TicketSort = (typeof SORTS)[number];

export interface TicketQuery {
  q?: string;
  status?: TicketStatus | "unresolved";
  priority?: TicketPriority;
  category?: TicketCategory;
  /** A user id, "me" (resolved by the route), or "none" for unassigned. */
  assignee?: string;
  overdue?: boolean;
  sort?: TicketSort;
  dir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

const PRIORITY_RANK: Record<TicketPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export function queryTickets(all: Ticket[], query: TicketQuery, config: SlaConfig, now: number) {
  const q = query.q?.trim().toLowerCase() ?? "";
  const num = q.replace(/^#/, "");
  const withSla = all.map((t) => ({ ...t, sla: slaFor(t, config, now) }));
  const items = withSla.filter((t) => {
    if (query.status === "unresolved" ? !isUnresolved(t.status) : query.status && t.status !== query.status) return false;
    if (query.priority && t.priority !== query.priority) return false;
    if (query.category && t.category !== query.category) return false;
    if (query.assignee === "none" ? t.assigneeId : query.assignee && t.assigneeId !== query.assignee) return false;
    if (query.overdue && !t.sla.overdue) return false;
    if (q) {
      if (/^\d+$/.test(num) && String(t.number) === num) return true;
      const hay = `${t.subject} ${t.email} ${t.name} ${t.preview} ${t.tags.join(" ")} ${t.chatRef ?? ""}`.toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const dir = query.dir === "asc" ? 1 : -1;
  const sort = query.sort ?? "updated";
  const key = (t: (typeof withSla)[number]): number =>
    sort === "created"
      ? t.createdAt
      : sort === "priority"
        ? PRIORITY_RANK[t.priority] * 1e13 + (1e13 - t.createdAt)
        : sort === "number"
          ? t.number
          : sort === "due"
            ? (t.sla.nextDue ?? Number.MAX_SAFE_INTEGER)
            : t.updatedAt;
  items.sort((a, b) => (key(a) - key(b)) * dir || b.number - a.number);
  const limit = Math.max(1, Math.min(query.limit ?? 25, 100));
  const pages = Math.max(1, Math.ceil(items.length / limit));
  const page = Math.max(1, Math.min(query.page ?? 1, pages));
  return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, pages, limit };
}

/* -------------------------------- rate limits -------------------------------- */

/** How many of each the user-facing routes accept per hour. */
export const INTAKE_LIMITS = { guestPerIp: 5, guestPerEmail: 3, userPerHour: 10, repliesPerHour: 30 } as const;

/**
 * Counts one more hit in a fixed window. `ok` false once more than `limit`
 * arrived in this window; `retryAfter` is seconds until it rolls over.
 */
export async function hitRateLimit(bucket: string, limit: number, windowSec: number, now = Date.now()) {
  const windowId = Math.floor(now / (windowSec * 1000));
  const key = rlKey(`${bucket}:${windowId}`);
  const count = Number(await kv.incr(key));
  if (count === 1) await kv.expire(key, windowSec + 5);
  const retryAfter = Math.ceil(((windowId + 1) * windowSec * 1000 - now) / 1000);
  return { ok: count <= limit, count, retryAfter };
}

/* -------------------------------- attachments -------------------------------- */

// One file a message. Size and types are set in the admin area (Content >
// Limits, kind "support"); these are the defaults until changed.
/** 5 MB a file. */
export const SUPPORT_UPLOAD_MAX_BYTES = DEFAULT_UPLOAD_RULES.support.maxBytes;

/** Screenshots, PDFs and text — enough to show a problem; nothing executable. */
export const SUPPORT_UPLOAD_ALLOWED = new Set<string>(DEFAULT_UPLOAD_RULES.support.mimes);

type Uploader = (key: string, body: Uint8Array, contentType: string) => Promise<void>;
let uploader: Uploader | null = null;

/** Tests swap the R2 upload for a recorder. */
export function __setSupportUploader(fn: Uploader | null): void {
  uploader = fn;
}

export function attachmentStorageReady(): boolean {
  return uploader != null || isR2Configured();
}

function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || "file";
  return base.replace(/[^\w. \-]+/g, "_").replace(/^\.+/, "").slice(0, 100) || "file";
}

export type AttachmentCheck =
  | { ok: true; file: File }
  | { ok: false; error: "too_large" | "unsupported_type" | "empty_file"; message: string };

/** The size and type rule in force (admin area, Content > Limits), checked by the server. */
export async function checkAttachment(file: File): Promise<AttachmentCheck> {
  const refusal = checkUpload(await uploadRule("support"), file);
  if (refusal) return { ok: false, error: refusal.error, message: refusal.message };
  return { ok: true, file };
}

export async function storeAttachment(ticketId: string, file: File): Promise<SupportAttachment> {
  const name = safeName(file.name || "file");
  const key = `support/${ticketId}/${newId(6)}-${name}`;
  const body = new Uint8Array(await file.arrayBuffer());
  const type = file.type.toLowerCase();
  if (uploader) await uploader(key, body, type);
  else await putObject(key, body, type, { cacheControl: "private, max-age=0" });
  return { key, name, size: file.size, type };
}

/** What the browser gets for an attachment: a short-lived link, never the key. */
export async function presentAttachments(list: SupportAttachment[]) {
  return Promise.all(
    list.map(async (a) => {
      let url: string | null = null;
      try {
        url = await signGetUrl(a.key, 15 * 60);
      } catch {
        url = null;
      }
      return { name: a.name, size: a.size, type: a.type, url };
    }),
  );
}

/* ------------------------------ data retention ------------------------------ */
// For account deletion and the retention settings (admin data governance).

type Deleter = (key: string) => Promise<void>;
let deleter: Deleter | null = null;

/** Tests record R2 deletes instead of making them. */
export function __setSupportDeleter(fn: Deleter | null): void {
  deleter = fn;
}

/** Deletes each object; returns how many went. A failure is logged, not thrown. */
async function deleteAttachments(list: SupportAttachment[]): Promise<number> {
  let n = 0;
  for (const a of list) {
    try {
      await (deleter ?? deleteObject)(a.key);
      // The admin file index (Content): the attachment is gone.
      await indexDeleted(a.key);
      n++;
    } catch (err) {
      console.error("[support] attachment delete failed", a.key, err);
    }
  }
  return n;
}

async function rewriteMessages(id: string, list: TicketMessage[]): Promise<void> {
  await kv.del(msgsKey(id));
  // listMessages() is oldest first; LPUSH of each in turn leaves the newest at the head.
  for (const m of list) await kv.lpush(msgsKey(id), JSON.stringify(m));
}

export const DELETED_USER = "Deleted user";

/**
 * When an account is deleted: its tickets lose who sent them (user id,
 * email, name) and the files they attached, and keep the text, support's
 * replies and internal notes, so the support history still reads.
 */
export async function anonymiseTicketsForAccount(userId: string, emails: string[]): Promise<{ tickets: number; attachments: number }> {
  const mine = ticketsForAccount(await listTickets(), userId || null, emails);
  let attachments = 0;
  for (const t of mine) {
    const msgs = await listMessages(t.id);
    const next: TicketMessage[] = [];
    for (const m of msgs) {
      if (m.author !== "user") {
        next.push(m);
        continue;
      }
      attachments += await deleteAttachments(m.attachments ?? []);
      next.push({ ...m, authorName: DELETED_USER, attachments: [] });
    }
    await rewriteMessages(t.id, next);
    t.userId = null;
    t.email = "";
    t.name = DELETED_USER;
    await saveTicket(t);
  }
  return { tickets: mine.length, attachments };
}

/** Retention: deletes closed tickets closed before `ts` — the ticket, its conversation, notes and files. */
export async function purgeTicketsClosedBefore(ts: number): Promise<{ tickets: number }> {
  const old = (await listTickets()).filter((t) => t.status === "closed" && t.closedAt != null && t.closedAt < ts);
  for (const t of old) {
    for (const m of await listMessages(t.id)) await deleteAttachments(m.attachments ?? []);
    await kv.del(msgsKey(t.id));
    await kv.del(notesKey(t.id));
    await kv.hdel(TICKETS, t.id);
  }
  return { tickets: old.length };
}
