// src/app/api/events/[id]/calls/route.ts
//
// GET — who is being called into a group meeting and how that is going:
// ringing, answered, joined, declined, missed or busy, with rings used. For
// the room's Calling panel; Moderator and up (group:participants:manage).
// Path param: id or slug.

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { inviteesOf } from "@/lib/groupMeetings";
import { getCalls } from "@/lib/ringEngine";
import { requireGroupPermission } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev?.groupId || !ev.groupMeeting) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const gate = await requireGroupPermission(ev.groupId, "group:participants:manage");
  if (!gate.ok) return gate.response;

  const [invitees, calls] = await Promise.all([inviteesOf(ev), getCalls(ev.id)]);
  const people = invitees
    .filter((r) => r.userId)
    .map((r) => {
      const c = calls.get(r.userId!);
      return {
        userId: r.userId!,
        name: r.name,
        status: c?.status ?? "not_called",
        attempts: c?.attempts ?? 0,
        lastAttemptAt: c?.lastAttemptAt ?? 0,
      };
    });
  return NextResponse.json(
    { eventId: ev.id, maxAttempts: gate.group.settings.maxAttempts, people },
    { headers: { "cache-control": "no-store" } }
  );
}
