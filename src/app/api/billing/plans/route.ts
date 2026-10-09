// GET /api/billing/plans — the plans /pricing shows, from the admin plan
// catalog: listed and not archived, in the catalog's order, with their
// current terms and any promotional offer running for them. Public: the
// pricing page is. Prices in currencies other than ESP are for show and
// come marked as not connected to a payment gateway.

import { NextResponse } from "next/server";
import { CURRENCIES, NOT_CONNECTED, offerApplies } from "@/lib/billing/model";
import { listOffers, listPlans } from "@/lib/billing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const now = Date.now();
    const [plans, offers] = await Promise.all([listPlans(), listOffers()]);
    const out = plans
      .filter((p) => p.public && !p.archived)
      .map((p) => ({
        id: p.id,
        baseTier: p.baseTier,
        name: p.current.name,
        description: p.current.description,
        version: p.current.version,
        prices: p.current.prices,
        trialDays: p.current.trialDays,
        limits: p.current.limits,
        selfServe: p.selfServe,
        highlight: p.highlight,
        offers: offers
          .filter((o) => offerApplies(o, p.id, "monthly", now) || offerApplies(o, p.id, "annual", now))
          // The label is public copy; the offer's name is for admins only.
          .map((o) => ({ label: o.label || null, kind: o.kind, value: o.value, cycles: o.cycles, endsAt: o.endsAt })),
      }));
    const currencies = CURRENCIES.map((c) => ({ ...c, note: c.live ? null : NOT_CONNECTED }));
    return NextResponse.json({ ok: true, plans: out, currencies }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("[billing/plans] catalog read failed", e);
    return NextResponse.json({ ok: false, error: "catalog_unavailable" }, { status: 503 });
  }
}
