// src/app/api/push/subscribe/route.ts
//
// POST   { subscription }  remember this browser for call alerts. The same
//                          endpoint again replaces its entry; an 11th browser
//                          replaces the oldest.
// DELETE { endpoint }      forget this browser.
//
// Signed-in only. 503 push_not_configured when the VAPID keys are not set,
// so a browser is never left believing it subscribed to nothing.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cleanSubscription, isPushConfigured, removeSubscription, saveSubscription } from "@/lib/pushStore";
import { invalidBody, readJsonObject } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isPushConfigured()) return NextResponse.json({ error: "push_not_configured" }, { status: 503 });

  const body = await readJsonObject(req);
  const subscription = cleanSubscription(body?.subscription);
  if (!subscription) return invalidBody("invalid_subscription");

  const { id, evicted } = await saveSubscription(userId, subscription, req.headers.get("user-agent") || "");
  return NextResponse.json({ ok: true, device: id, evicted: evicted.length });
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  const endpoint = body?.endpoint;
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > 2048) return invalidBody("invalid_endpoint");
  const removed = await removeSubscription(userId, endpoint);
  return NextResponse.json({ ok: true, removed });
}
