// src/lib/content/model.ts
//
// Content, files and storage — the pure part, safe for client components:
// what a stored object is (FileRecord), how a storage key says what it is,
// the upload limits and the one check every upload route makes, and the
// problem kinds the admin "Problems" view reports. KV lives in ./files.ts,
// ./limits.ts and ./reports.ts.

import { CHAT_UPLOAD_ALLOWED, CHAT_UPLOAD_MAX_BYTES } from "@/lib/chatUploadRules";

/* ---------------------------------- files --------------------------------- */

export const CONTENT_TYPES = [
  { id: "recording", label: "Recordings" },
  { id: "recording_audio", label: "Recording audio" },
  { id: "transcript", label: "Transcripts" },
  { id: "chat_upload", label: "Meeting chat files" },
  { id: "group_upload", label: "Group chat files" },
  { id: "support_attachment", label: "Support attachments" },
  { id: "roster", label: "Roster spreadsheets" },
  { id: "system", label: "Platform files (logo, backups)" },
  { id: "other", label: "Other objects" },
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number]["id"];

export function isContentType(v: unknown): v is ContentType {
  return typeof v === "string" && CONTENT_TYPES.some((t) => t.id === v);
}

export function contentTypeLabel(t: ContentType): string {
  return CONTENT_TYPES.find((x) => x.id === t)?.label ?? t;
}

export type ProcessingStatus = "pending" | "processing" | "ready" | "failed";
export const PROCESSING_STATUSES: ProcessingStatus[] = ["pending", "processing", "ready", "failed"];

/** Who can reach the file's contents without an administrator. */
export type Visibility = "private" | "shared" | "public";
export const VISIBILITIES: Visibility[] = ["private", "shared", "public"];

/** Moderation state: hidden = unpublished from public pages; trashed = recoverable deletion. */
export type FileState = "active" | "hidden" | "trashed";

/** Where the bytes are: an R2 object, or a KV value (transcripts). */
export type Storage = "r2" | "kv";

export interface FileRecord {
  id: string;
  storage: Storage;
  /** The R2 key, or for KV content a stable key such as "transcript:<recording key>". */
  key: string;
  type: ContentType;
  /** The account the file belongs to (its folder, or whoever uploaded it). Null = unknown (an orphan). */
  ownerId: string | null;
  eventSlug?: string;
  groupId?: string;
  ticketId?: string;
  egressId?: string;
  /** For a transcript: the recording it transcribes. */
  recordingKey?: string;
  name?: string;
  size: number;
  contentType: string;
  /** "md5:<hex>" (an upload, or R2's single-part ETag) or "etag:<value>" (multipart). */
  checksum?: string;
  createdAt: number;
  updatedAt: number;
  status: ProcessingStatus;
  statusAt: number;
  statusDetail?: string;
  /** What the owner last chose (a share link makes "shared"). Recordings also follow their meeting's replay. */
  visibility: Visibility;
  state: FileState;
  stateAt?: number;
  stateById?: string;
  stateReason?: string;
  /** Recordings: when recording started (from the key) and stopped (egress), for overlap checks. */
  startedAt?: number;
  endedAt?: number;
  /** How the index learnt about it. "backfill" = found in R2 by the listing, not at its upload point. */
  source: "upload" | "egress" | "transcribe" | "backfill";
  /** When a complete backfill pass last saw the object in R2. */
  r2SeenAt?: number;
  /** Phase 11 trash item holding the file while it is trashed (src/lib/dataGov/trash.ts). */
  trashId?: string;
  /** The state it was in before the trash, so a restore puts it back. */
  trashedFrom?: FileState;
  /** Problem kinds an administrator chose to ignore for this file. */
  ignored?: ProblemKind[];
}

/** What a storage key says about the object (the layouts the app writes). */
export interface KeyFacts {
  type: ContentType;
  ownerId: string | null;
  eventSlug?: string;
  groupId?: string;
  ticketId?: string;
  name?: string;
  startedAt?: number;
}

/**
 * recordings/<uid>/<slug>/<yyyy-mm-dd-hh-mm-ss>.mp4   (+ .m4a / .m4a.mp4 audio sidecar)
 * chat/<uid>/<uuid>-<name>
 * groups/<gid>/<uuid>-<name>
 * support/<ticketId>/<id>-<name>
 * platform/logo-<ts>.<ext>, ops-backups/kv/<id>.json.gz   (the platform's own)
 */
