"use client";

// Incidents (with an update timeline) and scheduled maintenance windows.
// Both reach users only through the Settings area's site notice and
// maintenance mode — there is no second banner or switch here. ?status=open
// (the Overview's link) shows unresolved incidents only.

import { useCallback, useEffect, useState } from "react";
import { Time, errorText, fromZonedInput, toZonedInput, useAdmin, zoneLabel } from "../../AdminApi";
import { Confirm, Empty, FilterBar, Labeled, LoadState, Notice, PageHeader, Pager, Panel, btn, field, useClientTable, useUrlFilters } from "../../ui";
import { StatusBadge, statusLabel } from "../opsUi";

type Update = { at: number; status: string; message: string; by: string };
type Incident = {
  id: string;
  title: string;
  impact: string;
  status: string;
  services: string[];
  showBanner: boolean;
  banner?: { ok: boolean; detail: string };
  updates: Update[];
  createdAt: number;
  resolvedAt?: number;
};
type Window = {
  id: string;
  title: string;
  message: string;
  startsAt: number;
  endsAt: number;
  maintenanceMode: boolean;
  announceFrom: number | null;
  state: string;
  surface?: { ok: boolean; detail: string };
  createdBy: string;
};
type Data = { incidents: Incident[]; maintenance: Window[]; services: { id: string; label: string }[] };

const STATUSES = ["investigating", "identified", "monitoring", "resolved"];

