"use client";

// src/app/admin/analytics/analytics-client.tsx — adoption, retention,
// conversion, cancellations, features and consumption by account, for a
// period compared with the one before. Every figure opens the records behind
// it: a Logs search, the meetings list below, or the accounts table.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountRow, AnalyticsReport, Figure } from "@/lib/admin/analytics";
import { fmtDay, fmtMoney, fmtNumber, fmtTime, useAdmin } from "../AdminApi";
import { Badge, Empty, LoadState, Notice, PageHeader, Pager, Panel, SortTh, StatTile, btn, field, useClientTable, type SortDir } from "../ui";
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

const REPORTS = ["summary", "daily", "features", "retention", "accounts", "plans"];

/** A button that downloads an export through adminFetch's code prompt, saying what it exports. */
function ExportButton({ url, label, onError }: { url: string; label: string; onError: (m: string | null) => void }) {
  const { adminDownload } = useAdmin();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={btn.ghost}
      disabled={busy}
      aria-busy={busy}
      onClick={async () => {
        onError(null);
        setBusy(true);
        const r = await adminDownload(url);
        setBusy(false);
        if (!r.ok && r.data.error !== "cancelled") onError(r.data.message ?? `The export failed (HTTP ${r.status}).`);
      }}
    >
      {busy ? "Preparing…" : label}
    </button>
  );
}

