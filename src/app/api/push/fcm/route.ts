// src/app/api/push/fcm/route.ts
//
// The Android app's call alerts (src/lib/fcmStore.ts).
//
// POST   { token }  remember this phone's FCM token. The same token again
//                   replaces its entry; an 11th phone replaces the oldest.
// DELETE { token }  forget it (signing out of the app).
//
// Signed-in only (the app sends its Clerk session as a Bearer token). 503
// fcm_not_configured when FIREBASE_SERVICE_ACCOUNT is not set, so the app
// knows to try again later rather than believe it is registered.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cleanFcmToken, isFcmConfigured, removeFcmToken, saveFcmToken } from "@/lib/fcmStore";
import { invalidBody, readJsonObject } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isFcmConfigured()) return NextResponse.json({ error: "fcm_not_configured" }, { status: 503 });

  const body = await readJsonObject(req);
  const token = cleanFcmToken(body?.token);
  if (!token) return invalidBody("invalid_token");

  const { id, evicted } = await saveFcmToken(userId, token);
  return NextResponse.json({ ok: true, device: id, evicted: evicted.length });
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  const token = cleanFcmToken(body?.token);
  if (!token) return invalidBody("invalid_token");
  const removed = await removeFcmToken(userId, token);
  return NextResponse.json({ ok: true, removed });
}
