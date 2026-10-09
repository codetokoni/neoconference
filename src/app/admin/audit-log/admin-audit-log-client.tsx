"use client";

// Reader UI for the authz decision log written by src/lib/auditLog.ts.
// Newest first, capped at 5 000 entries on the server; this tab requests
// a chunk, and searches, sorts and pages it in the browser because the
// data set is small.

import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText, fmtNumber, fmtTime, useAdmin } from "../AdminApi";
import { FilterBar, Labeled, LoadState, Pager, SortTh, TableWrap, btn, field, useClientTable } from "../ui";

interface AuditLogEntry {
  ts: number;
  permission: string;
  allowed: boolean;
  userId: string | null;
  role: string;
  reason: string;
  eventId?: string;
}

const DEFAULT_LIMIT = 500;
const LIMIT_OPTIONS = [100, 500, 1000, 5000];

export default function AdminAuditLogClient() {
  const { adminFetch } = useAdmin();
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [filter, setFilter] = useState<string>("");
  const [deniedOnly, setDeniedOnly] = useState(false);

  const load = useCallback(
    async (n: number) => {
      setLoading(true);
      setErr(null);
      const r = await adminFetch<{ ok?: boolean; entries?: AuditLogEntry[] }>(`/api/admin/audit-log?limit=${n}`);
      setLoading(false);
      if (r.ok && r.data.ok) setEntries(Array.isArray(r.data.entries) ? r.data.entries : []);
      else setErr(`Could not load the permission decisions: ${errorText(r)}`);
    },
    [adminFetch],
  );

  useEffect(() => {
    load(DEFAULT_LIMIT);
  }, [load]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (entries ?? []).filter((e) => {
      if (deniedOnly && e.allowed) return false;
      if (!q) return true;
      return (
        e.permission.toLowerCase().includes(q) ||
        (e.userId || "").toLowerCase().includes(q) ||
        e.role.toLowerCase().includes(q) ||
        (e.eventId || "").toLowerCase().includes(q) ||
        e.reason.toLowerCase().includes(q)
      );
    });
  }, [entries, filter, deniedOnly]);

  const t = useClientTable(
    filtered,
    (e, k) => (k === "ts" ? e.ts : k === "allowed" ? (e.allowed ? 1 : 0) : k === "permission" ? e.permission : k === "role" ? e.role : k === "user" ? e.userId : (e.eventId ?? null)),
    { key: "ts", dir: "desc", pageSize: 50 },
  );
  const { setPage } = t;
  useEffect(() => setPage(1), [filter, deniedOnly, entries, setPage]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-zinc-100">Authorization decisions</h2>
          <p className="mt-1 text-xs text-zinc-400">Every allow / deny decision from the meeting permission gate. Newest first. The server keeps the latest 5 000.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Read the latest">
            <select
              value={limit}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10) || DEFAULT_LIMIT;
                setLimit(n);
                load(n);
              }}
              className={`${field} w-auto`}
            >
              {LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {fmtNumber(n)}
                </option>
              ))}
            </select>
          </Labeled>
          <button type="button" onClick={() => load(limit)} disabled={loading} aria-busy={loading} className={btn.ghost}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <FilterBar
        active={!!filter || deniedOnly}
        onClear={() => {
          setFilter("");
          setDeniedOnly(false);
        }}
      >
        <Labeled label="Search" className="min-w-[14rem] flex-1">
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Permission, user, role, event, reason…" className={field} />
        </Labeled>
        <label className="flex items-center gap-2 pb-2 text-xs text-zinc-400">
          <input type="checkbox" checked={deniedOnly} onChange={(e) => setDeniedOnly(e.target.checked)} className="accent-rose-400" />
          Denied only
        </label>
        {entries && (
          <span className="pb-2 text-xs text-zinc-400">
            {fmtNumber(filtered.length)} shown of {fmtNumber(entries.length)} read
          </span>
        )}
      </FilterBar>

      <LoadState
        data={entries}
        error={err}
        onRetry={() => load(limit)}
        isEmpty={() => filtered.length === 0}
        empty={entries && entries.length === 0 ? "No decisions recorded yet." : "No decisions match the search."}
      >
        {() => (
          <>
            <TableWrap minWidth={820}>
              <thead className="border-b border-white/10 text-xs text-zinc-400">
                <tr>
                  <SortTh label="Time" k="ts" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Verdict" k="allowed" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Permission" k="permission" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="User" k="user" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Role" k="role" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Event" k="event" sort={t.sort} onSort={t.onSort} />
                  <th className="px-3 py-2 font-medium">Via</th>
                </tr>
              </thead>
              <tbody className="text-xs">
                {t.visible.map((e, i) => (
                  <tr key={`${e.ts}-${i}`} className="border-t border-white/5">
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{fmtTime(e.ts)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span
                        className={
                          "inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide " +
                          (e.allowed ? "border border-emerald-400/30 bg-emerald-500/15 text-emerald-300" : "border border-rose-400/30 bg-rose-500/15 text-rose-300")
                        }
                      >
                        {e.allowed ? "allow" : "deny"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-cyan-200">{e.permission}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-zinc-200">{e.userId || <span className="text-zinc-400">anonymous</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-300">{e.role}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-zinc-400">{e.eventId || <span className="text-zinc-400">—</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pager page={t.page} pageSize={t.pageSize} total={t.total} noun="decision" onPage={t.setPage} onPageSize={t.setPageSize} sizes={[50, 100, 250]} />
          </>
        )}
      </LoadState>
    </div>
  );
}
