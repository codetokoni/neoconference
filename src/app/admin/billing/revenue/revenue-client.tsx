"use client";

// Revenue: money in and out per currency for a date range, compared with
// the range before it; recurring revenue from active plans; renewals,
// cancellations, failed and abandoned payments; a chart per currency.

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { adminToday, fmtMoney, fmtNumber, fmtTime, useAdmin, zoneLabel } from "../../AdminApi";
import { Badge, Empty, FilterBar, Labeled, Loading, Notice, PageHeader, Panel, StatTile, btn, field, useUrlFilters } from "../../ui";
import { currenciesOf, type ByCurrency } from "@/lib/finance/money";
import { BarChart, BillingNav, Totals, apiTime, day, dayInput, isInstantRange } from "../shared";

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

/** A calendar day `n` days before `d` ("YYYY-MM-DD" arithmetic, no clock involved). */
const daysBefore = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
// What the API is sent: the instants the chosen days start and end on the admin clock.
const apiRange = (a: { from: string; to: string; bucket: string }): Record<string, string> => ({
  from: apiTime(a.from, false),
  to: apiTime(a.to, true),
  ...(a.bucket ? { bucket: a.bucket } : {}),
});

const PRESETS: [string, number][] = [
  ["7 days", 7],
  ["30 days", 30],
  ["90 days", 90],
  ["12 months", 365],
];

