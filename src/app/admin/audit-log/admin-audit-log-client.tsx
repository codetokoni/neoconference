"use client";

// Reader UI for the authz decision log written by src/lib/auditLog.ts.
// Newest first, capped at MAX_ENTRIES on the server; this page requests
// a chunk, renders it as a table, and filters client-side because the
// data set is small (5 000 entries max on the server side).

import { useEffect, useMemo, useState } from "react";

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

function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export default function AdminAuditLogClient() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [filter, setFilter] = useState<string>("");
  const [deniedOnly, setDeniedOnly] = useState(false);

  const load = async (n: number) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/audit-log?limit=${n}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error((j as { error?: string })?.error || "load_failed");
      setEntries(Array.isArray(j.entries) ? (j.entries as AuditLogEntry[]) : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load_failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(DEFAULT_LIMIT);
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => {
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

  return (
    <main className="max-w-7xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Authorization audit log</h1>
          <p className="text-xs text-zinc-500 mt-1">
            Every allow / deny decision from the authz gate. Newest first. Bounded at 5 000 entries on the server.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-400 flex items-center gap-1">
            Limit
            <select
              value={limit}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10) || DEFAULT_LIMIT;
                setLimit(n);
                load(n);
              }}
              className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100"
            >
              {LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => load(limit)}
            disabled={loading}
            className="px-3 py-1 rounded border border-cyan-400/40 text-cyan-100 text-xs hover:bg-cyan-400/10 transition disabled:opacity-60"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search permission, user, role, event, reason…"
          className="flex-1 min-w-[240px] bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-100 focus:border-cyan-400/60 focus:outline-none"
        />
        <label className="text-xs text-zinc-400 flex items-center gap-2">
          <input
            type="checkbox"
            checked={deniedOnly}
            onChange={(e) => setDeniedOnly(e.target.checked)}
            className="accent-rose-400"
          />
          Denied only
        </label>
        <div className="text-xs text-zinc-500">
          {filtered.length} shown / {entries.length} loaded
        </div>
      </div>

      {err && (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 text-rose-200 px-3 py-2 text-xs">
          {err}
        </div>
      )}

      <div className="overflow-auto border border-zinc-800 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-zinc-950/60 text-zinc-400">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Time (UTC)</th>
              <th className="text-left px-3 py-2 font-medium">Verdict</th>
              <th className="text-left px-3 py-2 font-medium">Permission</th>
              <th className="text-left px-3 py-2 font-medium">User</th>
              <th className="text-left px-3 py-2 font-medium">Role</th>
              <th className="text-left px-3 py-2 font-medium">Event</th>
              <th className="text-left px-3 py-2 font-medium">Via</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e, i) => (
              <tr key={`${e.ts}-${i}`} className="border-t border-zinc-800/60">
                <td className="px-3 py-2 whitespace-nowrap text-zinc-400 font-mono">
                  {formatTs(e.ts)}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span
                    className={
                      "inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide " +
                      (e.allowed
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-400/30"
                        : "bg-rose-500/15 text-rose-300 border border-rose-400/30")
                    }
                  >
                    {e.allowed ? "allow" : "deny"}
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-cyan-200 font-mono">
                  {e.permission}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-zinc-200 font-mono">
                  {e.userId || <span className="text-zinc-600">anonymous</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-zinc-300">
                  {e.role}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-zinc-400 font-mono">
                  {e.eventId || <span className="text-zinc-600">—</span>}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-zinc-500">{e.reason}</td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-zinc-500 text-xs">
                  {entries.length === 0 ? "No entries yet." : "No entries match the current filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
