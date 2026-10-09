"use client";

// Incidents (with an update timeline) and scheduled maintenance windows.
// Both reach users only through the Settings area's site notice and
// maintenance mode — there is no second banner or switch here.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
import { StatusBadge } from "../opsUi";

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

function localInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export default function OpsIncidentsClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("ops:write");
  const canMode = can("features:write");
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [inc, setInc] = useState({ title: "", impact: "minor", status: "investigating", message: "", services: [] as string[], showBanner: true });
  const [upd, setUpd] = useState<Record<string, { status: string; message: string }>>({});
  const now = Date.now();
  const [mw, setMw] = useState({ title: "", message: "", startsAt: localInput(now + 3600_000), endsAt: localInput(now + 2 * 3600_000), maintenanceMode: false, announceMinutes: 60 });
  const [cancel, setCancel] = useState<Window | null>(null);
  // ?status=open (the Overview's link): unresolved incidents only.
  const [onlyOpen, setOnlyOpen] = useState(false);
  useEffect(() => {
    setOnlyOpen(new URLSearchParams(window.location.search).get("status") === "open");
  }, []);

  const load = useCallback(async () => {
    const r = await adminFetch<Data>("/api/admin/ops/incidents");
    if (r.ok) setData(r.data);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load incidents." });
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const open = async () => {
    const r = await adminFetch<{ incident: Incident }>("/api/admin/ops/incidents", { method: "POST", json: inc });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not open the incident." });
    setMsg({ kind: "ok", text: `Incident opened.${r.data.incident.showBanner ? ` Site notice: ${r.data.incident.banner?.detail}` : ""}` });
    setInc({ ...inc, title: "", message: "" });
    load();
  };
  const post = async (i: Incident) => {
    const u = upd[i.id] ?? { status: i.status, message: "" };
    const r = await adminFetch(`/api/admin/ops/incidents/${encodeURIComponent(i.id)}`, { method: "PATCH", json: { status: u.status, message: u.message } });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not post the update." });
    setUpd({ ...upd, [i.id]: { status: u.status, message: "" } });
    load();
  };
  const schedule = async () => {
    const r = await adminFetch<{ window: Window }>("/api/admin/ops/maintenance", {
      method: "POST",
      json: { ...mw, startsAt: new Date(mw.startsAt).getTime(), endsAt: new Date(mw.endsAt).getTime() },
    });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not schedule the window." });
    setMsg({ kind: "ok", text: `Maintenance window scheduled.${r.data.window.surface ? ` ${r.data.window.surface.detail}` : ""}` });
    load();
  };
  const doCancel = async (w: Window) => {
    setCancel(null);
    const r = await adminFetch(`/api/admin/ops/maintenance/${encodeURIComponent(w.id)}`, { method: "DELETE" });
    if (!r.ok) setMsg({ kind: "err", text: r.data.message ?? "Could not cancel." });
    load();
  };

  if (!data) return <Loading />;
  const label = (id: string) => data.services.find((s) => s.id === id)?.label ?? id;
  const incidents = onlyOpen ? data.incidents.filter((i) => i.status !== "resolved") : data.incidents;

  return (
    <div>
      <PageHeader title="Incidents & maintenance" sub="Shown to users through the site-wide notice and maintenance mode in Settings. Ops only clears what it put there itself." />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}

      {write && (
        <Panel className="mb-4">
          <h2 className="font-medium text-white">Open an incident</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-zinc-300">
              Title
              <input className={`${field} mt-1`} value={inc.title} maxLength={120} onChange={(e) => setInc({ ...inc, title: e.target.value })} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm text-zinc-300">
                Impact
                <select className={`${field} mt-1`} value={inc.impact} onChange={(e) => setInc({ ...inc, impact: e.target.value })}>
                  <option value="minor">Minor</option>
                  <option value="major">Major</option>
                  <option value="critical">Critical</option>
                </select>
              </label>
              <label className="text-sm text-zinc-300">
                Status
                <select className={`${field} mt-1`} value={inc.status} onChange={(e) => setInc({ ...inc, status: e.target.value })}>
                  {STATUSES.slice(0, 3).map((s) => (
                    <option key={s} value={s}>
                      {s}
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
                {data.services.map((s) => (
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
              <button type="button" className={btn.primary} disabled={!inc.title.trim() || !inc.message.trim()} onClick={open}>
                Open incident
              </button>
            </div>
          </div>
        </Panel>
      )}

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-cyan-50">Incidents</h2>
        <label className="ml-auto flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Open only
        </label>
      </div>
      {incidents.length === 0 ? (
        <Empty>{onlyOpen ? "No open incidents." : "No incidents."}</Empty>
      ) : (
        <div className="grid gap-3">
          {incidents.map((i) => (
            <Panel key={i.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-white">
                    <StatusBadge status={i.status} /> {i.title} <span className="text-xs text-zinc-500">({i.impact})</span>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Opened {fmtTime(i.createdAt)}
                    {i.resolvedAt ? ` · resolved ${fmtTime(i.resolvedAt)}` : ""}
                    {i.services.length ? ` · ${i.services.map(label).join(", ")}` : ""}
                  </p>
                  {i.showBanner && i.banner && <p className={`mt-1 text-xs ${i.banner.ok ? "text-emerald-300" : "text-amber-300"}`}>Site notice: {i.banner.detail}</p>}
                </div>
              </div>
              <ol className="mt-3 space-y-1 border-l border-white/10 pl-3 text-sm">
                {[...i.updates].reverse().map((u, n) => (
                  <li key={n}>
                    <span className="text-xs text-zinc-500">{fmtTime(u.at)} · {u.status} · {u.by}</span>
                    <p className="text-zinc-300">{u.message}</p>
                  </li>
                ))}
              </ol>
              {write && i.status !== "resolved" && (
                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <select
                    aria-label="New status"
                    className={`${field} w-40`}
                    value={upd[i.id]?.status ?? i.status}
                    onChange={(e) => setUpd({ ...upd, [i.id]: { status: e.target.value, message: upd[i.id]?.message ?? "" } })}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Update"
                    placeholder="Update for the timeline"
                    className={`${field} min-w-[12rem] flex-1`}
                    value={upd[i.id]?.message ?? ""}
                    onChange={(e) => setUpd({ ...upd, [i.id]: { status: upd[i.id]?.status ?? i.status, message: e.target.value } })}
                  />
                  <button type="button" className={btn.ghost} onClick={() => post(i)}>
                    Post update
                  </button>
                </div>
              )}
            </Panel>
          ))}
        </div>
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
              Starts (your time)
              <input type="datetime-local" className={`${field} mt-1`} value={mw.startsAt} onChange={(e) => setMw({ ...mw, startsAt: e.target.value })} />
            </label>
            <label className="text-sm text-zinc-300">
              Ends (your time)
              <input type="datetime-local" className={`${field} mt-1`} value={mw.endsAt} onChange={(e) => setMw({ ...mw, endsAt: e.target.value })} />
            </label>
            <label className="text-sm text-zinc-300">
              Announce in the site notice (minutes before)
              <input type="number" min={0} className={`${field} mt-1`} value={mw.announceMinutes} onChange={(e) => setMw({ ...mw, announceMinutes: Number(e.target.value) })} />
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300" title={canMode ? undefined : "Needs features:write"}>
              <input type="checkbox" disabled={!canMode} checked={mw.maintenanceMode} onChange={(e) => setMw({ ...mw, maintenanceMode: e.target.checked })} />
              Turn on maintenance mode for the window {canMode ? "(asks for a fresh code)" : "(needs features:write)"}
            </label>
          </div>
          <div className="mt-3 text-right">
            <button type="button" className={btn.primary} disabled={!mw.title.trim() || !mw.message.trim()} onClick={schedule}>
              Schedule
            </button>
          </div>
        </Panel>
      )}
      {data.maintenance.length === 0 ? (
        <Empty>No maintenance windows.</Empty>
      ) : (
        <div className="grid gap-2">
          {data.maintenance.map((w) => (
            <Panel key={w.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-white">
                    <StatusBadge status={w.state} /> {w.title}
                  </p>
                  <p className="mt-0.5 text-sm text-zinc-400">{w.message}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {fmtTime(w.startsAt)} → {fmtTime(w.endsAt)} · {w.maintenanceMode ? "maintenance mode" : "notice only"} · by {w.createdBy}
                  </p>
                  {w.surface && <p className={`mt-1 text-xs ${w.surface.ok ? "text-emerald-300" : "text-amber-300"}`}>{w.surface.detail}</p>}
                </div>
                {write && (w.state === "scheduled" || w.state === "active") && (
                  <button type="button" className={btn.warn} onClick={() => setCancel(w)}>
                    Cancel window
                  </button>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
      {cancel && (
        <Confirm
          title="Cancel this maintenance window?"
          body={cancel.state === "active" ? "Its notice comes down now and, if it turned maintenance mode on, maintenance mode goes off." : "It will not start."}
          confirmLabel="Cancel window"
          danger
          onConfirm={() => doCancel(cancel)}
          onCancel={() => setCancel(null)}
        />
      )}
    </div>
  );
}
