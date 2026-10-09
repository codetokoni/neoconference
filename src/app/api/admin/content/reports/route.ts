// /api/admin/content/reports — content:read
//
// GET ?status=open|actioned|dismissed|all&q=  The moderation queue, newest
//     activity first. Who reported is shown only to content:moderate, and
//     only as an account id (or "signed out"); never to the content's owner.

import { NextResponse } from "next/server";
import { can, requireAdmin } from "@/lib/admin/context";
import { caseView, listCases } from "@/lib/content/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "content:read");
  if (!g.ok) return g.response;
  const p = new URL(req.url).searchParams;
  const status = p.get("status") || "open";
  const q = (p.get("q") || "").trim().toLowerCase();
  const all = await listCases();
  const counts = { open: 0, actioned: 0, dismissed: 0 };
  for (const c of all) counts[c.status]++;
  const items = all
    .filter((c) => status === "all" || c.status === status)
    .filter((c) => !q || `${c.label} ${c.eventSlug ?? ""} ${c.fileId ?? ""} ${c.ownerId ?? ""}`.toLowerCase().includes(q))
    .slice(0, 200)
    .map((c) => {
      const v = caseView(c, { showReporters: can(g.ctx, "content:moderate") });
      // The list does not need every report and every history line.
      return { ...v, reports: v.reports.slice(0, 3), history: v.history.slice(0, 3), notes: [] };
    });
  return NextResponse.json({ items, counts });
}
