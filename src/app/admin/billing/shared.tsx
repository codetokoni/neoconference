"use client";

// src/app/admin/billing/shared.tsx — pieces the billing screens share:
// the payment shape the API returns, amounts that always show their
// currency, status badges, per-currency totals and a bar chart.

import { useState } from "react";
import Link from "next/link";
import { currenciesOf, currencyName, fmtMoney, type ByCurrency } from "@/lib/finance/money";
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
  if (!cs.length) return <span className="text-zinc-500">{empty}</span>;
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

export const day = (t: number | undefined) => (t ? new Date(t).toISOString().slice(0, 10) : "—");

export function customerHref(userId: string) {
  return `/admin/billing/payments/customers/${encodeURIComponent(userId)}`;
}

export function invoiceHref(id: string) {
  return `/admin/billing/payments/invoice/${encodeURIComponent(id)}`;
}

/**
 * Bars for one currency over time: gross per bucket, refunds as a red cap
 * on top. One chart per currency, so no axis ever mixes two.
 */
export function BarChart({
  currency,
  points,
}: {
  currency: string;
  points: { label: string; gross: ByCurrency; refunds: ByCurrency }[];
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
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${currency} received per period`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - 8} y1={y(max * f)} y2={y(max * f)} stroke="rgb(63,63,70)" strokeDasharray="3 4" strokeWidth="0.5" />
            <text x={padL - 6} y={y(max * f) + 3} textAnchor="end" className="fill-zinc-500" style={{ fontSize: "10px" }}>
              {Math.round(max * f).toLocaleString("en-US")}
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
        <div className="pointer-events-none absolute right-2 top-1 rounded-lg border border-cyan-400/30 bg-black/85 px-2.5 py-1 text-xs text-zinc-100">
          <div className="text-zinc-400">{h.label}</div>
          <div>Received {fmtMoney(h.gross[currency] ?? 0, currency)}</div>
          {(h.refunds[currency] ?? 0) > 0 && <div className="text-red-300">Refunded {fmtMoney(h.refunds[currency] ?? 0, currency)}</div>}
        </div>
      )}
    </div>
  );
}
