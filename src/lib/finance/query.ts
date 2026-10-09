// src/lib/finance/query.ts — reading the admin billing routes' query strings.

import type { EntryStatus, LedgerQuery, Provider } from "@/lib/finance/ledger";

/** YYYY-MM-DD (UTC, `to` covers the whole day) or epoch ms. */
export function timeParam(v: string | null, endOfDay: boolean): number | undefined {
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) ? t + (endOfDay ? 86_400_000 - 1 : 0) : undefined;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

const STATUSES = ["paid", "partially_refunded", "refunded", "failed", "refunds"];
const PROVIDERS = ["espees", "stripe", "manual"];

export function ledgerQuery(p: URLSearchParams): LedgerQuery {
  const status = p.get("status") ?? "";
  const provider = p.get("provider") ?? "";
  return {
    from: timeParam(p.get("from"), false),
    to: timeParam(p.get("to"), true),
    status: STATUSES.includes(status) ? (status as EntryStatus | "refunds") : undefined,
    provider: PROVIDERS.includes(provider) ? (provider as Provider) : undefined,
    plan: (p.get("plan") || "").trim().slice(0, 60) || undefined,
    user: (p.get("user") || "").trim().slice(0, 120) || undefined,
    q: (p.get("q") || "").trim().slice(0, 120) || undefined,
    offset: Number(p.get("offset")) || 0,
    limit: Number(p.get("limit")) || 50,
  };
}

/** A ledger id from a route segment ("pay:<ref>" / "tkt:<id>"), decoded once. */
export function entryIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
