// src/lib/support/model.ts
//
// Customer support: tickets, their response-time targets, and help-centre
// articles. Pure data and arithmetic — safe for client components, which use
// it to label statuses and draw SLA badges. Storage is in tickets.ts and
// help.ts; the routes are what enforce who may read what.

export const TICKET_STATUSES = ["new", "open", "pending_user", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const STATUS_LABEL: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  pending_user: "Waiting on user",
  resolved: "Resolved",
  closed: "Closed",
};

/** Statuses where the ticket still needs something from support. */
export function isUnresolved(s: TicketStatus): boolean {
  return s === "new" || s === "open" || s === "pending_user";
}

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const TICKET_CATEGORIES = [
  { key: "account", label: "Account and sign-in" },
  { key: "billing", label: "Plans and billing" },
  { key: "meetings", label: "Meetings and joining" },
  { key: "recording", label: "Recordings and replays" },
  { key: "translation", label: "Live translation and captions" },
  { key: "technical", label: "Something is broken" },
  { key: "other", label: "Something else" },
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number]["key"];

export function isTicketStatus(v: unknown): v is TicketStatus {
  return typeof v === "string" && (TICKET_STATUSES as readonly string[]).includes(v);
}
export function isTicketPriority(v: unknown): v is TicketPriority {
  return typeof v === "string" && (TICKET_PRIORITIES as readonly string[]).includes(v);
}
export function isTicketCategory(v: unknown): v is TicketCategory {
  return typeof v === "string" && TICKET_CATEGORIES.some((c) => c.key === v);
}
export function categoryLabel(key: string): string {
  return TICKET_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

export interface SupportAttachment {
  /** R2 object key. Never sent to the browser; the routes sign a URL instead. */
  key: string;
  name: string;
  size: number;
  type: string;
}

/** Where a ticket came from. "chat" = an agent copied a NeoSupport chat into a ticket. */
export type TicketSource = "web" | "guest" | "chat" | "agent";

export interface Ticket {
  id: string;
  /** Human number, shown as #1042. */
  number: number;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  /** Clerk user id, or null for a visitor who was not signed in. */
  userId: string | null;
  /** Where replies are emailed. Lower-cased. */
  email: string;
  name: string;
  source: TicketSource;
  /** A NeoSupport conversation reference, when converted from a chat. */
  chatRef?: string;
  assigneeId: string | null;
  assigneeEmail: string | null;
  tags: string[];
  /** The first 300 characters of the description, for search and the list. */
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  /** First public reply from support. */
  firstResponseAt: number | null;
  resolvedAt: number | null;
  closedAt: number | null;
  lastUserMessageAt: number | null;
  lastAgentMessageAt: number | null;
}

/** A message the user can see: theirs, support's public replies, and status notes. */
export interface TicketMessage {
  id: string;
  ts: number;
  author: "user" | "agent" | "system";
  authorName: string;
  body: string;
  attachments: SupportAttachment[];
}

/** Support's internal note. Stored apart from the conversation; only the admin API reads it. */
export interface InternalNote {
  id: string;
  ts: number;
  authorId: string;
  authorEmail: string;
  body: string;
}

/* ----------------------------- response times ----------------------------- */

export interface SlaTarget {
  /** Hours from creation to support's first public reply. */
  firstResponseHours: number;
  /** Hours from creation to resolved. */
  resolutionHours: number;
}

export type SlaConfig = Record<TicketPriority, SlaTarget>;

export const DEFAULT_SLA: SlaConfig = {
  urgent: { firstResponseHours: 1, resolutionHours: 8 },
  high: { firstResponseHours: 4, resolutionHours: 24 },
  normal: { firstResponseHours: 8, resolutionHours: 72 },
  low: { firstResponseHours: 24, resolutionHours: 120 },
};

const HOUR = 60 * 60 * 1000;

export interface SlaState {
  firstResponseDue: number;
  resolutionDue: number;
  /** Time to first public reply, once there is one. */
  firstResponseMs: number | null;
  /** Time to resolution, once resolved or closed. */
  resolutionMs: number | null;
  /** Unresolved and past the first-response target with no reply yet. */
  firstResponseOverdue: boolean;
  /** Unresolved and past the resolution target. */
  resolutionOverdue: boolean;
  overdue: boolean;
  /** The reply came, but after the target. */
  firstResponseBreached: boolean;
  /** The next deadline that still matters, for sorting; null once resolved. */
  nextDue: number | null;
}

/**
 * Where a ticket stands against its targets at `now`. The clocks run in
 * wall-clock hours from when the ticket was opened, and do not pause while
 * waiting on the user — a target is a promise about the whole ticket.
 */
export function slaFor(
  t: Pick<Ticket, "priority" | "status" | "createdAt" | "firstResponseAt" | "resolvedAt" | "closedAt">,
  config: SlaConfig,
  now: number,
): SlaState {
  const target = config[t.priority] ?? DEFAULT_SLA[t.priority];
  const firstResponseDue = t.createdAt + target.firstResponseHours * HOUR;
  const resolutionDue = t.createdAt + target.resolutionHours * HOUR;
  const open = isUnresolved(t.status);
  const doneAt = t.resolvedAt ?? t.closedAt ?? null;
  const firstResponseOverdue = open && t.firstResponseAt == null && now > firstResponseDue;
  const resolutionOverdue = open && now > resolutionDue;
  return {
    firstResponseDue,
    resolutionDue,
    firstResponseMs: t.firstResponseAt != null ? t.firstResponseAt - t.createdAt : null,
    resolutionMs: !open && doneAt != null ? doneAt - t.createdAt : null,
    firstResponseOverdue,
    resolutionOverdue,
    overdue: firstResponseOverdue || resolutionOverdue,
    firstResponseBreached: t.firstResponseAt != null && t.firstResponseAt > firstResponseDue,
    nextDue: !open ? null : t.firstResponseAt == null ? Math.min(firstResponseDue, resolutionDue) : resolutionDue,
  };
}

/** Accepts only whole, positive hours up to a year; anything else keeps the old value. */
export function cleanSla(input: unknown, fallback: SlaConfig = DEFAULT_SLA): SlaConfig {
  const out = {} as SlaConfig;
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 24 * 366;
  for (const p of TICKET_PRIORITIES) {
    const row = (src[p] && typeof src[p] === "object" ? src[p] : {}) as Record<string, unknown>;
    out[p] = {
      firstResponseHours: ok(row.firstResponseHours) ? Number(row.firstResponseHours) : fallback[p].firstResponseHours,
      resolutionHours: ok(row.resolutionHours) ? Number(row.resolutionHours) : fallback[p].resolutionHours,
    };
  }
  return out;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface SupportSummary {
  openByPriority: Record<TicketPriority, number>;
  open: number;
  unassigned: number;
  overdue: number;
  /** Median ms to first reply, for tickets first answered in the last 7 days. */
  medianFirstResponseThisWeek: number | null;
  /** The same for the 7 days before that. */
  medianFirstResponseLastWeek: number | null;
  answeredThisWeek: number;
  answeredLastWeek: number;
}

export function summarize(tickets: Ticket[], config: SlaConfig, now: number): SupportSummary {
  const WEEK = 7 * 24 * HOUR;
  const openByPriority = { low: 0, normal: 0, high: 0, urgent: 0 } as Record<TicketPriority, number>;
  let open = 0;
  let unassigned = 0;
  let overdue = 0;
  const thisWeek: number[] = [];
  const lastWeek: number[] = [];
  for (const t of tickets) {
    if (isUnresolved(t.status)) {
      open++;
      openByPriority[t.priority]++;
      if (!t.assigneeId) unassigned++;
      if (slaFor(t, config, now).overdue) overdue++;
    }
    if (t.firstResponseAt != null) {
      const ms = t.firstResponseAt - t.createdAt;
      if (t.firstResponseAt > now - WEEK && t.firstResponseAt <= now) thisWeek.push(ms);
      else if (t.firstResponseAt > now - 2 * WEEK && t.firstResponseAt <= now - WEEK) lastWeek.push(ms);
    }
  }
  return {
    openByPriority,
    open,
    unassigned,
    overdue,
    medianFirstResponseThisWeek: median(thisWeek),
    medianFirstResponseLastWeek: median(lastWeek),
    answeredThisWeek: thisWeek.length,
    answeredLastWeek: lastWeek.length,
  };
}

/** "3 h 20 min", "2 d 4 h", "45 min". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const neg = ms < 0;
  let m = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const parts = d ? [`${d} d`, h ? `${h} h` : ""] : h ? [`${h} h`, m ? `${m} min` : ""] : [`${m} min`];
  return (neg ? "-" : "") + parts.filter(Boolean).join(" ");
}

/* --------------------------------- help centre -------------------------------- */

export const HELP_CATEGORIES = [
  { key: "getting-started", label: "Getting started" },
  { key: "meetings", label: "Meetings" },
  { key: "recording", label: "Recording and replays" },
  { key: "translation", label: "Translation and captions" },
  { key: "account", label: "Account and sign-in" },
  { key: "billing", label: "Plans and billing" },
  { key: "troubleshooting", label: "Troubleshooting" },
] as const;
export type HelpCategory = (typeof HELP_CATEGORIES)[number]["key"];

export const HELP_KINDS = ["article", "faq", "troubleshooting"] as const;
export type HelpKind = (typeof HELP_KINDS)[number];
export const HELP_KIND_LABEL: Record<HelpKind, string> = { article: "Article", faq: "FAQ", troubleshooting: "Troubleshooting guide" };

export function isHelpCategory(v: unknown): v is HelpCategory {
  return typeof v === "string" && HELP_CATEGORIES.some((c) => c.key === v);
}
export function helpCategoryLabel(key: string): string {
  return HELP_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

export interface HelpArticle {
  id: string;
  slug: string;
  title: string;
  /** One or two sentences, shown in lists and as the page description. */
  summary: string;
  /** Light markdown: ## headings, - lists, 1. lists, **bold**, `code`, [links](/x). */
  body: string;
  category: HelpCategory;
  kind: HelpKind;
  status: "draft" | "published";
  tags: string[];
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  createdBy: string;
  updatedBy: string;
}

/** Which ticket categories a help category answers, for suggestions on the contact form. */
const HELP_FOR_TICKET: Record<TicketCategory, HelpCategory[]> = {
  account: ["account", "getting-started"],
  billing: ["billing"],
  meetings: ["meetings", "getting-started", "troubleshooting"],
  recording: ["recording"],
  translation: ["translation"],
  technical: ["troubleshooting", "meetings"],
  other: [],
};

const STOP = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "it", "my", "i", "can", "how", "do", "does", "not", "with", "what", "why", "when", "me", "be", "are", "this", "that"]);

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * How well an article answers some text. Title and tag hits count most, then
 * the summary, then the body; a matching category adds a little.
 */
export function scoreArticle(a: Pick<HelpArticle, "title" | "summary" | "body" | "tags" | "category">, query: string, ticketCategory?: string): number {
  const q = [...new Set(words(query))];
  if (!q.length) return 0;
  const title = new Set(words(a.title));
  const tags = new Set(a.tags.flatMap((t) => words(t)));
  const summary = new Set(words(a.summary));
  const body = new Set(words(a.body));
  let score = 0;
  for (const w of q) {
    const prefix = (s: Set<string>) => [...s].some((x) => x.startsWith(w) || (x.length > 3 && w.startsWith(x)));
    if (title.has(w)) score += 6;
    else if (w.length > 2 && prefix(title)) score += 3;
    if (tags.has(w)) score += 5;
    if (summary.has(w)) score += 3;
    if (body.has(w)) score += 1;
  }
  if (score > 0 && ticketCategory && isTicketCategory(ticketCategory) && HELP_FOR_TICKET[ticketCategory].includes(a.category)) score += 2;
  return score;
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "article"
  );
}
