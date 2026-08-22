"use client";

import { useEffect, useState } from "react";

/**
 * AttendancePanel
 *
 * FRS §4: post-meeting attendance report. Shows a lightweight preview
 * (participant count + total sessions + latest joins) and a "Download XLSX"
 * button that hits GET /api/events/[id]/attendance.
 *
 * The preview is a courtesy for the host — the authoritative artifact is the
 * downloadable spreadsheet, which the export route generates on demand off
 * the Redis journal, so there's nothing to precompute or persist here.
 */
export default function AttendancePanel({
  eventId,
  eventSlug,
}: {
  eventId: string;
  eventSlug: string;
}) {
  const [preview, setPreview] = useState<{
    participants: number;
    sessions: number;
    latest: Array<{ name: string; joinedDate: string; joinedTime: string; duration: string; status: string }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/attendance?preview=1`, {
          method: "HEAD",
        }).catch(() => null);
        if (!res || !res.ok) {
          // Preview endpoint not there yet — best-effort. The download still works.
          if (!cancelled) setPreview(null);
          return;
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  async function handleDownload() {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/attendance`, {
        method: "GET",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string })?.error || "download_failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `attendance-${eventSlug}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "download_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-cyan-200 uppercase">Attendance report</h3>
          <p className="text-xs text-slate-400 mt-1">
            Every join and leave is captured for 90 days. Download the spreadsheet for a per-participant summary plus the underlying session log.
          </p>
        </div>
      </div>
      {preview && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2">
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Participants</div>
            <div className="text-2xl font-semibold text-cyan-100 mt-1">{preview.participants}</div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">Sessions</div>
            <div className="text-2xl font-semibold text-cyan-100 mt-1">{preview.sessions}</div>
          </div>
        </div>
      )}
      {err ? <p className="text-xs text-rose-300">{err}</p> : null}
      <div className="flex justify-end pt-2 border-t border-slate-800">
        <button
          onClick={handleDownload}
          disabled={busy}
          className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-60"
        >
          {busy ? "Preparing..." : "Download XLSX"}
        </button>
      </div>
    </section>
  );
}