export default function OpsIncidentsClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("ops:write");
  const canMode = can("features:write");
  const filters = useUrlFilters({ status: "", q: "" });
  const onlyOpen = filters.value.status === "open";
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inc, setInc] = useState({ title: "", impact: "minor", status: "investigating", message: "", services: [] as string[], showBanner: true });
  const [upd, setUpd] = useState<Record<string, { status: string; message: string }>>({});
  // Times typed on the admin clock (Settings → Regional), not the browser's.
  const [mw, setMw] = useState(() => {
    const now = Date.now();
    return { title: "", message: "", startsAt: toZonedInput(now + 3600_000), endsAt: toZonedInput(now + 2 * 3600_000), maintenanceMode: false, announceMinutes: 60 };
  });
  const [cancel, setCancel] = useState<Window | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askSchedule, setAskSchedule] = useState(false);

  const load = useCallback(async () => {
    const r = await adminFetch<Data>("/api/admin/ops/incidents");
    if (r.ok) {
      setData(r.data);
      setLoadErr(null);
    } else setLoadErr(`Could not load incidents. ${errorText(r)}`);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const open = async () => {
    setBusy("open");
    setMsg(null);
    const r = await adminFetch<{ incident: Incident }>("/api/admin/ops/incidents", { method: "POST", json: inc });
    setBusy(null);
    setAskOpen(false);
    if (!r.ok) return setMsg({ kind: "err", text: `Could not open the incident. ${errorText(r)}` });
    setMsg({ kind: "ok", text: `Incident opened.${r.data.incident.showBanner ? ` Site notice: ${r.data.incident.banner?.detail}` : ""}` });
    setInc({ ...inc, title: "", message: "" });
    await load();
  };
  const post = async (i: Incident) => {
    const u = upd[i.id] ?? { status: i.status, message: "" };
    setBusy(`post:${i.id}`);
    setMsg(null);
    const r = await adminFetch(`/api/admin/ops/incidents/${encodeURIComponent(i.id)}`, { method: "PATCH", json: { status: u.status, message: u.message } });
    setBusy(null);
    if (!r.ok) return setMsg({ kind: "err", text: `Could not post the update. ${errorText(r)}` });
    setUpd({ ...upd, [i.id]: { status: u.status, message: "" } });
    setMsg({ kind: "ok", text: u.status === "resolved" ? `"${i.title}" resolved.` : `Update posted to "${i.title}".` });
    await load();
  };
  const startsAt = fromZonedInput(mw.startsAt);
  const endsAt = fromZonedInput(mw.endsAt);
  const timesOk = startsAt != null && endsAt != null && endsAt > startsAt;
  const schedule = async () => {
    setBusy("schedule");
    setMsg(null);
    const r = await adminFetch<{ window: Window }>("/api/admin/ops/maintenance", {
      method: "POST",
      json: { ...mw, startsAt, endsAt },
    });
    setBusy(null);
    setAskSchedule(false);
    if (!r.ok) return setMsg({ kind: "err", text: `Could not schedule the window. ${errorText(r)}` });
    setMsg({ kind: "ok", text: `Maintenance window scheduled.${r.data.window.surface ? ` ${r.data.window.surface.detail}` : ""}` });
    await load();
  };
  const doCancel = async (w: Window) => {
    setMsg(null);
    const r = await adminFetch(`/api/admin/ops/maintenance/${encodeURIComponent(w.id)}`, { method: "DELETE" });
    setCancel(null);
    if (!r.ok) return setMsg({ kind: "err", text: `Could not cancel the window. ${errorText(r)}` });
    setMsg({ kind: "ok", text: `"${w.title}" cancelled.` });
    await load();
  };

  const needle = filters.value.q.trim().toLowerCase();
  const incidents = data
    ? data.incidents.filter((i) => (!onlyOpen || i.status !== "resolved") && (!needle || `${i.title} ${i.updates.map((u) => u.message).join(" ")}`.toLowerCase().includes(needle)))
    : null;
  const incTable = useClientTable(incidents, (i) => i.createdAt, { key: "createdAt", dir: "desc", pageSize: 25 });
  const winTable = useClientTable(data?.maintenance, (w) => w.startsAt, { key: "startsAt", dir: "desc", pageSize: 25 });

  return (
    <div>
      <PageHeader title="Incidents & maintenance" sub="Shown to users through the site-wide notice and maintenance mode in Settings. Ops only clears what it put there itself." />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}

      <LoadState data={data} error={loadErr} onRetry={load}>
        {(d) => {
          const label = (id: string) => d.services.find((s) => s.id === id)?.label ?? id;
          return (
            <>
              {write && (
                <Panel className="mb-4">
                  <h2 className="font-medium text-white">Open an incident</h2>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm text-zinc-300">
                      Title
                      <input className={`${field} mt-1`} value={inc.title} maxLength={120} onChange={(e) => setInc({ ...inc, title: e.target.value })} />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <label className="min-w-0 text-sm text-zinc-300">
                        Impact
                        <select className={`${field} mt-1`} value={inc.impact} onChange={(e) => setInc({ ...inc, impact: e.target.value })}>
                          <option value="minor">Minor</option>
                          <option value="major">Major</option>
                          <option value="critical">Critical</option>
                        </select>
                      </label>
                      <label className="min-w-0 text-sm text-zinc-300">
                        Status
                        <select className={`${field} mt-1`} value={inc.status} onChange={(e) => setInc({ ...inc, status: e.target.value })}>
                          {STATUSES.slice(0, 3).map((s) => (
                            <option key={s} value={s}>
                              {statusLabel(s)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="text-sm text-zinc-300 sm:col-span-2">
                      What is happening
                      <textarea className={`${field} mt-1`} rows={2} maxLength={1000} value={inc.message} onChange={(e) => setInc({ ...inc, message: e.target.value })} />
                    </label>
                    <fieldset className="text-sm text-zinc-300 sm:col-span-2">
                      <legend>Affected services</legend>
                      <div className="mt-1 flex flex-wrap gap-3">
                        {d.services.map((s) => (
                          <label key={s.id} className="flex items-center gap-1.5 text-xs">
                            <input
                              type="checkbox"
                              checked={inc.services.includes(s.id)}
                              onChange={(e) => setInc({ ...inc, services: e.target.checked ? [...inc.services, s.id] : inc.services.filter((x) => x !== s.id) })}
                            />
                            {s.label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <label className="flex items-center gap-2 text-sm text-zinc-300">
                      <input type="checkbox" checked={inc.showBanner} onChange={(e) => setInc({ ...inc, showBanner: e.target.checked })} /> Show in the site notice
                    </label>
                    <div className="text-right">
                      {(!inc.title.trim() || !inc.message.trim()) && <p className="mb-1 text-xs text-zinc-400">Give it a title and say what is happening.</p>}
                      <button
                        type="button"
                        className={btn.primary}
                        disabled={!inc.title.trim() || !inc.message.trim() || !!busy}
                        onClick={() => (inc.showBanner ? setAskOpen(true) : open())}
                      >
                        {busy === "open" ? "Opening…" : "Open incident"}
                      </button>
                    </div>
                  </div>
                </Panel>
              )}

              <h2 className="mb-2 text-lg font-semibold text-cyan-50">Incidents</h2>
              <FilterBar active={filters.active} onClear={filters.reset}>
                <Labeled label="Show">
                  <select className={`${field} w-auto`} value={filters.value.status} onChange={(e) => filters.set({ status: e.target.value })}>
                    <option value="">All incidents</option>
                    <option value="open">Open only</option>
                  </select>
                </Labeled>
                <Labeled label="Search" className="min-w-[12rem] flex-1">
                  <input type="search" className={field} value={filters.value.q} placeholder="Title or update" onChange={(e) => filters.set({ q: e.target.value })} />
                </Labeled>
              </FilterBar>
              {incTable.total === 0 ? (
                <Empty>{needle ? "No incidents match this search." : onlyOpen ? "No open incidents." : "No incidents."}</Empty>
              ) : (
                <>
                  <div className="grid gap-3">
                    {incTable.visible.map((i) => (
                      <Panel key={i.id} className="min-w-0">
                        <div className="min-w-0">
                          <p className="font-medium text-white">
                            <StatusBadge status={i.status} /> {i.title} <span className="text-xs text-zinc-400">({i.impact})</span>
                          </p>
                          <p className="mt-0.5 text-xs text-zinc-400">
                            Opened <Time ts={i.createdAt} />
                            {i.resolvedAt && (
                              <>
                                {" "}
                                · resolved <Time ts={i.resolvedAt} />
                              </>
                            )}
                            {i.services.length ? ` · ${i.services.map(label).join(", ")}` : ""}
                          </p>
                          {i.showBanner && i.banner && <p className={`mt-1 text-xs ${i.banner.ok ? "text-emerald-300" : "text-amber-300"}`}>Site notice: {i.banner.detail}</p>}
                        </div>
                        <ol className="mt-3 space-y-1 border-l border-white/10 pl-3 text-sm">
                          {[...i.updates].reverse().map((u, n) => (
                            <li key={n}>
                              <span className="text-xs text-zinc-400">
                                <Time ts={u.at} /> · {statusLabel(u.status)} · {u.by}
                              </span>
                              <p className="break-words text-zinc-300">{u.message}</p>
                            </li>
                          ))}
                        </ol>
                        {write && i.status !== "resolved" && (
                          <div className="mt-3 flex flex-wrap items-end gap-2">
                            <select
                              aria-label={`New status for ${i.title}`}
                              className={`${field} w-40`}
                              value={upd[i.id]?.status ?? i.status}
                              onChange={(e) => setUpd({ ...upd, [i.id]: { status: e.target.value, message: upd[i.id]?.message ?? "" } })}
                            >
                              {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {statusLabel(s)}
                                </option>
                              ))}
                            </select>
                            <input
                              aria-label={`Update for ${i.title}`}
                              placeholder="Update for the timeline"
                              className={`${field} min-w-0 flex-1 basis-48`}
                              value={upd[i.id]?.message ?? ""}
                              onChange={(e) => setUpd({ ...upd, [i.id]: { status: upd[i.id]?.status ?? i.status, message: e.target.value } })}
                            />
                            <button type="button" className={btn.ghost} disabled={!!busy} aria-label={`Post update: ${i.title}`} onClick={() => post(i)}>
                              {busy === `post:${i.id}` ? "Posting…" : "Post update"}
                            </button>
                          </div>
                        )}
                      </Panel>
                    ))}
                  </div>
                  <Pager page={incTable.page} pageSize={incTable.pageSize} total={incTable.total} onPage={incTable.setPage} onPageSize={incTable.setPageSize} noun="incident" />
                </>
              )}

              <h2 className="mb-2 mt-6 text-lg font-semibold text-cyan-50">Scheduled maintenance</h2>
              {write && (
                <Panel className="mb-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm text-zinc-300">
                      Title
                      <input className={`${field} mt-1`} value={mw.title} maxLength={120} onChange={(e) => setMw({ ...mw, title: e.target.value })} />
                    </label>
                    <label className="text-sm text-zinc-300">
                      Message users see
                      <input className={`${field} mt-1`} value={mw.message} maxLength={500} onChange={(e) => setMw({ ...mw, message: e.target.value })} />
                    </label>
                    <label className="text-sm text-zinc-300">
                      Starts ({zoneLabel()})
                      <input type="datetime-local" className={`${field} mt-1`} value={mw.startsAt} onChange={(e) => setMw({ ...mw, startsAt: e.target.value })} />
                    </label>
                    <label className="text-sm text-zinc-300">
                      Ends ({zoneLabel()})
                      <input type="datetime-local" className={`${field} mt-1`} value={mw.endsAt} onChange={(e) => setMw({ ...mw, endsAt: e.target.value })} />
                    </label>
                    <label className="text-sm text-zinc-300">
                      Announce in the site notice (minutes before)
                      <input type="number" min={0} className={`${field} mt-1`} value={mw.announceMinutes} onChange={(e) => setMw({ ...mw, announceMinutes: Number(e.target.value) })} />
                    </label>
                    <label className="flex items-center gap-2 text-sm text-zinc-300">
                      <input type="checkbox" disabled={!canMode} checked={mw.maintenanceMode} onChange={(e) => setMw({ ...mw, maintenanceMode: e.target.checked })} />
                      Turn on maintenance mode for the window {canMode ? "(asks for a fresh code)" : "(needs features:write)"}
                    </label>
                  </div>
                  <div className="mt-3 text-right">
                    {!timesOk && <p className="mb-1 text-xs text-amber-300">The window must end after it starts.</p>}
                    {timesOk && (!mw.title.trim() || !mw.message.trim()) && <p className="mb-1 text-xs text-zinc-400">Give it a title and the message users see.</p>}
                    <button
                      type="button"
                      className={btn.primary}
                      disabled={!mw.title.trim() || !mw.message.trim() || !timesOk || !!busy}
                      onClick={() => (mw.maintenanceMode ? setAskSchedule(true) : schedule())}
                    >
                      {busy === "schedule" ? "Scheduling…" : "Schedule"}
                    </button>
                  </div>
                </Panel>
              )}
              {winTable.total === 0 ? (
                <Empty>No maintenance windows.</Empty>
              ) : (
                <>
                  <div className="grid gap-2">
                    {winTable.visible.map((w) => (
                      <Panel key={w.id} className="min-w-0">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-white">
                              <StatusBadge status={w.state} /> {w.title}
                            </p>
                            <p className="mt-0.5 break-words text-sm text-zinc-400">{w.message}</p>
                            <p className="mt-0.5 text-xs text-zinc-400">
                              <Time ts={w.startsAt} /> → <Time ts={w.endsAt} /> · {w.maintenanceMode ? "maintenance mode" : "notice only"} · by {w.createdBy}
                            </p>
                            {w.surface && <p className={`mt-1 text-xs ${w.surface.ok ? "text-emerald-300" : "text-amber-300"}`}>{w.surface.detail}</p>}
                          </div>
                          {write && (w.state === "scheduled" || w.state === "active") && (
                            <button type="button" className={btn.warn} aria-label={`Cancel window: ${w.title}`} onClick={() => setCancel(w)}>
                              Cancel window
                            </button>
                          )}
                        </div>
                      </Panel>
                    ))}
                  </div>
                  <Pager page={winTable.page} pageSize={winTable.pageSize} total={winTable.total} onPage={winTable.setPage} onPageSize={winTable.setPageSize} noun="window" />
                </>
              )}
            </>
          );
        }}
      </LoadState>

      {askOpen && (
        <Confirm
          title="Open this incident?"
          body={
            <>
              <b className="text-zinc-200">{inc.title}</b> ({inc.impact}) goes into the site-wide notice, so every user sees it now.
            </>
          }
          confirmLabel="Open incident"
          onConfirm={open}
          onCancel={() => setAskOpen(false)}
        />
      )}
      {askSchedule && (
        <Confirm
          title="Schedule maintenance mode?"
          body={
            <>
              From <b className="text-zinc-200">{startsAt ? <Time ts={startsAt} /> : "—"}</b> to <b className="text-zinc-200">{endsAt ? <Time ts={endsAt} /> : "—"}</b> the site goes into
              maintenance mode and people cannot use it. The notice is shown {mw.announceMinutes} minutes before.
            </>
          }
          confirmLabel="Schedule"
          danger
          typeToConfirm="maintenance"
          onConfirm={schedule}
          onCancel={() => setAskSchedule(false)}
        />
      )}
      {cancel && (
        <Confirm
          title="Cancel this maintenance window?"
          body={
            <>
              <b className="text-zinc-200">{cancel.title}</b> —{" "}
              {cancel.state === "active" ? "its notice comes down now and, if it turned maintenance mode on, maintenance mode goes off." : "it will not start."}
            </>
          }
          confirmLabel="Cancel window"
          danger
          typeToConfirm={cancel.state === "active" && cancel.maintenanceMode ? "cancel" : undefined}
          onConfirm={() => doCancel(cancel)}
          onCancel={() => setCancel(null)}
        />
      )}
    </div>
  );
}
