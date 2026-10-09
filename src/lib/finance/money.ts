// src/lib/finance/money.ts
//
// Amounts in the admin billing area. Pure — safe for client components.
//
// Every amount travels with its currency and is shown with it. Totals are
// kept per currency (a Record<currency, amount>) and never added across
// currencies: 10 ESP and 10 USD are not 20 of anything.

/** Upper-case currency code: "ESP" for Espees, ISO 4217 for the rest. */
export type Currency = string;

export const CURRENCY_NAMES: Record<string, string> = {
  ESP: "Espees",
  USD: "US dollars",
  EUR: "Euros",
  GBP: "Pounds sterling",
  NGN: "Naira",
  ZAR: "Rand",
  KES: "Kenyan shillings",
  GHS: "Cedis",
  CAD: "Canadian dollars",
};

/** Currencies with no minor unit (Stripe amounts in them are whole units). */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

export function normCurrency(c: string | null | undefined): Currency {
  const s = String(c ?? "").trim().toUpperCase();
  // The ticket editor stores Espees as "espees".
  if (s === "ESPEES") return "ESP";
  return s || "ESP";
}

export function minorDigits(currency: Currency): number {
  return ZERO_DECIMAL.has(normCurrency(currency)) ? 0 : 2;
}

/** Stripe-style minor units (cents) to an amount. */
export function fromMinor(minor: number, currency: Currency): number {
  return round(minor / 10 ** minorDigits(currency), currency);
}

export function toMinor(amount: number, currency: Currency): number {
  return Math.round(amount * 10 ** minorDigits(currency));
}

export function round(amount: number, currency: Currency = "ESP"): number {
  const f = 10 ** minorDigits(currency);
  return Math.round(amount * f) / f;
}

/** "1,250.00 ESP" — the code always follows the number. */
export function fmtMoney(amount: number, currency: Currency): string {
  const c = normCurrency(currency);
  const d = minorDigits(c);
  const n = Number.isFinite(amount) ? amount : 0;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })} ${c}`;
}

export function currencyName(c: Currency): string {
  return CURRENCY_NAMES[normCurrency(c)] ?? normCurrency(c);
}

export type ByCurrency = Record<Currency, number>;

export function addTo(totals: ByCurrency, currency: Currency, amount: number): ByCurrency {
  const c = normCurrency(currency);
  totals[c] = round((totals[c] ?? 0) + amount, c);
  return totals;
}

/** Currencies in a stable order: Espees first, then alphabetical. */
export function currenciesOf(...totals: ByCurrency[]): Currency[] {
  const all = new Set<string>();
  for (const t of totals) for (const k of Object.keys(t)) all.add(k);
  return [...all].sort((a, b) => (a === "ESP" ? -1 : b === "ESP" ? 1 : a.localeCompare(b)));
}

/** Percentage change, or null when there is nothing to compare against. */
export function pctChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}
