// /api/admin/comms/reminders — usage-limit reminders (notifications:send).
//
// GET   the settings
// PUT   { meetings?: { enabled, thresholds, channels }, recording?: … }

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { getReminderConfig, saveReminderConfig } from "@/lib/comms/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  return NextResponse.json({ config: await getReminderConfig() }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(req: Request) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const body = await readJson(req);
  if (!body) return fail("invalid_body", "Send the settings as JSON.");
  const { before, after } = await saveReminderConfig(body, g.ctx.email);
  const change = diff({ meetings: before.meetings, recording: before.recording }, { meetings: after.meetings, recording: after.recording });
  if (Object.keys(change.after).length) {
    await recordAdminAction(actorOf(g.ctx), req, { action: "comms.reminders", targetType: "settings", targetId: "reminders", targetLabel: "Usage reminders", ...change });
  }
  return NextResponse.json({ ok: true, config: after });
}
