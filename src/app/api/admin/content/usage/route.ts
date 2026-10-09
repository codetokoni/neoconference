// /api/admin/content/usage — content:read
//
// GET ?sort=bytes|files&dir=desc|asc&limit=  Storage per account, with who
//     each account is and the storage quota on its plan (enforced at chat
//     and group uploads; src/lib/content/limits.ts refuseOverQuota).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { ownerInfo, usageTotals, type OwnerInfo } from "@/lib/content/admin";
import { allFiles } from "@/lib/content/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const sort = p.get("sort") === "files" ? "files" : "bytes";
  const dir = p.get("dir") === "asc" ? 1 : -1;
  const limit = Math.min(Math.max(Number(p.get("limit")) || 100, 1), 500);
  const usage = usageTotals(await allFiles());
  const accounts = [...usage.byAccount].sort((a, b) => (a[sort] - b[sort]) * dir || (a.ownerId ?? "").localeCompare(b.ownerId ?? "")).slice(0, limit);
  let owners = new Map<string, OwnerInfo>();
  try {
    owners = await ownerInfo(accounts.map((a) => a.ownerId ?? ""));
  } catch (err) {
    console.warn("[admin/content/usage] owner lookup failed", err);
  }
  return NextResponse.json({
    total: usage.total,
    byType: usage.byType,
    accounts: accounts.map((a) => {
      const o = a.ownerId ? owners.get(a.ownerId) : undefined;
      return {
        ...a,
        email: o?.email ?? null,
        name: o?.name ?? null,
        known: !!o,
        quotaBytes: o?.storageGb ? o.storageGb * 1024 * 1024 * 1024 : null,
      };
    }),
    accountCount: usage.byAccount.length,
    quotas: {
      enforced: true,
      note: "Each plan's Storage limit (Plans) applies to uploads in meeting and group chat: once an account's stored files reach it, its next upload is refused. 0 = unlimited. Recordings count towards it but are never stopped.",
    },
  });
}
