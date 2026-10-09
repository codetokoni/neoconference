"use client";

// Jobs and queues: every scheduled job's run history from the job runner,
// failed runs with a Retry only where a second run is safe, and the queues
// outside the runner (transcription, pending checkouts, webhook events that
// changed nothing).

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn } from "../../ui";
import { Counts, StatusBadge, ago, fmtMs } from "../opsUi";

type Run = {
  id: string;
  job: string;
  trigger: string;
  actor: string;
  retryOf?: string;
  startedAt: number;
  durationMs?: number;
  outcome: string;
  summary?: string;
  error?: string;
};
type Job = {
  name: string;
  label: string;
  description: string;
  scheduleText: string;
  retrySafe: boolean;
  retryNote: string;
  registered: boolean;
  running: boolean;
  runs: Run[];
};
type Data = {
  jobs: Job[];
  failed: Run[];
  queues: {
    transcription: { byStatus: Record<string, number>; total: number; truncated: boolean; queued: Array<{ id: string; status: string; provider: string; recordingKey?: string; updatedAt?: string }> };
    sends: { open: number; items: Array<{ id: string; title: string; status: string; audience: string; recipients: number; sent: number; failed: number; lastError: string | null; updatedAt: number }> };
    checkouts: { total: number; byStatus: Record<string, number>; items: Array<{ nonce: string; userId: string; plan: string; billingCycle: string; status: string; createdAt: number }> };
    webhookRejections: Array<{ atMs: number; event: string; room: string; reason: string; state?: string }>;
  };
};

type Pending = { job: Job; run?: Run };

