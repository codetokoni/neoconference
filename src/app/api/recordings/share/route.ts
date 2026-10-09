// src/app/api/recordings/share/route.ts
// Recording share-link endpoints.
//
// POST   - mints a share token for a recording R2 key: the recorder's own,
//          or one of a meeting the caller may read recordings of.
// GET    - public: resolves a share token to a short-lived signed download URL.
// DELETE - owner-only: revokes a share token.

import { errorMessage } from "@/lib/errorMessage";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { shareStore } from "@/lib/shareStore";
import { isR2Configured, signGetUrl } from "@/lib/r2";
import { recordingAnalytics } from "@/lib/analytics";
import { blockedKeys, markShared } from "@/lib/content/files";
import { eventStore } from "@/lib/eventStore";
import { authorize } from "@/lib/authz";
import { slugFromRecordingKey, userPrefix } from "@/lib/eventRecordings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Null when `userId` may share `key`, else the refusal to send. */
async function refuseShare(key: string, userId: string): Promise<NextResponse | null> {
  // Only recordings have share links; chat, group and support files do not.
  if (!key.startsWith("recordings/")) {
    return NextResponse.json({ error: "not_shareable", message: "Only recordings can be shared with a link." }, { status: 400 });
  }
  if (key.startsWith(userPrefix(userId))) return null;
  const slug = slugFromRecordingKey(key);
  const ev = slug ? await eventStore.bySlug(slug) : null;
  if (ev) {
    const gate = await authorize(ev, "recording:read");
    if (gate.ok) return null;
  }
  return NextResponse.json({ error: "forbidden", message: "You can only share your own recordings, or those of a meeting you host." }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!shareStore.isConfigured()) {
    return NextResponse.json({ error: "kv_not_configured" }, { status: 503 });
  }
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const key = typeof body.key === "string" ? body.key : "";
  if (!key || key.includes("..")) {
    return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  }
  // Who may hand out a link anyone can download from: the recording's own
  // recorder (their folder), or someone who may read the meeting's
  // recordings (recording:read, the people the meeting's Recordings panel
  // shows them to). Any other key was shareable by any signed-in account.
  const refused = await refuseShare(key, userId);
  if (refused) return refused;
  const label = typeof body.label === "string" ? body.label.slice(0, 200) : undefined;
  const ttlSeconds = typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined;
  const rec = await shareStore.create({ key, ownerUserId: userId, label, ttlSeconds });
  // The admin file index (Content): anyone with the link can download it now.
  await markShared(key);
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
  // Hidden by a moderator or in the trash (admin area, Content).
  if ((await blockedKeys([rec.key])).has(rec.key)) {
    return NextResponse.json({ error: "removed" }, { status: 410 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ error: "r2_not_configured" }, { status: 503 });
  }
  try {
    const downloadUrl = await signGetUrl(rec.key, 300);
    // Best-effort: count this share resolution.
    recordingAnalytics.bump("shares", rec.key).catch(() => {});
    return NextResponse.json({
      ok: true,
      downloadUrl,
      label: rec.label || null,
      expiresAt: rec.expiresAt,
    });
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) || "sign_failed" }, { status: 500 });
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

