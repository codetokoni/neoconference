"use client";

// src/app/admin/analytics/summary/summary-client.tsx — the period's analytics
// on one printable page. The print stylesheet drops the admin navigation and
// the dark theme, so "Print" (or Save as PDF) gives a plain report.

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AnalyticsReport } from "@/lib/admin/analytics";
import { fmtDay, fmtMoney, fmtNumber, fmtTime, useAdmin } from "../../AdminApi";
import { LoadState, btn } from "../../ui";
import { PeriodBar, usePeriod } from "../period";
import { changeText } from "../analytics-client";

const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; color: #000 !important; }
  aside, nav, header, footer, .print\\:hidden { display: none !important; }
  .print-sheet, .print-sheet * { color: #000 !important; background: transparent !important; border-color: #bbb !important; box-shadow: none !important; }
  .print-sheet table { page-break-inside: auto; min-width: 0 !important; }
  .print-sheet .overflow-x-auto { overflow: visible !important; }
  .print-sheet tr { page-break-inside: avoid; }
  .print-sheet section { page-break-inside: avoid; }
}`;

/** A table that scrolls sideways on a narrow screen and prints at the page's width. */
function Scroll({ minWidth, label, children }: { minWidth: number; label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`${label} (scrolls sideways)`}>
      <table className="w-full" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

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
      <LoadState data={data} error={error} onRetry={load}>
        {(d) => (
          <article className="print-sheet min-w-0 space-y-5 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-zinc-200 sm:p-5">
            <div>
              <h1 className="text-xl font-semibold text-white">NeoConference platform summary</h1>
              <p className="text-zinc-400">
                {fmtDay(d.period.from)} to {fmtDay(d.period.to)} ({d.period.tz}), compared with {fmtDay(d.previous.from)} to {fmtDay(d.previous.to)}. Printed {fmtTime(Date.now())}.
              </p>
              <p className="text-xs text-zinc-400">
                Activity figures come from the activity log{d.logSince ? `, which began ${fmtTime(d.logSince)}` : ", which has no events yet"}; meetings and plans from stores with full history. Active users and retention use UTC days.
              </p>
            </div>

            <section>
              <h2 className="mb-1 font-semibold text-white">Key figures</h2>
              <Scroll minWidth={420} label="Key figures">
                <thead className="text-left text-xs text-zinc-400">
                  <tr>
                    <th className={cell}>Figure</th>
                    <th className={`${cell} text-right`}>This period</th>
                    <th className={`${cell} text-right`}>Previous</th>
                    <th className={`${cell} text-right`}>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {d.figures.map((f) => (
                    <tr key={f.key}>
                      <td className={cell}>{f.label}</td>
                      <td className={`${cell} text-right tabular-nums`}>{fmtNumber(f.value)}</td>
                      <td className={`${cell} text-right tabular-nums`}>{fmtNumber(f.previous)}</td>
                      <td className={`${cell} text-right`}>{changeText(f.change).text}</td>
                    </tr>
                  ))}
                </tbody>
              </Scroll>
            </section>

            <section>
              <h2 className="mb-1 font-semibold text-white">Most-used features</h2>
              <Scroll minWidth={360} label="Most-used features">
                <thead className="sr-only">
                  <tr>
                    <th>Feature</th>
                    <th>Uses</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {d.features.map((f) => (
                    <tr key={f.type}>
                      <td className={cell}>{f.label}</td>
                      <td className={`${cell} text-right tabular-nums`}>{fmtNumber(f.count)}</td>
                      <td className={`${cell} text-right`}>{changeText(f.change).text}</td>
                    </tr>
                  ))}
                </tbody>
              </Scroll>
            </section>

            <section>
              <h2 className="mb-1 font-semibold text-white">Conversion and cancellations</h2>
              <p>
                Free → paid: <b>{fmtNumber(d.conversion.conversions)}</b> · all purchases: <b>{fmtNumber(d.conversion.purchases)}</b> ({fmtMoney(d.conversion.revenueEsp, "ESP")}) · cancellations:{" "}
                <b>{fmtNumber(d.cancellations.cancelled)}</b> (previous period {fmtNumber(d.cancellations.previousCancelled)}) · plans ended: <b>{fmtNumber(d.cancellations.ended)}</b> (previous period{" "}
                {fmtNumber(d.cancellations.previousEnded)}).
              </p>
            </section>

            {d.retention.length > 0 && (
              <section>
                <h2 className="mb-1 font-semibold text-white">Retention by weekly cohort (UTC)</h2>
                <Scroll minWidth={420} label="Retention by weekly cohort">
                  <thead className="text-left text-xs text-zinc-400">
                    <tr>
                      <th className={cell}>Week of</th>
                      <th className={`${cell} text-right`}>People</th>
                      <th className={cell}>Active in week 0, 1, 2…</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.retention.map((c) => (
                      <tr key={c.week}>
                        <td className={`${cell} whitespace-nowrap`}>{fmtDay(c.week)}</td>
                        <td className={`${cell} text-right tabular-nums`}>{fmtNumber(c.size)}</td>
                        <td className={cell}>{c.retained.map((n) => `${Math.round((n / c.size) * 100)}%`).join(" · ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </Scroll>
              </section>
            )}

            <section>
              <h2 className="mb-1 font-semibold text-white">Plans of meeting owners</h2>
              <p>{d.plans.map((x) => `${x.plan}: ${fmtNumber(x.meetings)} meetings by ${fmtNumber(x.owners)} owner${x.owners === 1 ? "" : "s"}`).join(" · ") || "No meetings created."}</p>
            </section>

            <section>
              <h2 className="mb-1 font-semibold text-white">Top accounts by meetings</h2>
              <Scroll minWidth={640} label="Top accounts by meetings">
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
                  {[...d.accounts]
                    .sort((a, b) => b.meetings - a.meetings || b.meetingMinutes - a.meetingMinutes)
                    .slice(0, 20)
                    .map((a) => (
                      <tr key={a.id}>
                        <td className={`${cell} break-words`}>{a.label}</td>
                        <td className={cell}>{a.plan}</td>
                        <td className={`${cell} text-right tabular-nums`}>{fmtNumber(a.meetings)}</td>
                        <td className={`${cell} text-right tabular-nums`}>{fmtNumber(a.meetingMinutes)}</td>
                        <td className={`${cell} text-right tabular-nums`}>{fmtNumber(a.participants)}</td>
                        <td className={`${cell} text-right tabular-nums`}>{fmtNumber(a.recordingHours)}</td>
                        <td className={`${cell} text-right tabular-nums`}>{fmtNumber(a.apiCalls)}</td>
                      </tr>
                    ))}
                </tbody>
              </Scroll>
              {d.accounts.length > 20 && <p className="mt-1 text-xs text-zinc-400">The top 20 of {fmtNumber(d.accounts.length)} accounts; the full list is on the Analytics page and in its export.</p>}
            </section>
          </article>
        )}
      </LoadState>
    </div>
  );
}