export default function RevenueClient() {
  const { can, adminFetch, adminDownload } = useAdmin();
  // Today on the admin clock; ranges are whole days on that clock.
  const today = adminToday();
  // ?from=&to= (a day, or epoch ms from the Overview) &bucket=day|week|month open the page on that range, and it stays in the URL.
  const { value: applied, set: setApplied } = useUrlFilters({ from: daysBefore(today, 29), to: today, bucket: "" });
  const appliedKey = JSON.stringify(applied);
  const [range, setRange] = useState(applied);
  useEffect(() => setRange(JSON.parse(appliedKey)), [appliedKey]);
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setR(null);
    setError(null);
    const a = JSON.parse(appliedKey) as typeof applied;
    adminFetch<Report>(`/api/admin/billing/revenue?${new URLSearchParams(apiRange(a))}`).then((res) => {
      if (!live) return;
      if (res.ok) setR(res.data);
      else setError(res.data.message ?? "Could not load revenue.");
    });
    return () => {
      live = false;
    };
  }, [adminFetch, appliedKey, reload]);

  const preset = (days: number) => setApplied({ from: daysBefore(today, days - 1), to: today, bucket: "" });
  const exportUrl = (format: string) => `/api/admin/billing/export?${new URLSearchParams({ type: "revenue", format, ...apiRange(applied) })}`;
  const download = async (label: string, format: string) => {
    setExporting(label);
    setExportError(null);
    const res = await adminDownload(exportUrl(format));
    setExporting(null);
    if (!res.ok && res.data.error !== "cancelled") setExportError(`${label}: ${res.data.message ?? "the export failed."}`);
  };
  // The payments list behind a figure, for the same range.
  const paymentsHref = (extra: Record<string, string> = {}) => `/admin/billing/payments?${new URLSearchParams({ ...extra, from: applied.from, to: applied.to })}`;

  return (
    <div>
      <PageHeader title="Billing" sub="Revenue per currency. Espees and other currencies are shown side by side and never added together." />
      <BillingNav active="revenue" />
      <Panel className="mb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(range);
          }}
        >
          <FilterBar>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Quick ranges">
              {PRESETS.map(([l, d]) => (
                <button key={l} type="button" className={btn.ghost} onClick={() => preset(d)}>
                  {l}
                </button>
              ))}
            </div>
            <Labeled label={`From (${zoneLabel()})`}>
              <input type="date" value={dayInput(range.from)} max={dayInput(range.to) || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} className={`${field} sm:w-40`} />
            </Labeled>
            <Labeled label={`To (${zoneLabel()})`}>
              <input type="date" value={dayInput(range.to)} max={today} onChange={(e) => setRange({ ...range, to: e.target.value })} className={`${field} sm:w-40`} />
            </Labeled>
            <Labeled label="Chart by">
              <select value={range.bucket} onChange={(e) => setRange({ ...range, bucket: e.target.value })} className={`${field} sm:w-36`}>
                <option value="">Automatic</option>
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </Labeled>
            <button type="submit" className={btn.primary}>
              Apply
            </button>
          </FilterBar>
        </form>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-zinc-400">
            {isInstantRange(applied.from, applied.to) && (
              <p>
                Period from the Overview: {fmtTime(Number(applied.from))} – {fmtTime(Number(applied.to))}.
              </p>
            )}
            {r && (
              <p>
                {day(r.range.from)} to {day(r.range.to)} ({zoneLabel()}), compared with {day(r.previousRange.from)} to {day(r.previousRange.to)}. The charts group by UTC day, week or month.
              </p>
            )}
          </div>
          {can("reports:export") && (
            <span className="flex flex-wrap gap-1.5">
              {(
                [
                  ["Revenue CSV", "csv"],
                  ["Revenue Excel", "xlsx"],
                ] as const
              ).map(([label, format]) => (
                <button key={label} type="button" className={btn.ghost} disabled={!!exporting} onClick={() => download(label, format)}>
                  {exporting === label ? "Preparing…" : label}
                </button>
              ))}
            </span>
          )}
        </div>
        {exportError && (
          <div className="mt-3">
            <Notice kind="err" onClose={() => setExportError(null)}>
              {exportError}
            </Notice>
          </div>
        )}
      </Panel>

      {error && (
        <Notice kind="err" onRetry={() => setReload((n) => n + 1)}>
          {error}
        </Notice>
      )}
      {!r ? (
        !error && <Loading />
      ) : (
        <div className="space-y-4">
          <CurrencyCards r={r} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Count
              label="Payments"
              now={r.current.payments}
              before={r.previous.payments}
              note={`${fmtNumber(r.current.planPayments)} plans · ${fmtNumber(r.current.ticketSales)} tickets`}
              href={paymentsHref()}
            />
            <Count label="New paying customers" now={r.current.newCustomers} before={r.previous.newCustomers} />
            <Count label="Renewals" now={r.current.renewals} before={r.previous.renewals} />
            <Count
              label="Cancellations"
              now={r.current.cancellations.total}
              before={r.previous.cancellations.total}
              note={`${fmtNumber(r.current.cancellations.lapsed)} ran out · ${fmtNumber(r.current.cancellations.cancelled)} ${r.current.basis === "subscriptions" ? "cancelled" : "ended by refund"}`}
              lowerIsBetter
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel>
              <h2 className="text-sm font-semibold text-white">Recurring revenue</h2>
              <p className="mt-0.5 text-xs text-zinc-400">Plans active on {day(r.range.to)}, each counted per month (annual ÷ 12).</p>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-400">MRR</p>
                  <div className="break-words text-lg font-semibold text-white">
                    <Totals totals={r.recurring.mrr} empty="None" />
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-zinc-400">ARR</p>
                  <div className="break-words text-lg font-semibold text-white">
                    <Totals totals={r.recurring.arr} empty="None" />
                  </div>
                </div>
              </div>
              <p className="mt-2 text-xs text-zinc-400">
                {fmtNumber(r.recurring.activePaid)} active paid plan{r.recurring.activePaid === 1 ? "" : "s"} ({fmtNumber(r.recurring.monthly)} monthly, {fmtNumber(r.recurring.annual)} annual).
                {r.recurring.notInClerk > 0 && ` ${r.recurring.notInClerk} paid period${r.recurring.notInClerk === 1 ? "" : "s"} left out: the account is on Free now.`}
                {!!r.recurring.unpaid && ` ${r.recurring.unpaid} running without a price (trial, complimentary or recorded without payment).`}
                {!!r.recurring.ending && ` ${r.recurring.ending} cancelled, running to the end of the paid period.`}
              </p>
              {r.subscriptions.used && (
                <p className="mt-1 text-xs text-zinc-400">
                  From payments instead: {currenciesOf(r.recurringFromPayments.mrr).map((c) => fmtMoney(r.recurringFromPayments.mrr[c], c)).join(" and ") || "nothing"} a month across{" "}
                  {fmtNumber(r.recurringFromPayments.activePaid)} plan{r.recurringFromPayments.activePaid === 1 ? "" : "s"}. A gap means accounts without a subscription record — run the Clerk backfill on
                  Subscriptions.
                </p>
              )}
              <p className="mt-1 text-xs text-zinc-400">
                {r.recurring.basis} Plans do not renew by themselves: eSPees payments are one period at a time, so “recurring” means paid periods running now.
              </p>
            </Panel>
            <Panel>
              <h2 className="text-sm font-semibold text-white">Outstanding and failed</h2>
              <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
                <dt className="text-zinc-400">
                  Checkouts in progress <Badge>{fmtNumber(r.outstanding.inProgress.count)}</Badge>
                </dt>
                <dd className="text-right">
                  <Totals totals={r.outstanding.inProgress.amount} />
                </dd>
                <dt className="text-zinc-400">
                  Abandoned checkouts <Badge tone="amber">{fmtNumber(r.outstanding.abandoned.count)}</Badge>
                </dt>
                <dd className="text-right">
                  <Totals totals={r.outstanding.abandoned.amount} />
                </dd>
                <dt className="text-zinc-400">
                  {r.outstanding.failed.count > 0 ? (
                    <Link href={paymentsHref({ status: "failed" })} className="text-cyan-300 hover:underline">
                      Failed payments
                    </Link>
                  ) : (
                    "Failed payments"
                  )}{" "}
                  <Badge tone="red">{fmtNumber(r.outstanding.failed.count)}</Badge>
                </dt>
                <dd className="text-right">
                  <Totals totals={r.outstanding.failed.amount} />
                </dd>
              </dl>
              <p className="mt-2 text-xs text-zinc-400">
                A checkout is abandoned when the buyer did not come back from eSPees within the hour it stays open. Checkouts are recorded from this release on.
                {r.current.unverified > 0 && ` ${r.current.unverified} plan payment${r.current.unverified === 1 ? " was" : "s were"} granted on the eSPees redirect without confirmation.`}
              </p>
            </Panel>
          </div>

          {currenciesOf(...r.series.map((p) => p.gross), ...r.series.map((p) => p.refunds)).map((c) => (
            <Panel key={c}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-white">
                  Received per {r.bucket} (UTC) — {c}
                </h2>
                <span aria-hidden className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-cyan-400" /> received
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-sm bg-red-400" /> refunded
                  </span>
                </span>
              </div>
              <BarChart currency={c} points={r.series} bucket={r.bucket} />
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
                  <li>Recurring revenue: running subscriptions with a price, from their records ({fmtNumber(r.subscriptions.records)} records).</li>
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
  if (pct == null) return <span className="text-xs text-zinc-400">no earlier figure</span>;
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return (
    <span className={`text-xs ${pct === 0 ? "text-zinc-400" : good ? "text-emerald-300" : "text-red-300"}`}>
      <span aria-hidden>{pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} </span>
      <span className="sr-only">{pct > 0 ? "up " : pct < 0 ? "down " : "unchanged "}</span>
      {fmtNumber(Math.abs(pct))}% vs previous
    </span>
  );
}

function CurrencyCards({ r }: { r: Report }) {
  const cs = currenciesOf(r.current.gross, r.current.refunds, r.previous.gross);
  if (!cs.length) return <Empty>No money received or refunded in this range or the one before it.</Empty>;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {cs.map((c) => (
        <Panel key={c} className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-400">{c === "ESP" ? "Espees (ESP)" : c}</p>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Figure label="Received" value={fmtMoney(r.current.gross[c] ?? 0, c)}>
              <Change pct={r.change[c]?.gross ?? null} />
            </Figure>
            <Figure label="Refunded" value={fmtMoney(r.current.refunds[c] ?? 0, c)} tone="text-red-200" />
            <Figure label="Net" value={fmtMoney(r.current.net[c] ?? 0, c)}>
              <Change pct={r.change[c]?.net ?? null} />
            </Figure>
          </div>
          <p className="mt-2 text-xs text-zinc-400">Previous period: {fmtMoney(r.previous.gross[c] ?? 0, c)} received.</p>
        </Panel>
      ))}
    </div>
  );
}

function Figure({ label, value, tone = "text-white", children }: { label: string; value: string; tone?: string; children?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className={`break-words text-lg font-semibold tabular-nums ${tone}`}>{value}</p>
      {children}
    </div>
  );
}

function Count({ label, now, before, note, lowerIsBetter, href }: { label: string; now: number; before: number; note?: string; lowerIsBetter?: boolean; href?: string }) {
  const pct = before ? Math.round(((now - before) / before) * 1000) / 10 : null;
  return (
    <StatTile
      label={label}
      value={fmtNumber(now)}
      href={href}
      hint={
        <>
          <Change pct={pct} lowerIsBetter={lowerIsBetter} />
          <span className="block truncate">
            was {fmtNumber(before)}
            {note ? ` · ${note}` : ""}
          </span>
        </>
      }
    />
  );
}
