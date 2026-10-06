// src/app/api/groups/[id]/members/route.ts
//
// POST   { emails?: string[], userIds?: string[] }  add Members
//        (group:members:manage, Moderator and up). Emails are matched exactly
//        against Clerk accounts; ones with no account come back in `notFound`
//        so the screen can offer the invite link instead.
// PATCH  { userId, role }  change a role. Hosts manage Moderators and Members,
//        the Owner manages Hosts too; a Moderator changes no one's role.
//        role "owner" hands the group over (Owner only); they become a Host.
// DELETE ?userId=  remove someone (group:members:manage, and only below your
//        own rank). Without userId, or with your own, you leave the group.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isMeetingRole } from "@/lib/permissions";
import {
  addMembers,
  leaveGroup,
  removeMember,
  setRole,
  transferOwnership,
  type NewMember,
} from "@/lib/groupStore";
import {
  groupErrorResponse,
  invalidBody,
  readJsonObject,
  requireGroupPermission,
} from "@/lib/groupAuthz";
import { memberLimitFor, membersByEmail, membersById } from "@/lib/groupPeople";
import { listMembers } from "@/lib/groupStore";
import { ringNewMembers } from "@/lib/ringEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const MAX_PER_REQUEST = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stringList(v: unknown, test: (s: string) => boolean): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_PER_REQUEST) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") return null;
    const s = item.trim();
    if (!s || s.length > 254 || !test(s)) return null;
    out.push(s);
  }
  return out;
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:members:manage");
  if (!gate.ok) return gate.response;

  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const emails = stringList(body.emails, (s) => EMAIL.test(s));
  const userIds = stringList(body.userIds, (s) => s.length <= 64);
  if (!emails || !userIds) return invalidBody("invalid_members");
  if (emails.length + userIds.length === 0) return invalidBody("no_members");
  if (emails.length + userIds.length > MAX_PER_REQUEST) return invalidBody("too_many_at_once");

  const [byEmail, byId] = await Promise.all([membersByEmail(emails), membersById(userIds)]);
  const people: NewMember[] = [...byEmail.found, ...byId.found];
  const notFound = [...byEmail.missing, ...byId.missing];
  if (people.length === 0) {
    return NextResponse.json({ error: "user_not_found", notFound }, { status: 404 });
  }

  try {
    // The group's size follows its Owner's plan.
    const owner = (await listMembers(id)).find((m) => m.role === "owner");
    const limit = owner ? await memberLimitFor(owner.userId) : undefined;
    const { added, alreadyMembers } = await addMembers(id, people, gate.actor, limit);
    // A meeting of the group on right now rings its newest members too.
    await ringNewMembers(id, added.map((m) => m.userId)).catch((err) => console.warn("[groups/members] ring failed", err));
    return NextResponse.json({ ok: true, added, alreadyMembers, notFound });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const { userId, role } = body;
  if (typeof userId !== "string" || !userId || userId.length > 64) return invalidBody("invalid_user");
  if (!isMeetingRole(role)) return invalidBody("invalid_role");

  // The gate is the least a caller needs for this kind of change; the store
  // then checks the exact roles involved.
  const gate = await requireGroupPermission(
    id,
    role === "owner" ? "group:hosts:manage" : "group:moderators:manage"
  );
  if (!gate.ok) return gate.response;

  try {
    if (role === "owner") {
      const { owner, previous } = await transferOwnership(id, userId, gate.actor);
      return NextResponse.json({ ok: true, member: owner, previousOwner: previous });
    }
    const member = await setRole(id, userId, role, gate.actor);
    return NextResponse.json({ ok: true, member });
  } catch (err) {
    return groupErrorResponse(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const target = (new URL(req.url).searchParams.get("userId") || "").trim();
  const { userId } = await auth();

  const leaving = !target || target === userId;
  const gate = await requireGroupPermission(id, leaving ? "group:leave" : "group:members:manage");
  if (!gate.ok) return gate.response;

  try {
    if (leaving) {
      const left = await leaveGroup(id, gate.member.userId);
      return NextResponse.json({ ok: true, left: left.userId });
    }
    // Holding group:members:manage is not enough on its own: the store
    // refuses with 403 unless the target's role is below the caller's.
    const removed = await removeMember(id, target, gate.actor);
    return NextResponse.json({ ok: true, removed: removed.userId });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
