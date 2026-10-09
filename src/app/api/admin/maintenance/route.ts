// /api/admin/maintenance — maintenance mode.
//
// GET (features:write, no fresh code to look)
// PUT (features:write + fresh code)  { enabled, message?, endsAt? (ms or ISO, optional) }
//
// While on, every page but the admin area shows the maintenance screen and
// API calls get 503 with the message (src/lib/platform/gate.ts), except for
// the owner and administrators, sign-in, health checks, cron and webhooks.
// It ends by itself at endsAt, if one is set.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { getFeatureControls, saveFeatureControls } from "@/lib/platform/settings";
import { DEFAULT_MAINTENANCE_MESSAGE, maintenanceActive, type Maintenance } from "@/lib/platform/model";
import { emitPlatformEvent } from "@/lib/platform/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "features:write", { readOnly: true });
  if (!g.ok) return g.response;
  const { maintenance } = await getFeatureControls();
  return NextResponse.json({ ok: true, maintenance, active: maintenanceActive(maintenance) });
}

export async function PUT(req: Request) {
  const g = await requireAdmin(req, "features:write");
  if (!g.ok) return g.response;
  const body = await readJson<{ enabled?: unknown; message?: unknown; endsAt?: unknown }>(req);
  if (typeof body?.enabled !== "boolean") return fail("invalid_value", "Say whether maintenance mode is on (true) or off (false).");
  let endsAt: number | null = null;
  if (body.endsAt !== undefined && body.endsAt !== null && body.endsAt !== "") {
    const n = typeof body.endsAt === "number" ? body.endsAt : Date.parse(String(body.endsAt));
    if (!Number.isFinite(n)) return fail("invalid_time", "The end time is not a valid date and time.");
    if (body.enabled && n <= Date.now()) return fail("invalid_time", "The end time is already past.");
    endsAt = Math.floor(n);
  }

  const current = await getFeatureControls();
  const wasActive = maintenanceActive(current.maintenance);
  const message = str(body.message, 1000) || current.maintenance.message || DEFAULT_MAINTENANCE_MESSAGE;
  const maintenance: Maintenance = body.enabled
    ? {
        enabled: true,
        message,
        endsAt,
        startedAt: wasActive ? current.maintenance.startedAt : Date.now(),
        startedBy: wasActive ? current.maintenance.startedBy : g.ctx.email,
      }
    : { enabled: false, message, endsAt: null, startedAt: null, startedBy: null };
  const saved = await saveFeatureControls({ ...current, maintenance });

  await recordAdminAction(actorOf(g.ctx), req, {
    action: body.enabled ? (wasActive ? "maintenance.update" : "maintenance.on") : "maintenance.off",
    targetType: "maintenance",
    targetId: "platform",
    targetLabel: "maintenance mode",
    before: { enabled: wasActive, message: current.maintenance.message, endsAt: current.maintenance.endsAt },
    after: { enabled: maintenance.enabled, message: maintenance.message, endsAt: maintenance.endsAt },
  });
  if (body.enabled !== wasActive) {
    await emitPlatformEvent(body.enabled ? "maintenance.started" : "maintenance.ended", { message: maintenance.message, endsAt: maintenance.endsAt });
  }
  return NextResponse.json({ ok: true, maintenance: saved.maintenance, active: maintenanceActive(saved.maintenance) });
}
