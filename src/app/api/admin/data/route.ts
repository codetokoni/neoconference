// GET /api/admin/data — the Data page: deletion requests (open and closed),
// legal holds, retention settings, the trash and the data map. users:read
// to see it; every change goes through routes that need data:delete.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { can, requireAdmin } from "@/lib/admin/context";
import { primaryEmail, type ClerkUserish } from "@/lib/admin/users";
import { isOwnerEmailList } from "@/lib/admin/owner";
import { allHolds, closedRequests, openRequests, openStatus } from "@/lib/dataGov/requests";
import { RETENTION, getRetention } from "@/lib/dataGov/settings";
import { PURGES, daysFor } from "@/lib/dataGov/purge";
import { expiresAt, listTrash, trashWindowMs } from "@/lib/dataGov/trash";
import { DATA_MAP } from "@/lib/dataMap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function label(uid: string): Promise<{ email: string; name: string; exists: boolean; owner: boolean }> {
  try {
    const client = await clerkClient();
    const u = (await client.users.getUser(uid)) as unknown as ClerkUserish;
    return { email: primaryEmail(u), name: [u.firstName, u.lastName].filter(Boolean).join(" "), exists: true, owner: isOwnerEmailList(u.emailAddresses) };
  } catch {
    return { email: "", name: "", exists: false, owner: false };
  }
}

export async function GET(req: Request) {
  const g = await requireAdmin(req, "users:read");
  if (!g.ok) return g.response;
  const now = Date.now();
  const [open, closed, holds, retention, trash, win] = await Promise.all([
    openRequests(),
    closedRequests(200),
    allHolds(),
    getRetention(),
    listTrash({ includeRestored: true }),
    trashWindowMs(),
  ]);
  const requests = await Promise.all(
    [...open.entries()].map(async ([uid, d]) => ({
      id: d.id ?? null,
      userId: uid,
      ...(await label(uid)),
      status: holds.has(uid) ? "refused" : openStatus(d, now),
      source: d.source ?? "admin",
      requestedAt: d.requestedAt,
      deleteAfter: d.deleteAfter,
      reason: d.reason,
      requestedBy: d.source === "user" ? "the account holder" : d.requestedByEmail,
      held: holds.has(uid),
    })),
  );
  requests.sort((a, b) => a.deleteAfter - b.deleteAfter);
  const holdRows = await Promise.all(
    [...holds.entries()].map(async ([uid, h]) => ({ userId: uid, ...(await label(uid)), at: h.at, byEmail: h.byEmail, reason: h.reason })),
  );
  const purges = await Promise.all(
    PURGES.map(async (p) => {
      const days = await daysFor(p.id);
      return { id: p.id, label: p.label, days, unavailable: p.unavailable(days) };
    }),
  );
  return NextResponse.json({
    now,
    canDelete: can(g.ctx, "data:delete"),
    canExport: can(g.ctx, "data:export"),
    requests,
    closed: closed.map((c) => ({ ...c })),
    holds: holdRows,
    retention: {
      values: retention.values,
      updatedAt: retention.updatedAt,
      updatedBy: retention.updatedBy,
      defs: RETENTION,
    },
    purges,
    trash: {
      windowDays: Math.round(win / 86_400_000),
      items: trash.map((t) => ({
        id: t.id,
        kind: t.kind,
        label: t.label,
        ownerId: t.ownerId,
        ref: t.ref,
        deletedAt: t.deletedAt,
        deletedBy: t.deletedBy,
        expiresAt: expiresAt(t, win),
        restoredAt: t.restoredAt ?? null,
        files: t.r2.length,
        keys: t.keyCount,
      })),
    },
    dataMap: DATA_MAP,
  });
}
