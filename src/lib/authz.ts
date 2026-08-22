// src/lib/authz.ts
//
// Request-scoped glue between Clerk and the permission catalog.
//
// permissions.ts answers "may this actor do X"; this file answers "who is
// calling" and turns a refusal into an HTTP response. Route handlers should
// import from here and never re-implement an ownership check.
//
// Three entry points, smallest to largest:
//
//   getActor(event)                  -> Actor            (resolve once, ask many)
//   authorize(event, 'meeting:end')  -> ok | NextResponse (inline in a handler)
//   requirePermission(...)           -> wrapped handler   (whole-route guard)

import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/roles";
import { eventStore } from "@/lib/eventStore";
import { appendAuditEntry } from "@/lib/auditLog";
import type { NeoEvent } from "@/types/event";
import {
  ANONYMOUS_ACTOR,
  can,
  grantsFor,
  resolveRole,
  type Actor,
  type Eventish,
  type Permission,
  type PermissionOverrides,
} from "@/lib/permissions";

export type { Actor, Permission } from "@/lib/permissions";

/* -------------------------------------------------------------------------- */
/*  Identity                                                                   */
/* -------------------------------------------------------------------------- */

interface Identity {
  userId: string | null;
  emails: string[];
  isPlatformAdmin: boolean;
}

/**
 * Reads the caller from Clerk. Emails come from `currentUser()` only — the
 * verified, request-scoped list. Nothing from the request body is trusted here.
 */
export async function getIdentity(): Promise<Identity> {
  const { userId } = await auth();
  if (!userId) return { userId: null, emails: [], isPlatformAdmin: false };
  const u = await currentUser().catch(() => null);
  const emails = (u?.emailAddresses || []).map((e) => e.emailAddress.toLowerCase());
  return { userId, emails, isPlatformAdmin: emails.some((e) => isAdmin(e)) };
}

/** Resolve the caller's standing on one event. Cheap to call; do it once per request. */
export async function getActor(event: Eventish | null | undefined): Promise<Actor> {
  const identity = await getIdentity();
  if (!identity.userId) return { ...ANONYMOUS_ACTOR };
  return resolveRole(event, identity);
}

/* -------------------------------------------------------------------------- */
/*  Audit                                                                      */
/* -------------------------------------------------------------------------- */

export interface AuthzDecision {
  permission: Permission;
  allowed: boolean;
  userId: string | null;
  role: Actor["role"];
  reason: Actor["reason"];
  eventId?: string;
}

/**
 * Every decision passes through here. Writes the same structured line to the
 * Vercel log drain that it always did (for tail -f), and fire-and-forgets an
 * append into the KV-backed audit log so promotions, demotions, kicks, mutes,
 * recordings, and meeting-ends are all queryable after the fact (FRS §12.4).
 */
export function recordDecision(d: AuthzDecision): void {
  const verb = d.allowed ? "allow" : "DENY";
  console.log(
    `[authz] ${verb} ${d.permission} user=${d.userId ?? "anon"} role=${d.role} via=${d.reason}` +
      (d.eventId ? ` event=${d.eventId}` : "")
  );
  // Fire-and-forget. appendAuditEntry catches its own errors — an audit sink
  // must never be able to break the request it audits.
  void appendAuditEntry({
    ts: Date.now(),
    permission: d.permission,
    allowed: d.allowed,
    userId: d.userId,
    role: d.role,
    reason: d.reason,
    eventId: d.eventId,
  });
}

/* -------------------------------------------------------------------------- */
/*  Responses                                                                  */
/* -------------------------------------------------------------------------- */

export const unauthorized = () =>
  NextResponse.json({ error: "unauthorized" }, { status: 401 });

export const forbidden = (permission?: Permission) =>
  NextResponse.json(
    { error: "forbidden", ...(permission ? { requires: permission } : {}) },
    { status: 403 }
  );

export const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

/* -------------------------------------------------------------------------- */
/*  Inline check                                                               */
/* -------------------------------------------------------------------------- */

export type AuthorizeResult =
  | { ok: true; actor: Actor; response?: undefined }
  | { ok: false; actor: Actor; response: NextResponse };

/**
 * Inline guard for handlers that already loaded their event.
 *
 *   const ev = await eventStore.byId(id);
 *   if (!ev) return notFound();
 *   const gate = await authorize(ev, "meeting:end");
 *   if (!gate.ok) return gate.response;
 *   // gate.actor is resolved and safe to log
 */
export async function authorize(
  event: (Eventish & { id?: string }) | null | undefined,
  permission: Permission
): Promise<AuthorizeResult> {
  const actor = await getActor(event);
  const overrides = (event as { permissionOverrides?: PermissionOverrides } | null | undefined)
    ?.permissionOverrides;
  const allowed = can(actor, permission, overrides);

  recordDecision({
    permission,
    allowed,
    userId: actor.userId,
    role: actor.role,
    reason: actor.reason,
    eventId: event?.id,
  });

  if (allowed) return { ok: true, actor };
  return {
    ok: false,
    actor,
    response: actor.userId ? forbidden(permission) : unauthorized(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Route wrapper                                                              */
/* -------------------------------------------------------------------------- */

type RouteCtx = { params: Promise<Record<string, string>> };

export interface GuardedContext<P = Record<string, string>> {
  params: P;
  actor: Actor;
  event: NeoEvent;
  /** Permissions the caller holds on this event — handy for shaping the response. */
  grants: Permission[];
}

export interface RequirePermissionOptions {
  /**
   * How to find the event for this request. Defaults to `params.id` via
   * eventStore.byId, falling back to `params.slug` via eventStore.bySlug.
   * Supply your own when the identifier lives in the body or the query string.
   */
  resolveEvent?: (
    req: Request,
    params: Record<string, string>
  ) => Promise<NeoEvent | null> | NeoEvent | null;
}

async function defaultResolveEvent(
  req: Request,
  params: Record<string, string>
): Promise<NeoEvent | null> {
  if (params.id) {
    const byId = await eventStore.byId(params.id);
    if (byId) return byId;
  }
  if (params.slug) return eventStore.bySlug(params.slug);
  const qs = new URL(req.url).searchParams;
  const slug = qs.get("slug");
  if (slug) return eventStore.bySlug(slug);
  return null;
}

/**
 * Whole-route guard. Authenticates, loads the event, checks the permission,
 * and hands the handler a context where `actor` and `event` are non-null.
 *
 *   export const POST = requirePermission("meeting:end", async (req, { event, actor }) => {
 *     await eventStore.update(event.id, { state: "ended" });
 *     return NextResponse.json({ ok: true, endedBy: actor.userId });
 *   });
 *
 * A route that forgets the wrapper is now visibly different from one that has
 * it — which is the point. Grep for handlers that export a bare `POST`.
 */
export function requirePermission<P extends Record<string, string> = Record<string, string>>(
  permission: Permission,
  handler: (req: Request, ctx: GuardedContext<P>) => Promise<Response> | Response,
  options?: RequirePermissionOptions
) {
  return async function guarded(req: Request, ctx?: RouteCtx): Promise<Response> {
    const params = ((await ctx?.params) ?? {}) as Record<string, string>;

    const resolver = options?.resolveEvent ?? defaultResolveEvent;
    const event = await resolver(req, params);
    if (!event) return notFound();

    const gate = await authorize(event, permission);
    if (!gate.ok) return gate.response;

    return handler(req, {
      params: params as P,
      actor: gate.actor,
      event,
      grants: grantsFor(gate.actor, event.permissionOverrides),
    });
  };
}
