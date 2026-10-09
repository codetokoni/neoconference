"use client";

// Media pipeline: uploads and recordings per day with their failures,
// transcription success and failure, AMS streams live against expected, and
// the translation worker's errors.

import { useCallback, useEffect, useState } from "react";
import { Time, errorText, fmtDay, fmtNumber, useAdmin } from "../../AdminApi";
import { EmptyLine, LoadState, PageHeader, Panel, btn } from "../../ui";
import { Counts, StatusBadge } from "../opsUi";

type Failure = { at: number; kind: string; ref: string; detail: string };
type Media = {
  generatedAt: number;
  days: Array<{ day: string; upload: { ok: number; failed: number }; recording: { ok: number; failed: number } }>;
  uploadFailures: Failure[];
  recordingFailures: Failure[];
  transcription: { total: number; byStatus: Record<string, number>; failureRate: number | null; recentFailures: Failure[]; truncated: boolean };
  streaming: { reachable: boolean; detail: string; liveStreams: number | null; expected: Array<{ room: string; streamId: string; why: string; live: boolean }> };
  translation: { configured: boolean; reachable: boolean; detail: string; rooms: Array<{ room: string; charsTotal: number; errorsTotal: number; errorsWindow: number; lastErrorAt: number | null; lastErrorMessage: string | null }> };
  recordedThisMonth: { month: string; hours: number; owners: number };
};

// The server sends the latest 20 failures of each kind.
const FAILURES_SENT = 20;
const FAILURES_SHOWN = 10;

const pct = (n: number | null) => (n == null ? "—" : fmtNumber(n, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }));

