"use client";

// Remove someone invited by email from the meeting's roles (DELETE
// /api/events/<id>/invite). They join next time as anyone with the link does.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function RemoveRoleButton({ eventId, identifier, role }: { eventId: string; identifier: string; role: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm(`Remove ${identifier} as ${role}? They will join as an ordinary participant.`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/events/" + encodeURIComponent(eventId) + "/invite", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error === "forbidden" ? "Only the meeting's owner can remove people." : j.error || "Could not remove.");
      startTransition(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not remove.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={remove}
        disabled={busy || isPending}
        aria-label={`Remove ${identifier}`}
        className="text-xs px-2.5 py-1 rounded-full border border-rose-400/40 text-rose-200 hover:bg-rose-500/15 transition disabled:opacity-50"
      >
        {busy || isPending ? "Removing…" : "Remove"}
      </button>
      {err ? <span className="text-[11px] text-rose-300">{err}</span> : null}
    </span>
  );
}
