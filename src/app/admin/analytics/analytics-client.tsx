"use client";

// src/app/admin/analytics/analytics-client.tsx — adoption, retention,
// conversion, cancellations, features and consumption by account, for a
// period compared with the one before. Every figure opens the records behind
// it: a Logs search, the meetings list below, or the accounts table.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountRow, AnalyticsReport, Figure } from "@/lib/admin/analytics";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn } from "../ui";
import { DailyBars, HBars } from "./charts";
import { PeriodBar, usePeriod } from "./period";

type Report = AnalyticsReport & { ok: boolean };

interface SignUpRecord {
  id: string;
  label: string;
  email: string;
  createdAt: number;
  href: string;
}

interface MeetingRecord {
  id: string;
  slug: string;
  title?: string;
  owner: string;
  ownerId: string;
  plan: string;
  createdAt: number | null;
  endedAt: number | null;
  minutes: number;
  state: string;
}

export function changeText(c: number | null): { text: string; tone: "green" | "red" | "zinc" } {
  if (c === null) return { text: "new", tone: "zinc" };
  if (c === 0) return { text: "no change", tone: "zinc" };
  return { text: `${c > 0 ? "▲" : "▼"} ${Math.abs(c)}%`, tone: c > 0 ? "green" : "red" };
}

function logsHref(type: string, query: string) {
  return `/admin/logs?source=activity${type ? `&type=${encodeURIComponent(type)}` : ""}&${query}`;
}

const SORTS: Array<{ key: keyof AccountRow; label: string }> = [
  { key: "meetings", label: "Meetings" },
  { key: "meetingMinutes", label: "Minutes" },
  { key: "participants", label: "Participants" },
  { key: "recordingHours", label: "Rec. hours" },
  { key: "apiCalls", label: "API calls" },
  { key: "uploadMB", label: "Uploads MB" },
];

