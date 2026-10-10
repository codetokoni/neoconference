"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Lock or open the room's join page. Locked: codes let nobody new in (people
 * already in stay in). Open: codes work. Polls so two moderators see the
 * same state.
 */
export default function JoinLockToggle({ room, compact = false }: { room: string; compact?: boolean }) {
  const [locked, setLocked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/video/room/join-lock?room=${encodeURIComponent(room)}`, { cache: "no-store" });
      const j = (await r.json()) as { ok?: boolean; locked?: boolean };
      if (j.ok) setLocked(Boolean(j.locked));
    } catch {
      /* next poll */
    }
  }, [room]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const set = async (next: boolean) => {
    if (next && !window.confirm("Lock the join page? Codes will not let anyone new in until you open it. People already in stay in.")) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/video/room/join-lock?room=${encodeURIComponent(room)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked: next }),
      });
      const j = (await r.json()) as { ok?: boolean; locked?: boolean; error?: string };
      if (j.ok) setLocked(Boolean(j.locked));
      else setErr(j.error ?? "Could not change it.");
    } catch {
      setErr("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  if (locked === null) return null;

  return (
    <div
      className={
        "flex items-center gap-3 rounded-lg border " +
        (locked ? "border-amber-400/40 bg-amber-500/10" : "border-emerald-400/30 bg-emerald-500/[0.07]") +
        (compact ? " px-2.5 py-1.5" : " px-4 py-3")
      }
    >
      <span className={"font-mono uppercase tracking-[0.14em] " + (compact ? "text-[10px]" : "text-[11px]") + " text-white/55"}>
        Join page
      </span>
      <span
        className={
          "font-mono font-semibold uppercase tracking-[0.14em] " +
          (compact ? "text-[10px] " : "text-xs ") +
          (locked ? "text-amber-300" : "text-emerald-300")
        }
      >
        {locked ? "Locked · codes do not work" : "Open · codes work"}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => set(!locked)}
        className={
          "rounded-md border font-semibold transition disabled:opacity-50 " +
          (compact ? "px-2 py-0.5 text-[11px] " : "px-3 py-1.5 text-sm ") +
          (locked
            ? "border-emerald-400/50 bg-emerald-600 text-white hover:bg-emerald-500"
            : "border-amber-400/50 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25")
        }
      >
        {busy ? "…" : locked ? "Open joining" : "Lock joining"}
      </button>
      {err && <span className="text-xs text-red-300">{err}</span>}
    </div>
  );
}
