// src/lib/content/admin.ts
//
// What the /api/admin/content routes share: the index joined with each
// recording's meeting (for what a public link reaches), search and filters,
// storage totals, and who the owners are. Metadata only — nothing here
// reads a file's contents.

import { clerkClient } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import {
  PROCESSING_STATUSES,
  VISIBILITIES,
  isContentType,
  type ContentType,
  type FileRecord,
  type FileState,
  type ProcessingStatus,
  type Visibility,
} from "@/lib/content/model";
import { allFiles, effectiveVisibility } from "@/lib/content/files";
import type { NeoEvent } from "@/types/event";

export type FileRow = FileRecord & { effectiveVisibility: Visibility; eventName?: string };

/** Every indexed file, with what its public link reaches now. */
export async function loadRows(records?: FileRecord[]): Promise<FileRow[]> {
  const recs = records ?? (await allFiles());
  const slugs = [...new Set(recs.filter((r) => r.eventSlug && (r.type === "recording" || r.type === "recording_audio")).map((r) => r.eventSlug!))];
  const events = new Map<string, NeoEvent | null>();
  // Bounded fan-out: KV reads, a few at a time.
  for (let i = 0; i < slugs.length; i += 20) {
    const chunk = slugs.slice(i, i + 20);
    const got = await Promise.all(chunk.map((s) => eventStore.bySlug(s).catch(() => null)));
    chunk.forEach((s, j) => events.set(s, got[j]));
  }
  return recs.map((r) => {
    const ev = r.eventSlug ? events.get(r.eventSlug) : null;
    return { ...r, effectiveVisibility: effectiveVisibility(r, ev), ...(ev?.name ? { eventName: ev.name } : {}) };
  });
}

export interface FileQuery {
  q?: string;
  owner?: string;
  type?: ContentType;
  status?: ProcessingStatus;
  visibility?: Visibility;
  state?: FileState | "all";
  minSize?: number;
  maxSize?: number;
  from?: number;
  to?: number;
  sort?: "createdAt" | "size" | "name";
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

function numParam(v: string | null): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function dateParam(v: string | null, endOfDay = false): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : v);
  return Number.isFinite(t) ? t : undefined;
}

export function parseFileQuery(url: URL): FileQuery {
  const p = url.searchParams;
  const type = p.get("type");
  const status = p.get("status");
  const visibility = p.get("visibility");
  const state = p.get("state");
  const sort = p.get("sort");
  return {
    q: p.get("q")?.trim().toLowerCase() || undefined,
    owner: p.get("owner")?.trim() || undefined,
    type: isContentType(type) ? type : undefined,
    status: PROCESSING_STATUSES.includes(status as ProcessingStatus) ? (status as ProcessingStatus) : undefined,
    visibility: VISIBILITIES.includes(visibility as Visibility) ? (visibility as Visibility) : undefined,
    state: state === "all" || state === "active" || state === "hidden" || state === "trashed" ? state : undefined,
    minSize: numParam(p.get("minSize")),
    maxSize: numParam(p.get("maxSize")),
    from: dateParam(p.get("from")),
    to: dateParam(p.get("to"), true),
    sort: sort === "size" || sort === "name" || sort === "createdAt" ? sort : "createdAt",
    dir: p.get("dir") === "asc" ? "asc" : "desc",
    limit: Math.min(Math.max(numParam(p.get("limit")) ?? 50, 1), 200),
    offset: Math.max(numParam(p.get("offset")) ?? 0, 0),
  };
}

export function filterRows(rows: FileRow[], q: FileQuery): FileRow[] {
  return rows.filter((r) => {
    // The trash is its own view unless asked for.
    if (q.state === "all") {
      // everything
    } else if (q.state) {
      if (r.state !== q.state) return false;
    } else if (r.state === "trashed") return false;
    if (q.owner && r.ownerId !== q.owner) return false;
    if (q.type && r.type !== q.type) return false;
    if (q.status && r.status !== q.status) return false;
    if (q.visibility && r.effectiveVisibility !== q.visibility) return false;
    if (q.minSize != null && r.size < q.minSize) return false;
    if (q.maxSize != null && r.size > q.maxSize) return false;
    if (q.from != null && r.createdAt < q.from) return false;
    if (q.to != null && r.createdAt > q.to) return false;
    if (q.q) {
      const hay = `${r.name ?? ""} ${r.key} ${r.ownerId ?? ""} ${r.eventSlug ?? ""} ${r.eventName ?? ""} ${r.groupId ?? ""}`.toLowerCase();
      if (!hay.includes(q.q)) return false;
    }
    return true;
  });
}

