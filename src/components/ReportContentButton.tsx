"use client";

// src/components/ReportContentButton.tsx
//
// "Report" on public and shared content (replay, share and explore pages):
// a reason, optional details, sent to /api/content/reports. Works signed
// out. The server rate limits and words every answer; this shows it.

import { useEffect, useState } from "react";
import { REPORT_REASONS, type ReportReason, type ReportTargetType } from "@/lib/content/model";

export default function ReportContentButton({
  targetType,
  target,
  label = "Report",
  className,
}: {
  targetType: ReportTargetType;
  target: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | "">("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);

  const send = async () => {
    if (!reason) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/content/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetType, target, reason, details }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      setResult({ ok: res.ok, text: data.message || (res.ok ? "Thanks — reported." : "That didn't go through. Please try again.") });
    } catch {
      setResult({ ok: false, text: "Could not reach the server. Check your connection." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-report-button
        onClick={() => {
          setOpen(true);
          setResult(null);
        }}
        className={className ?? "inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-white/55 hover:border-rose-300/40 hover:text-rose-200"}
      >
        <span aria-hidden>⚑</span> {label}
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="report-title" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0B1220] p-5 text-left text-white shadow-2xl"
          >
            <h2 id="report-title" className="text-base font-semibold">
              Report this content
            </h2>
            {result?.ok ? (
              <>
                <p role="status" className="mt-3 text-sm text-emerald-200">
                  {result.text}
                </p>
                <div className="mt-4 flex justify-end">
                  <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-black hover:bg-cyan-400">
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-1 text-sm text-zinc-400">Tell us what is wrong. The person who shared it is not told who reported it.</p>
                <fieldset className="mt-3 space-y-1.5">
                  <legend className="sr-only">Reason</legend>
                  {REPORT_REASONS.map((r) => (
                    <label key={r.id} className="flex cursor-pointer items-center gap-2 text-sm text-zinc-200">
                      <input type="radio" name="report-reason" value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} />
                      {r.label}
                    </label>
                  ))}
                </fieldset>
                <label className="mt-3 block text-sm text-zinc-300">
                  Details (optional)
                  <textarea
                    value={details}
                    onChange={(e) => setDetails(e.target.value)}
                    maxLength={1000}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-white/12 bg-black/40 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-cyan-400/70"
                  />
                </label>
                {result && !result.ok && (
                  <p role="alert" className="mt-2 text-sm text-red-300">
                    {result.text}
                  </p>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-white/5">
                    Cancel
                  </button>
                  <button type="submit" disabled={!reason || busy} className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-400 disabled:opacity-40">
                    {busy ? "Sending…" : "Send report"}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
    </>
  );
}
