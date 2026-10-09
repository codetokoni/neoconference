"use client";

// Service health: every dependency's latest probe, its 24-hour history, and
// a "Check now" that runs the probes (read-only against every provider).

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import { Loading, Notice, PageHeader, Panel, btn } from "../ui";
import { HealthHistory, StatusBadge, ago, fmtMs, type HealthPoint, type ProbeStatus } from "./opsUi";

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

export default function OpsHealthClient() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<Health>("/api/admin/ops/health");
    if (r.ok) setData(r.data);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load service health." });
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
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "The check did not run." });
    const down = r.data.results.filter((x) => x.status === "down").length;
    setMsg({ kind: down ? "err" : "ok", text: `Checked ${r.data.results.length} services: ${down ? `${down} down` : "none down"}.` });
    load();
  };

  if (!data) return <Loading />;
  const rows = data.probes.map((p) => ({ p, r: data.latest[p.id] }));
  const groups = [...new Set(data.probes.map((p) => p.group))];
  const count = (s: ProbeStatus) => rows.filter((x) => x.r?.status === s).length;
  const lastChecked = Math.max(0, ...rows.map((x) => x.r?.checkedAt ?? 0));

  return (
    <div>
      <PageHeader
        title="Service health"
        sub="Every dependency, probed read-only every 5 minutes and on demand. A probe lists, counts or asks for a balance — it never changes anything at the provider."
        actions={
          <button type="button" onClick={checkNow} disabled={busy} className={btn.primary}>
            {busy ? "Checking…" : "Check now"}
          </button>
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <Panel className="mb-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="text-zinc-300">
            <b className="text-emerald-300">{count("up")}</b> up
          </span>
          <span className="text-zinc-300">
            <b className="text-amber-300">{count("degraded")}</b> degraded
          </span>
          <span className="text-zinc-300">
            <b className="text-red-300">{count("down")}</b> down
          </span>
          <span className="text-zinc-400">{count("not_configured")} not configured</span>
          <span className="ml-auto text-xs text-zinc-500" title={fmtTime(lastChecked)}>
            Last checked {ago(lastChecked || null)}
          </span>
        </div>
        <p className="mt-2 flex flex-wrap gap-3 text-[11px] text-zinc-500">
          History: one cell per check, latest on the right —
          <span><span className="text-emerald-400">■</span> up</span>
          <span><span className="text-amber-400">■</span> degraded</span>
          <span><span className="text-red-400">■</span> down</span>
          <span><span className="text-zinc-500">■</span> not configured</span>
          <span><span className="text-cyan-300">—</span> latency</span>
        </p>
      </Panel>
      {groups.map((g) => (
        <section key={g} className="mb-5">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-500">{g}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {rows
              .filter((x) => x.p.group === g)
              .map(({ p, r }) => (
                <Panel key={p.id}>
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
                    <HealthHistory points={data.history[p.id] ?? []} label={p.label} />
                  </div>
                  <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-zinc-500">
                    <span title={r ? fmtTime(r.checkedAt) : undefined}>Checked {ago(r?.checkedAt)}</span>
                    <span title={r?.lastFailure ?? undefined}>
                      Last failure: {r?.lastFailureAt ? `${ago(r.lastFailureAt)} — ${r.lastFailure}` : "none recorded"}
                    </span>
                  </div>
                </Panel>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