export default function AnalyticsClient() {
  const { adminFetch, can } = useAdmin();
  const p = usePeriod(30);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<{ metric: string; items: MeetingRecord[]; withTitles: boolean } | null>(null);
  const [signUps, setSignUps] = useState<SignUpRecord[] | null>(null);
  const [report, setReport] = useState("summary");
  const sort = (p.params.get("sort") as keyof AccountRow) || "meetings";

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    const r = await adminFetch<Report>(`/api/admin/analytics?${p.query}`);
    if (r.ok) setData(r.data);
    else setError(r.data.message ?? "Could not load analytics.");
  }, [adminFetch, p.query]);

  useEffect(() => {
    load();
    setRecords(null);
    setSignUps(null);
  }, [load]);

  const openRecords = async (metric: string) => {
    if (metric === "signUps") {
      const r = await adminFetch<{ items: SignUpRecord[] }>(`/api/admin/analytics/records?metric=signUps&${p.query}`);
      if (r.ok) {
        setRecords(null);
        setSignUps(r.data.items);
      } else setError(r.data.message ?? "Could not load the sign-ups.");
      setTimeout(() => document.getElementById("records")?.scrollIntoView({ behavior: "smooth" }), 50);
      return;
    }
    setSignUps(null);
    const r = await adminFetch<{ items: MeetingRecord[]; withTitles: boolean }>(`/api/admin/analytics/records?metric=${metric}&${p.query}`);
    if (r.ok) setRecords({ metric, items: r.data.items, withTitles: r.data.withTitles });
    else setError(r.data.message ?? "Could not load the records.");
    setTimeout(() => document.getElementById("records")?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  const accounts = useMemo(
    () => [...(data?.accounts ?? [])].sort((a, b) => (b[sort] as number) - (a[sort] as number)),
    [data, sort],
  );

  const figureAction = (f: Figure) => {
    if (f.drill.kind === "logs") return { href: logsHref(f.drill.type, p.query) };
    if (f.drill.kind === "records") {
      const metric = f.drill.metric;
      return { onClick: () => openRecords(metric) };
    }
    const s = f.drill.sort;
    return {
      onClick: () => {
        p.setParams({ sort: s });
        document.getElementById("accounts")?.scrollIntoView({ behavior: "smooth" });
      },
    };
  };

  const exportUrl = (format: "csv" | "xlsx") => `/api/admin/analytics?${p.query}&format=${format}${format === "csv" ? `&report=${report}` : ""}`;

  return (
    <div>
      <PageHeader
        title="Analytics"
        sub={
          <>
            Adoption, retention, conversion and usage across the platform.{" "}
            {data?.logSince ? (
              <>Activity figures start on {fmtTime(data.logSince)}, when the activity log began; meetings and plans come from stores with their full history.</>
            ) : (
              <>The activity log has no events yet — activity figures fill in from its first day. Meetings and plans have their full history.</>
            )}
          </>
        }
        actions={
          <>
            <Link href={`/admin/analytics/summary?${p.query}`} className={btn.ghost}>
              Printable summary
            </Link>
            {can("reports:export") && (
              <>
                <select aria-label="Report to export as CSV" value={report} onChange={(e) => setReport(e.target.value)} className="rounded-lg border border-white/12 bg-black/40 px-2 py-1.5 text-sm text-zinc-100">
                  {["summary", "daily", "features", "retention", "accounts", "plans"].map((r) => (
                    <option key={r} value={r}>
                      {r[0].toUpperCase() + r.slice(1)}
                    </option>
                  ))}
                </select>
                <a href={exportUrl("csv")} className={btn.ghost} download>
                  CSV
                </a>
                <a href={exportUrl("xlsx")} className={btn.ghost} download>
                  Excel (all reports)
                </a>
              </>
            )}
          </>
        }
      />
      <PeriodBar p={p} />
      {error && <Notice kind="err">{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <div className="space-y-4">
          <section aria-label="Summary figures" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {data.figures.map((f) => {
              const c = changeText(f.change);
              const act = figureAction(f);
              const inner = (
                <>
                  <span className="flex items-start justify-between gap-1 text-xs text-zinc-400">
                    {f.label}
                    <Badge tone={f.source === "store" ? "cyan" : "zinc"}>{f.source === "store" ? "history" : "log"}</Badge>
                  </span>
                  <span className="mt-1 block text-2xl font-semibold tabular-nums text-white">{f.value.toLocaleString()}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
                    <Badge tone={c.tone}>{c.text}</Badge> was {f.previous.toLocaleString()}
                  </span>
                </>
              );
              const cls = "block w-full rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left transition hover:border-cyan-400/40 hover:bg-white/[0.05]";
              return "href" in act ? (
                <Link key={f.key} href={act.href!} className={cls} data-figure={f.key}>
                  {inner}
                </Link>
              ) : (
                <button key={f.key} type="button" onClick={act.onClick} className={cls} data-figure={f.key}>
                  {inner}
                </button>
              );
            })}
          </section>
          <p className="text-xs text-zinc-500">
            {data.liveNow} meeting{data.liveNow === 1 ? "" : "s"} live right now. “log” figures come from the activity log; “history” from stores that kept their own (meetings; accounts in Clerk). Active users and cohorts use UTC days.
          </p>

          <div className="grid gap-3 lg:grid-cols-2">
            <DailyBars title="Adoption" days={data.days} series={[{ label: "Sign-ups", values: data.daily.signUps }, { label: "Active users (UTC day)", values: data.daily.activeDaily, avg: true }]} />
            <DailyBars title="Meetings" days={data.days} series={[{ label: "Created", values: data.daily.meetings }, { label: "Joins", values: data.daily.joins }]} />
            <DailyBars title="Meeting minutes" days={data.days} series={[{ label: "Minutes", values: data.daily.meetingMinutes }]} />
            <DailyBars title="Plans" days={data.days} series={[{ label: "Purchases", values: data.daily.purchases }, { label: "Downgrades / ended", values: data.daily.downgrades }]} />
          </div>

          {signUps && (
            <Panel className="scroll-mt-4">
              <div id="records" className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-white">Accounts created · {signUps.length}</h2>
                <span className="flex gap-2">
                  {can("reports:export") && (
                    <>
                      <a className={btn.ghost} href={`/api/admin/analytics/records?metric=signUps&${p.query}&format=csv`} download>
                        CSV
                      </a>
                      <a className={btn.ghost} href={`/api/admin/analytics/records?metric=signUps&${p.query}&format=xlsx`} download>
                        Excel
                      </a>
                    </>
                  )}
                  <button type="button" className={btn.ghost} onClick={() => setSignUps(null)}>
                    Close
                  </button>
                </span>
              </div>
              {signUps.length === 0 ? (
                <Empty>No accounts were created in this period.</Empty>
              ) : (
                <ul className="max-h-96 divide-y divide-white/5 overflow-auto text-sm">
                  {signUps.map((u) => (
                    <li key={u.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                      <Link href={u.href} className="text-zinc-100 hover:text-cyan-300 hover:underline">
                        {u.label} <span className="text-xs text-zinc-500">{u.email}</span>
                      </Link>
                      <span className="text-zinc-400">{fmtTime(u.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {records && (
            <Panel className="scroll-mt-4">
              <div id="records" className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-white">
                  {records.metric === "meetings" ? "Meetings created" : "Meetings that ended"} · {records.items.length}
                </h2>
                <span className="flex gap-2">
                  {can("reports:export") && (
                    <>
                      <a className={btn.ghost} href={`/api/admin/analytics/records?metric=${records.metric}&${p.query}&format=csv`} download>
                        CSV
                      </a>
                      <a className={btn.ghost} href={`/api/admin/analytics/records?metric=${records.metric}&${p.query}&format=xlsx`} download>
                        Excel
                      </a>
                    </>
                  )}
                  <button type="button" className={btn.ghost} onClick={() => setRecords(null)}>
                    Close
                  </button>
                </span>
              </div>
              {!records.withTitles && <p className="mb-2 text-xs text-zinc-500">Titles are shown to administrators who can view meetings (events:read).</p>}
              {records.items.length === 0 ? (
                <Empty>No meetings in this period.</Empty>
              ) : (
                <div className="max-h-96 overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-[#0B1220] text-xs text-zinc-400">
                      <tr>
                        <th className="py-1.5 pr-3">Meeting</th>
                        <th className="pr-3">Owner</th>
                        <th className="pr-3">Plan</th>
                        <th className="pr-3">Created</th>
                        <th className="pr-3">Ended</th>
                        <th className="pr-3 text-right">Minutes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.items.map((m) => (
                        <tr key={m.id} className="border-t border-white/5">
                          <td className="py-1.5 pr-3 text-zinc-200">{m.title ?? m.slug}</td>
                          <td className="pr-3 text-zinc-300">{m.owner}</td>
                          <td className="pr-3 text-zinc-400">{m.plan}</td>
                          <td className="pr-3 text-zinc-400">{fmtTime(m.createdAt)}</td>
                          <td className="pr-3 text-zinc-400">{fmtTime(m.endedAt)}</td>
                          <td className="pr-3 text-right tabular-nums text-zinc-300">{m.minutes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel>
              <h2 className="mb-1 text-base font-semibold text-white">Retention by weekly cohort</h2>
              <p className="mb-2 text-xs text-zinc-500">
                People who signed up in a UTC week (Monday start), and the share active in each week after. Week 0 is the sign-up week. Cohorts start with the first full week the activity log ran
                {data.cohortsFrom ? ` (${data.cohortsFrom})` : ""}.
              </p>
              {data.retention.length === 0 ? (
                <Empty>No cohort to follow in this period yet.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-xs" aria-label="Retention cohorts">
                    <thead className="text-zinc-400">
                      <tr>
                        <th className="pr-2 text-left font-normal">Week of</th>
                        <th className="pr-2 text-right font-normal">People</th>
                        {Array.from({ length: Math.max(...data.retention.map((c) => c.retained.length)) }, (_, k) => (
                          <th key={k} className="px-1 text-center font-normal">
                            W{k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.retention.map((c) => (
                        <tr key={c.week}>
                          <td className="pr-2 text-zinc-300">{c.week}</td>
                          <td className="pr-2 text-right tabular-nums text-zinc-300">{c.size}</td>
                          {c.retained.map((n, k) => {
                            const pct = Math.round((n / c.size) * 100);
                            return (
                              <td key={k} className="px-0.5 py-0.5">
                                <span title={`${n} of ${c.size}`} className="block min-w-[2.5rem] rounded px-1 py-0.5 text-center tabular-nums text-white" style={{ background: `rgba(34,211,238,${0.08 + (pct / 100) * 0.6})` }}>
                                  {pct}%
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel>
              <h2 className="mb-2 text-base font-semibold text-white">Conversion and cancellations</h2>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-zinc-400">Free → paid</dt>
                  <dd className="text-xl font-semibold text-white">
                    <Link href={logsHref("plan.purchased", p.query) + "&q=%22from%22%3A%22free%22"} className="hover:underline">
                      {data.conversion.conversions}
                    </Link>
                  </dd>
                  <dd className="text-xs text-zinc-500">{data.conversion.perSignUp === null ? "no sign-ups to compare with" : `${data.conversion.perSignUp} per 100 sign-ups`}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-400">All purchases</dt>
                  <dd className="text-xl font-semibold text-white">
                    <Link href={logsHref("plan.purchased", p.query)} className="hover:underline">
                      {data.conversion.purchases}
                    </Link>
                  </dd>
                  <dd className="text-xs text-zinc-500">{data.conversion.revenueEsp.toLocaleString()} ESP</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-400">Downgrades / plans ended</dt>
                  <dd className="text-xl font-semibold text-white">
                    <Link href={logsHref("plan.downgraded", p.query)} className="hover:underline">
                      {data.cancellations.total}
                    </Link>
                  </dd>
                  <dd className="text-xs text-zinc-500">was {data.cancellations.previous} the period before</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-400">Ended plans by tier</dt>
                  <dd className="text-xs text-zinc-300">
                    {Object.entries(data.cancellations.byFromPlan).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-zinc-500">
                Purchases are counted when eSpees returns the buyer; plans ending are counted by the daily expiry sweep. Neither existed in the log before it began.
              </p>
            </Panel>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel>
              <h2 className="mb-2 text-base font-semibold text-white">Most-used features</h2>
              <HBars
                rows={data.features.map((f) => ({
                  label: f.label,
                  value: f.count,
                  sub: changeText(f.change).text,
                  href: f.type === "api.call" ? undefined : logsHref(f.type, p.query),
                }))}
              />
            </Panel>
            <Panel>
              <h2 className="mb-1 text-base font-semibold text-white">Plans of meeting owners</h2>
              <p className="mb-2 text-xs text-zinc-500">The plan on each owner’s account (Clerk), for everyone who created a meeting in the period. “staff” runs on the top tier by role.</p>
              {data.plans.length === 0 ? (
                <Empty>No meetings created in this period.</Empty>
              ) : (
                <HBars rows={data.plans.map((x) => ({ label: x.plan, value: x.meetings, sub: `${x.owners} owner${x.owners === 1 ? "" : "s"}` }))} unit="meetings" />
              )}
            </Panel>
          </div>

          <Panel>
            <div id="accounts" className="mb-2 flex flex-wrap items-center justify-between gap-2 scroll-mt-4">
              <h2 className="text-base font-semibold text-white">Resource use by account</h2>
              <span className="text-xs text-zinc-500">Meetings and minutes: full history. Participants, recordings, API calls, uploads: from the activity log. Storage of recordings is not measured.</span>
            </div>
            {accounts.length === 0 ? (
              <Empty>No account used anything in this period.</Empty>
            ) : (
              <div className="max-h-[32rem] overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-[#0B1220] text-xs text-zinc-400">
                    <tr>
                      <th className="py-1.5 pr-3">Account</th>
                      <th className="pr-3">Plan</th>
                      {SORTS.map((s) => (
                        <th key={s.key} className="pr-3 text-right" aria-sort={sort === s.key ? "descending" : "none"}>
                          <button type="button" onClick={() => p.setParams({ sort: s.key })} className={sort === s.key ? "text-cyan-300" : "hover:text-zinc-200"}>
                            {s.label}
                            {sort === s.key ? " ↓" : ""}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id} className="border-t border-white/5">
                        <td className="py-1.5 pr-3">
                          <Link href={a.href} className="text-zinc-100 hover:text-cyan-300 hover:underline">
                            {a.label}
                          </Link>
                          {a.email && a.email !== a.label && <span className="block text-xs text-zinc-500">{a.email}</span>}
                        </td>
                        <td className="pr-3 text-zinc-400">{a.plan}</td>
                        {SORTS.map((s) => (
                          <td key={s.key} className="pr-3 text-right tabular-nums text-zinc-300">
                            {(a[s.key] as number).toLocaleString()}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
