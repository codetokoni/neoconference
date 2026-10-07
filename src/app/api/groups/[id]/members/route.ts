// src/app/api/groups/[id]/members/route.ts
//
// POST   { emails?: string[], userIds?: string[], kcHandles?: string[],
//          pending?: boolean }  add Members (group:members:manage, Moderator
//        and up). Emails are matched exactly against Clerk accounts and
//        KingsChat handles against the accounts that signed in with them.
//        Without `pending`, ones with no account come back in `notFound` so
//        the screen can offer the invite link instead. With `pending: true`
//        they are kept as pending members, who join the moment they sign in
//        with that email or handle; they come back in `pending`.
// PATCH  { userId, role }  change a role. Hosts manage Moderators and Members,
//        the Owner manages Hosts too; a Moderator changes no one's role.
//        role "owner" hands the group over (Owner only); they become a Host.
// DELETE ?userId=  remove someone (group:members:manage, and only below your
//        own rank). Without userId, or with your own, you leave the group.
// DELETE ?pending=<key>  take back a pending member ("email:…" / "kc:…").

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isMeetingRole } from "@/lib/permissions";
import {
  addMembers,
  addPendingMembers,
  leaveGroup,
  listMembers,
  listPendingMembers,
  memberLimitError,
  pendingKeyFor,
  removeMember,
  removePendingMember,
  setRole,
  transferOwnership,
  type NewMember,
} from "@/lib/groupStore";
import { normalizeKcHandle } from "@/lib/kcHandle";
import {
  groupErrorResponse,
  invalidBody,
  readJsonObject,
  requireGroupPermission,
} from "@/lib/groupAuthz";
import { memberLimitFor, membersByEmail, membersById, membersByKcHandle } from "@/lib/groupPeople";
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
  const rawHandles = stringList(body.kcHandles, (s) => normalizeKcHandle(s) !== null);
  if (!emails || !userIds || !rawHandles) return invalidBody("invalid_members");
  const kcHandles = Array.from(new Set(rawHandles.map((h) => normalizeKcHandle(h)!)));
  const asked = emails.length + userIds.length + kcHandles.length;
  if (asked === 0) return invalidBody("no_members");
  if (asked > MAX_PER_REQUEST) return invalidBody("too_many_at_once");
  const keepPending = body.pending === true;

  const [byEmail, byId, byHandle] = await Promise.all([
    membersByEmail(emails),
    membersById(userIds),
    membersByKcHandle(kcHandles),
  ]);
  const people: NewMember[] = [...byEmail.found, ...byId.found, ...byHandle.found];
  // Unknown user ids are never pending: there is nobody to wait for.
  const waiting = keepPending
    ? [
        ...byEmail.missing.map((value) => ({ kind: "email" as const, value })),
        ...byHandle.missing.map((value) => ({ kind: "kc" as const, value })),
      ]
    : [];
  const notFound = keepPending
    ? byId.missing
    : [...byEmail.missing, ...byId.missing, ...byHandle.missing.map((h) => `@${h}`)];
  if (people.length === 0 && waiting.length === 0) {
    return NextResponse.json({ error: "user_not_found", notFound }, { status: 404 });
  }

  try {
    // The group's size follows its Owner's plan.
    const [members, pendingNow] = await Promise.all([listMembers(id), listPendingMembers(id)]);
    const owner = members.find((m) => m.role === "owner");
    const limit = owner ? await memberLimitFor(owner.userId) : undefined;
    // The whole request fits or none of it is written: members and pending
    // places share the limit, and adding one kind must not strand the other.
    if (limit) {
      const memberIds = new Set(members.map((m) => m.userId));
      const pendingKeys = new Set(pendingNow.map((p) => p.key));
      const newPeople = new Set(people.map((p) => p.userId).filter((u) => !memberIds.has(u))).size;
      const newWaiting = new Set(
        waiting.map((w) => pendingKeyFor(w.kind, w.value)).filter((k): k is string => !!k && !pendingKeys.has(k))
      ).size;
      if (members.length + pendingNow.length + newPeople + newWaiting > limit.cap) throw memberLimitError(limit);
    }
    const { added, alreadyMembers } = people.length
      ? await addMembers(id, people, gate.actor, limit)
      : { added: [], alreadyMembers: [] };
    const { pending, alreadyPending } = waiting.length
      ? await addPendingMembers(id, waiting, gate.actor, limit)
      : { pending: [], alreadyPending: [] };
    // A meeting of the group on right now rings its newest members too.
    await ringNewMembers(id, added.map((m) => m.userId)).catch((err) => console.warn("[groups/members] ring failed", err));
    return NextResponse.json({ ok: true, added, alreadyMembers, notFound, pending, alreadyPending });
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
  const params = new URL(req.url).searchParams;

  // Taking back a pending member. Checked first: without a userId this
  // request would otherwise read as leaving the group.
  const pendingParam = params.get("pending");
  if (pendingParam !== null) {
    const key = pendingParam.trim();
    if (!key || key.length > 260) return invalidBody("invalid_pending");
    const gate = await requireGroupPermission(id, "group:members:manage");
    if (!gate.ok) return gate.response;
    try {
      const removed = await removePendingMember(id, key, gate.actor);
      return NextResponse.json({ ok: true, removedPending: removed.key });
    } catch (err) {
      return groupErrorResponse(err);
    }
  }

  const target = (params.get("userId") || "").trim();
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
