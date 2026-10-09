"use client";

// Revenue: money in and out per currency for a date range, compared with
// the range before it; recurring revenue from active plans; renewals,
// cancellations, failed and abandoned payments; a chart per currency.

import { useEffect, useState } from "react";
import { useAdmin } from "../../AdminApi";
import { Badge, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
import { currenciesOf, fmtMoney, type ByCurrency } from "@/lib/finance/money";
import { BarChart, BillingNav, Totals, day } from "../shared";

type Figures = {
  gross: ByCurrency;
  refunds: ByCurrency;
  net: ByCurrency;
  payments: number;
  planPayments: number;
  ticketSales: number;
  newCustomers: number;
  renewals: number;
  cancellations: { total: number; cancelled: number; lapsed: number };
  basis: "payments" | "subscriptions";
  failed: { count: number; amount: ByCurrency };
  unverified: number;
};
type Recurring = { mrr: ByCurrency; arr: ByCurrency; activePaid: number; monthly: number; annual: number; notInClerk: number; basis: string; unpaid?: number; ending?: number };
type Report = {
  range: { from: number; to: number };
  previousRange: { from: number; to: number };
  bucket: "day" | "week" | "month";
  current: Figures;
  previous: Figures;
  change: Record<string, { gross: number | null; net: number | null }>;
  series: { label: string; gross: ByCurrency; refunds: ByCurrency; payments: number }[];
  recurring: Recurring;
  recurringFromPayments: Recurring;
  subscriptions: { records: number; used: boolean };
  outstanding: { inProgress: { count: number; amount: ByCurrency }; abandoned: { count: number; amount: ByCurrency }; failed: { count: number; amount: ByCurrency } };
};

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const PRESETS: [string, number][] = [
  ["7 days", 7],
  ["30 days", 30],
  ["90 days", 90],
  ["12 months", 365],
];

export default function RevenueClient() {
  const { can, adminFetch } = useAdmin();
  const today = iso(Date.now());
  const [range, setRange] = useState({ from: iso(Date.now() - 29 * 86_400_000), to: today, bucket: "" });
  const [applied, setApplied] = useState(range);
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setR(null);
    setError(null);
    const p = new URLSearchParams({ from: applied.from, to: applied.to });
    if (applied.bucket) p.set("bucket", applied.bucket);
    adminFetch<Report>(`/api/admin/billing/revenue?${p}`).then((res) => {
      if (!live) return;
      if (res.ok) setR(res.data);
      else setError(res.data.message ?? "Could not load revenue.");
    });
    return () => {
      live = false;
    };
  }, [adminFetch, applied]);

  const preset = (days: number) => {
    const next = { from: iso(Date.now() - (days - 1) * 86_400_000), to: today, bucket: "" };
    setRange(next);
    setApplied(next);
  };
  const exportQ = (format: string) => `/api/admin/billing/export?${new URLSearchParams({ type: "revenue", format, from: applied.from, to: applied.to, ...(applied.bucket ? { bucket: applied.bucket } : {}) })}`;

  return (
    <div>
      <PageHeader title="Billing" sub="Revenue per currency. Espees and other currencies are shown side by side and never added together." />
      <BillingNav active="revenue" />
      <Panel className="mb-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(range);
          }}
        >
          <div className="flex flex-wrap gap-1">
            {PRESETS.map(([l, d]) => (
              <button key={l} type="button" className={btn.ghost} onClick={() => preset(d)}>
                {l}
              </button>
            ))}
          </div>
          <label className="text-xs text-zinc-400">
            From
            <input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} className={`${field} mt-1`} />
          </label>
          <label className="text-xs text-zinc-400">
            To
            <input type="date" value={range.to} max={today} onChange={(e) => setRange({ ...range, to: e.target.value })} className={`${field} mt-1`} />
          </label>
          <label className="text-xs text-zinc-400">
            Chart by
            <select value={range.bucket} onChange={(e) => setRange({ ...range, bucket: e.target.value })} className={`${field} mt-1`}>
              <option value="">Automatic</option>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
          <button type="submit" className={btn.primary}>
            Apply
          </button>
          {can("reports:export") && (
            <span className="ml-auto flex gap-1.5">
              <a className={btn.ghost} href={exportQ("csv")}>
                Revenue CSV
              </a>
              <a className={btn.ghost} href={exportQ("xlsx")}>
                Revenue Excel
              </a>
            </span>
          )}
        </form>
        {r && (
          <p className="mt-2 text-xs text-zinc-500">
            {day(r.range.from)} to {day(r.range.to)} (UTC), compared with {day(r.previousRange.from)} to {day(r.previousRange.to)}.
          </p>
        )}
      </Panel>

      {error && <Notice kind="err">{error}</Notice>}
      {!r ? (
        !error && <Loading />
      ) : (
        <div className="space-y-4">
          <CurrencyCards r={r} />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Count label="Payments" now={r.current.payments} before={r.previous.payments} note={`${r.current.planPayments} plans · ${r.current.ticketSales} tickets`} />
            <Count label="New paying customers" now={r.current.newCustomers} before={r.previous.newCustomers} />
            <Count label="Renewals" now={r.current.renewals} before={r.previous.renewals} />
            <Count
              label="Cancellations"
              now={r.current.cancellations.total}
              before={r.previous.cancellations.total}
              note={`${r.current.cancellations.lapsed} ran out · ${r.current.cancellations.cancelled} ${r.current.basis === "subscriptions" ? "cancelled" : "ended by refund"}`}
              lowerIsBetter
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel>
              <h2 className="text-sm font-semibold text-white">Recurring revenue</h2>
              <p className="mt-0.5 text-xs text-zinc-500">Plans active on {day(r.range.to)}, each counted per month (annual ÷ 12).</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-zinc-500">MRR</p>
                  <div className="text-lg font-semibold text-white">
                    <Totals totals={r.recurring.mrr} empty="None" />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">ARR</p>
                  <div className="text-lg font-semibold text-white">
                    <Totals totals={r.recurring.arr} empty="None" />
                  </div>
                </div>
              </div>
              <p className="mt-2 text-xs text-zinc-400">
                {r.recurring.activePaid} active paid plan{r.recurring.activePaid === 1 ? "" : "s"} ({r.recurring.monthly} monthly, {r.recurring.annual} annual).
                {r.recurring.notInClerk > 0 && ` ${r.recurring.notInClerk} paid period${r.recurring.notInClerk === 1 ? "" : "s"} left out: the account is on Free now.`}
                {!!r.recurring.unpaid && ` ${r.recurring.unpaid} running without a price (trial, complimentary or recorded without payment).`}
                {!!r.recurring.ending && ` ${r.recurring.ending} cancelled, running to the end of the paid period.`}
              </p>
              {r.subscriptions.used && (
                <p className="mt-1 text-xs text-zinc-500">
                  From payments instead: {currenciesOf(r.recurringFromPayments.mrr).map((c) => fmtMoney(r.recurringFromPayments.mrr[c], c)).join(" and ") || "nothing"} a month across {r.recurringFromPayments.activePaid} plan{r.recurringFromPayments.activePaid === 1 ? "" : "s"}. A gap means accounts without a subscription record — run the Clerk backfill on Subscriptions.
                </p>
              )}
              <p className="mt-1 text-xs text-zinc-500">
                {r.recurring.basis} Plans do not renew by themselves: eSPees payments are one period at a time, so “recurring” means paid periods running now.
              </p>
            </Panel>
            <Panel>
              <h2 className="text-sm font-semibold text-white">Outstanding and failed</h2>
              <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
                <dt className="text-zinc-400">
                  Checkouts in progress <Badge>{r.outstanding.inProgress.count}</Badge>
                </dt>
                <dd className="text-right">
                  <Totals totals={r.outstanding.inProgress.amount} />
                </dd>
                <dt className="text-zinc-400">
                  Abandoned checkouts <Badge tone="amber">{r.outstanding.abandoned.count}</Badge>
                </dt>
                <dd className="text-right">
                  <Totals totals={r.outstanding.abandoned.amount} />
                </dd>
                <dt className="text-zinc-400">
                  Failed payments <Badge tone="red">{r.outstanding.failed.count}</Badge>
                </dt>
                <dd className="text-right">
                  <Totals totals={r.outstanding.failed.amount} />
                </dd>
              </dl>
              <p className="mt-2 text-xs text-zinc-500">
                A checkout is abandoned when the buyer did not come back from eSPees within the hour it stays open. Checkouts are recorded from this release on.
                {r.current.unverified > 0 && ` ${r.current.unverified} plan payment${r.current.unverified === 1 ? " was" : "s were"} granted on the eSPees redirect without confirmation.`}
              </p>
            </Panel>
          </div>

          {currenciesOf(...r.series.map((p) => p.gross), ...r.series.map((p) => p.refunds)).map((c) => (
            <Panel key={c}>
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold text-white">Received per {r.bucket} — {c}</h2>
                <span className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-cyan-400" /> received
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-red-400" /> refunded
                  </span>
                </span>
              </div>
              <BarChart currency={c} points={r.series} />
            </Panel>
          ))}

          <Panel>
            <h2 className="text-sm font-semibold text-white">How these are counted</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-zinc-400">
              <li>Received: payments taken in the range. Failed payments took nothing and are not in it.</li>
              <li>Refunded: refunds made in the range, on the day they were made. Net = received − refunded, per currency.</li>
              {r.current.basis === "subscriptions" ? (
                <>
                  <li>Renewal: the same plan bought again while it was running (subscription history). New: a first plan payment.</li>
                  <li>Cancellation: a subscription cancelled by someone, or one whose paid period ran out, in the range.</li>
                  <li>Recurring revenue: running subscriptions with a price, from their records ({r.subscriptions.records} records).</li>
                </>
              ) : (
                <>
                  <li>Renewal: a plan payment by someone who had paid for a plan before. New: their first plan payment.</li>
                  <li>Cancellation: a plan ended with a refund, or a paid period that ran out in the range with no new payment within 3 days of its end.</li>
                  <li>Recurring revenue comes from plan payments and each account&apos;s current plan in Clerk (there are no subscription records yet).</li>
                </>
              )}
            </ul>
          </Panel>
        </div>
      )}
    </div>
  );
}

