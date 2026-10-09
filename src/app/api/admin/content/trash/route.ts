// /api/admin/content/trash — content:read
//
// GET  files in the trash, with when each one's restore window closes
//      (phase 11's trash retention; 30 days until that is set). Restoring
//      is ./files/[id]/action { action: "restore" } (content:moderate).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { listTrashedFiles, trashWindowDays } from "@/lib/content/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const items = await listTrashedFiles();
  return NextResponse.json({
    days: await trashWindowDays(),
    items: items.map((x) => ({ ...x.record, restoreUntil: x.restoreUntil, expired: x.expired })),
    bytes: items.reduce((s, x) => s + x.record.size, 0),
  });
}
