// src/app/api/events/[id]/calls/route.ts
//
// GET — who is being called into a group meeting and how that is going:
// ringing, answered, joined, left (joined, since gone), declined, missed or
// busy, with rings used. For the room's Calling panel; Moderator and up
// (group:participants:manage).
// Path param: id or slug.

import { NextResponse } from "next/server";
import { eventStore } from "@/lib/eventStore";
import { inviteesOf } from "@/lib/groupMeetings";
import { getCalls, shownStatus } from "@/lib/ringEngine";
import { getPresence } from "@/lib/presence";
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
  const now = Date.now();
  const people = await Promise.all(
    invitees
      .filter((r) => r.userId)
      .map(async (r) => {
        const c = calls.get(r.userId!);
        // Someone who joined and went shows as 'left', and can be rung
        // again; only they need a presence read.
        const presence = c?.status === "joined" ? await getPresence(r.userId!, now) : null;
        return {
          userId: r.userId!,
          name: r.name,
          status: c ? shownStatus(c, presence, ev.id, now) : "not_called",
          attempts: c?.attempts ?? 0,
          lastAttemptAt: c?.lastAttemptAt ?? 0,
        };
      })
  );
  return NextResponse.json(
    { eventId: ev.id, maxAttempts: gate.group.settings.maxAttempts, people },
    { headers: { "cache-control": "no-store" } }
  );
}
