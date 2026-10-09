// /api/admin/comms/delivery — what email went out and what became of it (notifications:send).
//
// GET ?q=&status=   transactional email as sent (with send-time failures),
//                   and Resend's delivery reports (delivered, bounced,
//                   complained…) when RESEND_WEBHOOK_SECRET is set.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { listDeliveryEvents, listLog } from "@/lib/comms/log";
import { isWebhookConfigured } from "@/lib/comms/webhook";
import { isMailConfigured } from "@/lib/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "notifications:send");
  if (!g.ok) return g.response;
  const sp = new URL(req.url).searchParams;
  const q = sp.get("q") ?? undefined;
  const [log, events] = await Promise.all([
    listLog({ q, status: sp.get("status") ?? undefined }),
    listDeliveryEvents({ q, status: sp.get("event") ?? undefined }),
  ]);
  return NextResponse.json(
    {
      log,
      events,
      mail: isMailConfigured(),
      webhook: isWebhookConfigured(),
      webhookUrl: `${new URL(req.url).origin}/api/comms/resend-webhook`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
