"use client";

// src/app/admin/overview-client.tsx
//
// The admin dashboard: the platform's figures for a period, each compared
// with the period before it (or the same dates last year), and each a link to
// the records behind it. Every figure comes from /api/admin/overview, which
// reads the stores the other admin sections keep; a card whose source failed
// says so on its own, and a card the role may not see is not drawn at all.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Overview, SourceResult } from "@/lib/admin/overview/aggregate";
import { COMPARES, RANGES, queryString, readQuery, type Delta, type MoneyDelta, type OverviewQuery } from "@/lib/admin/overview/period";
import type { SourceData, SourceId } from "@/lib/admin/overview/sources";
import { fmtMoney, currenciesOf } from "@/lib/finance/money";
import { formatBytes } from "@/lib/content/model";
import { fmtTime, useAdmin } from "./AdminApi";
import { DailyBars, HBars } from "./analytics/charts";
import { PageHeader, btn, field } from "./ui";

type Answer = Overview & { query: OverviewQuery };

/** The zone the Overview's days are in: the administrator's own clock. */
function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const n = (v: number) => v.toLocaleString("en-US");

function shortDate(day: string): string {
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export default function OverviewClient() {
  const { adminFetch } = useAdmin();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || "/admin";
  const tz = useMemo(viewerZone, []);
  const query = useMemo(() => {
    const p = new URLSearchParams(sp?.toString() ?? "");
    p.set("tz", tz);
    return readQuery(p);
  }, [sp, tz]);
  const qs = queryString(query);

  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState({ from: query.from ?? "", to: query.to ?? "" });

  const load = useCallback(
    async (opts: { refresh?: boolean; only?: SourceId } = {}) => {
      setBusy(true);
      const extra = `${opts.refresh ? "&refresh=1" : ""}${opts.only ? `&only=${opts.only}` : ""}`;
      const r = await adminFetch<Answer>(`/api/admin/overview?${qs}${extra}`);
      setBusy(false);
      if (!r.ok) {
        setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
        return;
      }
      setError(null);
      setData((prev) => (opts.only && prev ? { ...prev, sources: { ...prev.sources, ...r.data.sources }, asOf: r.data.asOf } : r.data));
    },
    [adminFetch, qs],
  );

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const setQuery = (patch: Partial<OverviewQuery>) => {
    const next = { ...query, ...patch };
    const p = new URLSearchParams(queryString(next));
    p.delete("tz");
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const s = data?.sources;
  const cur = data?.periods.current;
  const prev = data?.periods.previous;
  const retry = (id: SourceId) => () => load({ refresh: true, only: id });
  const revenue = s?.revenue?.status === "ok" ? s.revenue.data : null;
  const incidents = s?.incidents?.status === "ok" ? s.incidents.data : null;
  const jobs = s?.jobs?.status === "ok" ? s.jobs.data : null;

  return (
    <div>
      <PageHeader
        title="Overview"
        sub={
          data ? (
            <>
              Figures as of <b className="text-zinc-300">{data.asOf ? fmtTime(data.asOf) : "—"}</b> (kept for up to a minute).
            </>
          ) : (
            "The platform at a glance."
          )
        }
        actions={
          <button type="button" className={btn.ghost} onClick={() => load({ refresh: true })} disabled={busy}>
            {busy ? "Loading…" : "Refresh"}
          </button>
        }
      />

      <div className="mb-4 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Period">
            {RANGES.filter((r) => r.id !== "custom").map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={query.range === r.id}
                onClick={() => setQuery({ range: r.id, from: undefined, to: undefined })}
                className={`rounded-lg px-2.5 py-1.5 text-xs ${query.range === r.id ? "bg-cyan-400/15 text-cyan-200" : "text-zinc-300 hover:bg-white/5"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (custom.from && custom.to) setQuery({ range: "custom", from: custom.from, to: custom.to });
            }}
          >
            <label className="text-xs text-zinc-400">
              From
              <input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className={`${field} mt-0.5 py-1.5`} />
            </label>
            <label className="text-xs text-zinc-400">
              To
              <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className={`${field} mt-0.5 py-1.5`} />
            </label>
            <button type="submit" className={`${btn.ghost} py-1.5 text-xs`} aria-pressed={query.range === "custom"} disabled={!custom.from || !custom.to}>
              Apply dates
            </button>
          </form>
          <label className="text-xs text-zinc-400">
            Compare with
            <select value={query.compare} onChange={(e) => setQuery({ compare: e.target.value as OverviewQuery["compare"] })} className={`${field} mt-0.5 py-1.5`}>
              {COMPARES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {cur && prev && (
          <p className="text-xs text-zinc-500">
            <b className="text-zinc-300">
              {shortDate(cur.from)}
              {cur.to !== cur.from && ` – ${shortDate(cur.to)}`}
            </b>{" "}
            compared with {shortDate(prev.from)}
            {prev.to !== prev.from && ` – ${shortDate(prev.to)}`} · days in <b className="text-zinc-300">{cur.tz}</b> (your time zone)
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      {!data && !error && <p className="px-1 py-6 text-sm text-zinc-500">Loading the figures…</p>}

      {s && cur && (
        <>
          <section aria-label="Key figures" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {s.users && (
              <Card title="Users" r={s.users} retry={retry("users")}>
                {(d) => (
                  <>
                    <Figure href={d.links.total} value={n(d.total)} label="accounts in total" />
                    <Figure href={d.links.newUsers} value={n(d.newUsers.value)} label="new registrations" change={<Change d={d.newUsers} />} />
                  </>
                )}
              </Card>
            )}
            {s.activity && (
              <Card title="Active users" r={s.activity} retry={retry("activity")} foot={(d) => activityFoot(d)}>
                {(d) => (
                  <>
                    <Figure href={d.links.active} value={n(d.dailyAvg.value)} label="a day on average" change={<Change d={d.dailyAvg} comparable={d.comparable} />} />
                    <div className="grid grid-cols-2 gap-2">
                      <Figure href={d.links.active} value={n(d.wau.value)} label="weekly (WAU)" change={<Change d={d.wau} comparable={d.comparable} />} small />
                      <Figure href={d.links.active} value={n(d.mau.value)} label="monthly (MAU)" change={<Change d={d.mau} comparable={d.comparable} />} small />
                    </div>
                  </>
                )}
              </Card>
            )}
            {s.online && (
              <Card
                title="Online now"
                r={s.online}
                retry={retry("online")}
                foot={(d) => (d.configured ? "People connected to meeting rooms, as LiveKit counts them (recording and caption agents included)." : "LiveKit is not configured on this deployment.")}
              >
                {(d) => (d.configured ? <Figure href={d.links.live} value={n(d.participants)} label={`in ${n(d.rooms)} meeting room${d.rooms === 1 ? "" : "s"}`} /> : <Unavailable>Not configured</Unavailable>)}
              </Card>
            )}
            {s.subscriptions && (
              <Card title="Subscriptions" r={s.subscriptions} retry={retry("subscriptions")} foot={() => "From subscription records; accounts from before the plan catalog appear once the backfill has run."}>
                {(d) => (
                  <>
                    <Figure href={d.links.all} value={n(d.live)} label={`giving a plan now (of ${n(d.total)} records)`} />
                    <div className="grid grid-cols-2 gap-2">
                      <Figure href={d.links.renewalsDue} value={n(d.renewalsDue)} label="renewals due in 30 days" small />
                      <Figure href={d.links.all} value={n(d.started.value)} label="started in period" change={<Change d={d.started} />} small />
                    </div>
                  </>
                )}
              </Card>
            )}
            {s.revenue && (
              <Card title="Revenue" r={s.revenue} retry={retry("revenue")} foot={() => "Payments taken in the period, per currency — currencies are never added together."} wide>
                {(d) => (
                  <>
                    <MoneyRows href={d.links.revenue} m={d.gross} label="taken" empty="No payments in this period." />
                    {Object.keys(d.refunds).length > 0 && <MoneyRows href={d.links.refunds} m={d.refunds} label="refunded" goodWhenUp={false} />}
                  </>
                )}
              </Card>
            )}
            {s.revenue && (
              <Card title="Payments" r={s.revenue} retry={retry("revenue")}>
                {(d) => (
                  <>
                    <Figure href={d.links.failed} value={n(d.failed.count.value)} label="failed payments" change={<Change d={d.failed.count} goodWhenUp={false} />} />
                    <AmountList amounts={d.failed.amount} />
                    <div className="grid grid-cols-2 gap-2">
                      <Figure href={d.links.revenue} value={n(d.outstanding.inProgress.count + d.outstanding.abandoned.count)} label="outstanding checkouts" small />
                      <Figure href={d.links.payments} value={n(d.renewals.value)} label="renewals paid" change={<Change d={d.renewals} />} small />
                    </div>
                  </>
                )}
              </Card>
            )}
            {s.storage && (
              <Card title="Storage" r={s.storage} retry={retry("storage")} foot={(d) => storageFoot(d)}>
                {(d) => (
                  <>
                    <Figure href={d.links.storage} value={formatBytes(d.bytes)} label={`in ${n(d.files)} file${d.files === 1 ? "" : "s"}${d.complete ? "" : " (at least)"}`} />
                    <p className="text-xs text-zinc-500">
                      Bandwidth: <span className="text-zinc-400">not available</span>
                    </p>
                  </>
                )}
              </Card>
            )}
            {s.health && (
              <Card title="Service health" r={s.health} retry={retry("health")} foot={(d) => (d.checkedAt ? `Last checked ${fmtTime(d.checkedAt)}.` : "No health check has run yet.")}>
                {(d) => {
                  const checked = d.services.filter((x) => x.status !== "not_configured").length;
                  const bad = d.counts.down + d.counts.degraded;
                  return (
                    <Figure
                      href={d.links.health}
                      value={checked ? `${n(d.counts.up)} / ${n(checked)}` : "—"}
                      label={bad ? `services up · ${d.counts.down} down, ${d.counts.degraded} degraded` : "services up"}
                      tone={d.counts.down ? "bad" : d.counts.degraded ? "warn" : "ok"}
                    />
                  );
                }}
              </Card>
            )}
            {s.incidents && (
              <Card title="Incidents" r={s.incidents} retry={retry("incidents")}>
                {(d) => (
                  <div className="grid grid-cols-2 gap-2">
                    <Figure href={d.links.incidents} value={n(d.open.length)} label="open incidents" tone={d.open.length ? "bad" : "ok"} small />
                    <Figure href={d.links.alerts} value={n(d.alerts.active)} label="active alerts" tone={d.alerts.open ? "warn" : "ok"} small />
                  </div>
                )}
              </Card>
            )}
            {s.jobs && (
              <Card title="Background jobs" r={s.jobs} retry={retry("jobs")}>
                {(d) => (
                  <div className="grid grid-cols-2 gap-2">
                    <Figure href={d.links.failed} value={n(d.failing)} label={`failing of ${n(d.jobs.length)}`} tone={d.failing ? "bad" : "ok"} small />
                    <Figure href={d.links.failed} value={n(d.failedRuns.value)} label="failed runs in period" change={<Change d={d.failedRuns} goodWhenUp={false} />} small />
                  </div>
                )}
              </Card>
            )}
            {s.errors && (
              <Card title="Errors" r={s.errors} retry={retry("errors")} foot={(d) => ("admin" in d ? "Error-level events in the activity log, and administrator actions that failed." : "Error-level events in the activity log.")}>
                {(d) => (
                  <>
                    <Figure href={d.links.errors} value={`${n(d.activity.value)}${d.activity.truncated ? "+" : ""}`} label="app errors" change={<Change d={d.activity} goodWhenUp={false} />} tone={d.activity.value ? "warn" : "ok"} />
                    {"admin" in d && d.admin && (
                      <Figure href={d.links.errors} value={n(d.admin.value)} label="failed admin actions" change={<Change d={d.admin} goodWhenUp={false} />} small />
                    )}
                  </>
                )}
              </Card>
            )}
          </section>

          <section aria-label="Charts" className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {s.users?.status === "ok" && <DailyBars title="Sign-ups per day" days={s.users.data.days} series={[{ label: "Sign-ups", values: s.users.data.daily }]} />}
            {s.activity?.status === "ok" && (
              <DailyBars title="Active users per day" days={s.activity.data.days} series={[{ label: "Active", values: s.activity.data.daily, avg: true }]} note="People seen each day (UTC days)." />
            )}
            {revenue &&
              Object.keys(revenue.series.byCurrency)
                .sort((a, b) => (a === "ESP" ? -1 : b === "ESP" ? 1 : a.localeCompare(b)))
                .map((c) => (
                  <DailyBars
                    key={c}
                    title={`Revenue in ${c} per ${revenue.series.bucket}`}
                    days={revenue.series.starts}
                    series={[{ label: c, values: revenue.series.byCurrency[c] }]}
                    note={`Payments taken, in ${c} (UTC ${revenue.series.bucket}s).`}
                  />
                ))}
            {s.subscriptions?.status === "ok" && (
              <DailyBars
                title="Subscriptions over time"
                days={s.subscriptions.data.days}
                series={[{ label: "Records running", values: s.subscriptions.data.daily, avg: true }]}
                note="Subscription records that had started and not ended at the end of each day, from their start and end dates."
              />
            )}
          </section>

          <section aria-label="Breakdowns" className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {s.subscriptions?.status === "ok" && (
              <Panel title="Subscriptions by plan">
                {s.subscriptions.data.byPlan.length ? (
                  <HBars rows={s.subscriptions.data.byPlan.map((p) => ({ label: p.name, value: p.total, sub: `${p.live} giving a plan now`, href: p.href }))} />
                ) : (
                  <Quiet>No subscription records yet.</Quiet>
                )}
                {s.subscriptions.data.byStatus.length > 0 && (
                  <>
                    <h3 className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-zinc-500">By status</h3>
                    <HBars rows={s.subscriptions.data.byStatus.map((x) => ({ label: x.status, value: x.count, href: x.href }))} />
                  </>
                )}
              </Panel>
            )}
            {s.activity?.status === "ok" && (
              <Panel title="Feature usage" note={s.activity.data.comparable ? undefined : activityFoot(s.activity.data)}>
                {s.activity.data.features.some((f) => f.count.value > 0) ? (
                  <HBars rows={s.activity.data.features.filter((f) => f.count.value > 0).map((f) => ({ label: f.label, value: f.count.value, sub: pctText(f.count), href: f.href }))} />
                ) : (
                  <Quiet>No feature use recorded in this period.</Quiet>
                )}
              </Panel>
            )}
            {s.health?.status === "ok" && (
              <Panel title="Services" more={{ href: s.health.data.links.health, label: "Service health" }}>
                {s.health.data.services.length ? (
                  <ul className="divide-y divide-white/5 text-sm">
                    {s.health.data.services.map((x) => (
                      <li key={x.id} className="flex items-center justify-between gap-2 py-1.5">
                        <span className="min-w-0 truncate text-zinc-200" title={x.detail}>
                          {x.label}
                        </span>
                        <StatusPill status={x.status} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Quiet>No health check has run yet.</Quiet>
                )}
              </Panel>
            )}
            {(incidents || jobs) && (
              <Panel title="Incidents and jobs">
                {incidents &&
                  (incidents.open.length ? (
                    <ul className="mb-3 space-y-1 text-sm">
                      {incidents.open.map((i) => (
                        <li key={i.id}>
                          <Link href={incidents.links.incidents} className="flex justify-between gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                            <span className="truncate text-zinc-200">{i.title}</span>
                            <span className="shrink-0 text-xs text-red-300">
                              {i.impact} · {i.status}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Quiet>No open incidents.</Quiet>
                  ))}
                {jobs && (
                  <ul className="divide-y divide-white/5 text-sm">
                    {jobs.jobs.slice(0, 8).map((j) => (
                      <li key={j.name}>
                        <Link href={j.href} className="flex items-center justify-between gap-2 rounded px-1 py-1.5 hover:bg-white/5">
                          <span className="min-w-0 truncate font-mono text-xs text-zinc-300">{j.name}</span>
                          <span className={`shrink-0 text-xs ${j.failingRuns ? "text-red-300" : j.outcome === "ok" ? "text-emerald-300" : "text-zinc-400"}`}>
                            {j.failingRuns ? `failed ${j.failingRuns}× in a row` : (j.outcome ?? "never ran")}
                            {j.at ? ` · ${fmtTime(j.at)}` : ""}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            )}
            {s.storage?.status === "ok" && s.storage.data.byType.length > 0 && (
              <Panel title="Storage by type">
                <HBars rows={s.storage.data.byType.map((t) => ({ label: t.label, value: t.files, sub: formatBytes(t.bytes), href: t.href }))} unit="files" />
              </Panel>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function activityFoot(d: SourceData["activity"]): string {
  if (!d.since) return "The activity log has not recorded anything yet.";
  return d.comparable ? "From the activity log." : `The activity log starts ${fmtTime(d.since)}, so the comparison period is incomplete.`;
}

function storageFoot(d: SourceData["storage"]): string {
  const base = d.complete
    ? `From the file index, last fully checked against storage ${d.lastCompletePassAt ? fmtTime(d.lastCompletePassAt) : ""}.`
    : "From the file index; older files are still being indexed, so this is at least the figure shown.";
  return `${base} ${d.trashed.files ? `${formatBytes(d.trashed.bytes)} more in the bin. ` : ""}Bandwidth: ${d.bandwidth.reason}`;
}

function pctText(d: Delta): string {
  if (d.pct == null) return d.value ? "new" : "";
  return `${d.pct > 0 ? "+" : ""}${d.pct}%`;
}

/* ---------------------------------- pieces --------------------------------- */

function Card<T>({
  title,
  r,
  retry,
  foot,
  wide,
  children,
}: {
  title: string;
  r: SourceResult<T>;
  retry: () => void;
  foot?: (d: T) => ReactNode;
  wide?: boolean;
  children: (d: T) => ReactNode;
}) {
  return (
    <article className={`flex min-w-0 flex-col rounded-xl border border-white/10 bg-white/[0.03] p-3 ${wide ? "sm:col-span-2" : ""}`} aria-label={title}>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h2>
      {r.status === "error" ? (
        <div role="alert" className="flex flex-1 flex-col items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">
          <span>
            <b>Could not load.</b> {r.message}
          </span>
          <button type="button" onClick={retry} className="rounded border border-red-400/40 px-2 py-0.5 hover:bg-red-400/10">
            Try again
          </button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-2">{children(r.data)}</div>
      )}
      {r.status === "ok" && (
        <p className="mt-2 text-[11px] leading-snug text-zinc-500">
          {foot ? <>{foot(r.data)} </> : null}
          <span title={r.cached ? "Kept from an earlier load (up to a minute old)" : "Just computed"}>As of {fmtTime(r.at)}.</span>
        </p>
      )}
    </article>
  );
}

function Figure({ href, value, label, change, small, tone }: { href: string; value: string; label: string; change?: ReactNode; small?: boolean; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-red-300" : tone === "warn" ? "text-amber-200" : "text-cyan-50";
  return (
    <Link href={href} className="group block rounded-lg px-1 py-0.5 hover:bg-white/5">
      <span className={`block font-semibold tabular-nums ${small ? "text-lg" : "text-2xl"} ${color} group-hover:underline`}>{value}</span>
      <span className="block text-xs text-zinc-400">{label}</span>
      {change && <span className="block text-xs">{change}</span>}
    </Link>
  );
}

/** "+12% (34 → 38)" against the comparison period. Up is green unless more is worse. */
function Change({ d, goodWhenUp = true, comparable = true }: { d: Delta; goodWhenUp?: boolean; comparable?: boolean }) {
  if (!comparable) return <span className="text-zinc-500">no earlier data to compare</span>;
  if (d.diff === 0) return <span className="text-zinc-500">no change ({n(d.previous)} before)</span>;
  const up = d.diff > 0;
  const good = up === goodWhenUp;
  const pct = d.pct == null ? "new" : `${up ? "+" : ""}${d.pct}%`;
  return (
    <span className={good ? "text-emerald-300" : "text-red-300"}>
      {up ? "▲" : "▼"} {pct} <span className="text-zinc-500">({n(d.previous)} before)</span>
    </span>
  );
}

function MoneyRows({ href, m, label, empty, goodWhenUp = true }: { href: string; m: MoneyDelta; label: string; empty?: string; goodWhenUp?: boolean }) {
  const cs = currenciesOf(Object.fromEntries(Object.entries(m).map(([c, d]) => [c, d.value])));
  if (!cs.length) return empty ? <p className="text-sm text-zinc-500">{empty}</p> : null;
  return (
    <ul className="space-y-1">
      {cs.map((c) => {
        const d = m[c];
        return (
          <li key={c}>
            <Link href={href} className="group flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg px-1 py-0.5 hover:bg-white/5">
              <span className="text-xl font-semibold tabular-nums text-cyan-50 group-hover:underline">{fmtMoney(d.value, c)}</span>
              <span className="text-xs">
                <span className="text-zinc-400">{label} · </span>
                <MoneyChange d={d} c={c} goodWhenUp={goodWhenUp} />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function MoneyChange({ d, c, goodWhenUp }: { d: Delta; c: string; goodWhenUp: boolean }) {
  if (d.diff === 0) return <span className="text-zinc-500">no change</span>;
  const up = d.diff > 0;
  return (
    <span className={up === goodWhenUp ? "text-emerald-300" : "text-red-300"}>
      {up ? "▲" : "▼"} {d.pct == null ? "new" : `${up ? "+" : ""}${d.pct}%`} <span className="text-zinc-500">({fmtMoney(d.previous, c)} before)</span>
    </span>
  );
}

function AmountList({ amounts }: { amounts: Record<string, number> }) {
  const cs = currenciesOf(amounts);
  if (!cs.length) return null;
  return <p className="text-xs text-zinc-400">{cs.map((c) => fmtMoney(amounts[c], c)).join(" · ")}</p>;
}

function Panel({ title, note, more, children }: { title: string; note?: string; more?: { href: string; label: string }; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-100">{title}</h2>
        {more && (
          <Link href={more.href} className="text-xs text-cyan-300 hover:underline">
            {more.label} →
          </Link>
        )}
      </div>
      {children}
      {note && <p className="mt-2 text-[11px] text-zinc-500">{note}</p>}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "up" ? "bg-emerald-500/15 text-emerald-300" : status === "degraded" ? "bg-amber-400/15 text-amber-300" : status === "down" ? "bg-red-500/15 text-red-300" : "bg-white/5 text-zinc-400";
  return <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>{status.replace("_", " ")}</span>;
}

function Unavailable({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-500">{children}</p>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-500">{children}</p>;
}
