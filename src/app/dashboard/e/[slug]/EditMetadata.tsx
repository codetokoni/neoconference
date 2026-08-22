"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Visibility = "public" | "unlisted" | "private";

interface InactivityInitial {
  enabled?: boolean;
  warningMs?: number;
  responseMs?: number;
  autoRemove?: boolean;
  exemptAdmins?: boolean;
}

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
    endPinIsSet?: boolean;
    inactivity?: InactivityInitial | null;
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
  const [endPin, setEndPin] = useState("");
  const [clearEndPin, setClearEndPin] = useState(false);
  const [inactivityEnabled, setInactivityEnabled] = useState<boolean>(initial.inactivity?.enabled ?? true);
  const [inactivityWarningMin, setInactivityWarningMin] = useState<string>(
    String(Math.max(1, Math.round((initial.inactivity?.warningMs ?? 300_000) / 60_000))),
  );
  const [inactivityResponseSec, setInactivityResponseSec] = useState<string>(
    String(Math.max(10, Math.round((initial.inactivity?.responseMs ?? 60_000) / 1000))),
  );
  const [inactivityAutoRemove, setInactivityAutoRemove] = useState<boolean>(initial.inactivity?.autoRemove ?? false);
  const [inactivityExemptAdmins, setInactivityExemptAdmins] = useState<boolean>(initial.inactivity?.exemptAdmins ?? true);
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
      // FRS §6: only send endPin when the user actually intends to change it.
      // Typing a new value takes precedence over the clear checkbox.
      if (endPin.trim().length > 0) {
        body.endPin = endPin.trim();
      } else if (clearEndPin && initial.endPinIsSet) {
        body.endPin = "";
      }
      // FRS §11 inactivity config. Always send the whole object so a host
      // who flips a knob without touching the numbers still gets a durable
      // record. Values are validated server-side (30 s .. 60 min for
      // warning; 10 s .. 5 min for response).
      const warningMin = Math.max(1, Math.min(60, parseInt(inactivityWarningMin, 10) || 5));
      const responseSec = Math.max(10, Math.min(300, parseInt(inactivityResponseSec, 10) || 60));
      body.inactivity = {
        enabled: inactivityEnabled,
        warningMs: warningMin * 60_000,
        responseMs: responseSec * 1000,
        autoRemove: inactivityAutoRemove,
        exemptAdmins: inactivityExemptAdmins,
      };
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
      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-300">End Meeting PIN</span>
          <span className="text-[10px] text-slate-500">FRS §6 · optional</span>
        </div>
        <p className="text-[11px] text-slate-500">
          When set, ending the meeting for everyone requires the PIN. Min 4 characters. Leave blank to keep the current PIN unchanged.
        </p>
        <input
          type="password"
          value={endPin}
          onChange={(e) => setEndPin(e.target.value)}
          placeholder={initial.endPinIsSet ? "PIN currently set — type new to change" : "Set a PIN (optional)"}
          autoComplete="off"
          className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/60 focus:outline-none"
        />
        {initial.endPinIsSet && endPin.length === 0 && (
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            <input
              type="checkbox"
              checked={clearEndPin}
              onChange={(e) => setClearEndPin(e.target.checked)}
              className="accent-rose-400"
            />
            Remove the current PIN entirely
          </label>
        )}
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-300">Inactivity detection</span>
          <span className="text-[10px] text-slate-500">FRS §11</span>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={inactivityEnabled}
            onChange={(e) => setInactivityEnabled(e.target.checked)}
            className="accent-cyan-400"
          />
          Show "Are you still here?" prompt to idle participants
        </label>
        {inactivityEnabled && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400 space-y-1">
                <span>Warn after (minutes)</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={inactivityWarningMin}
                  onChange={(e) => setInactivityWarningMin(e.target.value)}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/60 focus:outline-none"
                />
              </label>
              <label className="text-xs text-slate-400 space-y-1">
                <span>Response window (seconds)</span>
                <input
                  type="number"
                  min={10}
                  max={300}
                  value={inactivityResponseSec}
                  onChange={(e) => setInactivityResponseSec(e.target.value)}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/60 focus:outline-none"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={inactivityAutoRemove}
                onChange={(e) => setInactivityAutoRemove(e.target.checked)}
                className="accent-rose-400"
              />
              Auto-remove participants who don&apos;t respond
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={inactivityExemptAdmins}
                onChange={(e) => setInactivityExemptAdmins(e.target.checked)}
                className="accent-cyan-400"
              />
              Exempt Host and Moderator from this check
            </label>
          </>
        )}
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
