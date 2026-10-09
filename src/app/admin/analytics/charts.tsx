"use client";

// src/app/admin/analytics/charts.tsx — the analytics pages' small charts:
// a daily bar chart (one or two series) and horizontal bars. Plain SVG and
// divs; every value is also in the table exports and, for screen readers
// and anyone who wants the numbers, in a "Show data" table under the chart.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { fmtDay, fmtNumber } from "../AdminApi";

const COLORS = ["#22d3ee", "#a78bfa", "#fbbf24", "#34d399"];

function nice(max: number): number {
  if (max <= 5) return Math.max(1, Math.ceil(max));
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function shortDay(d: string): string {
  const [, m, day] = d.split("-");
  return `${Number(day)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}`;
}

/** The chart's own width in CSS pixels, so its text stays the same size on a phone as on a desktop. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

export function DailyBars({
  title,
  days,
  series,
  note,
}: {
  title: string;
  days: string[];
  /** `avg`: the legend shows the daily average, for a series whose days do not add up (active users). */
  series: Array<{ label: string; values: number[]; avg?: boolean }>;
  note?: string;
}) {
  const { ref, w } = useWidth(640);
  const W = Math.max(240, w);
  // A little taller on a narrow screen so the bars are not slivers.
  const H = W < 480 ? 150 : 170;
  const pad = { l: 40, r: 8, t: 10, b: 22 };
  const max = nice(Math.max(0, ...series.flatMap((s) => s.values)));
  const n = Math.max(1, days.length);
  const slot = (W - pad.l - pad.r) / n;
  const barW = Math.max(1, (slot * 0.8) / series.length);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  // About one date label per 64 px, so they never overlap.
  const tickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - pad.l) / 64))));
  const totals = series.map((s) => s.values.reduce((a, b) => a + b, 0) / (s.avg ? Math.max(1, s.values.length) : 1));
  const range = days.length ? `${fmtDay(days[0])} to ${fmtDay(days[days.length - 1])}` : "no days";
  const summary = `${title}, ${range}. ${series
    .map((s, i) => {
      const peak = Math.max(0, ...s.values);
      const at = s.values.indexOf(peak);
      return `${s.label}: ${s.avg ? "average" : "total"} ${fmtNumber(Math.round(totals[i] * 10) / 10)}${peak > 0 && at >= 0 ? `, highest ${fmtNumber(peak)} on ${fmtDay(days[at])}` : ""}`;
    })
    .join("; ")}.`;
  return (
    <figure className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-zinc-100">{title}</span>
        <span className="flex flex-wrap gap-3 text-xs text-zinc-400">
          {series.map((s, i) => (
            <span key={s.label} className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[i] }} />
              {s.label}
              {s.avg ? " (avg)" : ""}: <b className="text-zinc-200">{fmtNumber(Math.round(totals[i] * 10) / 10)}</b>
            </span>
          ))}
        </span>
      </figcaption>
      <div ref={ref} className="w-full">
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="block">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" className="text-white/10" />
              <text x={pad.l - 4} y={y(max * f) + 4} textAnchor="end" fontSize="11" className="fill-zinc-400">
                {fmtNumber(Math.round(max * f * 10) / 10)}
              </text>
            </g>
          ))}
          {days.map((d, i) => (
            <g key={d}>
              {series.map((s, j) => {
                const v = s.values[i] ?? 0;
                return (
                  <rect key={s.label} x={pad.l + i * slot + slot * 0.1 + j * barW} y={y(v)} width={barW} height={Math.max(0, y(0) - y(v))} fill={COLORS[j]} rx={1}>
                    <title>{`${fmtDay(d)} · ${s.label}: ${fmtNumber(v)}`}</title>
                  </rect>
                );
              })}
              {i % tickEvery === 0 && (
                <text x={pad.l + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="11" className="fill-zinc-400">
                  {shortDay(d)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      {note && <p className="mt-1 text-[11px] text-zinc-400">{note}</p>}
      <details className="mt-1 text-xs text-zinc-400 print:hidden">
        <summary className="cursor-pointer select-none hover:text-zinc-200">Show data</summary>
        <div className="mt-1 max-h-64 overflow-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{title}, per day</caption>
            <thead className="sticky top-0 bg-[#0B1220] text-zinc-400">
              <tr>
                <th className="py-1 pr-3 font-medium">Day</th>
                {series.map((s) => (
                  <th key={s.label} className="py-1 pr-3 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d} className="border-t border-white/5">
                  <td className="py-0.5 pr-3">{fmtDay(d)}</td>
                  {series.map((s) => (
                    <td key={s.label} className="py-0.5 pr-3 text-right tabular-nums">
                      {fmtNumber(s.values[i] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function HBars({ rows, unit }: { rows: Array<{ label: string; value: number; sub?: string; href?: string }>; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const body = (
          <>
            <span className="flex justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-zinc-200">{r.label}</span>
              <span className="shrink-0 tabular-nums text-zinc-300">
                {fmtNumber(r.value)}
                {unit ? ` ${unit}` : ""}
                {r.sub && <span className="ml-2 text-xs text-zinc-400">{r.sub}</span>}
              </span>
            </span>
            <span aria-hidden className="mt-0.5 block h-1.5 rounded bg-white/5">
              <span className="block h-1.5 rounded bg-cyan-400/70" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
          </>
        );
        return (
          <li key={r.label}>
            {r.href ? (
              <Link href={r.href} className="block rounded px-1 py-0.5 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400">
                {body}
              </Link>
            ) : (
              <div className="px-1 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
