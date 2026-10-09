// src/lib/finance/settings.ts
//
// Billing settings an administrator with billing:settings can change:
// which gateways take payments, tax rules, and the seller details printed on
// invoices. One KV record:
//
//   billing:settings   BillingSettings
//
// Gateway credentials are NOT here and never will be: they are Vercel
// environment variables. gatewayStatus() reports only whether each one is
// set — never its value, not even a fragment of it.

import { kv } from "@/lib/kv";
import { stripeMode } from "@/lib/stripe";
import { isMailConfigured, mailFromAddress } from "@/lib/mail";

const KEY = "billing:settings";

export type GatewayId = "espees" | "stripe";

export interface TaxRule {
  id: string;
  /** ISO 3166-1 alpha-2 ("NG"), or "*" for everywhere else. */
  country: string;
  /** Optional state/region within the country, matched case-insensitively. */
  region?: string;
  /** Percent, e.g. 7.5. */
  rate: number;
  /** true: prices already include the tax. false: tax is added on top. */
  inclusive: boolean;
  /** Printed on the invoice: "VAT", "GST", "Sales tax". */
  label: string;
}

export interface InvoiceDetails {
  companyName: string;
  address: string;
  taxId: string;
  email: string;
  footer: string;
}

export interface BillingSettings {
  gateways: Record<GatewayId, { enabled: boolean }>;
  tax: { rules: TaxRule[] };
  invoice: InvoiceDetails;
  updatedAt?: number;
  updatedBy?: string;
}

export const DEFAULT_SETTINGS: BillingSettings = {
  gateways: { espees: { enabled: true }, stripe: { enabled: true } },
  tax: { rules: [] },
  invoice: { companyName: "NeoConference", address: "", taxId: "", email: "", footer: "" },
};

export async function getBillingSettings(): Promise<BillingSettings> {
  const raw = (await kv.get<BillingSettings>(KEY)) as Partial<BillingSettings> | null;
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  return {
    gateways: { ...DEFAULT_SETTINGS.gateways, ...(raw.gateways ?? {}) },
    tax: { rules: raw.tax?.rules ?? [] },
    invoice: { ...DEFAULT_SETTINGS.invoice, ...(raw.invoice ?? {}) },
    updatedAt: raw.updatedAt,
    updatedBy: raw.updatedBy,
  };
}

export async function saveBillingSettings(s: BillingSettings): Promise<void> {
  await kv.set(KEY, s);
}

/** Whether checkout through this gateway is switched on (it is unless an admin turned it off). */
export async function gatewayEnabled(id: GatewayId): Promise<boolean> {
  try {
    return (await getBillingSettings()).gateways[id]?.enabled !== false;
  } catch {
    // Settings unreadable: do not take payments down with them.
    return true;
  }
}

/* ------------------------------ validation ------------------------------ */

const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function cleanTaxRules(input: unknown): TaxRule[] | string {
  if (!Array.isArray(input)) return [];
  const out: TaxRule[] = [];
  const seen = new Set<string>();
  for (const r of input.slice(0, 200)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const country = s(o.country, 40).toUpperCase() || "*";
    if (country !== "*" && !/^[A-Z]{2}$/.test(country)) return `"${country}" is not a two-letter country code.`;
    const region = s(o.region, 60);
    const rate = Number(o.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return `The rate for ${country} must be between 0 and 100.`;
    const k = `${country}|${region.toLowerCase()}`;
    if (seen.has(k)) return `There are two rules for ${country}${region ? ` / ${region}` : ""}.`;
    seen.add(k);
    out.push({
      id: s(o.id, 40) || `tax_${Math.random().toString(36).slice(2, 9)}`,
      country,
      ...(region ? { region } : {}),
      rate: Math.round(rate * 1000) / 1000,
      inclusive: o.inclusive !== false,
      label: s(o.label, 30) || "Tax",
    });
  }
  return out;
}

export function cleanInvoiceDetails(input: unknown): InvoiceDetails {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    companyName: s(o.companyName, 120) || DEFAULT_SETTINGS.invoice.companyName,
    address: s(o.address, 500),
    taxId: s(o.taxId, 60),
    email: s(o.email, 120),
    footer: s(o.footer, 500),
  };
}

/** The most specific rule: country + region, then country, then "*". */
export function taxRuleFor(rules: TaxRule[], country?: string | null, region?: string | null): TaxRule | null {
  const c = (country ?? "").toUpperCase();
  const r = (region ?? "").toLowerCase();
  return (
    (c && r && rules.find((x) => x.country === c && (x.region ?? "").toLowerCase() === r)) ||
    (c && rules.find((x) => x.country === c && !x.region)) ||
    rules.find((x) => x.country === "*") ||
    null
  );
}

/* ---------------------------- gateway status ---------------------------- */

export interface GatewayStatus {
  id: string;
  name: string;
  /** Every variable it needs is set. */
  configured: boolean;
  /** Variable names and whether each is set — names only, never values. */
  vars: { name: string; set: boolean; secret: boolean }[];
  notes: string[];
  capabilities: { verify: boolean; webhook: boolean; refund: boolean };
}

const has = (name: string) => Boolean((process.env[name] || "").trim());

export function gatewayStatus(): GatewayStatus[] {
  const espeesVars = [
    { name: "ESPEES_API_KEY", set: has("ESPEES_API_KEY"), secret: true },
    { name: "ESPEES_MERCHANT_WALLET", set: has("ESPEES_MERCHANT_WALLET"), secret: true },
    { name: "ESPEES_PRODUCT_SKU", set: has("ESPEES_PRODUCT_SKU"), secret: false },
  ];
  const stripeVars = [
    { name: "STRIPE_SECRET_KEY", set: has("STRIPE_SECRET_KEY"), secret: true },
    { name: "STRIPE_WEBHOOK_SECRET", set: has("STRIPE_WEBHOOK_SECRET"), secret: true },
  ];
  const mode = stripeMode();
  return [
    {
      id: "espees",
      name: "eSPees (plans)",
      configured: espeesVars.every((v) => v.set),
      vars: espeesVars,
      notes: [
        "eSPees publishes no API for checking a payment, no webhook and no refund call that NeoConference can use. A plan is granted when the buyer's browser returns from eSPees, and is marked unverified.",
        "Refunds of eSPees payments are made outside NeoConference and recorded here.",
      ],
      capabilities: { verify: false, webhook: false, refund: false },
    },
    {
      id: "stripe",
      name: "Stripe (event tickets)",
      configured: stripeVars.every((v) => v.set),
      vars: stripeVars,
      notes: [
        mode ? `Key mode: ${mode}.` : "No key set: ticket checkout is off.",
        "Card details are entered on Stripe's own page and never reach NeoConference.",
      ],
      capabilities: { verify: true, webhook: true, refund: true },
    },
    {
      id: "resend",
      name: "Resend (billing emails)",
      configured: isMailConfigured(),
      vars: [
        { name: "RESEND_API_KEY", set: has("RESEND_API_KEY"), secret: true },
        { name: "MAIL_FROM", set: has("MAIL_FROM"), secret: false },
      ],
      notes: [`Reminders are sent from ${mailFromAddress()}.`],
      capabilities: { verify: false, webhook: false, refund: false },
    },
    {
      id: "cron",
      name: "Scheduled jobs",
      configured: has("CRON_SECRET"),
      vars: [{ name: "CRON_SECRET", set: has("CRON_SECRET"), secret: true }],
      notes: ["Without CRON_SECRET only Vercel's own scheduler can start the reminder job."],
      capabilities: { verify: false, webhook: false, refund: false },
    },
  ];
}
