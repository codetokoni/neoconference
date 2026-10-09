// /api/admin/support/sla — response-time targets per priority.
// GET (support:read) the targets; PUT (support:write) { urgent: {
// firstResponseHours, resolutionHours }, high: …, normal: …, low: … },
// audited with before and after.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { DEFAULT_SLA, cleanSla } from "@/lib/support/model";
import { getSla, saveSla } from "@/lib/support/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "support:read");
  if (!g.ok) return g.response;
  return NextResponse.json({ ok: true, sla: await getSla(), defaults: DEFAULT_SLA });
}

export async function PUT(req: Request) {
  const g = await requireAdmin(req, "support:write");
  if (!g.ok) return g.response;
  const b = await readJson(req);
  if (!b) return fail("invalid_body", "Send the targets as JSON.");
  const before = await getSla();
  const next = cleanSla(b, before);
  for (const p of Object.keys(next) as (keyof typeof next)[]) {
    if (next[p].firstResponseHours > next[p].resolutionHours) {
      return fail("invalid_sla", `The ${p} first-response target cannot be longer than its resolution target.`);
    }
  }
  await saveSla(next);
  const d = diff(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  if (Object.keys(d.after).length) {
    await recordAdminAction(actorOf(g.ctx), req, { action: "support.sla.update", targetType: "support", targetId: "sla", targetLabel: "Response-time targets", ...d });
  }
  return NextResponse.json({ ok: true, sla: next });
}
