"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Ends the meeting — or, for an always-open room, disconnects everyone in
 * it: the end route never ends one of those, so "End event" promised
 * something that did not happen.
 *
 * When the meeting has an End Meeting PIN, the confirmation asks for it.
 * It used to post without one, so on any meeting with a PIN this button
 * could only ever fail with "invalid_pin".
 */
export default function EndEventButton({
  eventId,
  alwaysOpen = false,
  pinRequired = false,
}: {
  eventId: string;
  alwaysOpen?: boolean;
  pinRequired?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleEnd() {
    setErr(null);
    if (pinRequired && !pin.trim()) {
      setErr("Enter the End Meeting PIN.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/events/" + eventId + "/end", {
        method: "POST",
        ...(pinRequired
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ pin: pin.trim() }),
            }
          : {}),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(
          j.error === "invalid_pin" ? "That PIN is not right." : j.error || "failed_to_end"
        );
      }
      startTransition(() => router.refresh());
      setConfirming(false);
      setPin("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setConfirming(false);
    setPin("");
    setErr(null);
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="px-4 py-2 rounded-full border border-rose-500/50 text-rose-200 hover:bg-rose-500/15 transition text-sm"
      >
        {alwaysOpen ? "Disconnect everyone" : "End event"}
      </button>
    );
  }

  const working = busy || isPending;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {pinRequired ? (
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleEnd();
          }}
          placeholder="End Meeting PIN"
          aria-label="End Meeting PIN"
          className="w-40 bg-slate-950/60 border border-slate-700 rounded-full px-3 py-2 text-sm text-slate-100 focus:border-rose-400/60 focus:outline-none"
        />
      ) : null}
      <button
        onClick={handleEnd}
        disabled={working}
        className="px-4 py-2 rounded-full bg-rose-500 text-slate-950 font-medium hover:bg-rose-400 transition text-sm disabled:opacity-60"
      >
        {alwaysOpen
          ? working ? "Disconnecting..." : "Confirm — the room stays open"
          : working ? "Ending..." : "Confirm end"}
      </button>
      <button
        onClick={cancel}
        disabled={working}
        className="px-3 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm"
      >
        Cancel
      </button>
      {err ? <span className="text-xs text-rose-300">{err}</span> : null}
    </div>
  );
}
