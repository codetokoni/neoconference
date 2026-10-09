// /api/comms/resend-webhook — Resend's delivery reports.
//
// Public in middleware: the Svix signature (RESEND_WEBHOOK_SECRET) is the
// credential. Register https://www.neoconference.app/api/comms/resend-webhook
// in Resend → Webhooks for email.delivered, email.delivery_delayed,
// email.bounced, email.complained and email.failed, and put the signing
// secret it shows (whsec_…) in RESEND_WEBHOOK_SECRET.
//
// -> 200 { applied, type? }  (a report already applied: { duplicate: true })
//    401 bad or stale signature, 503 when the secret is not set.

import { NextResponse } from "next/server";
import { ingestWebhook, verifyWebhook } from "@/lib/comms/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.text();
  const v = verifyWebhook(req.headers, body);
  if (!v.ok) {
    console.warn(`[resend-webhook] refused: ${v.why}`);
    return NextResponse.json({ error: v.why }, { status: v.why === "not_configured" ? 503 : 401 });
  }
  try {
    return NextResponse.json(await ingestWebhook(v.id, body));
  } catch (err) {
    // 500 makes Resend retry later, which is what we want for a KV blip.
    console.error("[resend-webhook] could not apply", err);
    return NextResponse.json({ error: "apply_failed" }, { status: 500 });
  }
}
