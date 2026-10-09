"use client";

// Service health: every dependency's latest probe, its 24-hour history, and
// a "Check now" that runs the probes (read-only against every provider).
// The up / degraded / down figures filter the services shown (?status=).

import { useCallback, useEffect, useState } from "react";
import { Time, errorText, useAdmin } from "../AdminApi";
import { EmptyLine, LoadState, Notice, PageHeader, Panel, StatTile, btn, useUrlFilters } from "../ui";
import { HealthHistory, StatusBadge, fmtMs, type HealthPoint, type ProbeStatus } from "./opsUi";

type ProbeInfo = { id: string; label: string; group: string; needs: string[] };
type Result = {
  id: string;
  label: string;
  group: string;
  status: ProbeStatus;
  latencyMs: number | null;
  checkedAt: number;
  detail: string;
  lastFailureAt: number | null;
  lastFailure: string | null;
};
type Health = { probes: ProbeInfo[]; latest: Record<string, Result>; history: Record<string, HealthPoint[]> };

const FIGURES: { s: ProbeStatus; label: string; tone?: "green" | "amber" | "red" }[] = [
  { s: "up", label: "Up", tone: "green" },
  { s: "degraded", label: "Degraded", tone: "amber" },
  { s: "down", label: "Down", tone: "red" },
  { s: "not_configured", label: "Not configured" },
];

export default function OpsHealthClient() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<Health | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const filters = useUrlFilters({ status: "" });
  const only = filters.value.status as ProbeStatus | "";

  const load = useCallback(async () => {
    const r = await adminFetch<Health>("/api/admin/ops/health");
    if (r.ok) {
      setData(r.data);
      setLoadErr(null);
    } else setLoadErr(`Could not load service health. ${errorText(r)}`);
  }, [adminFetch]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const checkNow = async () => {
    setBusy(true);
    setMsg(null);
    const r = await adminFetch<{ results: Result[] }>("/api/admin/ops/health", { method: "POST", json: {} });
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "err", text: `The check did not run. ${errorText(r)}` });
    const down = r.data.results.filter((x) => x.status === "down").length;
    setMsg({ kind: down ? "err" : "ok", text: `Checked ${r.data.results.length} services: ${down ? `${down} down` : "none down"}.` });
    load();
  };

  return (
    <div>
      <PageHeader
        title="Service health"
        sub="Every dependency, probed read-only every 5 minutes and on demand. A probe lists, counts or asks for a balance — it never changes anything at the provider."
        actions={
          <button type="button" onClick={checkNow} disabled={busy} aria-busy={busy} className={btn.primary}>
            {busy ? "Checking…" : "Check now"}
          </button>
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <LoadState data={data} error={loadErr} onRetry={load}>
        {(d) => {
          const rows = d.probes.map((p) => ({ p, r: d.latest[p.id] }));
          const statusOf = (x: { r?: Result }) => x.r?.status ?? "not_configured";
          const count = (s: ProbeStatus) => rows.filter((x) => statusOf(x) === s).length;
          const lastChecked = Math.max(0, ...rows.map((x) => x.r?.checkedAt ?? 0));
          const shown = only ? rows.filter((x) => statusOf(x) === only) : rows;
          const groups = [...new Set(shown.map((x) => x.p.group))];
          return (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {FIGURES.map((f) => (
                  <StatTile
                    key={f.s}
                    label={f.label}
                    value={count(f.s)}
                    tone={count(f.s) ? f.tone : undefined}
                    hint={only === f.s ? "Showing these — click to show all" : "Show these services"}
                    active={only === f.s}
                    onClick={() => filters.set({ status: only === f.s ? "" : f.s })}
                  />
                ))}
              </div>
              <Panel className="mb-4">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-zinc-400">
                  <span>
                    Last checked <Time ts={lastChecked || null} mode="relative" />
                  </span>
                  {only && (
                    <button type="button" className="text-cyan-300 underline" onClick={filters.reset}>
                      Show all services
                    </button>
                  )}
                </div>
                <p className="mt-2 flex flex-wrap gap-3 text-[11px] text-zinc-400">
                  History: one cell per check, latest on the right —
                  <span>
                    <span className="text-emerald-400">■</span> up
                  </span>
                  <span>
                    <span className="text-amber-400">■</span> degraded
                  </span>
                  <span>
                    <span className="text-red-400">■</span> down
                  </span>
                  <span>
                    <span className="text-zinc-400">■</span> not configured
                  </span>
                  <span>
                    <span className="text-cyan-300">—</span> latency
                  </span>
                </p>
              </Panel>
              {shown.length === 0 && <EmptyLine>No services are {FIGURES.find((f) => f.s === only)?.label.toLowerCase() ?? only} right now.</EmptyLine>}
              {groups.map((g) => (
                <section key={g} className="mb-5">
                  <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-400">{g}</h2>
                  <div className="grid gap-3 md:grid-cols-2">
                    {shown
                      .filter((x) => x.p.group === g)
                      .map(({ p, r }) => (
                        <Panel key={p.id} className="min-w-0">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="font-medium text-white">{p.label}</h3>
                              <p className="mt-0.5 break-words text-sm text-zinc-400">{r ? r.detail : "Not checked yet."}</p>
                            </div>
                            <div className="shrink-0 text-right">
                              {r ? <StatusBadge status={r.status} /> : <StatusBadge status="not_configured" />}
                              <p className="mt-1 font-mono text-xs text-zinc-400">{fmtMs(r?.latencyMs)}</p>
                            </div>
                          </div>
                          <div className="mt-3">
                            <HealthHistory points={d.history[p.id] ?? []} label={p.label} />
                          </div>
                          <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-zinc-400">
                            <span>
                              Checked <Time ts={r?.checkedAt} mode="relative" />
                            </span>
                            <span className="min-w-0 break-words">
                              Last failure:{" "}
                              {r?.lastFailureAt ? (
                                <>
                                  <Time ts={r.lastFailureAt} mode="relative" /> — {r.lastFailure}
                                </>
                              ) : (
                                "none recorded"
                              )}
                            </span>
                          </div>
                        </Panel>
                      ))}
                  </div>
                </section>
              ))}
            </>
          );
        }}
      </LoadState>
    </div>
  );
}
