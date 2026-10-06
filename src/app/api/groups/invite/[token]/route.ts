// src/app/api/groups/invite/[token]/route.ts
//
// GET  — public preview of a group invite: the group's name, description,
//        icon and size, so the landing page can say what is being joined.
// POST — join. Requires a signed-in user; they become a Member. Someone
//        already in the group keeps the role they have.
//
// The route is public in middleware for the GET; POST checks auth() itself,
// like /api/invites/[token].

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { countMembers, getGroup, getInvite, getMember, redeemInvite, GROUP_INVITE_TTL_SECONDS } from "@/lib/groupStore";
import { groupErrorResponse } from "@/lib/groupAuthz";
import { currentMember } from "@/lib/groupPeople";
import { ringNewMembers } from "@/lib/ringEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

const expired = () => NextResponse.json({ error: "invite_expired" }, { status: 410 });

export async function GET(_req: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const invite = await getInvite(token);
  if (!invite) return expired();
  const group = await getGroup(invite.gid);
  if (!group) return expired();

  const { userId } = await auth();
  const [memberCount, mine] = await Promise.all([
    countMembers(group.id),
    userId ? getMember(group.id, userId) : Promise.resolve(null),
  ]);

  return NextResponse.json(
    {
      invite: { expiresAt: new Date(invite.createdAt + GROUP_INVITE_TTL_SECONDS * 1000).toISOString() },
      group: {
        id: mine ? group.id : undefined,
        name: group.name,
        description: group.description,
        iconUrl: group.iconUrl,
        memberCount,
      },
      signedIn: Boolean(userId),
      alreadyMember: Boolean(mine),
    },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(_req: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const me = await currentMember();
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const { group, member, alreadyMember } = await redeemInvite(token, me);
    // Joining while a group meeting is on rings you into it.
    if (!alreadyMember) {
      await ringNewMembers(group.id, [member.userId]).catch((err) => console.warn("[groups/invite] ring failed", err));
    }
    return NextResponse.json({ ok: true, groupId: group.id, role: member.role, alreadyMember });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