export default function OpsMediaClient() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<Media | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    const r = await adminFetch<Media>("/api/admin/ops/media");
    setBusy(false);
    if (r.ok) {
      setData(r.data);
      setErr(null);
    } else setErr(`Could not load the media pipeline. ${errorText(r)}`);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Media pipeline"
        sub="Uploads, recordings, streaming, translation and transcription — counts and the recent failures."
        actions={
          <button type="button" className={btn.ghost} onClick={load} disabled={busy} aria-busy={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        }
      />
      <LoadState data={data} error={err} onRetry={load}>
        {(d) => {
          const sum = (k: "upload" | "recording", f: "ok" | "failed") => d.days.reduce((n, x) => n + x[k][f], 0);
          const maxDay = Math.max(1, ...d.days.map((x) => x.upload.ok + x.upload.failed + x.recording.ok + x.recording.failed));
          return (
            <>
              <div className="grid gap-3 lg:grid-cols-2">
                <Panel className="min-w-0">
                  <h2 className="font-medium text-white">Uploads and recordings, last {d.days.length} days</h2>
                  <div className="mt-2">
                    <Counts
                      items={[
                        ["Uploads ok", sum("upload", "ok")],
                        ["Uploads failed", sum("upload", "failed")],
                        ["Egress ok", sum("recording", "ok")],
                        ["Egress failed", sum("recording", "failed")],
                      ]}
                    />
                  </div>
                  <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Uploads and egress per day (scrolls sideways)">
                    <table className="w-full min-w-[420px] text-left text-xs">
                      <caption className="sr-only">Uploads and egress per day (UTC)</caption>
                      <thead className="text-zinc-400">
                        <tr>
                          <th className="py-1 pr-2 font-medium">Day (UTC)</th>
                          <th className="py-1 pr-2 font-medium">Uploads ok / failed</th>
                          <th className="py-1 pr-2 font-medium">Egress ok / failed</th>
                          <th className="w-1/3 py-1 font-medium" aria-hidden />
                        </tr>
                      </thead>
                      <tbody>
                        {d.days.map((x) => (
                          <tr key={x.day} className="border-t border-white/5">
                            <td className="whitespace-nowrap py-1 pr-2 text-zinc-300">{fmtDay(x.day)}</td>
                            <td className="py-1 pr-2 font-mono text-zinc-300">
                              {fmtNumber(x.upload.ok)} / <span className={x.upload.failed ? "text-red-300" : ""}>{fmtNumber(x.upload.failed)}</span>
                            </td>
                            <td className="py-1 pr-2 font-mono text-zinc-300">
                              {fmtNumber(x.recording.ok)} / <span className={x.recording.failed ? "text-red-300" : ""}>{fmtNumber(x.recording.failed)}</span>
                            </td>
                            <td className="py-1" aria-hidden>
                              <div className="flex h-2 gap-[2px]">
                                <span className="rounded-sm bg-cyan-400/70" style={{ width: `${((x.upload.ok + x.recording.ok) / maxDay) * 100}%` }} />
                                <span className="rounded-sm bg-red-400/80" style={{ width: `${((x.upload.failed + x.recording.failed) / maxDay) * 100}%` }} />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-[11px] text-zinc-400">
                    Egress counts every LiveKit egress that ended: recordings, their audio sidecars and livestreams. Counting started with this release. Recorded this month (
                    {d.recordedThisMonth.month}): {fmtNumber(d.recordedThisMonth.hours, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} h by{" "}
                    {fmtNumber(d.recordedThisMonth.owners)} owner(s).
                  </p>
                  <FailureList title="Recent upload failures" items={d.uploadFailures} />
                  <FailureList title="Recent egress failures" items={d.recordingFailures} />
                </Panel>

                <Panel className="min-w-0">
                  <h2 className="font-medium text-white">Transcription (jobs kept 30 days)</h2>
                  <div className="mt-2">
                    <Counts
                      items={[
                        ["Jobs", d.transcription.total],
                        ["Done", d.transcription.byStatus.done ?? 0],
                        ["Failed", d.transcription.byStatus.error ?? 0],
                        ["Failure rate", pct(d.transcription.failureRate)],
                        ["Queued", d.transcription.byStatus.queued ?? 0],
                        ["Running", d.transcription.byStatus.running ?? 0],
                      ]}
                    />
                  </div>
                  {d.transcription.truncated && <p className="mt-1 text-[11px] text-amber-200/80">Counted from the first 2,000 jobs found; there are more.</p>}
                  <FailureList title="Recent transcription failures" items={d.transcription.recentFailures} />
                </Panel>

                <Panel className="min-w-0">
                  <h2 className="font-medium text-white">Streaming (Ant Media Server)</h2>
                  <p className="mt-1 break-words text-sm text-zinc-400">
                    {d.streaming.reachable ? `${fmtNumber(d.streaming.liveStreams ?? 0)} live stream(s) on AMS.` : `AMS not reachable: ${d.streaming.detail}`}
                  </p>
                  {d.streaming.expected.length === 0 ? (
                    <EmptyLine>No stream is expected on air right now.</EmptyLine>
                  ) : (
                    <ul className="mt-3 space-y-1 text-sm">
                      {d.streaming.expected.map((e) => (
                        <li key={e.room + e.streamId} className="flex min-w-0 flex-wrap items-center gap-2">
                          <StatusBadge status={e.live ? "live" : "off_air"} />
                          <span className="break-all font-mono text-zinc-200">{e.streamId}</span>
                          <span className="text-xs text-zinc-400">{e.why}</span>
                          {!e.live && e.why.startsWith("featured") && <span className="text-xs text-amber-300">featured on air but not broadcasting</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-[11px] text-zinc-400">Expected = the main programme and any stream a producer has featured. Read-only: nothing here relinks or restarts a broadcast.</p>
                </Panel>

                <Panel className="min-w-0">
                  <h2 className="font-medium text-white">Translation worker</h2>
                  <p className="mt-1 break-words text-sm text-zinc-400">
                    {d.translation.configured ? (d.translation.reachable ? d.translation.detail : `Not reachable: ${d.translation.detail}`) : d.translation.detail}
                  </p>
                  {d.translation.rooms.length === 0 ? (
                    <EmptyLine>No rooms translating since the worker started.</EmptyLine>
                  ) : (
                    <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Translation per room (scrolls sideways)">
                      <table className="w-full min-w-[480px] text-left text-xs">
                        <caption className="sr-only">Translation per room</caption>
                        <thead className="text-zinc-400">
                          <tr>
                            <th className="py-1 pr-2 font-medium">Room</th>
                            <th className="py-1 pr-2 font-medium">Characters</th>
                            <th className="py-1 pr-2 font-medium">Errors (total / last min)</th>
                            <th className="py-1 font-medium">Last error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.translation.rooms.map((r) => (
                            <tr key={r.room} className="border-t border-white/5 align-top">
                              <td className="break-all py-1 pr-2 font-mono text-zinc-200">{r.room}</td>
                              <td className="py-1 pr-2 font-mono text-zinc-300">{fmtNumber(r.charsTotal)}</td>
                              <td className="py-1 pr-2 font-mono text-zinc-300">
                                {fmtNumber(r.errorsTotal)} / <span className={r.errorsWindow ? "text-red-300" : ""}>{fmtNumber(r.errorsWindow)}</span>
                              </td>
                              <td className="break-words py-1 text-zinc-400">
                                {r.lastErrorAt ? (
                                  <>
                                    <Time ts={r.lastErrorAt} mode="relative" />: {r.lastErrorMessage ?? ""}
                                  </>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              </div>
              <p className="mt-3 text-xs text-zinc-400">
                Generated <Time ts={d.generatedAt} />.
              </p>
            </>
          );
        }}
      </LoadState>
    </div>
  );
}

function FailureList({ title, items }: { title: string; items: Failure[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FAILURES_SHOWN);
  return (
    <div className="mt-3">
      <h3 className="text-xs font-medium text-zinc-400">{title}</h3>
      {items.length === 0 ? (
        <EmptyLine>None.</EmptyLine>
      ) : (
        <>
          <ul className="mt-1 space-y-1 text-xs">
            {shown.map((f, i) => (
              <li key={i} className="break-all text-zinc-400">
                <span className="text-zinc-400">
                  <Time ts={f.at} mode="relative" />
                </span>{" "}
                <span className="font-mono text-zinc-300">{f.ref}</span> — <span className="text-red-200">{f.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-zinc-400">
            Showing {shown.length} of {items.length}
            {items.length >= FAILURES_SENT ? ` (the latest ${FAILURES_SENT} are kept here)` : ""}.{" "}
            {items.length > FAILURES_SHOWN && (
              <button type="button" className="text-cyan-300 underline" aria-expanded={all} onClick={() => setAll(!all)}>
                {all ? "Show fewer" : `Show all ${items.length}`}
              </button>
            )}
          </p>
        </>
      )}
    </div>
  );
}
