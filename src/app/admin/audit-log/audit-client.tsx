"use client";

// Audit log: what administrators did (who, when, from where, what changed,
// before and after), searchable and exportable — and, on a second tab, the
// per-meeting permission decisions that were here before.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";
import AdminAuditLogClient from "./admin-audit-log-client";

type Entry = {
  seq: number;
  ts: number;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  before?: unknown;
  after?: unknown;
  note?: string;
  ip?: string;
  userAgent?: string;
  outcome: "ok" | "denied" | "failed";
};

const ACTIONS = [
  ["", "All actions"],
  ["admin.", "Administrators"],
  ["role.", "Roles"],
  ["mfa.", "Two-factor"],
  ["user.", "Users"],
  ["event.", "Meetings"],
  ["ops.", "Operations"],
  ["comms.", "Announcements"],
  ["template.", "Email templates"],
] as const;

const PAGE = 50;

export default function AuditClient() {
  const [tab, setTab] = useState<"admin" | "access">("admin");
  return (
    <div>
      <PageHeader title="Audit log" sub="Append-only. No one can edit or delete an entry from the app; each has a number, so a gap shows if one was removed elsewhere." />
      <div role="tablist" aria-label="Audit log" className="mb-4 flex gap-1 border-b border-white/10">
        {(
          [
            ["admin", "Administrator actions"],
            ["access", "Meeting permission decisions"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? "border-cyan-400 text-cyan-200" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === "admin" ? <AdminActions /> : <AdminAuditLogClient />}
    </div>
  );
}

function AdminActions() {
  const { can, adminFetch } = useAdmin();
  const [filters, setFilters] = useState({ actor: "", action: "", target: "", q: "", outcome: "", from: "", to: "" });
  const [applied, setApplied] = useState(filters);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ items: Entry[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [integrity, setIntegrity] = useState<{ intact: boolean; expected: number; missing: number[] } | null>(null);

  const query = useCallback(
    (extra: Record<string, string>) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...applied, ...extra })) if (v) p.set(k, v);
      return p.toString();
    },
    [applied],
  );

  useEffect(() => {
    let live = true;
    setData(null);
    adminFetch<{ items: Entry[]; total: number }>(`/api/admin/audit?${query({ limit: String(PAGE), offset: String(offset) })}`).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setError(r.data.message ?? "Could not load the audit log.");
    });
    return () => {
      live = false;
    };
  }, [adminFetch, query, offset]);

  useEffect(() => {
    adminFetch<{ intact: boolean; expected: number; missing: number[] }>("/api/admin/audit/integrity").then((r) => r.ok && setIntegrity(r.data));
  }, [adminFetch]);

  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <div>
      {integrity && (
        <p className="mb-3 text-xs">
          {integrity.intact ? (
            <Badge tone="green">All {integrity.expected} entries present</Badge>
          ) : (
            <Badge tone="red">
              {integrity.missing.length} entr{integrity.missing.length === 1 ? "y is" : "ies are"} missing (#{integrity.missing.slice(0, 5).join(", #")}) — removed outside the app
            </Badge>
          )}
        </p>
      )}
      <Panel className="mb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied(filters);
          }}
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
        >
          <input aria-label="Administrator" placeholder="Administrator (email)" value={filters.actor} onChange={set("actor")} className={field} />
          <select aria-label="Action" value={filters.action} onChange={set("action")} className={field}>
            {ACTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input aria-label="Target" placeholder="Target (email, id, name)" value={filters.target} onChange={set("target")} className={field} />
          <input aria-label="Search" placeholder="Any text" value={filters.q} onChange={set("q")} className={field} />
          <select aria-label="Outcome" value={filters.outcome} onChange={set("outcome")} className={field}>
            <option value="">Any outcome</option>
            <option value="ok">Done</option>
            <option value="denied">Denied</option>
            <option value="failed">Failed</option>
          </select>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            From
            <input type="date" value={filters.from} onChange={set("from")} className={field} />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            To
            <input type="date" value={filters.to} onChange={set("to")} className={field} />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={btn.primary}>
              Apply
            </button>
            {can("reports:export") && (
              <a className={btn.ghost} href={`/api/admin/audit?${query({ format: "csv" })}`}>
                Export CSV
              </a>
            )}
          </div>
        </form>
        <p className="mt-2 text-xs text-zinc-500">Dates are whole days in UTC. Times below are in your local time zone.</p>
      </Panel>

      {error && <Notice kind="err">{error}</Notice>}
      {!data ? (
        !error && <Loading />
      ) : data.items.length === 0 ? (
        <Empty>No administrator actions match.</Empty>
      ) : (
        <Panel>
          <ul className="divide-y divide-white/5">
            {data.items.map((e) => (
              <li key={e.seq} className="py-2">
                <button type="button" onClick={() => setOpen(open === e.seq ? null : e.seq)} aria-expanded={open === e.seq} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left">
                  <span className="w-12 font-mono text-[11px] text-zinc-500">#{e.seq}</span>
                  <span className="w-48 text-xs text-zinc-400">{fmtTime(e.ts)}</span>
                  <code className="text-xs text-cyan-200">{e.action}</code>
                  {e.outcome !== "ok" && <Badge tone={e.outcome === "denied" ? "amber" : "red"}>{e.outcome}</Badge>}
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                    {e.targetLabel ?? e.targetId ?? ""} <span className="text-zinc-500">by {e.actorEmail}</span>
                  </span>
                </button>
                {open === e.seq && (
                  <div className="mt-2 grid gap-2 rounded-lg bg-black/30 p-3 text-xs sm:grid-cols-2">
                    <Detail label="Before" value={e.before} />
                    <Detail label="After" value={e.after} />
                    {e.note && <p className="text-zinc-300 sm:col-span-2">Note: {e.note}</p>}
                    <p className="text-zinc-500 sm:col-span-2">
                      Actor id {e.actorId} · target {e.targetType ?? "—"} {e.targetId ?? ""} · from {e.ip ?? "unknown address"}
                      {e.userAgent ? ` · ${e.userAgent}` : ""}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between text-xs text-zinc-400">
            <span>
              {offset + 1}–{offset + data.items.length} of {data.total}
            </span>
            <div className="flex gap-2">
              <button type="button" className={btn.ghost} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Newer
              </button>
              <button type="button" className={btn.ghost} disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                Older
              </button>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">{label}</p>
      <pre className="mt-1 whitespace-pre-wrap break-all text-zinc-200">{value === undefined || value === null ? "—" : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
