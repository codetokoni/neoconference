"use client";

import { useCallback, useEffect, useState } from "react";

interface Queue {
  slug: string;
  name: string;
  order: string[];
}

export default function QueueList({ room }: { room: string }) {
  const [queues, setQueues] = useState<Queue[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/video/queues?room=${encodeURIComponent(room)}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(
          j.error === "forbidden"
            ? "You do not have control-room access."
            : "Could not load.",
        );
        return;
      }
      setErr(null);
      setQueues(j.queues);
    } catch {
      /* transient */
    }
  }, [room]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const create = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const finalName = name.trim();
      if (!finalName || busy) return;
      setBusy(true);
      try {
        const r = await fetch(`/api/video/queues?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: slug.trim() || undefined, name: finalName }),
        });
        const j = await r.json();
        if (!j.ok) {
          setErr(j.error ?? "Could not create.");
          return;
        }
        setName("");
        setSlug("");
        setErr(null);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [name, slug, busy, room, load],
  );

  return (
    <div className="flex flex-col gap-4">
      {err && <p className="text-sm text-red-400">{err}</p>}

      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-2 rounded-xl border border-white/12 bg-[#141C22] p-4"
      >
        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Queue name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Testimonies"
            className="w-full rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
          />
        </label>
        <label className="flex w-[220px] flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            URL slug (optional)
          </span>
          <input
            value={slug}
            onChange={(e) =>
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
            }
            maxLength={32}
            placeholder="testimonies"
            className="w-full rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 font-mono text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Create queue
        </button>
      </form>

      {queues.length === 0 ? (
        <p className="rounded-lg border border-white/12 bg-[#101820] p-4 text-sm text-white/60">
          No queues yet. Create one to stage participants for air.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {queues.map((q) => (
            <a
              key={q.slug}
              href={`/video/room/queue/${encodeURIComponent(q.slug)}?room=${encodeURIComponent(room)}`}
              className="flex flex-col gap-1.5 rounded-lg border border-white/12 bg-[#101820] p-4 transition hover:border-white/25 hover:bg-white/[0.04]"
            >
              <h3 className="text-lg font-semibold text-white">{q.name}</h3>
              <p className="text-sm text-white/60">
                {q.order.length} staged{q.order.length === 1 ? "" : ""}
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
                /{q.slug}
              </p>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
