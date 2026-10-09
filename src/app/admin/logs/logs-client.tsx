"use client";

// src/app/admin/logs/logs-client.tsx — one search over the activity log, the
// admin audit and the meeting permission log, filtered by user, event type,
// date range and severity, a page at a time.

import { useCallback, useEffect, useState } from "react";
import type { LogRow } from "@/lib/admin/logs";
import { ACTIVITY_TYPES } from "@/lib/activityTypes";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";
import { PeriodBar, usePeriod } from "../analytics/period";

type Result = { items: LogRow[]; total: number; truncated: boolean; sources: string[]; adminAuditHidden: boolean };

const PAGE = 50;
const SOURCE_LABEL: Record<string, string> = { activity: "Activity", admin: "Admin audit", meeting: "Meeting permissions" };
const SEVERITY_TONE = { info: "zinc", warn: "amber", error: "red" } as const;

export default function LogsClient() {
  const { adminFetch, can } = useAdmin();
  const p = usePeriod(7);
  const get = (k: string) => p.params.get(k) ?? "";
  const [draft, setDraft] = useState({ user: get("user"), type: get("type"), q: get("q") });
  // The URL is the filter: when it changes elsewhere (a user clicked in the
  // table, a link from Analytics), the boxes follow, so Search keeps it.
  const urlUser = get("user");
  const urlType = get("type");
  const urlQ = get("q");
  useEffect(() => setDraft({ user: urlUser, type: urlType, q: urlQ }), [urlUser, urlType, urlQ]);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const offset = Number(get("offset")) || 0;

  const filterQuery = ["source", "user", "type", "severity", "q"]
    .map((k) => (get(k) ? `&${k}=${encodeURIComponent(get(k))}` : ""))
    .join("");

  const load = useCallback(async () => {
    setError(null);
    setData(null);
    const r = await adminFetch<Result>(`/api/admin/logs?${p.query}${filterQuery}&limit=${PAGE}&offset=${offset}`);
    if (r.ok) setData(r.data);
    else setError(r.data.message ?? "Could not search the logs.");
  }, [adminFetch, p.query, filterQuery, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const apply = () => p.setParams({ user: draft.user.trim(), type: draft.type.trim(), q: draft.q.trim(), offset: null });
  const exportUrl = (format: "csv" | "xlsx") => `/api/admin/logs?${p.query}${filterQuery}&format=${format}`;

  return (
    <div>
      <PageHeader
        title="Logs"
        sub={
          <>
            What people did (activity), what administrators did (admin audit) and every meeting permission decision, in one search. Server runtime logs are kept by Vercel, not in the app: open them in the{" "}
            <a className="text-cyan-300 hover:underline" href="https://vercel.com/dashboard" target="_blank" rel="noreferrer">
              Vercel dashboard
            </a>{" "}
            (project → Logs). Bringing them here needs a Vercel log drain or an API token.
          </>
        }
        actions={
          can("reports:export") ? (
            <>
              <a href={exportUrl("csv")} className={btn.ghost} download>
                CSV
              </a>
              <a href={exportUrl("xlsx")} className={btn.ghost} download>
                Excel
              </a>
            </>
          ) : null
        }
      />
      <PeriodBar p={p} compareNote={false} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6"
      >
        <label className="text-xs text-zinc-400">
          Log
          <select value={get("source") || "all"} onChange={(e) => p.setParams({ source: e.target.value === "all" ? null : e.target.value, offset: null })} className={`${field} mt-0.5`}>
            <option value="all">All logs</option>
            <option value="activity">Activity</option>
            {can("audit:read") && <option value="admin">Admin audit</option>}
            <option value="meeting">Meeting permissions</option>
          </select>
        </label>
        <label className="text-xs text-zinc-400">
          User (person, account charged, or admin email)
          <input value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} className={`${field} mt-0.5`} placeholder="user_…" />
        </label>
        <label className="text-xs text-zinc-400">
          Event type (starts with)
          <input list="event-types" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} className={`${field} mt-0.5`} placeholder="meeting." />
          <datalist id="event-types">
            {Object.entries(ACTIVITY_TYPES).map(([k, d]) => (
              <option key={k} value={k}>
                {d.label}
              </option>
            ))}
          </datalist>
        </label>
        <label className="text-xs text-zinc-400">
          Severity
          <select value={get("severity")} onChange={(e) => p.setParams({ severity: e.target.value || null, offset: null })} className={`${field} mt-0.5`}>
            <option value="">Any</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label className="text-xs text-zinc-400">
          Text
          <input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} className={`${field} mt-0.5`} placeholder="any word" />
        </label>
        <div className="flex items-end">
          <button type="submit" className={`${btn.primary} w-full`}>
            Search
          </button>
        </div>
      </form>
      {error && <Notice kind="err">{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <Panel>
          <p className="mb-2 text-xs text-zinc-500">
            {data.total.toLocaleString()} {data.total === 1 ? "entry" : "entries"}
            {data.truncated && " (at least — the search stopped early; narrow the dates)"} · times in your browser’s zone ·{" "}
            {data.sources.map((s) => SOURCE_LABEL[s]).join(", ")}
            {data.adminAuditHidden && " · the admin audit needs audit:read"}. Developer API calls are counted, not logged one by one.
          </p>
          {data.items.length === 0 ? (
            <Empty>Nothing matches. Activity is logged from the day the log began; raw entries are kept for 90 days unless configured otherwise.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-400">
                  <tr>
                    <th className="py-1.5 pr-3">Time</th>
                    <th className="pr-3">Log</th>
                    <th className="pr-3">Event</th>
                    <th className="pr-3">User</th>
                    <th className="pr-3">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id} className="border-t border-white/5 align-top" data-log-row={r.source}>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-zinc-400">{fmtTime(r.ts)}</td>
                      <td className="pr-3 text-zinc-400">{SOURCE_LABEL[r.source]}</td>
                      <td className="pr-3">
                        <span className="flex items-center gap-1.5">
                          {r.severity !== "info" && <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>}
                          <span className="font-mono text-xs text-zinc-200">{r.type}</span>
                        </span>
                      </td>
                      <td className="pr-3">
                        {r.user ? (
                          <button type="button" className="font-mono text-xs text-cyan-300 hover:underline" onClick={() => p.setParams({ user: r.user, offset: null })} title="Show only this user">
                            {r.user}
                          </button>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="pr-3 text-xs text-zinc-300">
                        <button type="button" className="text-left hover:text-white" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                          {r.summary || "details"}
                        </button>
                        {open === r.id && <pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-[11px] text-zinc-300">{JSON.stringify(r.details, null, 2)}</pre>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between text-sm">
            <button type="button" className={btn.ghost} disabled={offset === 0} onClick={() => p.setParams({ offset: String(Math.max(0, offset - PAGE)) || null })}>
              ← Newer
            </button>
            <span className="text-xs text-zinc-500">
              {data.total ? `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total.toLocaleString()}` : ""}
            </span>
            <button type="button" className={btn.ghost} disabled={offset + PAGE >= data.total} onClick={() => p.setParams({ offset: String(offset + PAGE) })}>
              Older →
            </button>
          </div>
        </Panel>
      )}
    </div>
  );
}
