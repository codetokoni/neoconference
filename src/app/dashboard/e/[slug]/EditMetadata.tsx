"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Visibility = "public" | "unlisted" | "private";

export default function EditMetadata({
  eventId,
  initial,
}: {
  eventId: string;
  initial: {
    name: string;
    description?: string;
    scheduledAt?: string;
    visibility: Visibility;
    waitingRoomEnabled: boolean;
  };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description || "");
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(initial.scheduledAt));
  const [visibility, setVisibility] = useState<Visibility>(initial.visibility);
  const [waitingRoomEnabled, setWaitingRoomEnabled] = useState(initial.waitingRoomEnabled);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toLocalInput(iso?: string) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  async function handleSave() {
    setBusy(true);
 
   setErr(null);
    try {
      const body: Record<string, unknown> = {
        name,
        description,
        visibility,
        waitingRoomEnabled,
      };
      if (scheduledAt) {
        const d = new Date(scheduledAt);
        if (!isNaN(d.getTime())) body.scheduledAt = d.toISOString();
      } else {
        body.scheduledAt = "";
      }
      const res = await fetch("/api/events/" + eventId, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "failed");
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 rounded-full border border-slate-700 hover:border-cyan-400 hover:text-cyan-200 transition text-sm"
      >
        Edit details
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-cyan-400/40 bg-slate-900/60 p-5 space-y-4 w-full">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-wide text-cyan-200 uppercase">Edit event</h3>
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          Close
        </button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-xs text-slate-400 space-y-1">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/60 focus:outline-none"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          <span>Scheduled at</span>
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/60 focus:outline-none"
          />
        </label>
      </div>
      <label className="block text-xs text-slate-400 space-y-1">
        <span>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/60 focus:outline-none"
        />
      </label>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="text-xs text-slate-400 space-y-1">
          <span>Visibility</span>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as Visibility)}
            className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/60 focus:outline-none"
          >
            <option value="public">public (listed on /explore)</option>
            <option value="unlisted">unlisted (link only)</option>
            <option value="private">private (invite only)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300 mt-5 sm:mt-6">
          <input
            type="checkbox"
            checked={waitingRoomEnabled}
            onChange={(e) => setWaitingRoomEnabled(e.target.checked)}
            className="accent-cyan-400"
          />
          Waiting room
        </label>
      </div>
      {err ? <p className="text-xs text-rose-300">{err}</p> : null}
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          className="px-3 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={busy || isPending}
          className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
