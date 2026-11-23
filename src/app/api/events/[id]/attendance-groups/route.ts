// GET /api/events/<id>/attendance-groups — the meeting's attendance by church
// or group, for its owner's panel (src/lib/attendanceGroups.ts): the list,
// whether the plan allows it, whether each leader's KingsChat handle can be
// reached, and the sessions already sent with their downloads. Owner or
// admin, as the meeting's settings. The list itself is saved with PATCH
// /api/events/<id> { attendanceGroups }.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";
import { contactAllowed, contactReach } from "@/lib/meetingFeedback";
import { getPlanForUserId } from "@/lib/plan";
import { downloadUrl, listSends } from "@/lib/attendanceGroups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ev = (await eventStore.byId(id)) ?? (await eventStore.bySlug(id));
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const check = await assertOwnerOrAdmin(ev, userId);
  if (!check.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const groups = ev.attendanceGroups?.groups ?? [];
  const reach = await Promise.all(
    groups.map(async (g) => ({ group: g.name, ...(await contactReach(ev.ownerUserId, g.leader ?? null).catch(() => ({ kcHandleKnown: null, ownerKcLinked: null }))) })),
  );
  const sends = (await listSends(ev.id)).map((s) => ({ start: s.start, end: s.end, attended: s.attended, sentAt: s.sentAt, leaders: s.leaders, download: downloadUrl(s.token) }));
  return NextResponse.json(
    { groups, allowed: contactAllowed(await getPlanForUserId(ev.ownerUserId)), reach, sends },
    { headers: { "cache-control": "no-store" } },
  );
}
