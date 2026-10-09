// /api/admin/billing/settings
//
// GET  settings and each gateway's status (billing:read). Status is whether
//      each environment variable is set — never a value or part of one.
// PUT  { gateways?: { espees?: { enabled }, stripe?: { enabled } },
//        tax?: { rules: TaxRule[] }, invoice?: InvoiceDetails }
//      (billing:settings: sensitive, fresh authenticator code). Audited with
//      before and after.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { fail, readJson } from "@/lib/admin/http";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import {
  cleanInvoiceDetails,
  cleanTaxRules,
  gatewayStatus,
  getBillingSettings,
  saveBillingSettings,
  type BillingSettings,
} from "@/lib/finance/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "billing:read");
  if (!g.ok) return g.response;
  return NextResponse.json({ ok: true, settings: await getBillingSettings(), gateways: gatewayStatus() });
}

export async function PUT(req: Request) {
  const g = await requireAdmin(req, "billing:settings");
  if (!g.ok) return g.response;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return fail("invalid_body", "Send JSON.");
  const before = await getBillingSettings();
  const next: BillingSettings = structuredClone(before);

  if (body.gateways && typeof body.gateways === "object") {
    for (const id of ["espees", "stripe"] as const) {
      const v = (body.gateways as Record<string, { enabled?: unknown } | undefined>)[id];
      if (v && typeof v.enabled === "boolean") next.gateways[id] = { enabled: v.enabled };
    }
  }
  if (body.tax !== undefined) {
    const rules = cleanTaxRules((body.tax as { rules?: unknown } | null)?.rules);
    if (typeof rules === "string") return fail("invalid_tax", rules);
    next.tax = { rules };
  }
  if (body.invoice !== undefined) next.invoice = cleanInvoiceDetails(body.invoice);

  const flat = (s: BillingSettings) => ({
    espeesEnabled: s.gateways.espees.enabled,
    stripeEnabled: s.gateways.stripe.enabled,
    taxRules: s.tax.rules.map((r) => ({ country: r.country, region: r.region ?? null, rate: r.rate, inclusive: r.inclusive, label: r.label })),
    invoice: s.invoice,
  });
  const changes = diff(flat(before), flat(next));
  if (!Object.keys(changes.after).length) return NextResponse.json({ ok: true, settings: before, unchanged: true });

  next.updatedAt = Date.now();
  next.updatedBy = g.ctx.email;
  await saveBillingSettings(next);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "billing.settings.update",
    targetType: "billing_settings",
    targetId: "billing",
    targetLabel: "Billing settings",
    before: changes.before,
    after: changes.after,
  });
  return NextResponse.json({ ok: true, settings: next });
}
