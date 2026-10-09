// /api/admin/registration/clerk — the registration rules as Clerk sees them.
//
// GET  (settings:write)  Clerk's allowlist and blocklist identifiers (read only)
// POST (settings:write + fresh code)  copy the blocked email domains into
//      Clerk's blocklist as "*@domain", so Clerk refuses those sign-ups
//      itself; entries this route added earlier for domains no longer
//      blocked are removed. Entries made in the Clerk dashboard are never
//      touched.
//
// The app's own gate (src/lib/platform/gate.ts) enforces every rule either
// way; this only stops a blocked sign-up earlier. Refused when a blocked
// domain is the owner's or an administrator's: in older Clerk instances the
// blocklist also applies to sign-in.
//
// Only in the Clerk dashboard (no Backend API): the sign-up mode
// (Public / Restricted / Waitlist), and requiring email verification at
// sign-up (User & authentication → Email).

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { ownerEmails } from "@/lib/admin/owner";
import { listMembers } from "@/lib/admin/store";
import { getAdminEmails } from "@/lib/roles";
import { domainMatches, domainOf } from "@/lib/platform/model";
import { getPlatformSettings } from "@/lib/platform/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** domain -> Clerk blocklist identifier id, for entries this route made. */
const PUSHED = "neo:settings:clerk-blocklist";

type Identifier = { id: string; identifier: string; identifierType?: string; createdAt?: number };

async function clerkLists() {
  const client = await clerkClient();
  const [allow, block] = await Promise.all([
    client.allowlistIdentifiers.getAllowlistIdentifierList({ limit: 200 }),
    client.blocklistIdentifiers.getBlocklistIdentifierList({ limit: 200 }),
  ]);
  const shape = (x: Identifier) => ({ id: x.id, identifier: x.identifier, type: x.identifierType ?? null, createdAt: x.createdAt ?? null });
  return { allowlist: (allow.data as Identifier[]).map(shape), blocklist: (block.data as Identifier[]).map(shape) };
}

export async function GET(req: Request) {
  const g = await requireAdmin(req, "settings:write");
  if (!g.ok) return g.response;
  try {
    const [lists, pushed] = await Promise.all([clerkLists(), kv.hgetall(PUSHED)]);
    return NextResponse.json({ ok: true, ...lists, pushedByApp: Object.keys(pushed ?? {}), dashboardOnly: DASHBOARD_ONLY });
  } catch (err) {
    console.error("[admin/registration/clerk] read failed", err);
    return fail("clerk_unreachable", "Could not read the restrictions from Clerk.", 502);
  }
}

const DASHBOARD_ONLY = [
  "Sign-up mode (Public / Restricted / Waitlist): Clerk dashboard → Configure → Restrictions. The app's own gate enforces Closed and Invite-only either way.",
  "Requiring email verification at sign-up: Clerk dashboard → User & authentication → Email. The app's own gate refuses unverified new accounts when the rule is on.",
  "Whether the allowlist and blocklist also apply to sign-in (older Clerk instances): Clerk dashboard → Restrictions.",
];

export async function POST(req: Request) {
  const g = await requireAdmin(req, "settings:write", { stepUp: true });
  if (!g.ok) return g.response;
  const { registration } = await getPlatformSettings();
  const blocked = registration.blockDomains.map((d) => d.value);

  // Never push a domain that would catch the owner or an administrator.
  const staffEmails = [...ownerEmails(), ...getAdminEmails(), ...(await listMembers()).filter((m) => m.status === "active").map((m) => m.email)];
  const clash = blocked.filter((d) => staffEmails.some((e) => e && domainMatches(domainOf(e), d)));
  if (clash.length) {
    return fail(
      "would_block_staff",
      `Not sent to Clerk: ${clash.join(", ")} would also catch the owner or an administrator. The app still blocks new accounts from it.`,
      409,
      { domains: clash },
    );
  }

  const client = await clerkClient();
  const pushed = ((await kv.hgetall(PUSHED)) ?? {}) as Record<string, string>;
  const added: string[] = [];
  const removed: string[] = [];
  try {
    const existing = (await client.blocklistIdentifiers.getBlocklistIdentifierList({ limit: 500 })).data as Identifier[];
    for (const d of blocked) {
      if (pushed[d]) continue;
      const identifier = `*@${d}`;
      const already = existing.find((x) => x.identifier.toLowerCase() === identifier);
      const id = already ? already.id : (await client.blocklistIdentifiers.createBlocklistIdentifier({ identifier })).id;
      // An entry that was already there was not made here: remember it as ours only if we created it.
      if (!already) {
        pushed[d] = id;
        await kv.hset(PUSHED, { [d]: id });
        added.push(d);
      }
    }
    for (const [d, id] of Object.entries(pushed)) {
      if (blocked.includes(d)) continue;
      await client.blocklistIdentifiers.deleteBlocklistIdentifier(id).catch(() => undefined);
      await kv.hdel(PUSHED, d);
      removed.push(d);
    }
    if (blocked.length) await client.instance.updateRestrictions({ blocklist: true });
  } catch (err) {
    console.error("[admin/registration/clerk] sync failed", err);
    await recordAdminAction(actorOf(g.ctx), req, { action: "registration.clerk_sync", targetType: "clerk", targetId: "blocklist", after: { added, removed }, outcome: "failed", note: String((err as Error)?.message ?? err).slice(0, 200) });
    return fail("clerk_failed", "Clerk refused part of the change; what was done is in the audit log.", 502, { added, removed });
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "registration.clerk_sync",
    targetType: "clerk",
    targetId: "blocklist",
    targetLabel: "Clerk blocklist",
    before: { pushed: Object.keys(pushed).filter((d) => !added.includes(d)).concat(removed) },
    after: { added, removed, blocklistOn: blocked.length > 0 },
  });
  return NextResponse.json({ ok: true, added, removed, ...(await clerkLists()) });
}
