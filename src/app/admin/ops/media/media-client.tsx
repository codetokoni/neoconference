"use client";

// Media pipeline: uploads and recordings per day with their failures,
// transcription success and failure, AMS streams live against expected, and
// the translation worker's errors.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Empty, Loading, Notice, PageHeader, Panel, btn } from "../../ui";
import { Counts, StatusBadge, ago } from "../opsUi";

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

const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

export default function OpsMediaClient() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<Media | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await adminFetch<Media>("/api/admin/ops/media");
    if (r.ok) setData(r.data);
    else setErr(r.data.message ?? "Could not load the media pipeline.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  if (err) return <Notice kind="err">{err}</Notice>;
  if (!data) return <Loading />;
  const sum = (k: "upload" | "recording", f: "ok" | "failed") => data.days.reduce((n, d) => n + d[k][f], 0);
  const maxDay = Math.max(1, ...data.days.map((d) => d.upload.ok + d.upload.failed + d.recording.ok + d.recording.failed));

  return (
    <div>
      <PageHeader
        title="Media pipeline"
        sub="Uploads, recordings, streaming, translation and transcription — counts and the recent failures."
        actions={
          <button type="button" className={btn.ghost} onClick={load}>
            Refresh
          </button>
        }
      />
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <h2 className="font-medium text-white">Uploads and recordings, last {data.days.length} days</h2>
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
          <table className="mt-3 w-full text-left text-xs">
            <caption className="sr-only">Per day</caption>
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 font-medium">Day (UTC)</th>
                <th className="py-1 font-medium">Uploads ok / failed</th>
                <th className="py-1 font-medium">Egress ok / failed</th>
                <th className="w-1/3 py-1 font-medium" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.day} className="border-t border-white/5">
                  <td className="py-1 text-zinc-300">{d.day}</td>
                  <td className="py-1 font-mono text-zinc-300">
                    {d.upload.ok} / <span className={d.upload.failed ? "text-red-300" : ""}>{d.upload.failed}</span>
                  </td>
                  <td className="py-1 font-mono text-zinc-300">
                    {d.recording.ok} / <span className={d.recording.failed ? "text-red-300" : ""}>{d.recording.failed}</span>
                  </td>
                  <td className="py-1" aria-hidden>
                    <div className="flex h-2 gap-[2px]">
                      <span className="rounded-sm bg-cyan-400/70" style={{ width: `${((d.upload.ok + d.recording.ok) / maxDay) * 100}%` }} />
                      <span className="rounded-sm bg-red-400/80" style={{ width: `${((d.upload.failed + d.recording.failed) / maxDay) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-zinc-500">
            Egress counts every LiveKit egress that ended: recordings, their audio sidecars and livestreams. Counting started with this release.
            Recorded this month ({data.recordedThisMonth.month}): {data.recordedThisMonth.hours.toFixed(1)} h by {data.recordedThisMonth.owners} owner(s).
          </p>
          <FailureList title="Recent upload failures" items={data.uploadFailures} />
          <FailureList title="Recent egress failures" items={data.recordingFailures} />
        </Panel>

        <Panel>
          <h2 className="font-medium text-white">Transcription (jobs kept 30 days)</h2>
          <div className="mt-2">
            <Counts
              items={[
                ["Jobs", data.transcription.total],
                ["Done", data.transcription.byStatus.done ?? 0],
                ["Failed", data.transcription.byStatus.error ?? 0],
                ["Failure rate", pct(data.transcription.failureRate)],
                ["Queued", data.transcription.byStatus.queued ?? 0],
                ["Running", data.transcription.byStatus.running ?? 0],
              ]}
            />
          </div>
          <FailureList title="Recent transcription failures" items={data.transcription.recentFailures} />
        </Panel>

        <Panel>
          <h2 className="font-medium text-white">Streaming (Ant Media Server)</h2>
          <p className="mt-1 text-sm text-zinc-400">
            {data.streaming.reachable ? `${data.streaming.liveStreams ?? 0} live stream(s) on AMS.` : `AMS not reachable: ${data.streaming.detail}`}
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {data.streaming.expected.map((e) => (
              <li key={e.room + e.streamId} className="flex flex-wrap items-center gap-2">
                <StatusBadge status={e.live ? "live" : "off_air"} />
                <span className="font-mono text-zinc-200">{e.streamId}</span>
                <span className="text-xs text-zinc-500">{e.why}</span>
                {!e.live && e.why.startsWith("featured") && <span className="text-xs text-amber-300">featured on air but not broadcasting</span>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-zinc-500">Expected = the main programme and any stream a producer has featured. Read-only: nothing here relinks or restarts a broadcast.</p>
        </Panel>

        <Panel>
          <h2 className="font-medium text-white">Translation worker</h2>
          <p className="mt-1 text-sm text-zinc-400">{data.translation.configured ? (data.translation.reachable ? data.translation.detail : `Not reachable: ${data.translation.detail}`) : data.translation.detail}</p>
          {data.translation.rooms.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">No rooms translating since the worker started.</p>
          ) : (
            <table className="mt-3 w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 font-medium">Room</th>
                  <th className="py-1 font-medium">Characters</th>
                  <th className="py-1 font-medium">Errors (total / last min)</th>
                  <th className="py-1 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody>
                {data.translation.rooms.map((r) => (
                  <tr key={r.room} className="border-t border-white/5 align-top">
                    <td className="py-1 font-mono text-zinc-200">{r.room}</td>
                    <td className="py-1 font-mono text-zinc-300">{r.charsTotal.toLocaleString()}</td>
                    <td className="py-1 font-mono text-zinc-300">
                      {r.errorsTotal} / <span className={r.errorsWindow ? "text-red-300" : ""}>{r.errorsWindow}</span>
                    </td>
                    <td className="py-1 text-zinc-400">{r.lastErrorAt ? `${ago(r.lastErrorAt)}: ${r.lastErrorMessage ?? ""}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
      <p className="mt-3 text-xs text-zinc-500">Generated {fmtTime(data.generatedAt)}.</p>
    </div>
  );
}

function FailureList({ title, items }: { title: string; items: Failure[] }) {
  return (
    <div className="mt-3">
      <h3 className="text-xs font-medium text-zinc-400">{title}</h3>
      {items.length === 0 ? (
        <Empty>None.</Empty>
      ) : (
        <ul className="mt-1 space-y-1 text-xs">
          {items.slice(0, 10).map((f, i) => (
            <li key={i} className="break-all text-zinc-400">
              <span className="text-zinc-500" title={fmtTime(f.at)}>
                {ago(f.at)}
              </span>{" "}
              <span className="font-mono text-zinc-300">{f.ref}</span> — <span className="text-red-200">{f.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
