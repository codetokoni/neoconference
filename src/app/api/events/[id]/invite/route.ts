// src/app/api/events/[id]/invite/route.ts
// Owner-only POST. Adds invitees to an event by email.
// Stored as RoleAssignment[] entries with identifier=email and role.
// If CLERK_SECRET_KEY is configured, also fires Clerk magic-link invitation
// so the recipient lands at the event page after sign-in.
// On collision with an existing Clerk user (identifier_exists), we silently
// auto-link by email and return success per platform policy.

import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";
import type { EventRole, RoleAssignment } from "@/types/event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: ReadonlyArray<EventRole> = ["host", "cohost", "speaker", "viewer"];

function isEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const check = await assertOwnerOrAdmin(ev, userId);
  if (!check.ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: any = {};
  try { body = await req.json(); } catch {}
  const emailsRaw = Array.isArray(body.emails) ? body.emails : (typeof body.emails === "string" ? String(body.emails).split(/[\s,;]+/) : []);
  const role: EventRole = ROLES.includes(body.role) ? body.role : "speaker";
  const preApproved = Boolean(body.preApproved);
  const sendEmail = body.sendEmail !== false;

  const emails = (emailsRaw as string[])
    .map((e) => String(e || "").trim().toLowerCase())
    .filter((e) => e && isEmail(e));

  if (emails.length === 0) {
    return NextResponse.json({ error: "no_valid_emails" }, { status: 400 });
  }
  // Build the new role assignments (de-duped vs existing).
  const existing = new Set((ev.roles || []).map((r) => r.identifier.toLowerCase()));
  const additions: RoleAssignment[] = [];
  for (const email of emails) {
    if (existing.has(email)) continue;
    additions.push({ identifier: email, role, label: email, preApproved });
    existing.add(email);
  }

  if (additions.length > 0) {
    await eventStore.update(ev.id, (prev) => ({
      ...prev,
      roles: [...(prev.roles || []), ...additions],
      updatedAt: new Date().toISOString(),
    }));
  }

  // Best-effort Clerk magic-link invitations.
  // Failure is non-fatal: caller still gets a 200 with results array.
  const invited: Array<{ email: string; status: "sent" | "linked" | "skipped" | "error"; reason?: string }> = [];
  const clerkConfigured = Boolean(process.env.CLERK_SECRET_KEY);
  const origin = req.headers.get("origin") || (process.env.NEXT_PUBLIC_APP_URL || "");
  const redirectUrl = origin ? origin + "/e/" + ev.slug : undefined;

  if (sendEmail && clerkConfigured) {
    let cc: any = null;
    try { cc = await clerkClient(); } catch { cc = null; }
    for (const email of emails) {
      try {
        if (cc?.invitations?.createInvitation) {
          await cc.invitations.createInvitation({
            emailAddress: email,
            redirectUrl,
            publicMetadata: { neoEventId: ev.id, neoEventSlug: ev.slug, neoRole: role },
            ignoreExisting: true,
          });
          invited.push({ email, status: "sent" });
        } else {
          invited.push({ email, status: "skipped", reason: "no_invitations_api" });
        }
      } catch (err: any) {
        const msg = (err && (err.errors?.[0]?.code || err.message)) || "unknown";
        // Auto-link policy: collisions on existing user are treated as linked-success.
        if (String(msg).includes("identifier_exists") || String(msg).includes("already_invited")) {
          invited.push({ email, status: "linked" });
        } else {
          invited.push({ email, status: "error", reason: String(msg).slice(0, 120) });
        }
      }
    }
  } else {
    for (const email of emails) {
      invited.push({ email, status: clerkConfigured ? "skipped" : "skipped", reason: clerkConfigured ? "email_disabled" : "clerk_not_configured" });
    }
  }

  return NextResponse.json({
    ok: true,
    added: additions.length,
    invited,
  });
}
