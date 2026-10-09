// /api/admin/plans — the subscription plan catalog.
//
// GET  (plans:read)   every plan (archived too) in display order, its current
//                     version, and how many subscribers each version has
// POST (plans:write)  { id?, baseTier, name, description, prices, trialDays,
//                       limits, selfServe, public, highlight } a new plan.
//                     The five tiers already exist; a new plan names the
//                     tier the rest of the app treats it as (model.ts).

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { PLANS, isPlan } from "@/lib/planLimits";
import {
  CURRENCIES,
  LIMIT_FIELDS,
  PLAN_ID_RE,
  PRORATION_RULE,
  cleanTerms,
  espPrice,
  isTierId,
  slugPlanId,
} from "@/lib/billing/model";
import { createPlan, getPlan, getPlanDef, listPlans } from "@/lib/billing/store";
import { subscriberCounts } from "@/lib/billing/adminViews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "plans:read");
  if (!g.ok) return g.response;
  const [plans, counts] = await Promise.all([listPlans(), subscriberCounts()]);
  return NextResponse.json({
    ok: true,
    plans: plans.map((p) => ({ ...p, subscribers: counts[p.id] ?? { total: 0, live: 0, byVersion: {} } })),
    currencies: CURRENCIES,
    limitFields: LIMIT_FIELDS,
    tiers: PLANS,
    prorationRule: PRORATION_RULE,
  });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const body = await readJson(req);
  if (!body) return fail("bad_request", "Send the plan as JSON.");
  const baseTier = body.baseTier;
  if (!isPlan(baseTier) || baseTier === "free") {
    return fail("bad_base_tier", "Choose the tier this plan is treated as: Starter, Pro, Business or Enterprise.");
  }
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim().toLowerCase() : slugPlanId(String(body.name ?? ""));
  if (!PLAN_ID_RE.test(id)) return fail("bad_id", "A plan id is 2–40 lowercase letters, digits and dashes.");
  // "reorder" is a route under /api/admin/plans.
  if (isTierId(id) || id === "reorder" || (await getPlanDef(id))) return fail("id_taken", `There is already a plan "${id}".`, 409);
  const tier = await getPlan(baseTier);
  const terms = cleanTerms(body, {
    name: "",
    description: "",
    prices: {},
    trialDays: 0,
    limits: tier!.current.limits,
  });
  if (typeof terms === "string") return fail("bad_terms", terms);
  const selfServe = body.selfServe === true;
  if (selfServe && !espPrice(terms.prices, "monthly") && !espPrice(terms.prices, "annual")) {
    return fail("needs_esp_price", "A plan sold at checkout needs an ESP price: eSPees is the only payment gateway connected.");
  }
  const plan = await createPlan(
    { id, baseTier, selfServe, public: body.public === true, highlight: body.highlight === true },
    terms,
    g.ctx.email,
  );
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "plan.create",
    targetType: "plan",
    targetId: plan.id,
    targetLabel: plan.current.name,
    after: { baseTier, selfServe: plan.selfServe, public: plan.public, version: 1, ...terms },
  });
  return NextResponse.json({ ok: true, plan }, { status: 201 });
}