export default function AnalyticsClient() {
  const { adminFetch, can } = useAdmin();
  const p = usePeriod(30);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [records, setRecords] = useState<{ metric: string; items: MeetingRecord[]; withTitles: boolean } | null>(null);
  const [signUps, setSignUps] = useState<SignUpRecord[] | null>(null);
  const [report, setReport] = useState("summary");
  const sort = (SORTS.some((s) => s.key === p.params.get("sort")) ? p.params.get("sort") : "meetings") as keyof AccountRow;
  const dir: SortDir = p.params.get("dir") === "asc" ? "asc" : "desc";

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
    setActionErr(null);
    if (metric === "signUps") {
      const r = await adminFetch<{ items: SignUpRecord[] }>(`/api/admin/analytics/records?metric=signUps&${p.query}`);
      if (r.ok) {
        setRecords(null);
        setSignUps(r.data.items);
      } else return setActionErr(r.data.message ?? "Could not load the sign-ups.");
      setTimeout(() => document.getElementById("records")?.scrollIntoView({ behavior: "smooth" }), 50);
      return;
    }
    setSignUps(null);
    const r = await adminFetch<{ items: MeetingRecord[]; withTitles: boolean }>(`/api/admin/analytics/records?metric=${metric}&${p.query}`);
    if (r.ok) setRecords({ metric, items: r.data.items, withTitles: r.data.withTitles });
    else return setActionErr(r.data.message ?? "Could not load the records.");
    setTimeout(() => document.getElementById("records")?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  const accounts = useMemo(
    () => [...(data?.accounts ?? [])].sort((a, b) => ((a[sort] as number) - (b[sort] as number)) * (dir === "asc" ? 1 : -1)),
    [data, sort, dir],
  );
  const accountPage = useClientTable(accounts, () => 0, { key: "none", dir: "desc" });
  const signUpTable = useClientTable(signUps, (u) => u.createdAt, { key: "createdAt", dir: "desc" });
  const meetingTable = useClientTable(
    records?.items,
    (m, k) => (k === "meeting" ? m.title ?? m.slug : k === "owner" ? m.owner : k === "created" ? m.createdAt : k === "ended" ? m.endedAt : m.minutes),
    { key: "created", dir: "desc" },
  );

  const figureAction = (f: Figure) => {
    if (f.drill.kind === "logs") return { href: logsHref(f.drill.type, p.query) };
    if (f.drill.kind === "records") {
      const metric = f.drill.metric;
      return { onClick: () => openRecords(metric), active: metric === "signUps" ? !!signUps : records?.metric === metric };
    }
    const s = f.drill.sort;
    return {
      onClick: () => {
        p.setParams({ sort: s, dir: null });
        document.getElementById("accounts")?.scrollIntoView({ behavior: "smooth" });
      },
      active: sort === s && !!p.params.get("sort"),
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
                <select aria-label="Report to export as CSV" value={report} onChange={(e) => setReport(e.target.value)} className={`${field} w-auto py-1.5`}>
                  {REPORTS.map((r) => (
                    <option key={r} value={r}>
                      {r[0].toUpperCase() + r.slice(1)}
                    </option>
                  ))}
                </select>
                <ExportButton url={exportUrl("csv")} label={`Export ${report} as CSV`} onError={setActionErr} />
                <ExportButton url={exportUrl("xlsx")} label="Export all reports as Excel" onError={setActionErr} />
              </>
            )}
          </>
        }
      />
      <PeriodBar p={p} />
      {actionErr && (
        <Notice kind="err" onClose={() => setActionErr(null)}>
          {actionErr}
        </Notice>
      )}
      <LoadState data={data} error={error} onRetry={load}>
        {(d) => (
          <div className="space-y-4">
            <section aria-label="Summary figures" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              {d.figures.map((f) => {
                const c = changeText(f.change);
                const act = figureAction(f);
                return (
                  <div key={f.key} data-figure={f.key} className="min-w-0">
                    <StatTile
                      label={f.label}
                      value={fmtNumber(f.value)}
                      hint={
                        <>
                          <Badge tone={c.tone}>{c.text}</Badge> was {fmtNumber(f.previous)} · {f.source === "store" ? "history" : "log"}
                        </>
                      }
                      href={"href" in act ? act.href : undefined}
                      onClick={"onClick" in act ? act.onClick : undefined}
                      active={"active" in act ? act.active : undefined}
                    />
                  </div>
                );
              })}
            </section>
            <p className="text-xs text-zinc-400">
              <Link href="/admin/events?state=live" className="text-cyan-300 hover:underline">
                {fmtNumber(d.liveNow)} meeting{d.liveNow === 1 ? "" : "s"} live right now
              </Link>
              . “log” figures come from the activity log; “history” from stores that kept their own (meetings; accounts in Clerk). Active users and cohorts use UTC days.
            </p>

            <div className="grid gap-3 lg:grid-cols-2">
              <DailyBars title="Adoption" days={d.days} series={[{ label: "Sign-ups", values: d.daily.signUps }, { label: "Active users (UTC day)", values: d.daily.activeDaily, avg: true }]} />
              <DailyBars title="Meetings" days={d.days} series={[{ label: "Created", values: d.daily.meetings }, { label: "Joins", values: d.daily.joins }]} />
              <DailyBars title="Meeting minutes" days={d.days} series={[{ label: "Minutes", values: d.daily.meetingMinutes }]} />
              <DailyBars title="Plans" days={d.days} series={[{ label: "Purchases", values: d.daily.purchases }, { label: "Cancellations", values: d.daily.cancellations }, { label: "Plans ended", values: d.daily.downgrades }]} />
            </div>

            {signUps && (
              <Panel className="scroll-mt-4">
                <div id="records" className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white">Accounts created · {fmtNumber(signUps.length)}</h2>
                  <span className="flex flex-wrap gap-2">
                    {can("reports:export") && (
                      <>
                        <ExportButton url={`/api/admin/analytics/records?metric=signUps&${p.query}&format=csv`} label="Export sign-ups as CSV" onError={setActionErr} />
                        <ExportButton url={`/api/admin/analytics/records?metric=signUps&${p.query}&format=xlsx`} label="Export sign-ups as Excel" onError={setActionErr} />
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
                  <>
                    <ul className="divide-y divide-white/5 text-sm">
                      {signUpTable.visible.map((u) => (
                        <li key={u.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                          <Link href={u.href} className="min-w-0 break-words text-zinc-100 hover:text-cyan-300 hover:underline">
                            {u.label} <span className="text-xs text-zinc-400">{u.email}</span>
                          </Link>
                          <span className="text-zinc-400">{fmtTime(u.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                    <Pager page={signUpTable.page} pageSize={signUpTable.pageSize} total={signUpTable.total} onPage={signUpTable.setPage} onPageSize={signUpTable.setPageSize} noun="account" />
                  </>
                )}
              </Panel>
            )}

            {records && (
              <Panel className="scroll-mt-4">
                <div id="records" className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white">
                    {records.metric === "meetings" ? "Meetings created" : "Meetings that ended"} · {fmtNumber(records.items.length)}
                  </h2>
                  <span className="flex flex-wrap gap-2">
                    {can("reports:export") && (
                      <>
                        <ExportButton url={`/api/admin/analytics/records?metric=${records.metric}&${p.query}&format=csv`} label="Export these meetings as CSV" onError={setActionErr} />
                        <ExportButton url={`/api/admin/analytics/records?metric=${records.metric}&${p.query}&format=xlsx`} label="Export these meetings as Excel" onError={setActionErr} />
                      </>
                    )}
                    <button type="button" className={btn.ghost} onClick={() => setRecords(null)}>
                      Close
                    </button>
                  </span>
                </div>
                {!records.withTitles && <p className="mb-2 text-xs text-zinc-400">Titles are shown to administrators who can view meetings (events:read).</p>}
                {records.items.length === 0 ? (
                  <Empty>No meetings in this period.</Empty>
                ) : (
                  <>
                    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Meetings in this period (scrolls sideways)">
                      <table className="w-full min-w-[680px] text-left text-sm">
                        <thead className="text-xs text-zinc-400">
                          <tr>
                            <SortTh label="Meeting" k="meeting" sort={meetingTable.sort} onSort={meetingTable.onSort} className="pl-0" />
                            <SortTh label="Owner" k="owner" sort={meetingTable.sort} onSort={meetingTable.onSort} />
                            <th className="px-3 py-2 font-medium">Plan</th>
                            <SortTh label="Created" k="created" sort={meetingTable.sort} onSort={meetingTable.onSort} />
                            <SortTh label="Ended" k="ended" sort={meetingTable.sort} onSort={meetingTable.onSort} />
                            <SortTh label="Minutes" k="minutes" sort={meetingTable.sort} onSort={meetingTable.onSort} className="text-right" />
                          </tr>
                        </thead>
                        <tbody>
                          {meetingTable.visible.map((m) => (
                            <tr key={m.id} className="border-t border-white/5">
                              <td className="py-1.5 pr-3 text-zinc-200">{m.title ?? m.slug}</td>
                              <td className="px-3 text-zinc-300">{m.owner}</td>
                              <td className="px-3 text-zinc-400">{m.plan}</td>
                              <td className="px-3 text-zinc-400">{fmtTime(m.createdAt)}</td>
                              <td className="px-3 text-zinc-400">{fmtTime(m.endedAt)}</td>
                              <td className="px-3 text-right tabular-nums text-zinc-300">{fmtNumber(m.minutes)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pager page={meetingTable.page} pageSize={meetingTable.pageSize} total={meetingTable.total} onPage={meetingTable.setPage} onPageSize={meetingTable.setPageSize} noun="meeting" />
                  </>
                )}
              </Panel>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              <Panel className="min-w-0">
                <h2 className="mb-1 text-base font-semibold text-white">Retention by weekly cohort</h2>
                <p className="mb-2 text-xs text-zinc-400">
                  People who signed up in a UTC week (Monday start), and the share active in each week after. Week 0 is the sign-up week. Cohorts start with the first full week the activity log ran
                  {d.cohortsFrom ? ` (${fmtDay(d.cohortsFrom)}, UTC)` : ""}.
                </p>
                {d.retention.length === 0 ? (
                  <Empty>No cohort to follow in this period yet.</Empty>
                ) : (
                  <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Retention by cohort (scrolls sideways)">
                    <table className="text-xs">
                      <caption className="sr-only">Retention cohorts: the share of each week&apos;s sign-ups active in each week after</caption>
                      <thead className="text-zinc-400">
                        <tr>
                          <th className="pr-2 text-left font-normal">Week of (UTC)</th>
                          <th className="pr-2 text-right font-normal">People</th>
                          {Array.from({ length: Math.max(...d.retention.map((c) => c.retained.length)) }, (_, k) => (
                            <th key={k} className="px-1 text-center font-normal">
                              <abbr title={`Week ${k}`}>W{k}</abbr>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {d.retention.map((c) => (
                          <tr key={c.week}>
                            <td className="whitespace-nowrap pr-2 text-zinc-300">{fmtDay(c.week)}</td>
                            <td className="pr-2 text-right tabular-nums text-zinc-300">{fmtNumber(c.size)}</td>
                            {c.retained.map((n, k) => {
                              const pct = Math.round((n / c.size) * 100);
                              return (
                                <td key={k} className="px-0.5 py-0.5">
                                  <span title={`${fmtNumber(n)} of ${fmtNumber(c.size)}`} className="block min-w-[2.5rem] rounded px-1 py-0.5 text-center tabular-nums text-white" style={{ background: `rgba(34,211,238,${0.08 + (pct / 100) * 0.42})` }}>
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

              <Panel className="min-w-0">
                <h2 className="mb-2 text-base font-semibold text-white">Conversion and cancellations</h2>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <div className="min-w-0">
                    <dt className="text-xs text-zinc-400">Free → paid</dt>
                    <dd className="text-xl font-semibold text-white">
                      <Link href={logsHref("plan.purchased", p.query) + "&q=%22from%22%3A%22free%22"} className="hover:underline">
                        {fmtNumber(d.conversion.conversions)}
                      </Link>
                    </dd>
                    <dd className="text-xs text-zinc-400">{d.conversion.perSignUp === null ? "no sign-ups to compare with" : `${fmtNumber(d.conversion.perSignUp)} per 100 sign-ups`}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-zinc-400">All purchases</dt>
                    <dd className="text-xl font-semibold text-white">
                      <Link href={logsHref("plan.purchased", p.query)} className="hover:underline">
                        {fmtNumber(d.conversion.purchases)}
                      </Link>
                    </dd>
                    <dd className="text-xs text-zinc-400">{fmtMoney(d.conversion.revenueEsp, "ESP")}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-zinc-400">Cancellations</dt>
                    <dd className="text-xl font-semibold text-white">
                      <Link href={logsHref("plan.cancelled", p.query)} className="hover:underline">
                        {fmtNumber(d.cancellations.cancelled)}
                      </Link>
                    </dd>
                    <dd className="text-xs text-zinc-400">was {fmtNumber(d.cancellations.previousCancelled)} the period before</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-zinc-400">Plans ended</dt>
                    <dd className="text-xl font-semibold text-white">
                      <Link href={logsHref("plan.downgraded", p.query)} className="hover:underline">
                        {fmtNumber(d.cancellations.ended)}
                      </Link>
                    </dd>
                    <dd className="break-words text-xs text-zinc-400">
                      {Object.entries(d.cancellations.endedByPlan).map(([k, v]) => `${k}: ${fmtNumber(v)}`).join(" · ") || "—"} · was {fmtNumber(d.cancellations.previousEnded)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-zinc-400">
                  From the subscription records’ changes: a purchase when eSPees returns the buyer, a cancellation when an administrator cancels, a plan ending at the daily sweep — counted from the day the log began. Each account’s full record is under Billing → Subscriptions.
                </p>
              </Panel>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <Panel className="min-w-0">
                <h2 className="mb-2 text-base font-semibold text-white">Most-used features</h2>
                <HBars
                  rows={d.features.map((f) => ({
                    label: f.label,
                    value: f.count,
                    sub: changeText(f.change).text,
                    href: f.type === "api.call" ? undefined : logsHref(f.type, p.query),
                  }))}
                />
              </Panel>
              <Panel className="min-w-0">
                <h2 className="mb-1 text-base font-semibold text-white">Plans of meeting owners</h2>
                <p className="mb-2 text-xs text-zinc-400">The plan on each owner’s account (Clerk), for everyone who created a meeting in the period. “staff” runs on the top tier by role.</p>
                {d.plans.length === 0 ? (
                  <Empty>No meetings created in this period.</Empty>
                ) : (
                  <HBars rows={d.plans.map((x) => ({ label: x.plan, value: x.meetings, sub: `${fmtNumber(x.owners)} owner${x.owners === 1 ? "" : "s"}` }))} unit="meetings" />
                )}
              </Panel>
            </div>

            <Panel>
              <div id="accounts" className="mb-2 flex scroll-mt-4 flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-white">Resource use by account</h2>
                <span className="text-xs text-zinc-400">Meetings and minutes: full history. Participants, recordings, API calls, uploads: from the activity log. Storage of recordings is not measured.</span>
              </div>
              {accounts.length === 0 ? (
                <Empty>No account used anything in this period.</Empty>
              ) : (
                <>
                  <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Usage by account (scrolls sideways)">
                    <table className="w-full min-w-[820px] text-left text-sm">
                      <thead className="text-xs text-zinc-400">
                        <tr>
                          <th className="py-1.5 pr-3 font-medium">Account</th>
                          <th className="px-3 font-medium">Plan</th>
                          {SORTS.map((s) => (
                            <SortTh
                              key={s.key}
                              label={s.label}
                              k={s.key}
                              sort={{ key: sort, dir }}
                              onSort={(k, dr) => {
                                p.setParams({ sort: k, dir: dr === "desc" ? null : dr });
                                accountPage.setPage(1);
                              }}
                              className="text-right"
                            />
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {accountPage.visible.map((a) => (
                          <tr key={a.id} className="border-t border-white/5">
                            <td className="py-1.5 pr-3">
                              <Link href={a.href} className="text-zinc-100 hover:text-cyan-300 hover:underline">
                                {a.label}
                              </Link>
                              {a.email && a.email !== a.label && <span className="block text-xs text-zinc-400">{a.email}</span>}
                            </td>
                            <td className="px-3 text-zinc-400">{a.plan}</td>
                            {SORTS.map((s) => (
                              <td key={s.key} className="px-3 text-right tabular-nums text-zinc-300">
                                {fmtNumber(a[s.key] as number)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={accountPage.page} pageSize={accountPage.pageSize} total={accountPage.total} onPage={accountPage.setPage} onPageSize={accountPage.setPageSize} noun="account" />
                </>
              )}
            </Panel>
          </div>
        )}
      </LoadState>
    </div>
  );
}
