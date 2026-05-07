"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Entry = {
  id: string;
  name: string;
  email?: string;
  requestedAt: number;
  status: "pending" | "admitted" | "denied";
};

function fmt(ts: number) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString();
}

export default function WaitingRoomPanel({
  eventId,
  initial,
}: {
  eventId: string;
  initial: Entry[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function handle(action: "admit" | "deny", entryId: string) {
    setBusyId(entryId);
    setErr(null);
    try {
      const res = await fetch("/api/events/" + eventId + "/waiting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId, action }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "failed");
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusyId(null);
    }
  }
  const pending = initial.filter((e) => e.status === "pending");
  const decided = initial.filter((e) => e.status !== "pending");

  return (
    <div className="space-y-3">
      {pending.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-6 text-sm text-slate-500">
          No one waiting. Pending knocks will appear here in real time.
        </div>
      ) : (
        <ul className="grid gap-2">
          {pending.map((w) => (
            <li key={w.id} className="rounded-xl border border-amber-400/30 bg-amber-500/[0.06] p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-slate-100 truncate font-medium">{w.name}</div>
                <div className="text-xs text-slate-400 mt-0.5 truncate">
                  {w.email || w.id} · {fmt(w.requestedAt)}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  disabled={busyId === w.id}
                  onClick={() => handle("deny", w.id)}
                  className="text-xs px-3 py-1.5 rounded-full border border-rose-400/40 text-rose-200 hover:bg-rose-500/15 transition disabled:opacity-50"
                >
                  Deny
                </button>
                <button
                  disabled={busyId === w.id}
                  onClick={() => handle("admit", w.id)}
                  className="text-xs px-3 py-1.5 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition disabled:opacity-50"
                >
                  Admit
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {err ? <p className="text-xs text-rose-300">{err}</p> : null}
      {decided.length > 0 ? (
        <details className="rounded-xl border border-slate-800 bg-slate-900/30 px-3 py-2">
          <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200 select-none">
            Decided ({decided.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {decided.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3 text-xs py-1">
                <span className="text-slate-300 truncate">{w.name}</span>
                <span
                  className={
                    "px-2 py-0.5 rounded-full uppercase tracking-wider text-[10px] " +
                    (w.status === "admitted"
                      ? "bg-cyan-500/15 text-cyan-200 border border-cyan-400/40"
                      : "bg-rose-500/15 text-rose-200 border border-rose-400/40")
                  }
                >
                  {w.status}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
