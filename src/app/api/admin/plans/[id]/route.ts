// /api/admin/plans/[id] — one plan.
//
// GET   (plans:read)   the plan, every version, subscribers per version
// PATCH (plans:write)  { terms?: { name, description, prices, trialDays,
//                        limits }, settings?: { selfServe, public, highlight,
//                        archived }, note? }
//
// Changed terms are saved as a new version and become what new purchases
// get. Subscribers keep the version they bought — moving them is the
// separate, previewed migrate route. Settings are not versioned.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson, str } from "@/lib/admin/http";
import { cleanTerms, espPrice, termsDiff, type PlanDef, type PlanTerms } from "@/lib/billing/model";
import { addVersion, forgetFreeLimits, getPlan, listVersions, saveDef } from "@/lib/billing/store";
import { subscriberCounts } from "@/lib/billing/adminViews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

const termsOf = (v: PlanTerms): PlanTerms => ({ name: v.name, description: v.description, prices: v.prices, trialDays: v.trialDays, limits: v.limits });
const settingsOf = (d: PlanDef) => ({ selfServe: d.selfServe, public: d.public, highlight: d.highlight, archived: d.archived });

export async function GET(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "plans:read");
  if (!g.ok) return g.response;
  const plan = await getPlan(params.id);
  if (!plan) return fail("not_found", "That plan was not found.", 404);
  const [versions, counts] = await Promise.all([listVersions(plan.id), subscriberCounts()]);
  return NextResponse.json({ ok: true, plan, versions, subscribers: counts[plan.id] ?? { total: 0, live: 0, byVersion: {} } });
}

export async function PATCH(req: Request, { params }: Params) {
  const g = await requireAdmin(req, "plans:write");
  if (!g.ok) return g.response;
  const plan = await getPlan(params.id);
  if (!plan) return fail("not_found", "That plan was not found.", 404);
  const body = await readJson(req);
  if (!body) return fail("bad_request", "Send the change as JSON.");
  const isFree = plan.id === "free";

  const before = termsOf(plan.current);
  let terms = before;
  if (body.terms !== undefined) {
    const t = cleanTerms(body.terms, before);
    if (typeof t === "string") return fail("bad_terms", t);
    terms = t;
  }
  if (isFree) {
    const priced = Object.values(terms.prices).some((p) => (p?.monthly ?? 0) > 0 || (p?.annual ?? 0) > 0);
    if (priced || terms.trialDays) return fail("free_is_free", "Free has no price and no trial. Make a new plan to sell.");
  }

  const s = (body.settings ?? {}) as Record<string, unknown>;
  const settings = {
    selfServe: typeof s.selfServe === "boolean" ? s.selfServe : plan.selfServe,
    public: typeof s.public === "boolean" ? s.public : plan.public,
    highlight: typeof s.highlight === "boolean" ? s.highlight : plan.highlight,
    archived: typeof s.archived === "boolean" ? s.archived : plan.archived,
  };
  if (isFree && (settings.archived || settings.selfServe)) {
    return fail("free_is_fixed", "Free is what every account without a subscription has: it cannot be archived or sold.");
  }
  if (settings.selfServe && !settings.archived && !espPrice(terms.prices, "monthly") && !espPrice(terms.prices, "annual")) {
    return fail("needs_esp_price", "A plan sold at checkout needs an ESP price: eSPees is the only payment gateway connected.");
  }

  const changedTerms = termsDiff(before, terms);
  const changedSettings = diff(settingsOf(plan), settings);
  if (!Object.keys(changedTerms).length && !Object.keys(changedSettings.after).length) {
    return NextResponse.json({ ok: true, plan, unchanged: true });
  }

  const { current: _current, ...defOnly } = plan;
  void _current;
  let def: PlanDef = { ...defOnly, ...settings, updatedAt: Date.now() };
  let version = plan.current;
  const note = str(body.note, 300) || undefined;
  if (Object.keys(changedTerms).length) {
    ({ def, version } = await addVersion(def, terms, g.ctx.email, note));
  } else {
    await saveDef(def);
  }
  if (isFree) forgetFreeLimits();

  const auditBefore: Record<string, unknown> = { ...changedSettings.before };
  const auditAfter: Record<string, unknown> = { ...changedSettings.after };
  for (const [k, [a, b]] of Object.entries(changedTerms)) {
    auditBefore[k] = a;
    auditAfter[k] = b;
  }
  if (Object.keys(changedTerms).length) {
    auditBefore.version = plan.current.version;
    auditAfter.version = version.version;
  }
  await recordAdminAction(actorOf(g.ctx), req, {
    action: Object.keys(changedTerms).length ? "plan.version" : "plan.settings",
    targetType: "plan",
    targetId: plan.id,
    targetLabel: version.name,
    before: auditBefore,
    after: auditAfter,
    note,
  });
  const counts = await subscriberCounts();
  return NextResponse.json({
    ok: true,
    plan: { ...def, current: version },
    newVersion: Object.keys(changedTerms).length ? version.version : null,
    subscribers: counts[plan.id] ?? { total: 0, live: 0, byVersion: {} },
  });
}
