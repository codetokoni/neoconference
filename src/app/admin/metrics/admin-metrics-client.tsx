"use client";

// src/app/admin/metrics/admin-metrics-client.tsx
// Read-only admin metrics dashboard. Hand-written SVG charts (no chart
// library dep). Designed for screenshot / copy-summary sharing with
// stakeholders.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarDays,
  Clipboard,
  Clock,
  Loader2,
  Users,
} from "lucide-react";
import { useToaster } from "../events/Toaster";

type Range = "today" | "week" | "month" | "quarter" | "year" | "all" | "custom";

interface DayBucket {
  date: string;
  count: number;
}

interface PlanCounts {
  eventCount: number;
  ownerCount: number;
  recordingCount: number;
}

interface MetricsResponse {
  range: { from: string; to: string; label: string };
  totalEvents: number;
  uniqueOwners: number;
  streamingMinutes: number;
  activeEventsNow: number;
  eventsPerDay: DayBucket[];
  planBreakdown: { free: PlanCounts; paid: PlanCounts };
}

const RANGE_BUTTONS: ReadonlyArray<{ value: Exclude<Range, "custom">; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
  { value: "all", label: "All time" },
];

export default function AdminMetricsClient() {
  const [range, setRange] = useState<Range>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const customPopoverRef = useRef<HTMLDivElement | null>(null);

  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  const { pushToast, Toaster } = useToaster();

  useEffect(() => {
    if (!customOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!customPopoverRef.current?.contains(e.target as Node)) setCustomOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCustomOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [customOpen]);

  const fetchMetrics = useCallback(async () => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/admin/metrics", window.location.origin);
      url.searchParams.set("range", range);
      if (range === "custom") {
        if (customFrom) url.searchParams.set("from", new Date(customFrom).toISOString());
        if (customTo) url.searchParams.set("to", new Date(customTo + "T23:59:59").toISOString());
      }
      const res = await fetch(url, { cache: "no-store" });
      const json = (await res.json()) as MetricsResponse | { error?: string };
      if (!res.ok) {
        const msg = (json as { error?: string }).error || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      if (myReq === reqIdRef.current) setData(json as MetricsResponse);
    } catch (e) {
      if (myReq === reqIdRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [range, customFrom, customTo]);

  useEffect(() => {
    if (range === "custom" && (!customFrom || !customTo)) return;
    fetchMetrics();
  }, [fetchMetrics, range, customFrom, customTo]);

  const handleCopy = useCallback(async () => {
    if (!data) return;
    const lines = [
      `NeoConference Stats — ${data.range.label}`,
      `- ${data.totalEvents.toLocaleString()} events created`,
      `- ${data.uniqueOwners.toLocaleString()} unique event owners`,
      `- ${data.streamingMinutes.toLocaleString()} streaming minutes`,
      `- ${data.activeEventsNow.toLocaleString()} live events right now`,
      `- ${data.planBreakdown.free.eventCount.toLocaleString()} free plan events, ${data.planBreakdown.paid.eventCount.toLocaleString()} paid plan events`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast({ kind: "success", text: "Copied to clipboard" });
    } catch (e) {
      pushToast({ kind: "error", text: `Failed to copy: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [data, pushToast]);

  return (
    <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 sm:py-8 text-zinc-200">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold text-cyan-100">Admin · Metrics</h1>
        <p className="mt-1 text-sm text-zinc-400">Platform usage at a glance.</p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {RANGE_BUTTONS.map((b) => (
          <RangePill
            key={b.value}
            label={b.label}
            active={range === b.value}
            onClick={() => setRange(b.value)}
          />
        ))}
        <div ref={customPopoverRef} className="relative">
          <RangePill
            label="Custom"
            active={range === "custom"}
            onClick={() => {
              setRange("custom");
              setCustomOpen((o) => !o);
            }}
          />
          {customOpen && (
            <div
              className="absolute left-0 top-full z-30 mt-2 w-72 rounded-2xl border p-4 backdrop-blur-xl shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
              style={{
                background: "rgba(0,0,0,0.85)",
                borderColor: "rgba(255,255,255,0.1)",
                borderWidth: "0.5px",
              }}
            >
              <div className="space-y-3">
                <label className="block text-xs text-zinc-400">
                  From
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-cyan-400/60"
                  />
                </label>
                <label className="block text-xs text-zinc-400">
                  To
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-cyan-400/60"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    if (customFrom && customTo) {
                      setRange("custom");
                      setCustomOpen(false);
                      fetchMetrics();
                    }
                  }}
                  disabled={!customFrom || !customTo}
                  className="w-full rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:bg-cyan-500/40 disabled:cursor-not-allowed"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
        {data && (
          <span className="ml-2 text-xs text-zinc-500">
            {data.range.label}
            {loading && <span className="ml-2 text-cyan-400/60">refreshing...</span>}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Failed to load metrics: {error}
        </div>
      )}

      {!data && loading && (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-cyan-300" aria-hidden="true" />
        </div>
      )}

      {data && (
        <>
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumberCard
              label="Total events"
              value={data.totalEvents}
              icon={<CalendarDays className="h-4 w-4 text-cyan-400/70" aria-hidden="true" />}
            />
            <NumberCard
              label="Unique owners"
              value={data.uniqueOwners}
              icon={<Users className="h-4 w-4 text-cyan-400/70" aria-hidden="true" />}
            />
            <NumberCard
              label="Streaming minutes"
              value={data.streamingMinutes}
              icon={<Clock className="h-4 w-4 text-cyan-400/70" aria-hidden="true" />}
            />
            <NumberCard
              label="Live right now"
              value={data.activeEventsNow}
              icon={<Activity className="h-4 w-4 text-red-400/70" aria-hidden="true" />}
              accent={data.activeEventsNow > 0 ? "text-red-400" : undefined}
            />
          </div>

          <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ChartCard title="Events created per day">
                <LineChart points={data.eventsPerDay} />
              </ChartCard>
            </div>
            <div>
              <ChartCard title="Plan breakdown">
                <DonutChart
                  free={data.planBreakdown.free.eventCount}
                  paid={data.planBreakdown.paid.eventCount}
                />
              </ChartCard>
            </div>
          </div>

          <div className="mb-5">
            <ChartCard title="Plan breakdown details">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-white/[0.08] text-[10px] font-medium uppercase tracking-widest text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Plan tier</th>
                    <th className="px-3 py-2 text-right">Event count</th>
                    <th className="px-3 py-2 text-right">Owner count</th>
                    <th className="px-3 py-2 text-right">Recording count</th>
                  </tr>
                </thead>
                <tbody>
                  <PlanRow label="Free" tone="zinc" counts={data.planBreakdown.free} />
                  <PlanRow label="Paid" tone="cyan" counts={data.planBreakdown.paid} />
                </tbody>
              </table>
            </ChartCard>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400"
            >
              <Clipboard className="h-3.5 w-3.5" aria-hidden="true" />
              Copy summary
            </button>
          </div>
        </>
      )}

      <Toaster />
    </main>
  );
}

/* ----------------------------- small components ---------------------------- */

function RangePill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200"
          : "border-white/10 bg-black/40 text-zinc-300 hover:bg-white/[0.06]",
      ].join(" ")}
      style={!active ? { borderWidth: "0.5px" } : undefined}
    >
      {label}
    </button>
  );
}

function NumberCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <div
      className="relative rounded-2xl border p-5 backdrop-blur-xl"
      style={{
        background: "rgba(0,0,0,0.4)",
        borderColor: "rgba(255,255,255,0.08)",
        borderWidth: "0.5px",
      }}
    >
      <div className="absolute top-4 right-4">{icon}</div>
      <div className="text-xs font-medium uppercase tracking-widest text-zinc-400">{label}</div>
      <div
        className={[
          "mt-2 text-3xl font-semibold tabular-nums",
          accent || "text-zinc-100",
        ].join(" ")}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl border p-4 backdrop-blur-xl"
      style={{
        background: "rgba(0,0,0,0.4)",
        borderColor: "rgba(255,255,255,0.08)",
        borderWidth: "0.5px",
      }}
    >
      <h3 className="mb-3 text-xs font-medium uppercase tracking-widest text-zinc-400">{title}</h3>
      {children}
    </div>
  );
}

function PlanRow({
  label,
  tone,
  counts,
}: {
  label: string;
  tone: "zinc" | "cyan";
  counts: PlanCounts;
}) {
  const dot = tone === "cyan" ? "bg-cyan-400" : "bg-zinc-500";
  return (
    <tr className="border-b border-white/[0.04] last:border-b-0">
      <td className="px-3 py-3 align-middle">
        <span className="inline-flex items-center gap-2 text-zinc-200">
          <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
          {label}
        </span>
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-zinc-200">
        {counts.eventCount.toLocaleString()}
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-zinc-200">
        {counts.ownerCount.toLocaleString()}
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-zinc-200">
        {counts.recordingCount.toLocaleString()}
      </td>
    </tr>
  );
}

/* -------------------------------- Line chart ------------------------------- */
// Catmull-Rom-to-Bezier smoothing, cyan stroke, gradient fill, dashed gridlines.

function LineChart({ points }: { points: DayBucket[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const maxCount = useMemo(() => {
    return Math.max(1, ...points.map((p) => p.count));
  }, [points]);

  const yTickMax = useMemo(() => niceCeiling(maxCount), [maxCount]);

  if (points.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-zinc-500">
        No data in range.
      </div>
    );
  }

  const W = 600;
  const H = 240;
  const padL = 36;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xFor = (i: number) =>
    points.length === 1 ? padL + innerW / 2 : padL + (i / (points.length - 1)) * innerW;
  const yFor = (count: number) => padT + innerH - (count / yTickMax) * innerH;

  const xy = points.map((p, i) => ({ x: xFor(i), y: yFor(p.count) }));
  const pathD = catmullRomToBezier(xy);
  const fillD = `${pathD} L ${xy[xy.length - 1].x} ${padT + innerH} L ${xy[0].x} ${padT + innerH} Z`;

  // Y-axis: 5 horizontal lines (0, 1/4, 1/2, 3/4, max).
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: padT + innerH - f * innerH,
    value: Math.round(yTickMax * f),
  }));

  // X-axis: show ~6-8 labels evenly spaced.
  const xLabelStep = Math.max(1, Math.ceil(points.length / 7));
  const xLabels: Array<{ x: number; text: string }> = [];
  for (let i = 0; i < points.length; i += xLabelStep) {
    xLabels.push({ x: xFor(i), text: formatShortDate(points[i].date) });
  }
  if (xLabels.length > 0 && xLabels[xLabels.length - 1].x !== xFor(points.length - 1)) {
    xLabels.push({ x: xFor(points.length - 1), text: formatShortDate(points[points.length - 1].date) });
  }

  const hovered = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Events created per day"
      >
        <defs>
          <linearGradient id="line-fill-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(34,211,238)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="rgb(34,211,238)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={padL}
              x2={W - padR}
              y1={t.y}
              y2={t.y}
              stroke="rgb(63,63,70)"
              strokeDasharray="3 4"
              strokeWidth="0.5"
            />
            <text
              x={padL - 6}
              y={t.y + 3}
              textAnchor="end"
              className="fill-zinc-500"
              style={{ fontSize: "10px" }}
            >
              {t.value}
            </text>
          </g>
        ))}

        <path d={fillD} fill="url(#line-fill-grad)" />
        <path
          d={pathD}
          fill="none"
          stroke="rgb(34,211,238)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {xy.map((p, i) => (
          <g key={i}>
            <circle
              cx={p.x}
              cy={p.y}
              r={hoverIdx === i ? 4 : 2.5}
              fill="rgb(34,211,238)"
              stroke="rgba(0,0,0,0.6)"
              strokeWidth="1"
            />
            <circle
              cx={p.x}
              cy={p.y}
              r={12}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{ cursor: "pointer" }}
            />
          </g>
        ))}

        {xLabels.map((l, i) => (
          <text
            key={i}
            x={l.x}
            y={H - 6}
            textAnchor="middle"
            className="fill-zinc-400"
            style={{ fontSize: "10px" }}
          >
            {l.text}
          </text>
        ))}
      </svg>

      {hovered && (
        <div
          className="pointer-events-none absolute top-2 right-2 rounded-lg border border-cyan-400/30 bg-black/80 px-2.5 py-1 text-xs text-zinc-100 shadow-md"
          style={{ borderWidth: "0.5px" }}
        >
          <div className="font-mono text-cyan-300">{hovered.count}</div>
          <div className="text-zinc-400">{formatShortDate(hovered.date)}</div>
        </div>
      )}
    </div>
  );
}

function catmullRomToBezier(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = i === 0 ? points[0] : points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = i === points.length - 2 ? points[i + 1] : points[i + 2];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

function niceCeiling(max: number): number {
  if (max <= 1) return 1;
  if (max <= 5) return 5;
  if (max <= 10) return 10;
  const order = Math.pow(10, Math.floor(Math.log10(max)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * order);
  for (const c of candidates) {
    if (c >= max) return c;
  }
  return max;
}

function formatShortDate(iso: string): string {
  // iso is YYYY-MM-DD or full ISO; take YYYY-MM-DD prefix.
  const ymd = iso.slice(0, 10);
  const d = new Date(ymd + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/* -------------------------------- Donut chart ------------------------------ */

function DonutChart({ free, paid }: { free: number; paid: number }) {
  const total = free + paid;
  if (total === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-zinc-500">
        No events in range.
      </div>
    );
  }

  const W = 200;
  const cx = W / 2;
  const cy = W / 2;
  const R = 90;
  const r = 63;

  const freeFrac = free / total;
  const paidFrac = paid / total;
  const freePct = Math.round(freeFrac * 100);
  const paidPct = 100 - freePct;

  let freePath = "";
  let paidPath = "";

  if (free === 0 || paid === 0) {
    // One full ring.
    const ringColor = free > 0 ? "rgb(82,82,91)" : "rgb(34,211,238)";
    return (
      <div className="flex flex-col items-center">
        <svg viewBox={`0 0 ${W} ${W}`} className="w-44 h-44">
          <circle cx={cx} cy={cy} r={R} fill={ringColor} />
          <circle cx={cx} cy={cy} r={r} fill="rgb(10,11,18)" />
          <text
            x={cx}
            y={cy - 4}
            textAnchor="middle"
            className="fill-zinc-100"
            style={{ fontSize: "28px", fontWeight: 600 }}
          >
            {total.toLocaleString()}
          </text>
          <text
            x={cx}
            y={cy + 14}
            textAnchor="middle"
            className="fill-zinc-500"
            style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "1.5px" }}
          >
            events
          </text>
        </svg>
        <DonutLegend free={free} paid={paid} freePct={freePct} paidPct={paidPct} />
      </div>
    );
  }

  // Two slices. Start at 12 o'clock (-90deg).
  const startAngle = -Math.PI / 2;
  const freeEnd = startAngle + freeFrac * 2 * Math.PI;
  const paidEnd = freeEnd + paidFrac * 2 * Math.PI;

  freePath = arcRing(cx, cy, R, r, startAngle, freeEnd);
  paidPath = arcRing(cx, cy, R, r, freeEnd, paidEnd);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${W}`} className="w-44 h-44">
        <path d={freePath} fill="rgb(82,82,91)" />
        <path d={paidPath} fill="rgb(34,211,238)" />
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-zinc-100"
          style={{ fontSize: "28px", fontWeight: 600 }}
        >
          {total.toLocaleString()}
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-zinc-500"
          style={{ fontSize: "10px", textTransform: "uppercase", letterSpacing: "1.5px" }}
        >
          events
        </text>
      </svg>
      <DonutLegend free={free} paid={paid} freePct={freePct} paidPct={paidPct} />
    </div>
  );
}

function DonutLegend({
  free,
  paid,
  freePct,
  paidPct,
}: {
  free: number;
  paid: number;
  freePct: number;
  paidPct: number;
}) {
  return (
    <div className="mt-3 w-full space-y-1.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-zinc-300">
          <span className="h-2 w-2 rounded-full bg-zinc-500" aria-hidden="true" />
          Free
        </span>
        <span className="tabular-nums text-zinc-400">
          {free.toLocaleString()} <span className="text-zinc-600">·</span> {freePct}%
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-zinc-300">
          <span className="h-2 w-2 rounded-full bg-cyan-400" aria-hidden="true" />
          Paid
        </span>
        <span className="tabular-nums text-zinc-400">
          {paid.toLocaleString()} <span className="text-zinc-600">·</span> {paidPct}%
        </span>
      </div>
    </div>
  );
}

function arcRing(
  cx: number,
  cy: number,
  R: number,
  r: number,
  startAngle: number,
  endAngle: number
): string {
  const sweep = endAngle - startAngle;
  const largeArc = sweep > Math.PI ? 1 : 0;
  const x1 = cx + R * Math.cos(startAngle);
  const y1 = cy + R * Math.sin(startAngle);
  const x2 = cx + R * Math.cos(endAngle);
  const y2 = cy + R * Math.sin(endAngle);
  const x3 = cx + r * Math.cos(endAngle);
  const y3 = cy + r * Math.sin(endAngle);
  const x4 = cx + r * Math.cos(startAngle);
  const y4 = cy + r * Math.sin(startAngle);
  return [
    `M ${x1} ${y1}`,
    `A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${r} ${r} 0 ${largeArc} 0 ${x4} ${y4}`,
    "Z",
  ].join(" ");
}
