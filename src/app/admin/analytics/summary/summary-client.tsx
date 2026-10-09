"use client";

// src/app/admin/analytics/summary/summary-client.tsx — the period's analytics
// on one printable page. The print stylesheet drops the admin navigation and
// the dark theme, so "Print" (or Save as PDF) gives a plain report.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AnalyticsReport } from "@/lib/admin/analytics";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Loading, Notice, btn } from "../../ui";
import { PeriodBar, usePeriod } from "../period";
import { changeText } from "../analytics-client";

const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; color: #000 !important; }
  aside, nav, header, footer, .print\\:hidden { display: none !important; }
  .print-sheet, .print-sheet * { color: #000 !important; background: transparent !important; border-color: #bbb !important; box-shadow: none !important; }
  .print-sheet table { page-break-inside: auto; }
  .print-sheet tr { page-break-inside: avoid; }
  .print-sheet section { page-break-inside: avoid; }
}`;

export default function SummaryClient() {
  const { adminFetch } = useAdmin();
  const p = usePeriod(30);
  const [data, setData] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    setError(null);
    const r = await adminFetch<AnalyticsReport>(`/api/admin/analytics?${p.query}`);
    if (r.ok) setData(r.data);
    else setError(r.data.message ?? "Could not load the summary.");
  }, [adminFetch, p.query]);
  useEffect(() => {
    load();
  }, [load]);

  const cell = "border-b border-white/10 py-1 pr-3";
  return (
    <div>
      <style>{PRINT_CSS}</style>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href={`/admin/analytics?${p.query}`} className="text-sm text-cyan-300 hover:underline">
          ← Analytics
        </Link>
        <button type="button" className={btn.primary} onClick={() => window.print()} disabled={!data}>
          Print or save as PDF
        </button>
      </div>
      <PeriodBar p={p} />
      {error && <Notice kind="err">{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <article className="print-sheet space-y-5 rounded-xl border border-white/10 bg-white/[0.02] p-5 text-sm text-zinc-200">
          <div>
            <h1 className="text-xl font-semibold text-white">NeoConference platform summary</h1>
            <p className="text-zinc-400">
              {data.period.from} to {data.period.to} ({data.period.tz}), compared with {data.previous.from} to {data.previous.to}. Printed {fmtTime(Date.now())}.
            </p>
            <p className="text-xs text-zinc-500">
              Activity figures come from the activity log{data.logSince ? `, which began ${fmtTime(data.logSince)}` : ", which has no events yet"}; meetings and plans from stores with full history. Active users and retention use UTC days.
            </p>
          </div>

          <section>
            <h2 className="mb-1 font-semibold text-white">Key figures</h2>
            <table className="w-full">
              <thead className="text-left text-xs text-zinc-400">
                <tr>
                  <th className={cell}>Figure</th>
                  <th className={`${cell} text-right`}>This period</th>
                  <th className={`${cell} text-right`}>Previous</th>
                  <th className={`${cell} text-right`}>Change</th>
                </tr>
              </thead>
              <tbody>
                {data.figures.map((f) => (
                  <tr key={f.key}>
                    <td className={cell}>{f.label}</td>
                    <td className={`${cell} text-right tabular-nums`}>{f.value.toLocaleString()}</td>
                    <td className={`${cell} text-right tabular-nums`}>{f.previous.toLocaleString()}</td>
                    <td className={`${cell} text-right`}>{changeText(f.change).text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="mb-1 font-semibold text-white">Most-used features</h2>
            <table className="w-full">
              <tbody>
                {data.features.map((f) => (
                  <tr key={f.type}>
                    <td className={cell}>{f.label}</td>
                    <td className={`${cell} text-right tabular-nums`}>{f.count.toLocaleString()}</td>
                    <td className={`${cell} text-right`}>{changeText(f.change).text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="mb-1 font-semibold text-white">Conversion and cancellations</h2>
            <p>
              Free → paid: <b>{data.conversion.conversions}</b> · all purchases: <b>{data.conversion.purchases}</b> ({data.conversion.revenueEsp.toLocaleString()} ESP) · cancellations: <b>{data.cancellations.cancelled}</b> (previous period {data.cancellations.previousCancelled}) · plans ended: <b>{data.cancellations.ended}</b> (previous period {data.cancellations.previousEnded}).
            </p>
          </section>

          {data.retention.length > 0 && (
            <section>
              <h2 className="mb-1 font-semibold text-white">Retention by weekly cohort (UTC)</h2>
              <table className="w-full">
                <thead className="text-left text-xs text-zinc-400">
                  <tr>
                    <th className={cell}>Week of</th>
                    <th className={`${cell} text-right`}>People</th>
                    <th className={cell}>Active in week 0, 1, 2…</th>
                  </tr>
                </thead>
                <tbody>
                  {data.retention.map((c) => (
                    <tr key={c.week}>
                      <td className={cell}>{c.week}</td>
                      <td className={`${cell} text-right tabular-nums`}>{c.size}</td>
                      <td className={cell}>{c.retained.map((n) => `${Math.round((n / c.size) * 100)}%`).join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section>
            <h2 className="mb-1 font-semibold text-white">Plans of meeting owners</h2>
            <p>{data.plans.map((x) => `${x.plan}: ${x.meetings} meetings by ${x.owners} owner${x.owners === 1 ? "" : "s"}`).join(" · ") || "No meetings created."}</p>
          </section>

          <section>
            <h2 className="mb-1 font-semibold text-white">Top accounts by meetings</h2>
            <table className="w-full">
              <thead className="text-left text-xs text-zinc-400">
                <tr>
                  <th className={cell}>Account</th>
                  <th className={cell}>Plan</th>
                  <th className={`${cell} text-right`}>Meetings</th>
                  <th className={`${cell} text-right`}>Minutes</th>
                  <th className={`${cell} text-right`}>Participants</th>
                  <th className={`${cell} text-right`}>Rec. hours</th>
                  <th className={`${cell} text-right`}>API calls</th>
                </tr>
              </thead>
              <tbody>
                {[...data.accounts].sort((a, b) => b.meetings - a.meetings || b.meetingMinutes - a.meetingMinutes).slice(0, 20).map((a) => (
                  <tr key={a.id}>
                    <td className={cell}>{a.label}</td>
                    <td className={cell}>{a.plan}</td>
                    <td className={`${cell} text-right tabular-nums`}>{a.meetings}</td>
                    <td className={`${cell} text-right tabular-nums`}>{a.meetingMinutes}</td>
                    <td className={`${cell} text-right tabular-nums`}>{a.participants}</td>
                    <td className={`${cell} text-right tabular-nums`}>{a.recordingHours}</td>
                    <td className={`${cell} text-right tabular-nums`}>{a.apiCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </article>
      )}
    </div>
  );
}