export function classifyKey(key: string): KeyFacts {
  const parts = String(key || "").split("/");
  const last = parts[parts.length - 1] || "";
  if (parts[0] === "recordings" && parts.length === 4 && parts[1] && parts[2]) {
    const audio = /\.m4a(?:\.mp4)?$/i.test(key);
    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(last);
    const startedAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : undefined;
    return {
      type: audio ? "recording_audio" : /\.mp4$/i.test(key) ? "recording" : "other",
      ownerId: parts[1].startsWith("user_") ? parts[1] : null,
      eventSlug: parts[2],
      name: last,
      ...(startedAt && Number.isFinite(startedAt) ? { startedAt } : {}),
    };
  }
  const tail = (s: string) => s.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "").replace(/^[A-Za-z0-9_-]{4,12}-/, "");
  if (parts[0] === "chat" && parts.length === 3 && parts[1]) {
    return { type: "chat_upload", ownerId: parts[1].startsWith("user_") ? parts[1] : null, name: tail(last) };
  }
  if (parts[0] === "groups" && parts.length === 3 && parts[1]) {
    return { type: "group_upload", ownerId: null, groupId: parts[1], name: tail(last) };
  }
  // The platform's own files: the logo (settings) and KV backups (operations).
  if (parts[0] === "platform" || parts[0] === "ops-backups") return { type: "system", ownerId: null, name: last };
  if (parts[0] === "support" && parts.length === 3 && parts[1]) {
    return { type: "support_attachment", ownerId: null, ticketId: parts[1], name: tail(last) };
  }
  return { type: "other", ownerId: null, name: last };
}

/** A content type from a file name, for objects found without one. */
export function guessContentType(key: string): string {
  const ext = (key.split(".").pop() || "").toLowerCase();
  if (/\.m4a(?:\.mp4)?$/i.test(key)) return "audio/mp4";
  return KNOWN_FILE_TYPES.find((t) => (t.exts as readonly string[]).includes(ext))?.mime ?? (ext === "mp4" ? "video/mp4" : "application/octet-stream");
}

