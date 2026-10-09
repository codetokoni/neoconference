// src/lib/dataGov/purge.ts
//
// What each retention period removes once it has passed — found exactly
// (preview) and removed (run). Purges are never automatic: an administrator
// previews one and applies it through the bulk pattern (src/lib/admin/bulk.ts),
// so what runs is what was shown. Deleted accounts are not purged here:
// a due deletion request is completed (src/lib/dataGov/erase.ts).
//
// Categories whose store is added by another admin phase (activity,
// tickets, backups) say so and offer nothing until that phase is on main.

import { kv } from "@/lib/kv";
import { deleteObject } from "@/lib/r2";
import type { BulkRecord } from "@/lib/admin/bulk";
import { cutoffFor, DAY_MS, getRetention, type RetentionCategory } from "@/lib/dataGov/settings";
import { expiresAt, listTrash, purgeTrashItem, trashWindowMs, type TrashItem } from "@/lib/dataGov/trash";
import { EXPORT_R2_PREFIX } from "@/lib/dataGov/export";
import { listPrefix, parseJson, rewriteList, scanKeys } from "@/lib/dataGov/util";
import { purgeAuditMonths } from "@/lib/admin/audit";

export type PurgeCategory = Exclude<RetentionCategory, "accounts"> | "exports";

export interface PurgeRecord extends BulkRecord {
  /** Size in bytes, where it is a file. */
  bytes?: number;
  /** How many entries inside the record would go (e.g. notifications in one list). */
  entries?: number;
}

export interface PurgeDef {
  id: PurgeCategory;
  label: string;
  /** Null when it can run; otherwise why not. */
  unavailable: (days: number | null) => string | null;
  find: (days: number | null, now: number) => Promise<PurgeRecord[]>;
  remove: (records: PurgeRecord[], days: number | null, now: number) => Promise<{ removed: number; bytes: number }>;
}

/** Files older than the files period: recordings, meeting and group chat uploads. */
const FILE_PREFIXES = ["recordings/", "chat/", "groups/"];
export const EXPORT_KEEP_DAYS = 7;

const notAvailable = (phase: string) => () => `Arrives with ${phase}; the setting is kept until then.`;