export function sortRows(rows: FileRow[], q: FileQuery): FileRow[] {
  const dir = q.dir === "asc" ? 1 : -1;
  const by = q.sort ?? "createdAt";
  return [...rows].sort((a, b) => {
    const x = by === "size" ? a.size - b.size : by === "name" ? (a.name ?? a.key).localeCompare(b.name ?? b.key) : a.createdAt - b.createdAt;
    return x * dir || a.id.localeCompare(b.id);
  });
}

export interface TypeTotal {
  type: ContentType;
  files: number;
  bytes: number;
}

export interface AccountTotal {
  ownerId: string | null;
  files: number;
  bytes: number;
  byType: Partial<Record<ContentType, number>>;
}

/** Bytes and counts per type and per account. Trashed files still take space until purged, so they count. */
export function usageTotals(rows: FileRecord[]): { total: { files: number; bytes: number }; byType: TypeTotal[]; byAccount: AccountTotal[] } {
  const byType = new Map<ContentType, TypeTotal>();
  const byAccount = new Map<string, AccountTotal>();
  let files = 0;
  let bytes = 0;
  for (const r of rows) {
    files++;
    bytes += r.size;
    const t = byType.get(r.type) ?? { type: r.type, files: 0, bytes: 0 };
    t.files++;
    t.bytes += r.size;
    byType.set(r.type, t);
    const k = r.ownerId ?? "";
    const a = byAccount.get(k) ?? { ownerId: r.ownerId, files: 0, bytes: 0, byType: {} };
    a.files++;
    a.bytes += r.size;
    a.byType[r.type] = (a.byType[r.type] ?? 0) + r.size;
    byAccount.set(k, a);
  }
  return {
    total: { files, bytes },
    byType: [...byType.values()].sort((a, b) => b.bytes - a.bytes),
    byAccount: [...byAccount.values()],
  };
}

export interface OwnerInfo {
  id: string;
  email: string;
  name: string;
  /** Storage quota from the plan snapshot phase 3 writes (publicMetadata.planLimits.storageGb); null = none set. */
  storageGb: number | null;
}

/** Who these accounts are, 100 at a time from Clerk; ids Clerk does not know are missing from the map. */
export async function ownerInfo(ids: string[]): Promise<Map<string, OwnerInfo>> {
  const out = new Map<string, OwnerInfo>();
  const want = [...new Set(ids.filter((id) => /^user_[A-Za-z0-9]+$/.test(id)))];
  if (!want.length) return out;
  const client = await clerkClient();
  for (let i = 0; i < want.length; i += 100) {
    const chunk = want.slice(i, i + 100);
    const res = (await client.users.getUserList({ userId: chunk, limit: 100 })) as unknown as {
      data: {
        id: string;
        firstName?: string | null;
        lastName?: string | null;
        primaryEmailAddress?: { emailAddress?: string } | null;
        emailAddresses?: { emailAddress: string }[];
        publicMetadata?: Record<string, unknown> | null;
      }[];
    };
    for (const u of res.data ?? []) {
      const limits = (u.publicMetadata?.planLimits ?? null) as { storageGb?: unknown } | null;
      const gb = typeof limits?.storageGb === "number" && limits.storageGb > 0 ? limits.storageGb : null;
      out.set(u.id, {
        id: u.id,
        email: (u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || "").toLowerCase(),
        name: [u.firstName, u.lastName].filter(Boolean).join(" "),
        storageGb: gb,
      });
    }
  }
  return out;
}

/** Owners Clerk no longer has (deleted accounts), among those named. */
export async function goneOwners(ids: string[]): Promise<Set<string>> {
  const want = [...new Set(ids.filter((id) => /^user_[A-Za-z0-9]+$/.test(id)))].slice(0, 2000);
  try {
    const known = await ownerInfo(want);
    return new Set(want.filter((id) => !known.has(id)));
  } catch (err) {
    // Without Clerk, nobody is reported gone.
    console.warn("[content-admin] owner lookup failed", err);
    return new Set();
  }
}
