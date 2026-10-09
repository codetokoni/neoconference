"use client";

// src/app/admin/billing/shared.tsx — pieces the billing screens share:
// the payment shape the API returns, amounts that always show their
// currency, status badges, per-currency totals and a bar chart.

import { useState } from "react";
import Link from "next/link";
import { currenciesOf, currencyName, type ByCurrency } from "@/lib/finance/money";
import { fmtDate, fmtDay, fmtMoney, fmtNumber, fromZonedInput, toZonedInput } from "../AdminApi";
import { Badge } from "../ui";

export type RefundRow = {
  id: string;
  amount: number;
  currency: string;
  at: number;
  method: "stripe" | "outside";
  providerRef?: string;
  providerStatus?: string;
  reason?: string;
  byEmail: string;
  downgraded?: boolean;
};

export type Entry = {
  id: string;
  provider: "espees" | "stripe" | "manual";
  kind: "plan" | "ticket";
  ref: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  description: string;
  plan?: string;
  planId?: string;
  cycle?: string;
  amount: number;
  currency: string;
  status: "paid" | "partially_refunded" | "refunded" | "failed";
  at: number;
  periodStart?: number;
  periodEnd?: number;
  verified: boolean;
  source: string;
  invoiceNumber?: string;
  refundedAmount: number;
  refunds: RefundRow[];
  failureReason?: string;
  country?: string;
  eventId?: string;
};

/** An amount with its currency code, in the admin number format (Settings → Regional). */
export function Money({ amount, currency, className = "" }: { amount: number; currency: string; className?: string }) {
  return (
    <span className={`tabular-nums ${className}`} title={currencyName(currency)}>
      {fmtMoney(amount, currency)}
    </span>
  );
}

/** One line per currency. Never a single number for mixed currencies. */
export function Totals({ totals, empty = "—" }: { totals: ByCurrency; empty?: string }) {
  const cs = currenciesOf(totals);
  if (!cs.length) return <span className="text-zinc-400">{empty}</span>;
  return (
    <span className="flex flex-col">
      {cs.map((c) => (
        <Money key={c} amount={totals[c]} currency={c} />
      ))}
    </span>
  );
}

const STATUS: Record<Entry["status"], { label: string; tone: "green" | "amber" | "red" | "zinc" }> = {
  paid: { label: "Paid", tone: "green" },
  partially_refunded: { label: "Partly refunded", tone: "amber" },
  refunded: { label: "Refunded", tone: "zinc" },
  failed: { label: "Failed", tone: "red" },
};

export function StatusBadge({ e }: { e: Pick<Entry, "status" | "verified" | "kind"> }) {
  const s = STATUS[e.status];
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={s.tone}>{s.label}</Badge>
      {e.kind === "plan" && !e.verified && e.status !== "failed" && (
        <span title="Granted when the buyer's browser came back from eSPees. eSPees offers no way to confirm a payment, so it was never checked with them.">
          <Badge tone="amber">unverified</Badge>
        </span>
      )}
    </span>
  );
}

export const PROVIDER_LABEL: Record<Entry["provider"], string> = {
  espees: "eSPees",
  stripe: "Stripe",
  manual: "Manual",
};

