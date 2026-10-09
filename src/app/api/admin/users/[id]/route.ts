// /api/admin/users/[id] — one account.
//
// GET    everything the admin area knows about it. users:read; payments need
//        billing:read and the audit entries audit:read as well.
// PATCH  { firstName?, lastName? } — the details an administrator may edit.
//        users:write. Email addresses, passwords and sign-in methods are the
//        user's own to change (see the email and password routes for what an
//        administrator can do about them).

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, can, requireAdmin } from "@/lib/admin/context";
import { diff, listAdminAudit, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import {
  DELETION_RETENTION_DAYS,
  accessOf,
  activeSupportSession,
  displayName,
  getDeletion,
  getSuspension,
  getTags,
  isOwnerUser,
  listNotes,
  listSupportSessions,
  loadTargetUser,
  primaryEmail,
  summarize,
  targetGuard,
} from "@/lib/admin/users";
import { getRole } from "@/lib/admin/store";
import { getPlanLimits } from "@/lib/planLimits";
import { eventStore } from "@/lib/eventStore";
import { listUserMeetings } from "@/lib/userMeetings";
import { recordedSeconds, usageMonth } from "@/lib/recordingUsage";
import { listGroupsForUser } from "@/lib/groupStore";
import { listUserPayments } from "@/lib/paymentsStore";
import { getActiveSessions } from "@/lib/sessionStore";
import { isMailConfigured } from "@/lib/mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

/** Settled value or null: one store failing must not blank the whole page. */
async function soft<T>(label: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    console.error(`[admin-user] ${label} failed`, err);
    return null;
  }
}

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:read");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const { user, member } = t;
  const uid = user.id;
  const now = Date.now();
  const thisMonth = usageMonth(now);
  const lastMonth = usageMonth(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 0));

  const client = await clerkClient();
  const [tags, deletion, suspension, notes, support, mine, hosted, attended, recThis, recLast, groups, payments, clerkSessions, devices, audit, role] =
    await Promise.all([
      getTags(uid),
      getDeletion(uid),
      getSuspension(uid),
      listNotes(uid),
      listSupportSessions(uid),
      activeSupportSession(g.ctx.userId),
      soft("meetings", eventStore.listByOwner(uid)),
      soft("attended", listUserMeetings(uid, { limit: 10 })),
      soft("recording", recordedSeconds(uid, thisMonth)),
      soft("recording", recordedSeconds(uid, lastMonth)),
      soft("groups", listGroupsForUser(uid)),
      can(g.ctx, "billing:read") ? soft("payments", listUserPayments(uid, 50)) : Promise.resolve(null),
      soft("clerk sessions", client.sessions.getSessionList({ userId: uid, status: "active", limit: 50 })),
      soft("devices", getActiveSessions(uid)),
      // Anywhere the id appears: actions on the account, and group changes that name them.
      can(g.ctx, "audit:read") ? listAdminAudit({ q: uid, limit: 100 }) : Promise.resolve(null),
      member ? getRole(member.roleId) : Promise.resolve(null),
    ]);

  const row = summarize(user, { member, tags, deletion });
  const limits = getPlanLimits(row.plan);
  const meta = (user.publicMetadata ?? {}) as Record<string, unknown>;
  const refusal = await targetGuard(g.ctx, user, member);
  const refusalBody = refusal ? ((await refusal.clone().json()) as { error: string; message: string }) : null;

  return NextResponse.json({
    user: {
      ...row,
      username: (user.username as string | null | undefined) ?? null,
      emails: (user.emailAddresses ?? []).map((e) => ({
        id: e.id ?? "",
        address: e.emailAddress,
        verified: e.verification?.status === "verified",
        status: e.verification?.status ?? null,
        primary: e.emailAddress.toLowerCase() === row.email,
      })),
      passwordEnabled: !!user.passwordEnabled,
      twoFactorEnabled: !!user.twoFactorEnabled,
      meetingsCreated: typeof meta.meetingsCreated === "number" ? meta.meetingsCreated : 0,
    },
    protection: {
      isOwner: isOwnerUser(user),
      isSelf: uid === g.ctx.userId,
      refusal: refusalBody,
    },
    admin: member && accessOf(user, member) ? { roleId: member.roleId, roleName: role?.name ?? member.roleId, status: member.status } : null,
    plan: {
      effective: row.plan,
      stored: row.storedPlan,
      planExpiresAt: row.planExpiresAt,
      expired: row.planExpiresAt != null && row.planExpiresAt < now,
      lifetimeMeetingCap: limits.lifetimeMeetingCap,
      recordingHoursPerMonth: limits.recordingHoursPerMonth,
    },
    usage: {
      meetingsHosted: hosted?.length ?? null,
      recentHosted: (hosted ?? [])
        .slice()
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, 10)
        .map((e) => ({
          id: e.id,
          slug: e.slug,
          name: e.name,
          createdAt: e.createdAt,
          status: e.endedAt ? "ended" : e.startedAt ? "live" : "scheduled",
        })),
      attended: attended?.eids ?? null,
      recording: { thisMonth: { month: thisMonth, seconds: recThis }, lastMonth: { month: lastMonth, seconds: recLast } },
    },
    groups: groups?.map((s) => ({ id: s.group.id, name: s.group.name, role: s.role, memberCount: s.memberCount })) ?? null,
    payments,
    sessions: {
      clerk:
        clerkSessions?.data.map((s) => ({
          id: s.id,
          status: s.status,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          expireAt: s.expireAt,
          impersonated: !!s.actor,
          device: s.latestActivity
            ? [s.latestActivity.browserName, s.latestActivity.deviceType, s.latestActivity.city, s.latestActivity.country]
                .filter(Boolean)
                .join(" · ")
            : null,
          ip: s.latestActivity?.ipAddress ?? null,
        })) ?? null,
      devices,
    },
    audit: audit?.items ?? null,
    notes,
    deletion: deletion ? { ...deletion, due: deletion.deleteAfter <= now } : null,
    suspension: user.banned ? suspension : null,
    retentionDays: DELETION_RETENTION_DAYS,
    support: { history: support, mine: mine && mine.userId === uid ? mine : null, elsewhere: mine && mine.userId !== uid ? mine : null },
    mailConfigured: isMailConfigured(),
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "users:write");
  if (!g.ok) return g.response;
  const t = await loadTargetUser(params.id);
  if ("response" in t) return t.response;
  const refused = await targetGuard(g.ctx, t.user, t.member);
  if (refused) return refused;

  const body = await readJson<{ firstName?: unknown; lastName?: unknown }>(req);
  const clean = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 80) : undefined);
  const firstName = clean(body?.firstName);
  const lastName = clean(body?.lastName);
  if (firstName === undefined && lastName === undefined) return fail("nothing_to_change", "Send firstName and/or lastName.");
  if (firstName !== undefined && /[<>]/.test(firstName)) return fail("invalid_name", "Names cannot contain < or >.");
  if (lastName !== undefined && /[<>]/.test(lastName)) return fail("invalid_name", "Names cannot contain < or >.");

  const before = { firstName: t.user.firstName ?? null, lastName: t.user.lastName ?? null };
  const after = {
    firstName: firstName !== undefined ? firstName || null : before.firstName,
    lastName: lastName !== undefined ? lastName || null : before.lastName,
  };
  const change = diff(before, after);
  if (!Object.keys(change.after).length) return NextResponse.json({ ok: true, unchanged: true });

  const client = await clerkClient();
  // Clerk ignores an empty string for an unset name, so "" clears it.
  await client.users.updateUser(t.user.id, { firstName: after.firstName ?? "", lastName: after.lastName ?? "" });
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "user.update",
    targetType: "user",
    targetId: t.user.id,
    targetLabel: primaryEmail(t.user),
    ...change,
  });
  return NextResponse.json({ ok: true, name: displayName({ ...t.user, ...after }) });
}
