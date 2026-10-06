// src/app/api/events/[id]/call-response/route.ts
//
// POST { action: "answer" | "decline", ringId? } — the person being rung
// answers or declines (from the call overlay, or the notification's
// buttons). Only someone invited to the meeting may.
//   answer  -> { ok, status: "answered", roomUrl }   rings stop; the room's
//              join confirms it (status "joined")
//   decline -> { ok, status: "declined" }            no more rings for them
//
// Path param: id or slug.

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { isInvited } from "@/lib/groupMeetings";
import { respondToRing } from "@/lib/ringEngine";
import { joinUrl } from "@/lib/groupNotify";
import { invalidBody, readJsonObject } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev?.groupId || !ev.groupMeeting) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await readJsonObject(req);
  const action = body?.action;
  if (action !== "answer" && action !== "decline") return invalidBody("invalid_action");

  const u = await currentUser().catch(() => null);
  const emails = (u?.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());
  if (!(await isInvited(ev, userId, emails))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const call = await respondToRing(ev.id, userId, action);
  return NextResponse.json({
    ok: true,
    status: call.status,
    ...(action === "answer" ? { roomUrl: joinUrl(ev.slug) } : {}),
  });
}
