// /api/admin/comms/templates — the transactional email templates (notifications:send).
//
// GET   every template: what it is for, its variables, the default and the edit in use

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { listTemplates } from "@/lib/comms/templates";
import { isMailConfigured } from "@/lib/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const items = (await listTemplates()).map((t) => ({
    id: t.def.id,
    name: t.def.name,
    group: t.def.group,
    description: t.def.description,
    audience: t.def.audience,
    edited: !!t.current,
    version: t.active.version,
    savedAt: t.current?.savedAt ?? null,
    savedByEmail: t.current?.savedByEmail ?? null,
  }));
  return NextResponse.json({ items, mail: isMailConfigured(), me: g.ctx.email }, { headers: { "cache-control": "no-store" } });
}
