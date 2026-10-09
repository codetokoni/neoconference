// /api/admin/comms/sends — announcements and service notices (notifications:send).
//
// GET   ?q=&status=        history, newest first, searchable
// POST  { kind, title, body, severity, url, channels, audience, startsAt, endsAt }
//       -> a draft: the exact message per channel, the recipient count and a
//          sample. Nothing is delivered until POST …/<id>/confirm.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { cleanAudience } from "@/lib/comms/audience";
import { cleanDraft, createDraft, listSends, needsStepUp, STEP_UP_RECIPIENTS } from "@/lib/comms/sends";
import { isMailConfigured } from "@/lib/mail";
import { isPushConfigured } from "@/lib/pushStore";
import { isFcmConfigured } from "@/lib/fcmStore";
import { isWebhookConfigured } from "@/lib/comms/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const sp = new URL(req.url).searchParams;
  const items = await listSends(sp.get("q") ?? undefined, sp.get("status") ?? undefined);
  return NextResponse.json(
    {
      items,
      config: {
        mail: isMailConfigured(),
        push: isPushConfigured(),
        fcm: isFcmConfigured(),
        webhook: isWebhookConfigured(),
        stepUpAbove: STEP_UP_RECIPIENTS,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const body = await readJson(req);
  if (!body) return fail("invalid_body", "Send the message as JSON.");
  const d = cleanDraft(body);
  if ("error" in d) return fail("invalid_message", d.error);
  const a = cleanAudience(body.audience);
  if ("error" in a) return fail("invalid_audience", a.error);
  let created;
  try {
    created = await createDraft({ ...d.draft, audience: a.audience }, actorOf(g.ctx), new URL(req.url).origin);
  } catch (err) {
    console.error("[admin/comms] draft failed", err);
    return fail("audience_failed", "Could not list the recipients just now. Try again.", 502);
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "comms.draft",
    targetType: "send",
    targetId: created.send.id,
    targetLabel: created.send.message.title,
    after: { kind: created.send.kind, audience: created.send.audienceLabel, recipients: created.preview.count, channels: created.send.channels },
  });
  return NextResponse.json(
    { send: created.send, preview: created.preview, channels: created.channels, needsStepUp: needsStepUp(created.send) },
    { status: 201 },
  );
}
