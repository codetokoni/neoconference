"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type RecordType = "NONE" | "MP4" | "WEBM" | "HLS";

interface RecordingState {
  streamId: string;
  recordType: RecordType;
  live: boolean;
  updateTimeMs: number | null;
}

interface Vod {
  vodId: string;
  filename: string;
  url: string;
  sizeBytes: number;
  durationMs: number;
  createdAtMs: number;
}

interface Response {
  ok: true;
  room: string;
  state: RecordingState | null;
  stateError: string | null;
  vods: Vod[];
  vodsError: string | null;
}

/**
 * Programme-feed recording control + VOD browser.
 *
 * One switch: recording MP4 on / off for the room's main
 * broadcaster. Below it, every recorded file AMS has for that
 * stream, newest first, with download links and size + duration
 * chips so the admin can decide which one to distribute.
 *
 * Delete is confirm-first (irreversible on the AMS side). The whole
 * panel is admin-only (server enforces via videoAdmin).
 */
export default function RecordingPanel({ room }: { room: string }) {
  const [data, setData] = useState<Response | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/video/recording?room=${encodeURIComponent(room)}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (j.ok) setData(j as Response);
      else setMsg({ kind: "err", text: j.error ?? "Could not load." });
    } catch {
      /* transient — the interval will retry */
    }
  }, [room]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = useCallback(
    async (next: RecordType) => {
      setBusy(true);
      setMsg(null);
      try {
        const r = await fetch(
          `/api/video/recording?room=${encodeURIComponent(room)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recordType: next }),
          },
        );
        const j = await r.json();
        if (!j.ok) {
          setMsg({ kind: "err", text: j.error ?? "Could not update." });
          return;
        }
        setData((d) => (d ? { ...d, state: j.state ?? d.state } : d));
        // Sanity-check: AMS occasionally returns HTTP 200 + success
        // but the state field lags by a poll. If the returned state
        // does not match what we requested, do NOT tell the operator
        // "recording as MP4" — that message must be trustworthy.
        const actual = (j.state?.recordType ?? "NONE") as RecordType;
        if (actual !== next) {
          setMsg({
            kind: "err",
            text: `AMS accepted the request but the stream still reports ${actual}. Try again in a few seconds.`,
          });
          return;
        }
        setMsg({
          kind: "ok",
          text: next === "NONE" ? "Recording stopped." : `Recording as ${next}.`,
        });
      } finally {
        setBusy(false);
      }
    },
    [room],
  );

  const removeVod = useCallback(
    async (v: Vod) => {
      if (
        !window.confirm(
          `Delete "${v.filename}" from the AMS server? This cannot be undone.`,
        )
      )
        return;
      setBusy(true);
      try {
        const r = await fetch(
          `/api/video/recording?room=${encodeURIComponent(room)}&vodId=${encodeURIComponent(v.vodId)}`,
          { method: "DELETE" },
        );
        const j = await r.json();
        if (!j.ok) {
          setMsg({ kind: "err", text: j.error ?? "Could not delete." });
          return;
        }
        setData((d) =>
          d ? { ...d, vods: d.vods.filter((x) => x.vodId !== v.vodId) } : d,
        );
      } finally {
        setBusy(false);
      }
    },
    [room],
  );

  const recording = data?.state?.recordType === "MP4";
  const live = Boolean(data?.state?.live);
  const totalBytes = useMemo(
    () => (data?.vods ?? []).reduce((n, v) => n + (v.sizeBytes || 0), 0),
    [data],
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
        Programme recording
      </h2>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/12 bg-[#141C22] p-4">
        <div className="flex flex-col leading-tight">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Programme feed {data?.state?.streamId ? `· ${data.state.streamId}` : ""}
          </span>
          <span className="text-lg font-bold text-white">
            {recording ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
                Recording {live ? "· live" : "· ready"}
              </span>
            ) : (
              <span className="text-white/70">
                Recording off {!live && <span className="text-xs text-white/45">· waiting for publisher</span>}
              </span>
            )}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {recording ? (
            <button
              type="button"
              onClick={() => toggle("NONE")}
              disabled={busy}
              className="rounded-md border border-red-500/50 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/15 disabled:opacity-40"
            >
              Stop recording
            </button>
          ) : (
            <button
              type="button"
              onClick={() => toggle("MP4")}
              disabled={busy || !live}
              title={
                live
                  ? "Start recording the programme feed as MP4"
                  : "The programme feed must be broadcasting before AMS will start recording. Push from vMix / OBS first, then click here."
              }
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-40 disabled:hover:bg-red-600"
            >
              Start recording (MP4)
            </button>
          )}
        </div>
      </div>

      {data?.stateError && (
        <p className="text-xs text-amber-300/80">
          state: {data.stateError}
        </p>
      )}
      {msg && (
        <p className={"text-xs " + (msg.kind === "ok" ? "text-emerald-300" : "text-red-300")}>
          {msg.text}
        </p>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-white/12 bg-[#141C22] p-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            Recordings · {(data?.vods ?? []).length}
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
            {formatBytes(totalBytes)} total
          </span>
        </div>
        {(data?.vods ?? []).length === 0 ? (
          <p className="text-xs text-white/60">
            {data?.vodsError
              ? `Could not list recordings: ${data.vodsError}`
              : "No recordings for this room yet. Start recording during a live broadcast to capture one."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(data?.vods ?? []).map((v) => (
              <li
                key={v.vodId}
                className="flex flex-wrap items-center gap-3 rounded-md border border-white/8 bg-[#0B1319] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white" title={v.filename}>
                    {v.filename}
                  </div>
                  <div className="font-mono text-[10.5px] uppercase tracking-[0.10em] text-white/45">
                    {v.createdAtMs ? new Date(v.createdAtMs).toLocaleString() : "unknown time"}
                    {" · "}
                    {formatDuration(v.durationMs)}
                    {" · "}
                    {formatBytes(v.sizeBytes)}
                  </div>
                </div>
                <a
                  href={v.url}
                  download={v.filename}
                  className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => removeVod(v)}
                  disabled={busy}
                  className="inline-flex items-center justify-center rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 transition hover:bg-red-500/20 disabled:opacity-40"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "0s";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
