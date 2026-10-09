// /api/admin/subscriptions/[userId] — one account's subscription.
//
// GET  (plans:read)  the account, its subscription record, its history, and
//                    (with billing:read) its payments
// POST (subscriptions:write)
//      { action, ...fields, preview?: true, reason? }
//      action: assign | change | extend | pause | resume | cancel | comp |
//              custom | addons | unschedule  (fields: subscriptions.ts
//              SubActionInput)
//      With preview nothing is written: the answer says what would happen
//      (`lines`, including the proration). Without it the change is made,
//      written to Clerk, added to the history and to the admin audit log.
//
// The platform owner is refused for every action (owner_protected): the
// owner is enterprise by identity, never by subscription.

import { NextResponse } from "next/server";
import { actorOf, can, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { listUserPayments } from "@/lib/paymentsStore";
import { PRORATION_RULE, summarize } from "@/lib/billing/model";
import { OwnerProtected, SUB_ACTIONS, commitPlanned, getHistory, getSubscription, planAction } from "@/lib/billing/subscriptions";
import { loadTarget, subscriptionTarget } from "@/lib/billing/adminViews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { userId: string } };

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "plans:read");
  if (!g.ok) return g.response;
  const target = await loadTarget(params.userId);
  if (!target) return fail("not_found", "There is no account with that id.", 404);
  const [subscription, history, payments] = await Promise.all([
    getSubscription(target.userId),
    getHistory(target.userId),
    can(g.ctx, "billing:read") ? listUserPayments(target.userId, 50) : Promise.resolve(null),
  ]);
  return NextResponse.json({
    ok: true,
    user: {
      userId: target.userId,
      email: target.email,
      name: target.name,
      isOwner: target.isOwner,
      clerk: {
        plan: target.metadata.plan ?? null,
        planExpiresAt: target.metadata.planExpiresAt ?? null,
        planId: target.metadata.planId ?? null,
        planVersion: target.metadata.planVersion ?? null,
      },
    },
    subscription,
    history,
    payments,
    prorationRule: PRORATION_RULE,
  });
}

export async function POST(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "subscriptions:write");
  if (!g.ok) return g.response;
  const body = await readJson(req);
  const t = await subscriptionTarget(params.userId);
  if (!t.ok) {
    // A refused attempt on the owner is worth a line in the audit log.
    if (t.response.status === 403 && body?.preview !== true) {
      await recordAdminAction(actorOf(g.ctx), req, {
        action: "subscription.refused",
        targetType: "user",
        targetId: params.userId,
        outcome: "denied",
        note: `owner_protected: ${String(body?.action ?? "")}`,
      });
    }
    return t.response;
  }
  const { target } = t;
  if (!body || !(SUB_ACTIONS as readonly string[]).includes(String(body.action))) {
    return fail("bad_action", `Choose an action: ${SUB_ACTIONS.join(", ")}.`);
  }
  const current = await getSubscription(target.userId);
  const planned = await planAction(target.userId, target.email, current, body, actorOf(g.ctx));
  if (!planned.ok) return fail(planned.error, planned.message, 400);
  if (body.preview === true) {
    return NextResponse.json({ ok: true, preview: true, summary: planned.summary, lines: planned.lines, proration: planned.proration ?? null, before: summarize(current), after: summarize(planned.next) });
  }
  const reason = str(body.reason, 300) || undefined;
  let next;
  try {
    next = await commitPlanned(planned.next, current, actorOf(g.ctx), `admin.${body.action}`, planned.summary, reason);
  } catch (e) {
    if (e instanceof OwnerProtected) return fail("owner_protected", e.message, 403);
    console.error("[admin/subscriptions] commit failed", target.userId, e);
    return fail("clerk_update_failed", "The account could not be updated in Clerk, so nothing was changed. Try again.", 502);
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: `subscription.${body.action}`,
    targetType: "user",
    targetId: target.userId,
    targetLabel: target.email,
    before: summarize(current),
    after: summarize(next),
    note: [planned.summary, reason].filter(Boolean).join(" — "),
  });
  return NextResponse.json({ ok: true, preview: false, summary: planned.summary, lines: planned.lines, subscription: next, history: await getHistory(target.userId) });
}