function Change({ pct, lowerIsBetter = false }: { pct: number | null; lowerIsBetter?: boolean }) {
  if (pct == null) return <span className="text-xs text-zinc-500">no earlier figure</span>;
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return (
    <span className={`text-xs ${pct === 0 ? "text-zinc-400" : good ? "text-emerald-300" : "text-red-300"}`}>
      {pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} {Math.abs(pct)}% vs previous
    </span>
  );
}

function CurrencyCards({ r }: { r: Report }) {
  const cs = currenciesOf(r.current.gross, r.current.refunds, r.previous.gross);
  if (!cs.length) return <Panel className="text-sm text-zinc-400">No money received or refunded in this range or the one before it.</Panel>;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {cs.map((c) => (
        <Panel key={c}>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-500">{c === "ESP" ? "Espees (ESP)" : c}</p>
          <div className="mt-2 grid grid-cols-3 gap-3">
            <div>
              <p className="text-xs text-zinc-500">Received</p>
              <p className="text-lg font-semibold text-white">{fmtMoney(r.current.gross[c] ?? 0, c)}</p>
              <Change pct={r.change[c]?.gross ?? null} />
            </div>
            <div>
              <p className="text-xs text-zinc-500">Refunded</p>
              <p className="text-lg font-semibold text-red-200">{fmtMoney(r.current.refunds[c] ?? 0, c)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">Net</p>
              <p className="text-lg font-semibold text-white">{fmtMoney(r.current.net[c] ?? 0, c)}</p>
              <Change pct={r.change[c]?.net ?? null} />
            </div>
          </div>
          <p className="mt-2 text-xs text-zinc-500">Previous period: {fmtMoney(r.previous.gross[c] ?? 0, c)} received.</p>
        </Panel>
      ))}
    </div>
  );
}

function Count({ label, now, before, note, lowerIsBetter }: { label: string; now: number; before: number; note?: string; lowerIsBetter?: boolean }) {
  const pct = before ? Math.round(((now - before) / before) * 1000) / 10 : null;
  return (
    <Panel>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-2xl font-semibold text-white">{now}</p>
      <Change pct={pct} lowerIsBetter={lowerIsBetter} />
      <p className="text-[11px] text-zinc-500">was {before}{note ? ` · ${note}` : ""}</p>
    </Panel>
  );
}