/** "md5:<hex>" for a plain ETag, "etag:<value>" for a multipart one. */
export function checksumFromEtag(etag: string | undefined | null): string | undefined {
  const e = String(etag || "").replace(/^W\//, "").replace(/"/g, "").trim();
  if (!e) return undefined;
  return /^[0-9a-f]{32}$/i.test(e) ? `md5:${e.toLowerCase()}` : `etag:${e}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/* ------------------------------ upload limits ----------------------------- */

/** The upload points whose limits an administrator sets. */
export const UPLOAD_KINDS = [
  { id: "chat", label: "Meeting chat attachments", route: "/api/chat/upload" },
  { id: "group", label: "Group chat attachments", route: "/api/groups/[id]/upload" },
  { id: "roster", label: "Roster spreadsheets", route: "/api/video/room/roster" },
  { id: "support", label: "Support ticket attachments", route: "/api/support/tickets" },
] as const;

export type UploadKind = (typeof UPLOAD_KINDS)[number]["id"];

export function isUploadKind(v: unknown): v is UploadKind {
  return typeof v === "string" && UPLOAD_KINDS.some((k) => k.id === v);
}

/**
 * The file types an administrator can allow. A closed list on purpose:
 * nothing executable or scriptable (exe, js, html, sh …) can be ticked.
 */
export const KNOWN_FILE_TYPES = [
  { mime: "image/jpeg", exts: ["jpg", "jpeg", "jpe", "jfif"], label: "JPEG image" },
  { mime: "image/png", exts: ["png"], label: "PNG image" },
  { mime: "image/gif", exts: ["gif"], label: "GIF image" },
  { mime: "image/webp", exts: ["webp"], label: "WebP image" },
  { mime: "image/svg+xml", exts: ["svg"], label: "SVG image" },
  { mime: "image/heic", exts: ["heic"], label: "HEIC photo" },
  { mime: "image/heif", exts: ["heif"], label: "HEIF photo" },
  { mime: "application/pdf", exts: ["pdf"], label: "PDF" },
  { mime: "application/msword", exts: ["doc"], label: "Word (old)" },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", exts: ["docx"], label: "Word" },
  { mime: "application/vnd.ms-excel", exts: ["xls"], label: "Excel (old)" },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", exts: ["xlsx"], label: "Excel" },
  { mime: "application/vnd.ms-powerpoint", exts: ["ppt"], label: "PowerPoint (old)" },
  { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", exts: ["pptx"], label: "PowerPoint" },
  { mime: "text/plain", exts: ["txt", "md", "log"], label: "Text" },
  { mime: "text/csv", exts: ["csv"], label: "CSV" },
  { mime: "application/json", exts: ["json"], label: "JSON" },
  { mime: "application/zip", exts: ["zip"], label: "ZIP archive" },
  { mime: "audio/mpeg", exts: ["mp3"], label: "MP3 audio" },
  { mime: "audio/mp4", exts: ["m4a"], label: "M4A audio" },
  { mime: "video/mp4", exts: ["mp4"], label: "MP4 video" },
] as const;

export type KnownMime = (typeof KNOWN_FILE_TYPES)[number]["mime"];

export function isKnownMime(v: unknown): v is KnownMime {
  return typeof v === "string" && KNOWN_FILE_TYPES.some((t) => t.mime === v);
}

export interface UploadRule {
  maxBytes: number;
  mimes: KnownMime[];
}

/** Vercel Functions take request bodies up to 100 MB, and these routes read the whole file into memory. */
export const MAX_UPLOAD_CEILING = 100 * 1024 * 1024;
export const MIN_UPLOAD_BYTES = 1024;

const CHAT_DEFAULT_MIMES: KnownMime[] = [...CHAT_UPLOAD_ALLOWED].filter(isKnownMime);

/** What each upload point accepted before limits were configurable (src/lib/chatUploadRules.ts, the roster parser). */
export const DEFAULT_UPLOAD_RULES: Record<UploadKind, UploadRule> = {
  chat: { maxBytes: CHAT_UPLOAD_MAX_BYTES, mimes: CHAT_DEFAULT_MIMES },
  group: { maxBytes: CHAT_UPLOAD_MAX_BYTES, mimes: CHAT_DEFAULT_MIMES },
  roster: {
    maxBytes: 5 * 1024 * 1024,
    mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "text/csv"],
  },
  // Screenshots, PDFs and text: enough to show a problem (src/lib/support/tickets.ts).
  support: { maxBytes: 5 * 1024 * 1024, mimes: ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"] },
};

/** Normalise a rule an administrator sent; null when it cannot be saved. */
export function cleanRule(input: unknown): UploadRule | { error: string } {
  const r = (input ?? {}) as { maxBytes?: unknown; mimes?: unknown };
  const maxBytes = typeof r.maxBytes === "number" && Number.isFinite(r.maxBytes) ? Math.round(r.maxBytes) : NaN;
  if (!(maxBytes >= MIN_UPLOAD_BYTES && maxBytes <= MAX_UPLOAD_CEILING)) {
    return { error: `The size limit must be between ${formatBytes(MIN_UPLOAD_BYTES)} and ${formatBytes(MAX_UPLOAD_CEILING)}.` };
  }
  if (!Array.isArray(r.mimes)) return { error: "Choose the file types to allow." };
  const unknown = r.mimes.filter((m) => !isKnownMime(m));
  if (unknown.length) return { error: `Not a file type that can be allowed: ${unknown.map(String).join(", ").slice(0, 120)}.` };
  const mimes = [...new Set(r.mimes as KnownMime[])];
  if (!mimes.length) return { error: "Allow at least one file type." };
  return { maxBytes, mimes };
}

export type UploadRefusal = {
  error: "empty_file" | "too_large" | "unsupported_type";
  status: 400 | 413 | 415;
  message: string;
  limit?: number;
  size?: number;
};

function allowedList(rule: UploadRule): string {
  const exts = rule.mimes.flatMap((m) => KNOWN_FILE_TYPES.find((t) => t.mime === m)?.exts.slice(0, 1) ?? []);
  return exts.map((e) => e.toUpperCase()).join(", ");
}

/**
 * The check every upload route makes, server-side, before storing a byte.
 * The declared type must be allowed, and a file name's extension must be
 * one of the allowed types' — a renamed .exe sent as image/png is refused.
 * (The extension may belong to another allowed type: Windows sends .csv as
 * application/vnd.ms-excel.) A file the browser gave no type is judged by
 * its extension alone.
 */
export function checkUpload(rule: UploadRule, file: { size: number; type?: string; name?: string }): UploadRefusal | null {
  if (!(file.size > 0)) return { error: "empty_file", status: 400, message: "That file is empty." };
  if (file.size > rule.maxBytes) {
    return {
      error: "too_large",
      status: 413,
      limit: rule.maxBytes,
      size: file.size,
      message: `This file is ${formatBytes(file.size)}. Files here can be up to ${formatBytes(rule.maxBytes)}.`,
    };
  }
  const mime = String(file.type || "").toLowerCase().split(";")[0].trim();
  const name = String(file.name || "");
  const ext = name.includes(".") ? (name.split(".").pop() || "").toLowerCase() : "";
  const allowedExts = new Set<string>(rule.mimes.flatMap((m) => [...(KNOWN_FILE_TYPES.find((t) => t.mime === m)?.exts ?? [])]));
  const untyped = mime === "" || mime === "application/octet-stream";
  const typeOk = untyped ? !!ext && allowedExts.has(ext) : (rule.mimes as string[]).includes(mime);
  const extOk = !ext || allowedExts.has(ext);
  if (!typeOk || !extOk) {
    const what = ext ? `.${ext} files` : "That type of file";
    return { error: "unsupported_type", status: 415, message: `${what} can't be uploaded here. Allowed: ${allowedList(rule)}.` };
  }
  return null;
}