export default function OpsJobsClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("ops:write");
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<Data>("/api/admin/ops/jobs");
    if (r.ok) setData(r.data);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load jobs." });
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const go = async (p: Pending) => {
    setPending(null);
    setBusy(p.job.name);
    setMsg(null);
    const r = await adminFetch<{ run: Run | null }>(`/api/admin/ops/jobs/${encodeURIComponent(p.job.name)}`, {
      method: "POST",
      json: p.run ? { action: "retry", runId: p.run.id } : { action: "run" },
    });
    setBusy(null);
    if (!r.ok) setMsg({ kind: "err", text: r.data.message ?? "The job did not run." });
    else setMsg({ kind: r.data.run?.outcome === "failed" ? "err" : "ok", text: `${p.job.label}: ${r.data.run?.outcome ?? "done"}${r.data.run?.error ? ` — ${r.data.run.error}` : ""}` });
    load();
  };

  if (!data) return <Loading />;
  const byName = new Map(data.jobs.map((j) => [j.name, j]));
  const q = data.queues;

  return (
    <div>
      <PageHeader
        title="Jobs & queues"
        sub="Scheduled jobs run through one runner that records every run and holds a lock, so a job never runs twice at once. Retry is offered only where running a job again cannot repeat an effect."
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}

      <div className="grid gap-3">
        {data.jobs.map((j) => {
          const last = j.runs[0];
          return (
            <Panel key={j.name}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-2xl">
                  <h2 className="font-medium text-white">
                    {j.label} <span className="font-mono text-xs text-zinc-500">{j.name}</span>
                  </h2>
                  <p className="mt-0.5 text-sm text-zinc-400">{j.description}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {j.scheduleText} ·{" "}
                    {j.retrySafe ? <Badge tone="green">Safe to run again</Badge> : <Badge tone="amber">Not safe to run again</Badge>}{" "}
                    <span className="text-zinc-500">{j.retryNote}</span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {j.running ? <StatusBadge status="running" /> : last ? <StatusBadge status={last.outcome} /> : <Badge>No runs yet</Badge>}
                  {last && (
                    <span className="text-xs text-zinc-500" title={fmtTime(last.startedAt)}>
                      {ago(last.startedAt)} · {fmtMs(last.durationMs)}
                    </span>
                  )}
                  <div className="mt-1 flex gap-2">
                    <button type="button" className={btn.ghost} onClick={() => setOpen(open === j.name ? null : j.name)} aria-expanded={open === j.name}>
                      {open === j.name ? "Hide runs" : `Runs (${j.runs.length})`}
                    </button>
                    {write && j.registered && j.retrySafe && (
                      <button type="button" className={btn.ghost} disabled={!!busy || j.running} onClick={() => setPending({ job: j })}>
                        {busy === j.name ? "Running…" : "Run now"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {open === j.name && <RunTable runs={j.runs} />}
            </Panel>
          );
        })}
      </div>

      <h2 className="mb-2 mt-6 text-lg font-semibold text-cyan-50">Failed runs</h2>
      {data.failed.length === 0 ? (
        <Empty>No failed runs.</Empty>
      ) : (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Error</th>
                <th className="px-3 py-2 font-medium">Retry</th>
              </tr>
            </thead>
            <tbody>
              {data.failed.map((r) => {
                const j = byName.get(r.job);
                return (
                  <tr key={r.id} className="border-t border-white/5 align-top">
                    <td className="px-3 py-2 text-zinc-200">{j?.label ?? r.job}</td>
                    <td className="px-3 py-2 text-zinc-400" title={fmtTime(r.startedAt)}>
                      {ago(r.startedAt)}
                    </td>
                    <td className="px-3 py-2 text-red-200">{r.error ?? r.outcome}</td>
                    <td className="px-3 py-2">
                      {j?.retrySafe && j.registered ? (
                        write ? (
                          <button type="button" className={btn.ghost} disabled={!!busy || j.running} onClick={() => setPending({ job: j, run: r })}>
                            Retry
                          </button>
                        ) : (
                          <span className="text-xs text-zinc-500">Needs ops:write</span>
                        )
                      ) : (
                        <span className="text-xs text-amber-200/80" title={j?.retryNote}>
                          Not safe to retry
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>
      )}

      <h2 className="mb-2 mt-6 text-lg font-semibold text-cyan-50">Queues</h2>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <h3 className="font-medium text-white">Transcription jobs (last 30 days)</h3>
          <div className="mt-2">
            <Counts items={[["Total", q.transcription.total], ...Object.entries(q.transcription.byStatus).map(([k, v]) => [k, v] as [string, number])]} />
          </div>
          {q.transcription.queued.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs text-zinc-400">
              {q.transcription.queued.map((t) => (
                <li key={t.id} className="truncate">
                  <StatusBadge status={t.status} /> {t.provider} · {t.recordingKey ?? t.id} · {t.updatedAt?.slice(0, 16).replace("T", " ")}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-zinc-500">Nothing waiting.</p>
          )}
          <p className="mt-2 text-[11px] text-zinc-500">No retry here: every transcription attempt is billed again by the provider.</p>
        </Panel>
        <Panel>
          <h3 className="font-medium text-white">Announcement sends with recipients left</h3>
          {q.sends.items.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">Nothing waiting.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs text-zinc-400">
              {q.sends.items.map((s) => (
                <li key={s.id} className="truncate" title={s.lastError ?? undefined}>
                  <StatusBadge status={s.status} /> {s.title} · {s.audience} · {s.sent}/{s.recipients} sent{s.failed ? `, ${s.failed} failed` : ""} · {ago(s.updatedAt)}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-zinc-500">Delivered by the scheduler every 30 seconds and the daily comms job; controlled from Communication.</p>
        </Panel>
        <Panel>
          <h3 className="font-medium text-white">Pending checkouts (eSPees, 1-hour window)</h3>
          <div className="mt-2">
            <Counts items={[["Open", q.checkouts.total], ...Object.entries(q.checkouts.byStatus).map(([k, v]) => [k, v] as [string, number])]} />
          </div>
          {q.checkouts.items.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-zinc-400">
              {q.checkouts.items.slice(0, 10).map((c) => (
                <li key={c.nonce} className="truncate">
                  <StatusBadge status={c.status} /> {c.plan} {c.billingCycle} · {c.userId} · {ago(c.createdAt)}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel className="lg:col-span-2">
          <h3 className="font-medium text-white">LiveKit webhook events that changed nothing (latest 50)</h3>
          {q.webhookRejections.length === 0 ? (
            <p className="mt-2 text-xs text-zinc-500">None recorded.</p>
          ) : (
            <ul className="mt-2 grid gap-1 text-xs text-zinc-400 sm:grid-cols-2">
              {q.webhookRejections.slice(0, 20).map((w, i) => (
                <li key={i} className="truncate">
                  {ago(w.atMs)} · {w.event} · <span className="font-mono">{w.room}</span> · {w.reason}
                  {w.state ? ` (${w.state})` : ""}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {pending && (
        <Confirm
          title={pending.run ? `Retry ${pending.job.label}?` : `Run ${pending.job.label} now?`}
          body={
            <>
              <p>{pending.job.retryNote}</p>
              <p className="mt-2">It runs under the job&apos;s lock and is recorded in its history and the audit log.</p>
            </>
          }
          confirmLabel={pending.run ? "Retry" : "Run now"}
          onConfirm={() => go(pending)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function RunTable({ runs }: { runs: Run[] }) {
  if (!runs.length) return <p className="mt-3 text-xs text-zinc-500">No runs recorded yet.</p>;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className="py-1 pr-3 font-medium">Started</th>
            <th className="py-1 pr-3 font-medium">Outcome</th>
            <th className="py-1 pr-3 font-medium">Took</th>
            <th className="py-1 pr-3 font-medium">By</th>
            <th className="py-1 font-medium">Summary / error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-white/5 align-top">
              <td className="py-1 pr-3 text-zinc-300">{fmtTime(r.startedAt)}</td>
              <td className="py-1 pr-3">
                <StatusBadge status={r.outcome} />
              </td>
              <td className="py-1 pr-3 font-mono text-zinc-400">{fmtMs(r.durationMs)}</td>
              <td className="py-1 pr-3 text-zinc-400">
                {r.trigger === "schedule" ? "schedule" : `${r.trigger} · ${r.actor}`}
              </td>
              <td className="break-all py-1 font-mono text-zinc-400">{r.error ? <span className="text-red-200">{r.error}</span> : r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