export const PURGES: PurgeDef[] = [
  {
    id: "trash",
    label: "Trash past its restore window",
    unavailable: () => null,
    find: async (_days, now) => {
      const win = await trashWindowMs();
      return (await listTrash({ includeRestored: true }))
        // Restored items leave a record behind; it goes after the same window.
        .filter((t) => expiresAt(t, win) <= now)
        .map((t) => ({
          id: t.id,
          fingerprint: `${t.deletedAt}:${t.restoredAt ?? ""}`,
          bytes: t.r2.reduce((a, o) => a + (o.size ?? 0), 0),
          view: { kind: t.kind, label: t.label, deletedAt: t.deletedAt, restored: !!t.restoredAt },
        }));
    },
    remove: async (records) => {
      let removed = 0;
      for (const r of records) {
        const item = parseJson<TrashItem>(await kv.hget("neo:trash:items", r.id));
        if (!item) continue;
        await purgeTrashItem(item);
        removed++;
      }
      return { removed, bytes: records.reduce((a, r) => a + (r.bytes ?? 0), 0) };
    },
  },
  {
    id: "files",
    label: "Recordings and uploaded files past the files period",
    unavailable: (days) => (days == null ? "Files are kept until their owner deletes them (no period set)." : null),
    find: async (days, now) => {
      const cutoff = cutoffFor(days, now);
      if (cutoff == null) return [];
      const out: PurgeRecord[] = [];
      for (const pre of FILE_PREFIXES) {
        for (const o of await listPrefix(pre)) {
          const at = o.lastModified ? Date.parse(o.lastModified) : NaN;
          if (!Number.isFinite(at) || at >= cutoff) continue;
          out.push({ id: o.key, fingerprint: `${o.size}:${o.lastModified}`, bytes: o.size, view: { key: o.key, size: o.size, lastModified: o.lastModified } });
        }
      }
      return out;
    },
    remove: async (records) => {
      let removed = 0;
      let bytes = 0;
      for (const r of records) {
        await deleteObject(r.id);
        removed++;
        bytes += r.bytes ?? 0;
      }
      return { removed, bytes };
    },
  },
  {
    id: "notifications",
    label: "In-app notifications past the notification period",
    unavailable: (days) => (days == null ? "Notifications are kept (each list holds the newest 100)." : null),
    find: async (days, now) => {
      const cutoff = cutoffFor(days, now);
      if (cutoff == null) return [];
      const out: PurgeRecord[] = [];
      for (const k of await scanKeys("neo:notif:*")) {
        if (k.endsWith(":unread")) continue;
        const raw = ((await kv.lrange(k, 0, -1)) ?? []) as unknown[];
        const old = raw.filter((r) => (parseJson<{ ts?: number }>(r)?.ts ?? Infinity) < cutoff).length;
        if (old) out.push({ id: k, fingerprint: `${raw.length}:${old}`, entries: old, view: { list: k.replace(/^neo:notif:/, "user "), entries: old } });
      }
      return out;
    },
    remove: async (records, days, now) => {
      const cutoff = cutoffFor(days, now) ?? 0;
      let removed = 0;
      for (const r of records) {
        const raw = ((await kv.lrange(r.id, 0, -1)) ?? []) as unknown[];
        const keep = raw.filter((x) => (parseJson<{ ts?: number }>(x)?.ts ?? Infinity) >= cutoff);
        removed += raw.length - keep.length;
        await rewriteList(r.id, keep);
        // The bell's counter is recounted from what is left.
        await kv.set(`${r.id}:unread`, keep.filter((x) => !parseJson<{ read?: boolean }>(x)?.read).length);
      }
      return { removed, bytes: 0 };
    },
  },
  {
    id: "audit",
    label: "Admin audit months older than the audit period",
    unavailable: (days) => (days == null ? "The audit trail is kept forever (the default)." : null),
    find: async (days, now) => {
      const cutoff = cutoffFor(days, now);
      if (cutoff == null) return [];
      // Whole months only, and only months entirely before the cutoff.
      const cutoffMonth = new Date(cutoff).toISOString().slice(0, 7);
      const months = (((await kv.smembers("neo:admin:audit:months")) ?? []) as string[]).filter((m) => m < cutoffMonth).sort();
      const out: PurgeRecord[] = [];
      for (const m of months) {
        const n = Number(await kv.llen(`neo:admin:audit:${m}`));
        out.push({ id: m, fingerprint: String(n), entries: n, view: { month: m, entries: n } });
      }
      return out;
    },
    remove: async (records) => {
      const r = await purgeAuditMonths(records.map((x) => x.id));
      return { removed: r.entries, bytes: 0 };
    },
  },
  {
    id: "exports",
    label: `Data export files older than ${EXPORT_KEEP_DAYS} days`,
    unavailable: () => null,
    find: async (_days, now) => {
      const cutoff = now - EXPORT_KEEP_DAYS * DAY_MS;
      return (await listPrefix(EXPORT_R2_PREFIX))
        .filter((o) => o.lastModified && Date.parse(o.lastModified) < cutoff)
        .map((o) => ({ id: o.key, fingerprint: `${o.size}:${o.lastModified}`, bytes: o.size, view: { key: o.key, size: o.size, lastModified: o.lastModified } }));
    },
    remove: async (records) => {
      for (const r of records) await deleteObject(r.id);
      return { removed: records.length, bytes: records.reduce((a, r) => a + (r.bytes ?? 0), 0) };
    },
  },
  {
    id: "activity",
    label: "Raw activity events",
    unavailable: notAvailable("the analytics phase (activity log)"),
    find: async () => [],
    remove: async () => ({ removed: 0, bytes: 0 }),
  },
  {
    id: "tickets",
    label: "Closed support tickets",
    unavailable: notAvailable("the support phase (tickets)"),
    find: async () => [],
    remove: async () => ({ removed: 0, bytes: 0 }),
  },
  {
    id: "backups",
    label: "KV snapshots in R2",
    unavailable: notAvailable("the operations phase (backups)"),
    find: async () => [],
    remove: async () => ({ removed: 0, bytes: 0 }),
  },
];

export function purgeDef(id: string): PurgeDef | undefined {
  return PURGES.find((p) => p.id === id);
}

export async function daysFor(id: PurgeCategory): Promise<number | null> {
  if (id === "exports") return EXPORT_KEEP_DAYS;
  return (await getRetention()).values[id];
}
