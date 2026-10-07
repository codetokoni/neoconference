"use client";

// "Calling", inside the room's participants panel, for group meetings and
// Moderators and up: everyone invited, whether they are being rung, have
// joined, declined, missed it or are busy in another meeting, how many rings
// they have had, and "Ring again". Refreshes every 5 s, only while open.
//
// Renders nothing outside a group meeting or for anyone who may not see it.

import { useCallback, useEffect, useState } from "react";

type Status = "not_called" | "ringing" | "answered" | "joined" | "left" | "declined" | "missed" | "busy";

interface Person {
  userId: string;
  name: string;
  status: Status;
  attempts: number;
}

const LABEL: Record<Status, { text: string; mark: string; cls: string }> = {
  ringing: { text: "Ringing", mark: "…", cls: "text-cyan-200" },
  answered: { text: "Joining", mark: "→", cls: "text-emerald-200" },
  joined: { text: "Joined", mark: "✓", cls: "text-emerald-300" },
  declined: { text: "Declined", mark: "✕", cls: "text-rose-300" },
  missed: { text: "Missed", mark: "!", cls: "text-amber-300" },
  busy: { text: "In another meeting", mark: "◐", cls: "text-amber-200" },
  left: { text: "Left", mark: "←", cls: "text-slate-300" },
  not_called: { text: "Not rung yet", mark: "·", cls: "text-slate-400" },
};

const REFRESH_MS = 5_000;

export default function GroupCallingPanel({ slug }: { slug: string }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [maxAttempts, setMaxAttempts] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/calls`, { cache: "no-store" });
      if (!res.ok) {
        setAllowed(false);
        return;
      }
      const data = (await res.json()) as { people: Person[]; maxAttempts: number };
      setPeople(data.people);
      setMaxAttempts(data.maxAttempts);
      setAllowed(true);
    } catch {
      /* keep what is shown; the next refresh tries again */
    }
  }, [slug]);

  // Learn once whether this panel applies here at all.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [open, load]);

  if (!allowed) return null;

  async function ringAgain(p: Person) {
    setBusy(p.userId);
    setMsg(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(slug)}/ring`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds: [p.userId] }),
      });
      setMsg(res.ok ? `Ringing ${p.name} again.` : `Couldn't ring ${p.name}.`);
      await load();
    } catch {
      setMsg(`Couldn't ring ${p.name}.`);
    } finally {
      setBusy(null);
    }
  }

  const joined = people.filter((p) => p.status === "joined").length;

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", color: "#e2e8f0" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 6,
          border: "1px solid rgba(52,211,153,0.45)",
          background: "rgba(52,211,153,0.10)",
          color: "#d1fae5",
          cursor: "pointer",
        }}
      >
        {open ? "Hide calling" : `Calling · ${joined}/${people.length} joined`}
      </button>
      {open ? (
        <ul className="mt-3 space-y-1.5">
          {people.map((p) => {
            const l = LABEL[p.status];
            const canRing = p.status !== "joined" && p.status !== "answered";
            return (
              <li key={p.userId} className="flex items-center gap-2 rounded-lg bg-slate-900/60 border border-slate-800 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-100">{p.name}</div>
                  <div className={"text-xs " + l.cls}>
                    <span aria-hidden>{l.mark} </span>
                    {l.text}
                    {p.attempts > 0 ? <span className="text-slate-400"> · rung {p.attempts}/{maxAttempts}</span> : null}
                  </div>
                </div>
                {canRing ? (
                  <button
                    type="button"
                    onClick={() => ringAgain(p)}
                    disabled={busy === p.userId}
                    aria-label={`Ring ${p.name} again`}
                    className="shrink-0 rounded-full border border-emerald-400/50 px-2.5 py-1 text-xs text-emerald-100 hover:bg-emerald-500/15 transition disabled:opacity-60"
                  >
                    {busy === p.userId ? "…" : "Ring again"}
                  </button>
                ) : null}
              </li>
            );
          })}
          {people.length === 0 ? <li className="text-xs text-slate-400">No one to call.</li> : null}
          {msg ? <li className="text-xs text-slate-300">{msg}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
