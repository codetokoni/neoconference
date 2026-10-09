"use client";

// Jobs and queues: every scheduled job's run history from the job runner,
// failed runs with a Retry only where a second run is safe, and the queues
// outside the runner (transcription, pending checkouts, webhook events that
// changed nothing). ?job=<name> and ?outcome=failed (the Overview's links)
// are filters kept in the address bar.

import { useCallback, useEffect, useState } from "react";
import { Time, errorText, fmtNumber, fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Confirm, EmptyLine, FilterBar, Labeled, LoadState, Notice, PageHeader, Pager, Panel, SortTh, TableWrap, btn, field, useClientTable, useUrlFilters } from "../../ui";
import { Counts, StatusBadge, fmtMs } from "../opsUi";

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

// How many runs the server sends per job, and failed runs overall.
const RUNS_PER_JOB = 10;
const FAILED_SENT = 50;

// Jobs whose run changes or removes data beyond what a check does: the
// backup applies retention (deletes old snapshots) and the plan job moves
// accounts back to Free. Their Run now / Retry is styled as dangerous.
const DESTRUCTIVE = new Set(["ops-backup", "downgrade-expired-plans"]);

const failedRun = (r: Run) => r.outcome === "failed" || r.outcome === "abandoned";

export default function OpsJobsClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("ops:write");
  const filters = useUrlFilters({ job: "", outcome: "" });
  const only = { job: filters.value.job, failed: filters.value.outcome === "failed" };
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // A link to one job opens its runs.
  const [open, setOpen] = useState<string | null>(() => filters.value.job || null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<Data>("/api/admin/ops/jobs");
    if (r.ok) {
      setData(r.data);
      setLoadErr(null);
    } else setLoadErr(`Could not load jobs. ${errorText(r)}`);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const go = async (p: Pending) => {
    setBusy(p.job.name);
    setMsg(null);
    const r = await adminFetch<{ run: Run | null }>(`/api/admin/ops/jobs/${encodeURIComponent(p.job.name)}`, {
      method: "POST",
      json: p.run ? { action: "retry", runId: p.run.id } : { action: "run" },
    });
    setBusy(null);
    setPending(null);
    if (!r.ok) setMsg({ kind: "err", text: `${p.job.label} did not run. ${errorText(r)}` });
    else setMsg({ kind: r.data.run?.outcome === "failed" ? "err" : "ok", text: `${p.job.label}: ${r.data.run?.outcome ?? "done"}${r.data.run?.error ? ` — ${r.data.run.error}` : ""}` });
    await load();
  };

  const failedRows = data ? (only.job ? data.failed.filter((r) => r.job === only.job) : data.failed) : null;
  const byName = new Map((data?.jobs ?? []).map((j) => [j.name, j]));
  const table = useClientTable(failedRows, (r, k) => (k === "job" ? byName.get(r.job)?.label ?? r.job : r.startedAt), { key: "startedAt", dir: "desc" });

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

      <LoadState data={data} error={loadErr} onRetry={load}>
        {(d) => {
          const jobsShown = d.jobs
            .filter((j) => !only.job || j.name === only.job)
            .filter((j) => !only.failed || j.runs.some(failedRun))
            .map((j) => (only.failed ? { ...j, runs: j.runs.filter(failedRun) } : j));
          const q = d.queues;
          const waiting = (q.transcription.byStatus.queued ?? 0) + (q.transcription.byStatus.running ?? 0);
          return (
            <>
              <FilterBar active={filters.active} onClear={filters.reset}>
                <Labeled label="Job">
                  <select className={`${field} w-auto`} value={only.job} onChange={(e) => filters.set({ job: e.target.value })}>
                    <option value="">All jobs</option>
                    {d.jobs.map((j) => (
                      <option key={j.name} value={j.name}>
                        {j.label}
                      </option>
                    ))}
                    {only.job && !byName.has(only.job) && <option value={only.job}>{only.job}</option>}
                  </select>
                </Labeled>
                <Labeled label="Runs">
                  <select className={`${field} w-auto`} value={filters.value.outcome} onChange={(e) => filters.set({ outcome: e.target.value })}>
                    <option value="">Any outcome</option>
                    <option value="failed">Failed or abandoned</option>
                  </select>
                </Labeled>
              </FilterBar>

              <div className="grid gap-3">
                {jobsShown.length === 0 && <EmptyLine>No jobs match these filters.</EmptyLine>}
                {jobsShown.map((j) => {
                  const last = j.runs[0];
                  return (
                    <Panel key={j.name} className="min-w-0">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 max-w-2xl">
                          <h2 className="font-medium text-white">
                            {j.label} <span className="font-mono text-xs text-zinc-400">{j.name}</span>
                          </h2>
                          <p className="mt-0.5 text-sm text-zinc-400">{j.description}</p>
                          <p className="mt-1 text-xs text-zinc-400">
                            {j.scheduleText} ·{" "}
                            {j.retrySafe ? <Badge tone="green">Safe to run again</Badge> : <Badge tone="amber">Not safe to run again</Badge>}{" "}
                            <span className="text-zinc-400">{j.retryNote}</span>
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {j.running ? <StatusBadge status="running" /> : last ? <StatusBadge status={last.outcome} /> : <Badge>No runs yet</Badge>}
                          {last && (
                            <span className="text-xs text-zinc-400">
                              <Time ts={last.startedAt} mode="relative" /> · {fmtMs(last.durationMs)}
                            </span>
                          )}
                          <div className="mt-1 flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              className={btn.ghost}
                              onClick={() => setOpen(open === j.name ? null : j.name)}
                              aria-expanded={open === j.name}
                              aria-label={`${open === j.name ? "Hide runs" : `Runs (${j.runs.length})`}: ${j.label}`}
                            >
                              {open === j.name ? "Hide runs" : `Runs (${j.runs.length})`}
                            </button>
                            {write && j.registered && j.retrySafe && (
                              <button
                                type="button"
                                className={DESTRUCTIVE.has(j.name) ? btn.warn : btn.ghost}
                                disabled={!!busy || j.running}
                                aria-label={`Run now: ${j.label}`}
                                onClick={() => setPending({ job: j })}
                              >
                                {busy === j.name ? "Running…" : "Run now"}
                              </button>
                            )}
                          </div>
                          {write && j.registered && j.retrySafe && j.running && <span className="text-[11px] text-zinc-400">Running now — wait for it to finish.</span>}
                        </div>
                      </div>
                      {open === j.name && <RunTable runs={j.runs} label={j.label} filtered={only.failed} />}
                    </Panel>
                  );
                })}
              </div>

              <h2 className="mb-2 mt-6 text-lg font-semibold text-cyan-50">Failed runs</h2>
              {table.total === 0 ? (
                <EmptyLine>No failed runs{only.job ? " for this job" : ""}.</EmptyLine>
              ) : (
                <>
                  <TableWrap minWidth={640}>
                    <thead className="text-xs text-zinc-400">
                      <tr>
                        <SortTh label="Job" k="job" sort={table.sort} onSort={table.onSort} />
                        <SortTh label="When" k="startedAt" sort={table.sort} onSort={table.onSort} />
                        <th className="px-3 py-2 font-medium">Error</th>
                        <th className="px-3 py-2 font-medium">Retry</th>
                      </tr>
                    </thead>
                    <tbody>
                      {table.visible.map((r) => {
                        const j = byName.get(r.job);
                        return (
                          <tr key={r.id} className="border-t border-white/5 align-top">
                            <td className="px-3 py-2 text-zinc-200">{j?.label ?? r.job}</td>
                            <td className="px-3 py-2 text-zinc-400">
                              <Time ts={r.startedAt} mode="relative" />
                            </td>
                            <td className="break-words px-3 py-2 text-red-200">{r.error ?? r.outcome}</td>
                            <td className="px-3 py-2">
                              {j?.retrySafe && j.registered ? (
                                write ? (
                                  <>
                                    <button
                                      type="button"
                                      className={DESTRUCTIVE.has(j.name) ? btn.warn : btn.ghost}
                                      disabled={!!busy || j.running}
                                      aria-label={`Retry ${j.label} run from ${fmtTime(r.startedAt)}`}
                                      onClick={() => setPending({ job: j, run: r })}
                                    >
                                      {busy === j.name ? "Running…" : "Retry"}
                                    </button>
                                    {j.running && <span className="mt-1 block text-[11px] text-zinc-400">Running now</span>}
                                  </>
                                ) : (
                                  <span className="text-xs text-zinc-400">Needs ops:write</span>
                                )
                              ) : (
                                <span className="text-xs text-amber-200/80">Not safe to retry{j?.retryNote ? `: ${j.retryNote}` : ""}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </TableWrap>
                  <Pager page={table.page} pageSize={table.pageSize} total={table.total} onPage={table.setPage} onPageSize={table.setPageSize} noun="failed run" />
                  {d.failed.length >= FAILED_SENT && <p className="mt-1 text-xs text-zinc-400">Only the latest {FAILED_SENT} failed runs across all jobs are listed here.</p>}
                </>
              )}

              <h2 className="mb-2 mt-6 text-lg font-semibold text-cyan-50">Queues</h2>
              <div className="grid gap-3 lg:grid-cols-2">
                <Panel className="min-w-0">
                  <h3 className="font-medium text-white">Transcription jobs (last 30 days)</h3>
                  <div className="mt-2">
                    <Counts items={[["Total", q.transcription.total], ...Object.entries(q.transcription.byStatus).map(([k, v]) => [k, v] as [string, number])]} />
                  </div>
                  {q.transcription.truncated && <p className="mt-1 text-[11px] text-amber-200/80">Counted from the first 2,000 jobs found; there are more.</p>}
                  {q.transcription.queued.length > 0 ? (
                    <>
                      <ul className="mt-3 max-h-60 space-y-1 overflow-auto text-xs text-zinc-400">
                        {q.transcription.queued.map((t) => (
                          <li key={t.id} className="truncate">
                            <StatusBadge status={t.status} /> {t.provider} · {t.recordingKey ?? t.id} · {fmtTime(t.updatedAt)}
                          </li>
                        ))}
                      </ul>
                      {waiting > q.transcription.queued.length && (
                        <p className="mt-1 text-[11px] text-zinc-400">
                          Showing the latest {q.transcription.queued.length} of {fmtNumber(waiting)} waiting or running.
                        </p>
                      )}
                    </>
                  ) : (
                    <EmptyLine>Nothing waiting.</EmptyLine>
                  )}
                  <p className="mt-2 text-[11px] text-zinc-400">No retry here: every transcription attempt is billed again by the provider.</p>
                </Panel>
                <Panel className="min-w-0">
                  <h3 className="font-medium text-white">Announcement sends with recipients left</h3>
                  {q.sends.items.length === 0 ? (
                    <EmptyLine>Nothing waiting.</EmptyLine>
                  ) : (
                    <>
                      <ul className="mt-2 max-h-60 space-y-1 overflow-auto text-xs text-zinc-400">
                        {q.sends.items.map((s) => (
                          <li key={s.id} className="truncate" title={s.lastError ?? undefined}>
                            <StatusBadge status={s.status} /> {s.title} · {s.audience} · {fmtNumber(s.sent)}/{fmtNumber(s.recipients)} sent
                            {s.failed ? `, ${fmtNumber(s.failed)} failed` : ""} · <Time ts={s.updatedAt} mode="relative" />
                          </li>
                        ))}
                      </ul>
                      {q.sends.open > q.sends.items.length && (
                        <p className="mt-1 text-[11px] text-zinc-400">
                          Showing {q.sends.items.length} of {fmtNumber(q.sends.open)} open sends.
                        </p>
                      )}
                    </>
                  )}
                  <p className="mt-2 text-[11px] text-zinc-400">Delivered by the scheduler every 30 seconds and the daily comms job; controlled from Communication.</p>
                </Panel>
                <Panel className="min-w-0">
                  <h3 className="font-medium text-white">Pending checkouts (eSPees, 1-hour window)</h3>
                  <div className="mt-2">
                    <Counts items={[["Open", q.checkouts.total], ...Object.entries(q.checkouts.byStatus).map(([k, v]) => [k, v] as [string, number])]} />
                  </div>
                  {q.checkouts.items.length > 0 && (
                    <>
                      <ul className="mt-3 max-h-60 space-y-1 overflow-auto text-xs text-zinc-400">
                        {q.checkouts.items.map((c) => (
                          <li key={c.nonce} className="truncate">
                            <StatusBadge status={c.status} /> {c.plan} {c.billingCycle} · {c.userId} · <Time ts={c.createdAt} mode="relative" />
                          </li>
                        ))}
                      </ul>
                      {q.checkouts.total > q.checkouts.items.length && (
                        <p className="mt-1 text-[11px] text-zinc-400">
                          Showing the latest {q.checkouts.items.length} of {fmtNumber(q.checkouts.total)}.
                        </p>
                      )}
                    </>
                  )}
                </Panel>
                <Panel className="min-w-0 lg:col-span-2">
                  <h3 className="font-medium text-white">LiveKit webhook events that changed nothing (latest 50)</h3>
                  {q.webhookRejections.length === 0 ? (
                    <EmptyLine>None recorded.</EmptyLine>
                  ) : (
                    <ul className="mt-2 grid max-h-72 gap-1 overflow-auto text-xs text-zinc-400 sm:grid-cols-2">
                      {q.webhookRejections.map((w, i) => (
                        <li key={i} className="truncate">
                          <Time ts={w.atMs} mode="relative" /> · {w.event} · <span className="font-mono">{w.room}</span> · {w.reason}
                          {w.state ? ` (${w.state})` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            </>
          );
        }}
      </LoadState>

      {pending && (
        <Confirm
          title={pending.run ? `Retry ${pending.job.label}?` : `Run ${pending.job.label} now?`}
          body={
            <>
              <p>{pending.job.description}</p>
              <p className="mt-2">{pending.job.retryNote}</p>
              <p className="mt-2">It runs under the job&apos;s lock and is recorded in its history and the audit log.</p>
            </>
          }
          confirmLabel={pending.run ? "Retry" : "Run now"}
          danger={DESTRUCTIVE.has(pending.job.name)}
          onConfirm={() => go(pending)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

function RunTable({ runs, label, filtered }: { runs: Run[]; label: string; filtered: boolean }) {
  if (!runs.length) return <EmptyLine>{filtered ? "No failed runs among the latest." : "No runs recorded yet."}</EmptyLine>;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <caption className="sr-only">Latest runs of {label}</caption>
        <thead className="text-zinc-400">
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
              <td className="whitespace-nowrap py-1 pr-3 text-zinc-300">
                <Time ts={r.startedAt} />
              </td>
              <td className="py-1 pr-3">
                <StatusBadge status={r.outcome} />
              </td>
              <td className="py-1 pr-3 font-mono text-zinc-400">{fmtMs(r.durationMs)}</td>
              <td className="py-1 pr-3 text-zinc-400">{r.trigger === "schedule" ? "schedule" : `${r.trigger} · ${r.actor}`}</td>
              <td className="break-all py-1 font-mono text-zinc-400">{r.error ? <span className="text-red-200">{r.error}</span> : r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-zinc-400">
        {filtered ? `Failed runs among the latest ${RUNS_PER_JOB}.` : runs.length >= RUNS_PER_JOB ? `The latest ${RUNS_PER_JOB} runs are shown; older runs are not listed.` : ""}
      </p>
    </div>
  );
}
