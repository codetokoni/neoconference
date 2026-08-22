"use client";

import { useState } from "react";

/**
 * TranscriptsPanel
 *
 * FRS §8.4 downloadable transcript formats. Renders one row per
 * transcript artifact attached to the event with TXT / RTF / DOCX
 * download buttons. Each button hits the shared export route which
 * generates on demand from the stored text.
 *
 * PDF is deferred — it needs bundled fonts on Vercel, which is a
 * larger lane than the other formats.
 */
export default function TranscriptsPanel({
  eventId,
  eventSlug,
  transcripts,
}: {
  eventId: string;
  eventSlug: string;
  transcripts: Array<{ key: string; createdAt?: string; textPreview?: string }>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function download(format: "txt" | "rtf" | "docx", key?: string) {
    const label = key ? `${key}:${format}` : `latest:${format}`;
    setBusy(label);
    setErr(null);
    try {
      const q = new URLSearchParams();
      q.set("format", format);
      if (key) q.set("key", key);
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/transcript/export?${q.toString()}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || "export_failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transcript-${eventSlug}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "export_failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-cyan-200 uppercase">Transcript</h3>
          <p className="text-xs text-slate-400 mt-1">
            Download the meeting transcript in the format your workflow needs. TXT for archives, RTF and DOCX for editing.
          </p>
        </div>
      </div>

      {transcripts.length === 0 ? (
        <p className="text-xs text-slate-500 pt-2">
          No transcript has been generated yet. Once a recording is transcribed the download options will appear here.
        </p>
      ) : (
        <div className="space-y-3">
          {transcripts.map((t) => (
            <div
              key={t.key}
              className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] text-slate-400">
                  {t.createdAt ? new Date(t.createdAt).toLocaleString() : "unknown date"}
                </div>
                <div className="text-[11px] font-mono text-slate-500 truncate max-w-[50%]">
                  {t.key}
                </div>
              </div>
              {t.textPreview && (
                <p className="text-xs text-slate-300 line-clamp-3 whitespace-pre-wrap">
                  {t.textPreview}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                {(["txt", "rtf", "docx"] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => download(fmt, t.key)}
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded-full border border-cyan-400/40 text-cyan-100 text-xs font-medium hover:bg-cyan-400/10 transition disabled:opacity-60"
                  >
                    {busy === `${t.key}:${fmt}` ? "Preparing…" : fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {err ? <p className="text-xs text-rose-300 pt-1">{err}</p> : null}
    </section>
  );
}
