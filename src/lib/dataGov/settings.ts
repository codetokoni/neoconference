// src/lib/dataGov/settings.ts
//
// How long each kind of data is kept. Pure data plus the KV record:
//
//   neo:data:retention   JSON { values: { [category]: days | null }, updatedAt, updatedBy }
//
// `null` means "keep until deleted" where a category allows it. Changing a
// value needs data:delete and a fresh code, and goes through the bulk
// preview (src/lib/admin/bulk.ts) so the administrator sees what the change
// would affect before it is saved. Nothing is deleted by saving a value:
// purges are a separate, previewed action (src/lib/dataGov/purge.ts).

import { kv } from "@/lib/kv";

const KEY = "neo:data:retention";
const DAY = 24 * 60 * 60 * 1000;

export type RetentionCategory =
  | "accounts"
  | "trash"
  | "files"
  | "activity"
  | "notifications"
  | "tickets"
  | "backups"
  | "audit";

export interface RetentionDef {
  id: RetentionCategory;
  label: string;
  /** What the period is measured from and what happens when it ends. */
  meaning: string;
  defaultDays: number | null;
  minDays: number;
  maxDays: number;
  /** Whether "keep until deleted" (null) is allowed. */
  allowForever: boolean;
}

export const RETENTION: RetentionDef[] = [
  {
    id: "accounts",
    label: "Deleted accounts",
    meaning:
      "Grace period between a deletion request and the account being purged. The person (or an administrator) can cancel until it ends; then the request is due and an administrator completes it.",
    defaultDays: 30,
    minDays: 7,
    maxDays: 365,
    allowForever: false,
  },
  {
    id: "trash",
    label: "Trash (recoverable deletion)",
    meaning: "How long deleted meetings, recordings, groups and uploaded files can be restored by an administrator before they are purged for good.",
    defaultDays: 30,
    minDays: 1,
    maxDays: 365,
    allowForever: false,
  },
  {
    id: "files",
    label: "Files and recordings",
    meaning: "Recordings and uploaded files older than this are purged. Off by default: files are kept until their owner deletes them.",
    defaultDays: null,
    minDays: 30,
    maxDays: 3650,
    allowForever: true,
  },
  {
    id: "activity",
    label: "Raw activity logs",
    meaning: "Individual activity events (analytics). Daily totals are kept separately. The analytics store's own expiry (ACTIVITY_RETENTION_DAYS) is the ceiling.",
    defaultDays: 90,
    minDays: 7,
    maxDays: 400,
    allowForever: false,
  },
  {
    id: "notifications",
    label: "Notification history",
    meaning: "In-app notifications (the bell) older than this are removed. Each person's list also keeps at most the newest 100.",
    defaultDays: 365,
    minDays: 7,
    maxDays: 3650,
    allowForever: true,
  },
  {
    id: "tickets",
    label: "Support tickets",
    meaning: "Closed support tickets, their messages and attachments, measured from when they were closed.",
    defaultDays: null,
    minDays: 90,
    maxDays: 3650,
    allowForever: true,
  },
  {
    id: "backups",
    label: "Backups",
    meaning: "KV snapshots in R2 older than this are removed. Backups hold deleted accounts' data until they age out, so this bounds how long a deletion takes to reach them.",
    defaultDays: 14,
    minDays: 1,
    maxDays: 365,
    allowForever: false,
  },
  {
    id: "audit",
    label: "Admin audit trail",
    meaning: "What administrators did. Kept forever by default; can be limited to no less than one year. Whole months older than the period are removed.",
    defaultDays: null,
    minDays: 365,
    maxDays: 3650,
    allowForever: true,
  },
];

export function retentionDef(id: string): RetentionDef | undefined {
  return RETENTION.find((r) => r.id === id);
}

export type RetentionValues = Record<RetentionCategory, number | null>;

export interface RetentionRecord {
  values: RetentionValues;
  updatedAt: number | null;
  updatedBy: string | null;
}

export function defaultValues(): RetentionValues {
  return Object.fromEntries(RETENTION.map((r) => [r.id, r.defaultDays])) as RetentionValues;
}

/** A value an administrator asked for, checked against the category's bounds. */
export function checkValue(def: RetentionDef, v: unknown): { ok: true; days: number | null } | { ok: false; message: string } {
  if (v === null || v === "forever") {
    return def.allowForever ? { ok: true, days: null } : { ok: false, message: `${def.label} must have a period.` };
  }
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isInteger(n)) return { ok: false, message: "Give a whole number of days." };
  if (n < def.minDays || n > def.maxDays) return { ok: false, message: `${def.label}: between ${def.minDays} and ${def.maxDays} days.` };
  return { ok: true, days: n };
}

export async function getRetention(): Promise<RetentionRecord> {
  let raw: unknown = await kv.get(KEY);
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const rec = (raw && typeof raw === "object" ? raw : {}) as Partial<RetentionRecord>;
  const values = defaultValues();
  for (const def of RETENTION) {
    const v = rec.values?.[def.id];
    if (v === undefined) continue;
    const c = checkValue(def, v);
    if (c.ok) values[def.id] = c.days;
  }
  return { values, updatedAt: rec.updatedAt ?? null, updatedBy: rec.updatedBy ?? null };
}

export async function retentionDays(id: RetentionCategory): Promise<number | null> {
  return (await getRetention()).values[id];
}

export async function saveRetentionValue(id: RetentionCategory, days: number | null, by: string): Promise<RetentionRecord> {
  const cur = await getRetention();
  const next: RetentionRecord = { values: { ...cur.values, [id]: days }, updatedAt: Date.now(), updatedBy: by };
  await kv.set(KEY, JSON.stringify(next));
  return next;
}

/** The moment before which data of this category is past its period; null = kept. */
export function cutoffFor(days: number | null, now = Date.now()): number | null {
  return days == null ? null : now - days * DAY;
}

export const DAY_MS = DAY;
