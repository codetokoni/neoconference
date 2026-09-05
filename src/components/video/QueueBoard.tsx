"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Participant {
  slot: number;
  name: string;
  code: string;
  streamId: string;
  live: boolean;
  claimed: boolean;
}

interface Queue {
  slug: string;
  name: string;
  order: string[];
}

/**
 * Detail view of one queue.
 *
 * Poll-only; the queue itself renders no video. Entries show live status
 * so a producer knows if the top of the queue is actually ready before
 * they take it to air.
 *
 * The Send-to-preview action writes to /api/video/preview (server-side,
 * shared with the cameras board). The Take-to-air action posts to
 * /api/video/feature — the same endpoint every other cut in the app uses.
 */
export default function QueueBoard({ room, slug }: { room: string; slug: string }) {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addInput, setAddInput] = useState("");

  const load = useCallback(async () => {
    try {
      const [qRes, sRes] = await Promise.all([
        fetch(
          `/api/video/queues/${encodeURIComponent(slug)}?room=${encodeURIComponent(room)}`,
          { cache: "no-store" },
        ),
        fetch(`/api/video/room/summary?room=${encodeURIComponent(room)}`, {
          cache: "no-store",
        }),
      ]);
      const qJ = await qRes.json();
      const sJ = await sRes.json();
      if (!qJ.ok) {
        setErr(
          qJ.error === "forbidden"
            ? "You do not have control-room access."
            : qJ.error ?? "Queue not found.",
        );
        return;
      }
      if (!sJ.ok) return;
      setErr(null);
      setQueue(qJ.queue);

      const screens: number = sJ.screens ?? 1;
      const results = await Promise.all(
        Array.from({ length: screens }, (_, i) => i + 1).map((n) =>
          fetch(
            `/api/video/room?room=${encodeURIComponent(room)}&screen=${n}`,
            { cache: "no-store" },
          ).then((r) => r.json()),
        ),
      );
      const flat: Participant[] = [];
      for (const r of results) {
        if (r.ok && Array.isArray(r.participants)) flat.push(...r.participants);
      }
      setParticipants(flat);
    } catch {
      /* transient */
    }
  }, [room, slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const patchOrder = useCallback(
    async (nextOrder: string[]) => {
      setQueue((q) => (q ? { ...q, order: nextOrder } : q));
      try {
        await fetch(
          `/api/video/queues/${encodeURIComponent(slug)}?room=${encodeURIComponent(room)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: nextOrder }),
          },
        );
      } catch {
        /* next poll reconciles */
      }
    },
    [room, slug],
  );

  const moveEntry = useCallback(
    (streamId: string, direction: -1 | 1) => {
      if (!queue) return;
      const idx = queue.order.indexOf(streamId);
      if (idx < 0) return;
      const next = idx + direction;
      if (next < 0 || next >= queue.order.length) return;
      const arr = [...queue.order];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      patchOrder(arr);
    },
    [queue, patchOrder],
  );

  const removeEntry = useCallback(
    (streamId: string) => {
      if (!queue) return;
      patchOrder(queue.order.filter((s) => s !== streamId));
    },
    [queue, patchOrder],
  );

  const addEntry = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!queue) return;
      const raw = addInput.trim();
      if (!raw) return;

      let target: Participant | undefined;
      const asSlot = Number(raw);
      if (Number.isFinite(asSlot) && asSlot > 0) {
        target = participants.find((p) => p.slot === asSlot);
      }
      if (!target) {
        const upper = raw.toUpperCase();
        target = participants.find((p) => p.code.toUpperCase() === upper);
      }
      if (!target) {
        setErr(`No participant matches "${raw}".`);
        return;
      }
      if (queue.order.includes(target.streamId)) {
        setErr(`${target.name} is already queued.`);
        return;
      }
      setErr(null);
      await patchOrder([...queue.order, target.streamId]);
      setAddInput("");
    },
    [addInput, participants, queue, patchOrder],
  );

  const takeToAir = useCallback(
    async (streamId: string, label: string) => {
      if (!queue) return;
      setBusy(true);
      try {
        await fetch(`/api/video/feature?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamId, label }),
        });
        // Broadcast convention: after a Take, drop from queue. Producer can
        // re-queue the entry if they want to bring them back.
        await patchOrder(queue.order.filter((s) => s !== streamId));
      } finally {
        setBusy(false);
      }
    },
    [room, queue, patchOrder],
  );

  const sendToPreview = useCallback(
    async (streamId: string, label: string) => {
      setBusy(true);
      try {
        await fetch(`/api/video/preview?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamId, label }),
        });
      } finally {
        setBusy(false);
      }
    },
    [room],
  );

  const removeQueueEntirely = useCallback(async () => {
    if (!queue) return;
    if (
      !window.confirm(
        `Delete the "${queue.name}" queue? Entries are removed. Participants themselves are unaffected.`,
      )
    ) {
      return;
    }
    await fetch(
      `/api/video/queues/${encodeURIComponent(slug)}?room=${encodeURIComponent(room)}`,
      { method: "DELETE" },
    );
    window.location.href = `/video/room/queue?room=${encodeURIComponent(room)}`;
  }, [room, slug, queue]);

  const bySid = useMemo(
    () => new Map(participants.map((p) => [p.streamId, p])),
    [participants],
  );

  if (err && !queue) return <p className="text-sm text-red-400">{err}</p>;
  if (!queue) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-white/45">
        Loading…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {err && <p className="text-sm text-red-400">{err}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/12 bg-[#141C22] p-4">
        <div className="flex flex-col">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
            Queue
          </span>
          <span className="text-xl font-bold text-white">{queue.name}</span>
          <span className="font-mono text-[10px] text-white/35">
            /{queue.slug} · {queue.order.length} staged
          </span>
        </div>
        <button
          type="button"
          onClick={removeQueueEntirely}
          className="rounded-md border border-red-500/50 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/15"
        >
          Delete queue
        </button>
      </div>

      <form
        onSubmit={addEntry}
        className="flex flex-wrap items-end gap-2 rounded-xl border border-white/12 bg-[#141C22] p-4"
      >
        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Add participant — slot number or code
          </span>
          <input
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            maxLength={16}
            placeholder="e.g. 7  or  QAEX-07"
            className="w-full rounded-md border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !addInput.trim()}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Add
        </button>
      </form>

      <div className="flex flex-col gap-2">
        {queue.order.length === 0 ? (
          <p className="rounded-lg border border-white/12 bg-[#101820] p-4 text-sm text-white/60">
            No entries yet. Add participants to stage them for air.
          </p>
        ) : (
          queue.order.map((streamId, i) => (
            <QueueRow
              key={streamId}
              streamId={streamId}
              participant={bySid.get(streamId)}
              first={i === 0}
              busy={busy}
              onUp={() => moveEntry(streamId, -1)}
              onDown={() => moveEntry(streamId, 1)}
              onRemove={() => removeEntry(streamId)}
              onTake={() =>
                takeToAir(streamId, bySid.get(streamId)?.name ?? streamId)
              }
              onPreview={() =>
                sendToPreview(streamId, bySid.get(streamId)?.name ?? streamId)
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function QueueRow({
  streamId,
  participant,
  first,
  busy,
  onUp,
  onDown,
  onRemove,
  onTake,
  onPreview,
}: {
  streamId: string;
  participant: Participant | undefined;
  first: boolean;
  busy: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  onTake: () => void;
  onPreview: () => void;
}) {
  const status = participant?.live
    ? { label: "LIVE", tone: "bg-emerald-500/20 text-emerald-300 border-emerald-400/40" }
    : participant?.claimed
      ? { label: "JOINED", tone: "bg-amber-500/20 text-amber-300 border-amber-400/40" }
      : participant
        ? { label: "NOT JOINED", tone: "bg-white/[0.04] text-white/45 border-white/10" }
        : { label: "UNKNOWN", tone: "bg-red-500/15 text-red-300 border-red-400/40" };

  return (
    <div
      className={
        "flex flex-wrap items-center gap-3 rounded-lg border p-3 " +
        (first ? "border-amber-400/50 bg-amber-500/[0.06]" : "border-white/12 bg-[#101820]")
      }
    >
      <div className="flex min-w-[220px] flex-1 items-center gap-3">
        <span className="w-8 font-mono text-[10px] text-white/45">
          {participant ? String(participant.slot).padStart(2, "0") : "??"}
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold text-white">
            {participant?.name ?? streamId}
          </span>
          <span className="truncate font-mono text-[10px] text-white/45">
            {participant?.code ? participant.code + " · " : ""}
            {streamId}
          </span>
        </span>
        <span
          className={
            "rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] " +
            status.tone
          }
        >
          {status.label}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onUp}
          className="rounded-md border border-white/12 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
          aria-label="Move up"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={onDown}
          className="rounded-md border border-white/12 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
          aria-label="Move down"
        >
          ↓
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPreview}
          disabled={busy}
          className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-white/85 hover:bg-white/10 disabled:opacity-40"
        >
          Send to preview
        </button>
        <button
          type="button"
          onClick={onTake}
          disabled={busy}
          className={
            "rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-40 " +
            (first
              ? "bg-amber-500 text-[#14100a] hover:bg-amber-400"
              : "border border-amber-400/60 text-amber-300 hover:bg-amber-500/10")
          }
        >
          Take to air
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-md border border-red-500/50 px-2 py-1 text-xs text-red-300 hover:bg-red-500/15"
          aria-label="Remove from queue"
        >
          ×
        </button>
      </div>
    </div>
  );
}