/** The type to store an accepted file under: its own, or the one its extension names. */
export function storedMime(rule: UploadRule, file: { type?: string; name?: string }): string {
  const mime = String(file.type || "").toLowerCase().split(";")[0].trim();
  if (mime && mime !== "application/octet-stream") return mime;
  const ext = (String(file.name || "").split(".").pop() || "").toLowerCase();
  return rule.mimes.find((m) => (KNOWN_FILE_TYPES.find((t) => t.mime === m)?.exts as readonly string[] | undefined)?.includes(ext)) ?? "application/octet-stream";
}

/* -------------------------------- problems -------------------------------- */

export const PROBLEM_KINDS = [
  { id: "failed", label: "Failed uploads and processing" },
  { id: "stuck", label: "Stuck processing" },
  { id: "missing", label: "Missing in storage" },
  { id: "orphan", label: "Orphans (no owner)" },
  { id: "duplicate", label: "Likely duplicates" },
] as const;

export type ProblemKind = (typeof PROBLEM_KINDS)[number]["id"];

export function isProblemKind(v: unknown): v is ProblemKind {
  return typeof v === "string" && PROBLEM_KINDS.some((p) => p.id === v);
}

/** Minutes in pending/processing after which a file counts as stuck, per type. */
export const STUCK_MINUTES: Record<ContentType, number> = {
  // A recording is "processing" for as long as the meeting runs.
  recording: 12 * 60,
  recording_audio: 12 * 60,
  transcript: 60,
  chat_upload: 10,
  group_upload: 10,
  support_attachment: 10,
  roster: 10,
  system: 60,
  other: 60,
};

/** Overlapping time ranges (recordings of the same meeting made at once). */
export function overlaps(a: { startedAt?: number; endedAt?: number }, b: { startedAt?: number; endedAt?: number }): boolean {
  if (!a.startedAt || !b.startedAt) return false;
  const aEnd = a.endedAt ?? a.startedAt;
  const bEnd = b.endedAt ?? b.startedAt;
  return a.startedAt <= bEnd && b.startedAt <= aEnd;
}

/* ------------------------------- reports ---------------------------------- */

export const REPORT_REASONS = [
  { id: "spam", label: "Spam or scam" },
  { id: "harassment", label: "Harassment or hate" },
  { id: "violence", label: "Violence or threats" },
  { id: "sexual", label: "Sexual content" },
  { id: "copyright", label: "Copyright or trademark" },
  { id: "privacy", label: "Shares private information" },
  { id: "other", label: "Something else" },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["id"];

export function isReportReason(v: unknown): v is ReportReason {
  return typeof v === "string" && REPORT_REASONS.some((r) => r.id === v);
}

/** What a report can be about: a meeting's replay/listing, a share link, or one recording. */
export type ReportTargetType = "event" | "share" | "file";

export type CaseStatus = "open" | "actioned" | "dismissed";
