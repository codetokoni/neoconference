// /api/admin/comms/sends/[id]/confirm — send a previewed draft (notifications:send).
//
// POST { count }   the recipient count the administrator was shown. A send
//                  to everyone, or to more than STEP_UP_RECIPIENTS people,
//                  also needs an authenticator code from the last 10 minutes.
// The first slice is delivered before this answers; the rest follow (the
// admin page, the scheduler tick and the cron drive it).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { confirmSend, getSend, needsStepUp, processSend } from "@/lib/comms/sends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  const pre = await requireAdmin(req, "notifications:send");
  if (!pre.ok) return pre.response;
  const send = await getSend(params.id);
  if (!send) return fail("not_found", "That send was not found.", 404);
  const g = needsStepUp(send) ? await requireAdmin(req, "notifications:send", { stepUp: true }) : pre;
  if (!g.ok) return g.response;
  if (send.status !== "draft") return fail("already_confirmed", "This send was already confirmed.", 409, { status: send.status });
  const body = await readJson<{ count?: unknown }>(req);
  if (body?.count !== send.preview.count) {
    return fail("preview_required", "Look at the preview and confirm the number of recipients it shows.", 400, { count: send.preview.count });
  }
  const queued = await confirmSend(send, actorOf(g.ctx));
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "comms.send",
    targetType: "send",
    targetId: send.id,
    targetLabel: send.message.title,
    before: { status: "draft" },
    after: {
      status: "queued",
      kind: send.kind,
      severity: send.message.severity,
      audience: send.audienceLabel,
      audienceSpec: send.audience,
      recipients: send.preview.count,
      recipientsExact: send.preview.exact,
      channels: send.channels,
      startsAt: send.startsAt,
      endsAt: send.endsAt,
    },
  });
  const progress = await processSend(queued.id, 8_000);
  return NextResponse.json({ ok: true, send: (await getSend(queued.id)) ?? queued, progress });
}
