"use client";

// src/app/admin/analytics/charts.tsx — the analytics pages' small charts:
// a daily bar chart (one or two series) and horizontal bars. Plain SVG and
// divs; every value is also in the table exports.

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
  const W = 640;
  const H = 170;
  const pad = { l: 36, r: 8, t: 10, b: 22 };
  const max = nice(Math.max(0, ...series.flatMap((s) => s.values)));
  const n = Math.max(1, days.length);
  const slot = (W - pad.l - pad.r) / n;
  const barW = Math.max(1, (slot * 0.8) / series.length);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const tickEvery = Math.ceil(n / 8);
  const totals = series.map((s) => s.values.reduce((a, b) => a + b, 0) / (s.avg ? Math.max(1, s.values.length) : 1));
  return (
    <figure className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-zinc-100">{title}</span>
        <span className="flex flex-wrap gap-3 text-xs text-zinc-400">
          {series.map((s, i) => (
            <span key={s.label} className="inline-flex items-center gap-1">
              <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[i] }} />
              {s.label}
              {s.avg ? " (avg)" : ""}: <b className="text-zinc-200">{Math.round(totals[i] * 10) / 10}</b>
            </span>
          ))}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, per day`} className="h-auto w-full">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" className="text-white/10" />
            <text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end" fontSize="10" className="fill-zinc-500">
              {Math.round(max * f * 10) / 10}
            </text>
          </g>
        ))}
        {days.map((d, i) => (
          <g key={d}>
            {series.map((s, j) => {
              const v = s.values[i] ?? 0;
              return (
                <rect key={s.label} x={pad.l + i * slot + slot * 0.1 + j * barW} y={y(v)} width={barW} height={Math.max(0, y(0) - y(v))} fill={COLORS[j]} rx={1}>
                  <title>{`${d} · ${s.label}: ${v}`}</title>
                </rect>
              );
            })}
            {i % tickEvery === 0 && (
              <text x={pad.l + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize="10" className="fill-zinc-500">
                {shortDay(d)}
              </text>
            )}
          </g>
        ))}
      </svg>
      {note && <p className="mt-1 text-[11px] text-zinc-500">{note}</p>}
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
              <span className="truncate text-zinc-200">{r.label}</span>
              <span className="shrink-0 tabular-nums text-zinc-300">
                {r.value.toLocaleString()}
                {unit ? ` ${unit}` : ""}
                {r.sub && <span className="ml-2 text-xs text-zinc-500">{r.sub}</span>}
              </span>
            </span>
            <span className="mt-0.5 block h-1.5 rounded bg-white/5">
              <span className="block h-1.5 rounded bg-cyan-400/70" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
          </>
        );
        return (
          <li key={r.label}>
            {r.href ? (
              <a href={r.href} className="block rounded px-1 py-0.5 hover:bg-white/5">
                {body}
              </a>
            ) : (
              <div className="px-1 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
