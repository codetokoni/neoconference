"use client";

// What every viewer of the room watches: one stream, assigned here and
// checked on the server (src/lib/videoBroadcaster.ts). The programme feed
// unless an admin chooses one of this room's participant slots.

import { useCallback, useEffect, useState } from "react";

type Broadcaster = { streamId: string; label: string; source: "default" | "assigned"; live: boolean };

export default function ViewerFeedPanel({ room }: { room: string }) {
  const [b, setB] = useState<Broadcaster | null>(null);
  const [slot, setSlot] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const url = `/api/video/room/broadcaster?room=${encodeURIComponent(room)}`;

  const load = useCallback(async () => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      const j = await r.json();
      if (j.ok) setB(j.broadcaster);
      else setMsg({ ok: false, text: j.error ?? "Could not read the viewer feed." });
    } catch {
      setMsg({ ok: false, text: "Could not reach the server." });
    }
  }, [url]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const send = async (init: RequestInit, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(url, init);
      const j = await r.json();
      if (!j.ok) return setMsg({ ok: false, text: j.error ?? "That did not work." });
      setB(j.broadcaster);
      setMsg({ ok: true, text: done });
    } catch {
      setMsg({ ok: false, text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  };

  const useSlot = () => {
    const n = parseInt(slot, 10);
    if (!Number.isFinite(n) || n < 1) return setMsg({ ok: false, text: "Enter a slot number." });
    const streamId = `${room}-p${String(n).padStart(2, "0")}`;
    send(
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ streamId, label: `Slot ${n}` }) },
      `Viewers now watch slot ${n} (${streamId}).`,
    );
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/12 bg-[#141C22] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">Viewers watch</span>
        {b && (
          <span
            className={
              "rounded px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.14em] " +
              (b.live ? "bg-red-600 text-white" : "border border-white/15 text-white/60")
            }
          >
            {b.live ? "Live" : "Off air"}
          </span>
        )}
      </div>
      <p className="text-sm text-white">
        {b ? (
          <>
            {b.source === "default" ? "Programme feed" : b.label} ·{" "}
            <span className="font-mono text-white/70">{b.streamId}</span>
          </>
        ) : (
          "…"
        )}
      </p>
      <p className="text-xs text-white/60">
        Everyone on the join and streaming links sees only this stream in the main picture — never another
        participant&apos;s camera or another room. Off air, they see &ldquo;Waiting for the host&rsquo;s live
        broadcast.&rdquo; and it starts on its own when it goes live.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {b?.source === "assigned" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => send({ method: "DELETE" }, "Viewers watch the programme feed again.")}
            className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-white/85 hover:bg-white/10 disabled:opacity-40"
          >
            Back to the programme feed
          </button>
        )}
        <label className="flex items-center gap-2 text-xs text-white/60">
          Or a participant slot
          <input
            value={slot}
            onChange={(e) => setSlot(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="16"
            aria-label="Participant slot number for viewers to watch"
            className="w-16 rounded-md border border-white/12 bg-[#0B1319] px-2 py-1 text-center font-mono text-sm text-white"
          />
        </label>
        <button
          type="button"
          disabled={busy || !slot}
          onClick={useSlot}
          className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-white/85 hover:bg-white/10 disabled:opacity-40"
        >
          Show this slot to viewers
        </button>
      </div>
      {msg && <p className={"text-xs " + (msg.ok ? "text-emerald-300" : "text-red-400")}>{msg.text}</p>}
    </section>
  );
}
