// /api/admin/ops/maintenance
//
// POST { title, message, startsAt, endsAt, maintenanceMode, announceMinutes? }
//   schedules a maintenance window (ops:write). With maintenanceMode the
//   window also turns on the Settings area's maintenance mode for its
//   duration, which is that area's sensitive power: it needs features:write
//   as well, with a fresh code. Shown in the site notice from
//   announceMinutes before the start. Audited.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { scheduleMaintenance } from "@/lib/ops/incidents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY = 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  const b = await readJson<Record<string, unknown>>(req.clone());
  const maintenanceMode = b?.maintenanceMode === true;
  const g = await requireAdmin(req, maintenanceMode ? ["ops:write", "features:write"] : "ops:write");
  if (!g.ok) return g.response;
  const title = str(b?.title, 120);
  const message = str(b?.message, 500);
  const startsAt = Number(b?.startsAt);
  const endsAt = Number(b?.endsAt);
  if (!title) return fail("title_required", "Give the window a title.");
  if (!message) return fail("message_required", "Say what users will see.");
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return fail("bad_times", "The window must end after it starts.");
  if (endsAt <= Date.now()) return fail("in_the_past", "That window has already ended.");
  if (endsAt - startsAt > 7 * DAY) return fail("too_long", "A window can last at most 7 days.");
  const announce = Number(b?.announceMinutes);
  const announceFrom = Number.isFinite(announce) && announce > 0 ? startsAt - Math.min(announce, 14 * 24 * 60) * 60_000 : null;
  const w = await scheduleMaintenance({ title, message, startsAt, endsAt, maintenanceMode, announceFrom, by: g.ctx.email });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "ops.maintenance.schedule",
    targetType: "maintenance",
    targetId: w.id,
    targetLabel: title,
    after: { startsAt, endsAt, maintenanceMode, announceFrom, state: w.state, surface: w.surface },
  });
  return NextResponse.json({ ok: true, window: w }, { status: 201 });
}