export function BillingNav({ active }: { active: "payments" | "revenue" | "settings" }) {
  const tabs = [
    ["payments", "Payments", "/admin/billing/payments"],
    ["revenue", "Revenue", "/admin/billing/revenue"],
    ["settings", "Settings & reminders", "/admin/billing/settings"],
  ] as const;
  return (
    <nav aria-label="Billing" className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10">
      {tabs.map(([k, l, href]) => (
        <Link
          key={k}
          href={href}
          aria-current={active === k ? "page" : undefined}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${active === k ? "border-cyan-400 text-cyan-200" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
        >
          {l}
        </Link>
      ))}
    </nav>
  );
}

/** The calendar day of an instant on the admin clock. */
export const day = (t: number | null | undefined) => (t ? fmtDate(t) : "—");

// Date filters on the billing pages are whole days on the admin clock. The
// address bar may hold epoch ms (the Overview's links) or a day
// ("YYYY-MM-DD", what the date inputs write); the API is always sent the
// instant, since on its own it would read a bare day as UTC.

const isMs = (v: string) => /^\d+$/.test(v);
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A from/to value from the URL as the day a date input shows, on the admin clock. */
export function dayInput(v: string): string {
  if (isMs(v)) return toZonedInput(Number(v)).slice(0, 10);
  return isDay(v) ? v : "";
}

/** A from/to value from the URL as the instant the API reads: a day's first (or, for `to`, last) millisecond on the admin clock. */
export function apiTime(v: string, end: boolean): string {
  if (!v || isMs(v) || !isDay(v)) return v;
  const start = fromZonedInput(`${(end ? nextDay(v) : v)}T00:00`);
  return start == null ? v : String(end ? start - 1 : start);
}

/** True when the URL's from/to came as instants (the Overview's period). */
export const isInstantRange = (from: string, to: string) => isMs(from) && isMs(to);

export function customerHref(userId: string) {
  return `/admin/billing/payments/customers/${encodeURIComponent(userId)}`;
}

export function invoiceHref(id: string) {
  return `/admin/billing/payments/invoice/${encodeURIComponent(id)}`;
}

/** A bucket label from the revenue series ("2026-10-09" or "2026-10"), in the admin date style where it is a day. */
const bucketText = (label: string) => (/^\d{4}-\d{2}-\d{2}$/.test(label) ? fmtDay(label) : label);

/**
 * Bars for one currency over time: gross per bucket, refunds as a red cap
 * on top. One chart per currency, so no axis ever mixes two. The figures
 * are also in a table under "Show the figures", for keyboards and screen
 * readers (the hover box is for the mouse only).
 */
export function BarChart({
  currency,
  points,
  bucket = "period",
}: {
  currency: string;
  points: { label: string; gross: ByCurrency; refunds: ByCurrency }[];
  bucket?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 180;
  const padL = 44;
  const padB = 22;
  const padT = 10;
  const innerW = W - padL - 8;
  const innerH = H - padT - padB;
  const vals = points.map((p) => Math.max(p.gross[currency] ?? 0, p.refunds[currency] ?? 0));
  const max = Math.max(1, ...vals);
  const step = innerW / Math.max(1, points.length);
  const bw = Math.max(1, step * 0.7);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const h = hover != null ? points[hover] : null;
  const received = points.reduce((s, p) => s + (p.gross[currency] ?? 0), 0);
  const refunded = points.reduce((s, p) => s + (p.refunds[currency] ?? 0), 0);
  const peak = points.reduce<{ label: string; v: number } | null>((best, p) => ((p.gross[currency] ?? 0) > (best?.v ?? 0) ? { label: p.label, v: p.gross[currency] ?? 0 } : best), null);
  const summary =
    `${currency} received per ${bucket}, ${points.length} ${bucket}s: ${fmtMoney(received, currency)} received, ${fmtMoney(refunded, currency)} refunded` +
    (peak ? `; highest ${fmtMoney(peak.v, currency)} on ${bucketText(peak.label)}.` : ".");
  return (
    <div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={summary}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={padL} x2={W - 8} y1={y(max * f)} y2={y(max * f)} stroke="rgb(63,63,70)" strokeDasharray="3 4" strokeWidth="0.5" />
              <text x={padL - 6} y={y(max * f) + 3} textAnchor="end" className="fill-zinc-500" style={{ fontSize: "10px" }}>
                {fmtNumber(Math.round(max * f))}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const g = p.gross[currency] ?? 0;
            const r = p.refunds[currency] ?? 0;
            const x = padL + i * step + (step - bw) / 2;
            return (
              <g key={p.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={padL + i * step} y={padT} width={step} height={innerH} fill="transparent" />
                {g > 0 && <rect x={x} y={y(g)} width={bw} height={padT + innerH - y(g)} rx="1.5" fill={hover === i ? "rgb(103,232,249)" : "rgb(34,211,238)"} />}
                {r > 0 && <rect x={x + bw * 0.25} y={y(r)} width={bw * 0.5} height={padT + innerH - y(r)} rx="1" fill="rgb(248,113,113)" opacity="0.85" />}
                {i % labelEvery === 0 && (
                  <text x={padL + i * step + step / 2} y={H - 6} textAnchor="middle" className="fill-zinc-500" style={{ fontSize: "9px" }}>
                    {p.label.slice(5) || p.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {h && (
          <div aria-hidden className="pointer-events-none absolute right-2 top-1 rounded-lg border border-cyan-400/30 bg-black/85 px-2.5 py-1 text-xs text-zinc-100">
            <div className="text-zinc-400">{bucketText(h.label)}</div>
            <div>Received {fmtMoney(h.gross[currency] ?? 0, currency)}</div>
            {(h.refunds[currency] ?? 0) > 0 && <div className="text-red-300">Refunded {fmtMoney(h.refunds[currency] ?? 0, currency)}</div>}
          </div>
        )}
      </div>
      <details className="mt-2 text-xs text-zinc-400">
        <summary className="cursor-pointer select-none hover:text-zinc-200">Show the figures</summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{summary}</caption>
            <thead className="text-zinc-400">
              <tr>
                <th className="py-1 pr-3 font-medium capitalize">{bucket} (UTC)</th>
                <th className="py-1 pr-3 text-right font-medium">Received</th>
                <th className="py-1 text-right font-medium">Refunded</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.label} className="border-t border-white/5">
                  <td className="py-1 pr-3">{bucketText(p.label)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums text-zinc-200">{fmtMoney(p.gross[currency] ?? 0, currency)}</td>
                  <td className="py-1 text-right tabular-nums text-red-200">{fmtMoney(p.refunds[currency] ?? 0, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
