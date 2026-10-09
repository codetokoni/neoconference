// /api/admin/features/accounts — allow or deny a feature for one account,
// whatever its plan says (a global "off" still wins).
//
// GET ?user=<email or user id>  (features:write, no fresh code to look)
//     the account, its plan, its overrides and what is in effect, feature by feature
// PUT (features:write + fresh code)  { user, feature, value: "allow" | "deny" | null }
//
// The owner's account cannot be given overrides: nothing stored can lower it.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { isOwnerEmailList, type ClerkEmailish } from "@/lib/admin/owner";
import { getPlanForUserId, getPlanLimits, isAdminUserId } from "@/lib/plan";
import { featureDecisions } from "@/lib/platform/features";
import { getAccountOverrides, setAccountOverrides } from "@/lib/platform/settings";
import { FEATURE_KEYS, isFeatureKey, type FeatureKey } from "@/lib/platform/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Found = { userId: string; email: string; isOwner: boolean };

async function findAccount(q: string): Promise<Found | null> {
  const client = await clerkClient();
  try {
    let user;
    if (q.includes("@")) {
      const list = await client.users.getUserList({ emailAddress: [q.toLowerCase()], limit: 1 });
      user = list.data[0];
    } else {
      user = await client.users.getUser(q);
    }
    if (!user) return null;
    const emails = (user.emailAddresses ?? []) as ClerkEmailish[];
    return { userId: user.id, email: emails[0]?.emailAddress?.toLowerCase() ?? "", isOwner: isOwnerEmailList(emails) };
  } catch {
    return null;
  }
}

async function effective(userId: string) {
  const plan = await getPlanForUserId(userId);
  const limits = getPlanLimits(plan);
  const decisions = await featureDecisions(FEATURE_KEYS, {
    userId,
    plan,
    exempt: await isAdminUserId(userId),
    planAllows: { recording: limits.recording, translation: limits.translation, livestream: limits.livestream, breakouts: limits.breakouts, branding: limits.branding },
  });
  return { plan, decisions };
}

export async function GET(req: Request) {
  const g = await requireAdmin(req, "features:write", { readOnly: true });
  if (!g.ok) return g.response;
  const q = new URL(req.url).searchParams.get("user")?.trim() ?? "";
  if (!q) return fail("user_required", "Enter an email address or user id.");
  const found = await findAccount(q);
  if (!found) return fail("no_account", "No account with that email address or id.", 404);
  const [overrides, eff] = await Promise.all([getAccountOverrides(found.userId), effective(found.userId)]);
  return NextResponse.json({ ok: true, account: found, overrides, ...eff });
}

export async function PUT(req: Request) {
  const g = await requireAdmin(req, "features:write");
  if (!g.ok) return g.response;
  const body = await readJson<{ user?: unknown; feature?: unknown; value?: unknown }>(req);
  const q = str(body?.user, 200);
  if (!q) return fail("user_required", "Enter an email address or user id.");
  if (!isFeatureKey(body?.feature)) return fail("unknown_feature", "Choose a feature.");
  const feature = body!.feature as FeatureKey;
  const value = body?.value;
  if (value !== "allow" && value !== "deny" && value !== null) return fail("invalid_value", 'The override is "allow", "deny", or null to follow the plan.');

  const found = await findAccount(q);
  if (!found) return fail("no_account", "No account with that email address or id.", 404);
  if (found.isOwner) return fail("owner_protected", "The platform owner's account always has every feature; it cannot be overridden.", 403);

  const before = await getAccountOverrides(found.userId);
  const next = { ...before };
  if (value === null) delete next[feature];
  else next[feature] = value;
  await setAccountOverrides(found.userId, next);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "feature.account_override",
    targetType: "user",
    targetId: found.userId,
    targetLabel: found.email,
    before: { [feature]: before[feature] ?? null },
    after: { [feature]: value },
  });
  return NextResponse.json({ ok: true, account: found, overrides: next, ...(await effective(found.userId)) });
}
