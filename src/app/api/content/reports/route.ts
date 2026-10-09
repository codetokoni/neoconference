// /api/content/reports — public: report a replay, a shared recording or a
// recording on a public page.
//
// POST { targetType: "event" | "share" | "file", target, reason, details? }
//   event  target = the meeting's slug (replay page, explore listing)
//   share  target = the share link's token
//   file   target = an indexed file's id, for a file anyone can reach
//
// Signed in or not. Rate limited per address (5 per 10 minutes) and per
// account (10); the same person reporting the same thing again counts once.
// Content nobody outside could see cannot be reported (404, the same as an
// unknown target). The reporter is kept on the case for administrators and
// never shown to the content's owner.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { shareStore } from "@/lib/shareStore";
import { isReportReason } from "@/lib/content/model";
import { effectiveVisibility, getFile, getFileByKey, putFile, recordFromKey } from "@/lib/content/files";
import { fileReport, sourceHash, takeReportSlot, type Target } from "@/lib/content/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THANKS = "Thanks for telling us. An administrator will look at it.";

function bad(error: string, message: string, status = 400) {
  return NextResponse.json({ ok: false, error, message }, { status });
}

async function resolveTarget(type: string, target: string): Promise<Target | null> {
  if (type === "event") {
    const ev = await eventStore.bySlug(target);
    // Reachable without an invitation: listed publicly, or its replay is open to anyone with the link.
    if (!ev || (ev.visibility !== "public" && ev.replayEnabled === false)) return null;
    return { targetType: "event", targetKey: `event:${ev.id}`, eventSlug: ev.slug, label: ev.name || ev.slug, ownerId: ev.ownerUserId || null };
  }
  if (type === "share") {
    const share = await shareStore.get(target);
    if (!share) return null;
    let rec = await getFileByKey("r2", share.key);
    if (!rec) {
      // A share made before the index existed: index it now, as shared.
      rec = recordFromKey("r2", share.key, { source: "backfill", visibility: "shared" });
      await putFile(rec);
    }
    return { targetType: "file", targetKey: `file:${rec.id}`, fileId: rec.id, eventSlug: rec.eventSlug, label: share.label || rec.name || "Shared recording", ownerId: rec.ownerId ?? share.ownerUserId };
  }
  if (type === "file") {
    const rec = await getFile(target);
    if (!rec) return null;
    const ev = rec.eventSlug ? await eventStore.bySlug(rec.eventSlug) : null;
    if (effectiveVisibility(rec, ev) === "private") return null;
    return { targetType: "file", targetKey: `file:${rec.id}`, fileId: rec.id, eventSlug: rec.eventSlug, label: rec.name || ev?.name || "Recording", ownerId: rec.ownerId };
  }
  return null;
}

export async function POST(req: Request) {
  let body: Record<string, unknown> | null = null;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  const type = typeof body?.targetType === "string" ? body.targetType : "";
  const target = typeof body?.target === "string" ? body.target.trim().slice(0, 200) : "";
  if (!["event", "share", "file"].includes(type) || !target) return bad("bad_target", "Say what you are reporting.");
  if (!isReportReason(body?.reason)) return bad("bad_reason", "Choose a reason.");
  const details = typeof body?.details === "string" ? body.details.trim().slice(0, 1000) : "";

  let userId: string | null = null;
  try {
    userId = (await auth()).userId ?? null;
  } catch {
    userId = null;
  }
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "").split(",")[0]?.trim() || "unknown";
  const source = sourceHash(ip);

  // Counted before anything is looked up, so probing for targets costs the same.
  if (!(await takeReportSlot({ userId, sourceHash: source }))) {
    return bad("rate_limited", "You've sent several reports in a short time. Please try again in a few minutes.", 429);
  }
  const t = await resolveTarget(type, target);
  if (!t) return bad("not_found", "We couldn't find that page. It may have been removed already.", 404);
  const { duplicate } = await fileReport(t, { reason: body!.reason as Parameters<typeof fileReport>[1]["reason"], details, reporterId: userId, sourceHash: source });
  return NextResponse.json({ ok: true, message: duplicate ? "You've already reported this. Thanks — an administrator will look at it." : THANKS }, { status: duplicate ? 200 : 201 });
}
