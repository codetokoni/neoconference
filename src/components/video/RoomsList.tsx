"use client";

import { useCallback, useEffect, useState } from "react";

interface Room {
  slug: string;
  name: string;
  slotCount: number;
  createdAt: number;
}

export default function RoomsList() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slotCount, setSlotCount] = useState(50);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/video/rooms", { cache: "no-store" });
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
      setRooms(j.rooms);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const finalName = name.trim();
      if (!finalName || busy) return;
      setBusy(true);
      try {
        const r = await fetch("/api/video/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: slug.trim() || undefined,
            name: finalName,
            slotCount,
          }),
        });
        const j = await r.json();
        if (!j.ok) {
          setErr(j.error ?? "Could not create.");
          return;
        }
        setName("");
        setSlug("");
        setSlotCount(50);
        setErr(null);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [name, slug, slotCount, busy, load],
  );

  return (
    <div className="flex flex-col gap-4">
      {err && <p className="text-sm text-red-400">{err}</p>}

      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-2 rounded-xl border border-white/12 bg-[#141C22] p-4"
      >
        <label className="flex min-w-[220px] flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Room name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="e.g. Global Kids Connect"
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
            placeholder="global-kids"
            className="w-full rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 font-mono text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
          />
        </label>
        <label className="flex w-[120px] flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Slots
          </span>
          <input
            type="number"
            min={1}
            max={500}
            value={slotCount}
            onChange={(e) =>
              setSlotCount(Math.max(1, Math.min(500, Number(e.target.value) || 50)))
            }
            className="w-full rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Create room
        </button>
      </form>

      {rooms.length === 0 ? (
        <p className="rounded-lg border border-white/12 bg-[#101820] p-4 text-sm text-white/60">
          No rooms yet. Create one to host an event.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {rooms.map((r) => (
            <a
              key={r.slug}
              href={`/video/room?room=${encodeURIComponent(r.slug)}`}
              className="flex flex-col gap-1.5 rounded-lg border border-white/12 bg-[#101820] p-4 transition hover:border-white/25 hover:bg-white/[0.04]"
            >
              <h3 className="text-lg font-semibold text-white">{r.name}</h3>
              <p className="text-sm text-white/60">{r.slotCount} slots</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
                /{r.slug}
              </p>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
