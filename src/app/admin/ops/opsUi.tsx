"use client";

// src/app/admin/ops/opsUi.tsx — pieces the Operations pages share: status
// badges (colour + icon + word, never colour alone), sizes and durations,
// and the 24-hour health history chart. Times use the shared admin
// formatters (<Time mode="relative"> rather than a local "ago").

import { useState } from "react";
import { fmtNumber, fmtTime } from "../AdminApi";
import { Badge } from "../ui";

export type ProbeStatus = "up" | "degraded" | "down" | "not_configured";

const STATUS: Record<string, { tone: "green" | "amber" | "red" | "zinc" | "cyan"; icon: string; label: string }> = {
  up: { tone: "green", icon: "●", label: "Up" },
  degraded: { tone: "amber", icon: "▲", label: "Degraded" },
  down: { tone: "red", icon: "✕", label: "Down" },
  not_configured: { tone: "zinc", icon: "○", label: "Not configured" },
  ok: { tone: "green", icon: "●", label: "OK" },
  skipped: { tone: "zinc", icon: "○", label: "Skipped" },
  failed: { tone: "red", icon: "✕", label: "Failed" },
  running: { tone: "cyan", icon: "◐", label: "Running" },
  abandoned: { tone: "amber", icon: "▲", label: "Abandoned" },
  open: { tone: "red", icon: "!", label: "Open" },
  acknowledged: { tone: "amber", icon: "◐", label: "Acknowledged" },
  resolved: { tone: "green", icon: "✓", label: "Resolved" },
  investigating: { tone: "red", icon: "!", label: "Investigating" },
  identified: { tone: "amber", icon: "◐", label: "Identified" },
  monitoring: { tone: "cyan", icon: "◐", label: "Monitoring" },
  scheduled: { tone: "cyan", icon: "○", label: "Scheduled" },
  queued: { tone: "cyan", icon: "○", label: "Queued" },
  pending: { tone: "cyan", icon: "○", label: "Pending" },
  live: { tone: "green", icon: "●", label: "Live" },
  off_air: { tone: "zinc", icon: "○", label: "Off air" },
  sending: { tone: "cyan", icon: "◐", label: "Sending" },
  paused: { tone: "amber", icon: "‖", label: "Paused" },
  paid: { tone: "green", icon: "✓", label: "Paid" },
  active: { tone: "amber", icon: "●", label: "Active" },
  completed: { tone: "green", icon: "✓", label: "Completed" },
  cancelled: { tone: "zinc", icon: "✕", label: "Cancelled" },
};

export function statusLabel(status: string): string {
  return STATUS[status]?.label ?? status;
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: "zinc" as const, icon: "○", label: status };
  return (
    <Badge tone={s.tone}>
      <span aria-hidden className="mr-1">
        {s.icon}
      </span>
      {s.label}
    </Badge>
  );
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${fmtNumber(n / 1e9, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} GB`;
  if (n >= 1e6) return `${fmtNumber(n / 1e6, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;
  if (n >= 1e3) return `${fmtNumber(n / 1e3, { maximumFractionDigits: 0 })} kB`;
  return `${n} B`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${fmtNumber(ms / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export type HealthPoint = { t: number; s: ProbeStatus; l: number | null };

// Status ramp (reserved for state, with the badge legend beside it).
const FILL: Record<ProbeStatus, string> = { up: "#34d399", degraded: "#fbbf24", down: "#f87171", not_configured: "#52525b" };

/**
 * The last 24 hours of one service: a status strip (one cell per check) and
 * its latency as a 2px line beneath. Pointer, touch, or the arrow keys once
 * the chart has focus, show one check's time, status and latency; the label
 * sums the day up and "Show data" lists every check as a table.
 */
export function HealthHistory({ points, label }: { points: HealthPoint[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = [...points].reverse(); // oldest first
  const W = 288;
  const H = 40;
  if (!pts.length) return <p className="text-xs text-zinc-400">No history yet — it fills in every 5 minutes.</p>;
  const n = pts.length;
  const cw = W / Math.max(n, 1);
  const lat = pts.map((p) => p.l ?? 0);
  const max = Math.max(100, ...lat);
  const y = (v: number) => 14 + (H - 16) * (1 - v / max);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${(i + 0.5) * cw},${y(p.l ?? 0)}`).join(" ");
  const h = hover != null ? pts[hover] : null;
  const tally = (s: ProbeStatus) => pts.filter((p) => p.s === s).length;
  const latest = pts[n - 1];
  const summary =
    `${label}: last ${n} checks — ${tally("up")} up, ${tally("degraded")} degraded, ${tally("down")} down` +
    `${tally("not_configured") ? `, ${tally("not_configured")} not configured` : ""}; latest ${statusLabel(latest.s)} at ${fmtTime(latest.t)}. ` +
    "Use the arrow keys to read each check.";
  const pick = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    const i = Math.floor(((clientX - r.left) / r.width) * n);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  return (
    <div className="relative">
      <svg
        role="img"
        aria-label={summary}
        tabIndex={0}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-12 w-full touch-pan-y rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setHover(null);
        }}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
        onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          const cur = hover ?? n;
          const next = e.key === "ArrowLeft" ? cur - 1 : e.key === "ArrowRight" ? cur + 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
          if (next == null) return;
          e.preventDefault();
          setHover(Math.max(0, Math.min(n - 1, next)));
        }}
      >
        {pts.map((p, i) => (
          <rect key={i} x={i * cw + 0.25} y={0} width={Math.max(cw - 0.5, 0.5)} height={8} rx={1} fill={FILL[p.s] ?? FILL.not_configured} />
        ))}
        <path d={line} fill="none" stroke="#67e8f9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {hover != null && <line x1={(hover + 0.5) * cw} x2={(hover + 0.5) * cw} y1={0} y2={H} stroke="#a1a1aa" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <p aria-live="polite" className="h-4 truncate text-right font-mono text-[11px] text-zinc-300">
        {h ? `${fmtTime(h.t)} · ${statusLabel(h.s)} · ${fmtMs(h.l)}` : ""}
      </p>
      <details className="text-[11px] text-zinc-400">
        <summary className="cursor-pointer select-none hover:text-zinc-300">Show data</summary>
        <div className="mt-1 max-h-48 overflow-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{label}: every check in the last 24 hours, newest first</caption>
            <thead>
              <tr>
                <th className="py-0.5 pr-3 font-medium">Checked</th>
                <th className="py-0.5 pr-3 font-medium">Status</th>
                <th className="py-0.5 font-medium">Latency</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={i} className="border-t border-white/5 text-zinc-400">
                  <td className="py-0.5 pr-3">{fmtTime(p.t)}</td>
                  <td className="py-0.5 pr-3">{statusLabel(p.s)}</td>
                  <td className="py-0.5 font-mono">{fmtMs(p.l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Small table of key/value counts. */
export function Counts({ items }: { items: Array<[string, string | number]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="truncate text-xs text-zinc-400">{k}</dt>
          <dd className="font-mono text-zinc-100">{typeof v === "number" ? fmtNumber(v) : v}</dd>
        </div>
      ))}
    </dl>
  );
}
