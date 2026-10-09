// /api/admin/comms/sends/[id]/control — pause, resume or cancel (notifications:send).
//
// POST { action: "pause" | "resume" | "cancel" }

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { controlSend, getSend, processSend, type ControlAction } from "@/lib/comms/sends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const body = await readJson<{ action?: unknown }>(req);
  const action = body?.action;
  if (action !== "pause" && action !== "resume" && action !== "cancel") return fail("invalid_action", "Choose pause, resume or cancel.");
  const send = await getSend(params.id);
  if (!send) return fail("not_found", "That send was not found.", 404);
  const r = await controlSend(send.id, action as ControlAction);
  if (!r) return fail("not_now", `A send that is ${send.status} cannot be ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`, 409);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: `comms.${action}`,
    targetType: "send",
    targetId: send.id,
    targetLabel: send.message.title,
    before: { status: r.before.status },
    after: { status: r.after.status, recipientsSoFar: r.after.counts.recipients },
  });
  if (action === "resume") await processSend(send.id, 5_000);
  return NextResponse.json({ ok: true, send: (await getSend(send.id)) ?? r.after });
}
