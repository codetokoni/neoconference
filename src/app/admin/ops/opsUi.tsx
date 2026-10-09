"use client";

// src/app/admin/ops/opsUi.tsx — pieces the Operations pages share: status
// badges (colour + icon + word, never colour alone), sizes and durations,
// and the 24-hour health history chart.

import { useState } from "react";
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
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export type HealthPoint = { t: number; s: ProbeStatus; l: number | null };

// Status ramp (reserved for state, with the badge legend beside it).
const FILL: Record<ProbeStatus, string> = { up: "#34d399", degraded: "#fbbf24", down: "#f87171", not_configured: "#52525b" };

/**
 * The last 24 hours of one service: a status strip (one cell per check) and
 * its latency as a 2px line beneath. Hover shows the check's time, status
 * and latency.
 */
export function HealthHistory({ points, label }: { points: HealthPoint[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = [...points].reverse(); // oldest first
  const W = 288;
  const H = 40;
  if (!pts.length) return <p className="text-xs text-zinc-500">No history yet — it fills in every 5 minutes.</p>;
  const n = pts.length;
  const cw = W / Math.max(n, 1);
  const lat = pts.map((p) => p.l ?? 0);
  const max = Math.max(100, ...lat);
  const y = (v: number) => 14 + (H - 16) * (1 - v / max);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${(i + 0.5) * cw},${y(p.l ?? 0)}`).join(" ");
  const h = hover != null ? pts[hover] : null;
  return (
    <div className="relative">
      <svg
        role="img"
        aria-label={`${label}: last ${n} checks`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-12 w-full"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.floor(((e.clientX - r.left) / r.width) * n);
          setHover(Math.max(0, Math.min(n - 1, i)));
        }}
      >
        {pts.map((p, i) => (
          <rect key={i} x={i * cw + 0.25} y={0} width={Math.max(cw - 0.5, 0.5)} height={8} rx={1} fill={FILL[p.s] ?? FILL.not_configured} />
        ))}
        <path d={line} fill="none" stroke="#67e8f9" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {hover != null && <line x1={(hover + 0.5) * cw} x2={(hover + 0.5) * cw} y1={0} y2={H} stroke="#a1a1aa" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <p aria-live="polite" className="h-4 text-right font-mono text-[11px] text-zinc-300">
        {h ? `${new Date(h.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${STATUS[h.s]?.label ?? h.s} · ${fmtMs(h.l)}` : ""}
      </p>
    </div>
  );
}

/** Small table of key/value counts. */
export function Counts({ items }: { items: Array<[string, string | number]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="truncate text-xs text-zinc-500">{k}</dt>
          <dd className="font-mono text-zinc-100">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
