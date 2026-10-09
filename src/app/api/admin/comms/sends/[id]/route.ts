// /api/admin/comms/sends/[id] — one send (notifications:send).
//
// GET     the send, its progress, delivery reports and the message per channel
// DELETE  discard a draft (a confirmed send is cancelled, not deleted)

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { discardDraft, getSend, listFailures, needsStepUp, previewChannels, webhookCounts } from "@/lib/comms/sends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const send = await getSend(params.id);
  if (!send) return fail("not_found", "That send was not found.", 404);
  return NextResponse.json(
    {
      send,
      reports: await webhookCounts(send.id),
      failures: await listFailures(send.id, 100),
      channels: previewChannels(send, send.createdBy),
      needsStepUp: needsStepUp(send),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const send = await getSend(params.id);
  if (!send) return fail("not_found", "That send was not found.", 404);
  if (!(await discardDraft(send.id))) return fail("not_a_draft", "Only a draft can be discarded. Cancel a confirmed send instead.", 409);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "comms.discard",
    targetType: "send",
    targetId: send.id,
    targetLabel: send.message.title,
    before: { status: "draft" },
    after: null,
  });
  return NextResponse.json({ ok: true });
}
