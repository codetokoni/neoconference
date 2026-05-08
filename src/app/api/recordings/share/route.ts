// src/app/api/recordings/share/route.ts
// Recording share-link endpoints.
//
// POST   - owner-only: mints a share token for a recording R2 key.
// GET    - public: resolves a share token to a short-lived signed download URL.
// DELETE - owner-only: revokes a share token.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { shareStore } from "@/lib/shareStore";
import { isR2Configured, signGetUrl } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!shareStore.isConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 503 });
  }
  let body: any = {};
  try { body = await req.json(); } catch {}
  const key = typeof body.key === "string" ? body.key : "";
  if (!key || key.includes("..")) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label.slice(0, 200) : undefined;
  const ttlSeconds = typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined;
  const rec = await shareStore.create({ key, ownerUserId: userId, label, ttlSeconds });
  return NextResponse.json({ ok: true, share: rec });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }
  const rec = await shareStore.get(token);
  if (!rec) {
    return NextResponse.json({ error: "not_found_or_expired" }, { status: 404 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ error: "r2_not_configured" }, { status: 503 });
  }
  try {
    const downloadUrl = await signGetUrl(rec.key, 300);
    return NextResponse.json({
      ok: true,
      downloadUrl,
      label: rec.label || null,
      expiresAt: rec.expiresAt,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "sign_failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }
  const rec = await shareStore.get(token);
  if (rec && rec.ownerUserId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  await shareStore.revoke(token);
  return NextResponse.json({ ok: true });
}
