"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function EndEventButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleEnd() {
    setErr(null);
    try {
      const res = await fetch("/api/events/" + eventId + "/end", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "failed_to_end");
      }
      startTransition(() => router.refresh());
      setConfirming(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="px-4 py-2 rounded-full border border-rose-500/50 text-rose-200 hover:bg-rose-500/15 transition text-sm"
      >
        End event
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleEnd}
        disabled={isPending}
        className="px-4 py-2 rounded-full bg-rose-500 text-slate-950 font-medium hover:bg-rose-400 transition text-sm disabled:opacity-60"
      >
        {isPending ? "Ending..." : "Confirm end"}
      </button>
      <button
        onClick={() => setConfirming(false)}
        disabled={isPending}
        className="px-3 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm"
      >
        Cancel
      </button>
      {err ? <span className="text-xs text-rose-300">{err}</span> : null}
    </div>
  );
}
