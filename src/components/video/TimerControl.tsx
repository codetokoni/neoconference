"use client";

import { useCallback, useEffect, useState } from "react";

interface Timer {
  label: string;
  durationMs: number;
  startedAt: number;
  paused?: number | null;
  expiresBehaviour: "hold" | "hide";
}

const PRESETS: Array<{ label: string; minutes: number }> = [
  { label: "1 min", minutes: 1 },
  { label: "5 min", minutes: 5 },
  { label: "10 min", minutes: 10 },
  { label: "15 min", minutes: 15 },
  { label: "30 min", minutes: 30 },
];

/**
 * Admin-side control for the programme-feed countdown. Set a
 * duration + label, and every viewer sees the same digits ticking at
 * the top of the player. Under 60s the overlay goes amber, under
 * 10s it goes red, at zero it flashes with "time's up" (or hides
 * itself, depending on expiresBehaviour).
 *
 * Kept intentionally simple: no cron or scheduled starts, no
 * per-participant timers, no reset-to-previous-duration button. The
 * shape that maps to how a producer actually runs a segment is
 * "start N minutes now" — anything richer belongs in a rundown tool.
 */
export default function TimerControl({ room }: { room: string }) {
  const [timer, setTimer] = useState<Timer | null>(null);
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  const [label, setLabel] = useState("Segment");
  const [minutes, setMinutes] = useState<number>(5);
  const [seconds, setSeconds] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/video/room/timer?room=${encodeURIComponent(room)}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (j.ok) setTimer(j.timer ?? null);
    } catch {
      /* transient */
    }
  }, [room]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!timer) return;
    if (typeof timer.paused === "number") return;
    const t = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timer]);

  const start = useCallback(
    async (m: number, s: number, useLabel?: string) => {
      const total = Math.max(1, Math.floor(m) * 60 + Math.floor(s));
      setBusy(true);
      setErr(null);
      try {
        const r = await fetch(`/api/video/room/timer?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: useLabel ?? label,
            durationMs: total * 1000,
          }),
        });
        const j = await r.json();
        if (!j.ok) {
          setErr(j.error ?? "Could not start timer.");
          return;
        }
        setTimer(j.timer);
      } finally {
        setBusy(false);
      }
    },
    [room, label],
  );

  const action = useCallback(
    async (verb: "pause" | "resume") => {
      setBusy(true);
      try {
        const r = await fetch(
          `/api/video/room/timer?room=${encodeURIComponent(room)}&action=${verb}`,
          { method: "PATCH" },
        );
        const j = await r.json();
        if (j.ok) setTimer(j.timer);
      } finally {
        setBusy(false);
      }
    },
    [room],
  );

  const clear = useCallback(async () => {
    if (!window.confirm("Clear the timer? The overlay disappears immediately.")) return;
    setBusy(true);
    try {
      await fetch(`/api/video/room/timer?room=${encodeURIComponent(room)}`, {
        method: "DELETE",
      });
      setTimer(null);
    } finally {
      setBusy(false);
    }
  }, [room]);

  const remaining = timer
    ? typeof timer.paused === "number"
      ? Math.max(0, timer.paused)
      : Math.max(0, timer.durationMs - (tickNow - timer.startedAt))
    : 0;
  const totalSec = Math.floor(remaining / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const digits = hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
  const expired = timer && remaining === 0 && timer.paused == null;
  const paused = timer && typeof timer.paused === "number";

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
        Programme timer
      </h2>

      {timer ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/12 bg-[#141C22] p-4">
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
              {timer.label}
              {paused ? " · paused" : expired ? " · time's up" : ""}
            </span>
            <span
              className={
                "font-mono text-3xl font-bold tabular-nums " +
                (expired ? "text-red-300" : paused ? "text-amber-200" : "text-white")
              }
            >
              {digits}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {paused ? (
              <button
                type="button"
                onClick={() => action("resume")}
                disabled={busy}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={() => action("pause")}
                disabled={busy || expired || false}
                className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white hover:bg-white/10 disabled:opacity-40"
              >
                Pause
              </button>
            )}
            <button
              type="button"
              onClick={() => start(minutes, seconds, timer.label)}
              disabled={busy}
              className="rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white hover:bg-white/10 disabled:opacity-40"
              title="Restart with the same label at the currently entered duration"
            >
              Restart
            </button>
            <button
              type="button"
              onClick={clear}
              disabled={busy}
              className="rounded-md border border-red-500/50 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/15 disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-white/12 bg-[#101820] p-3 text-sm text-white/60">
          No timer running. Set one below to show a countdown at the top of
          every viewer&apos;s programme feed.
        </p>
      )}

      <div className="flex flex-col gap-3 rounded-xl border border-white/12 bg-[#141C22] p-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
              Label
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
              placeholder="Testimony, Prayer, Break…"
              className="rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
              Minutes
            </span>
            <input
              type="number"
              min={0}
              max={1440}
              value={minutes}
              onChange={(e) => setMinutes(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              className="w-24 rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
              Seconds
            </span>
            <input
              type="number"
              min={0}
              max={59}
              value={seconds}
              onChange={(e) => setSeconds(Math.max(0, Math.min(59, Math.floor(Number(e.target.value) || 0))))}
              className="w-24 rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => start(minutes, seconds)}
            disabled={busy || (minutes === 0 && seconds === 0)}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {timer ? "Replace with this" : "Start"}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            or preset
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setMinutes(p.minutes);
                setSeconds(0);
                start(p.minutes, 0);
              }}
              disabled={busy}
              className="rounded-md border border-white/12 bg-white/[0.03] px-3 py-1.5 text-xs text-white hover:bg-white/10 disabled:opacity-40"
            >
              {p.label}
            </button>
          ))}
        </div>
        {err && <p className="text-xs text-red-400">{err}</p>}
      </div>
    </section>
  );
}
