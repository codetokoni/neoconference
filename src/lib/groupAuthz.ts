// src/lib/groupAuthz.ts
//
// The group counterpart of authorize() in src/lib/authz.ts. That file resolves
// a caller against an event; a group has no event, so the caller's standing
// comes from the group's member hash instead. The decision itself is still
// can() from permissions.ts and is still audited through recordDecision().
//
// A group is private to its members. Someone outside it gets the same 404 as
// for a group that does not exist, so a guessed id says nothing.

import { NextResponse } from "next/server";
import { forbidden, getIdentity, notFound, recordDecision, unauthorized } from "@/lib/authz";
import type { Actor, Permission } from "@/lib/permissions";
import {
  GroupError,
  decideGroupAccess,
  getGroup,
  getMember,
  type Group,
  type GroupMember,
} from "@/lib/groupStore";

export type GroupGate =
  | { ok: true; actor: Actor; group: Group; member: GroupMember; response?: undefined }
  | { ok: false; response: NextResponse };

/**
 *   const gate = await requireGroupPermission(id, "group:members:manage");
 *   if (!gate.ok) return gate.response;
 *
 * 401 signed out · 404 no such group, or not a member · 403 rank too low.
 */
export async function requireGroupPermission(groupId: string, permission: Permission): Promise<GroupGate> {
  const identity = await getIdentity();
  const [group, member] = identity.userId
    ? await Promise.all([getGroup(groupId), getMember(groupId, identity.userId)])
    : [null, null];

  const decision = decideGroupAccess(identity, group, member, permission);
  recordDecision({
    permission,
    allowed: decision.ok,
    userId: identity.userId,
    role: decision.actor?.role ?? "participant",
    reason: decision.actor?.reason ?? (identity.userId ? "default" : "anonymous"),
    groupId,
  });

  if (decision.ok && group && member) return { ok: true, actor: decision.actor, group, member };
  if (!decision.ok && decision.status === 401) return { ok: false, response: unauthorized() };
  if (!decision.ok && decision.status === 403) return { ok: false, response: forbidden(permission) };
  return { ok: false, response: notFound() };
}

/** A GroupError as the response it describes; anything else is a 500. */
export function groupErrorResponse(err: unknown): NextResponse {
  if (err instanceof GroupError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[groups] unexpected error", err);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

/** The request body as an object, or null when it is missing or not JSON. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const invalidBody = (code = "invalid_body") => NextResponse.json({ error: code }, { status: 400 });
