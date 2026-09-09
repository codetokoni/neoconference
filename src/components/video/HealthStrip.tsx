"use client";

import { useCallback, useEffect, useState } from "react";

type CheckStatus = "ok" | "degraded" | "down" | "off";

interface Check {
  status: CheckStatus;
  latencyMs: number | null;
  detail: string;
}

interface Health {
  ok: true;
  room: string;
  at: number;
  checks: {
    programme: Check;
    storage: Check;
    translation: Check;
  };
}

/**
 * One-glance ops strip for the moderator hub. Renders four coloured
 * dots (programme / storage / translation / age) with the last check
 * timestamp underneath. Hover a dot for the raw detail line. Polls
 * every 10s — cheap because every probe on the server side runs in
 * parallel with a short timeout.
 *
 * "off" is deliberately gray, not red — an event that isn't
 * broadcasting yet is a totally normal state and shouldn't look like
 * a fire. Red is reserved for "supposed to be working, isn't."
 */
export default function HealthStrip({ room }: { room: string }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [failedAt, setFailedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/video/health?room=${encodeURIComponent(room)}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (j.ok) {
        setHealth(j as Health);
        setFailedAt(null);
      } else {
        setFailedAt(Date.now());
      }
    } catch {
      setFailedAt(Date.now());
    }
  }, [room]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (!health && !failedAt) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#101820] px-3 py-2 text-xs text-white/45">
        Checking…
      </div>
    );
  }
  if (failedAt && !health) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
        Health endpoint unreachable — check your connection.
      </div>
    );
  }

  const c = health!.checks;
  const age = Math.round((Date.now() - health!.at) / 1000);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/12 bg-[#0F1519] px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
        Health
      </span>
      <Dot label="Programme" check={c.programme} hint="AMS main-track HLS" />
      <Dot label="Translation" check={c.translation} hint="worker /healthz" />
      <Dot label="Storage" check={c.storage} hint="Vercel KV round-trip" />
      <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
        checked {age}s ago
      </span>
    </div>
  );
}

function Dot({ label, check, hint }: { label: string; check: Check; hint: string }) {
  const dotClass =
    check.status === "ok"
      ? "bg-emerald-400"
      : check.status === "degraded"
        ? "bg-amber-400"
        : check.status === "off"
          ? "bg-white/25"
          : "bg-red-500 animate-pulse";
  const textClass =
    check.status === "ok"
      ? "text-white/70"
      : check.status === "degraded"
        ? "text-amber-200"
        : check.status === "off"
          ? "text-white/40"
          : "text-red-300";
  const latency =
    check.latencyMs != null ? ` · ${check.latencyMs} ms` : "";
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${label} — ${check.status}\n${check.detail}${latency}\n${hint}`}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
      <span className={`font-mono text-[10.5px] uppercase tracking-[0.14em] ${textClass}`}>
        {label}
      </span>
    </span>
  );
}
