"use client";

// Audit log: what administrators did (who, when, from where, what changed,
// before and after), searchable and exportable — and, on a second tab, the
// per-meeting permission decisions that were here before.

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { errorText, fmtNumber, fmtTime, useAdmin } from "../AdminApi";
import { Badge, FilterBar, Labeled, LoadState, Notice, PageHeader, Pager, Panel, TabPanel, Tabs, btn, field, useUrlFilters } from "../ui";
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
// The server's CSV export holds at most this many entries (newest first).
const CSV_MAX = 1000;

const TABS = [
  { id: "admin", label: "Administrator actions" },
  { id: "access", label: "Meeting permission decisions" },
] as const;

// Filters other pages link to: ?actor=, ?action=, ?target=, ?q= (and ?open=<seq> to open one entry).
const FILTERS = { actor: "", action: "", target: "", q: "", outcome: "", from: "", to: "" };

export default function AuditClient() {
  const [tab, setTab] = useState<"admin" | "access">("admin");
  return (
    <div>
      <PageHeader title="Audit log" sub="Append-only. No one can edit or delete an entry from the app; each has a number, so a gap shows if one was removed elsewhere." />
      <Tabs label="Audit log" idBase="audit" tabs={TABS} value={tab} onChange={setTab} />
      <TabPanel idBase="audit" value={tab}>
        {tab === "admin" ? <AdminActions /> : <AdminAuditLogClient />}
      </TabPanel>
    </div>
  );
}

function AdminActions() {
  const { can, adminFetch, adminDownload } = useAdmin();
  const sp = useSearchParams();
  const f = useUrlFilters(FILTERS);
  const applied = f.value;
  const appliedKey = JSON.stringify(applied);
  // What is typed is applied (and written to the address bar) with Apply; a
  // new link from elsewhere replaces what is typed.
  const [draft, setDraft] = useState(applied);
  useEffect(() => {
    setDraft(JSON.parse(appliedKey));
  }, [appliedKey]);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [appliedKey]);
  const [data, setData] = useState<{ items: Entry[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const openParam = Number(sp?.get("open")) || null;
  const [open, setOpen] = useState<number | null>(openParam);
  useEffect(() => {
    if (openParam) setOpen(openParam);
  }, [openParam]);
  const [integrity, setIntegrity] = useState<{ intact: boolean; expected: number; missing: number[] } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);

  const query = useCallback(
    (extra: Record<string, string>) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...(JSON.parse(appliedKey) as typeof FILTERS), ...extra })) if (v) p.set(k, v);
      return p.toString();
    },
    [appliedKey],
  );

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    adminFetch<{ items: Entry[]; total: number }>(`/api/admin/audit?${query({ limit: String(PAGE), offset: String(offset) })}`).then((r) => {
      if (!live) return;
      if (r.ok) setData(r.data);
      else setError(`Could not load the audit log: ${errorText(r)}`);
    });
    return () => {
      live = false;
    };
  }, [adminFetch, query, offset, reload]);

  useEffect(() => {
    adminFetch<{ intact: boolean; expected: number; missing: number[] }>("/api/admin/audit/integrity").then((r) => r.ok && setIntegrity(r.data));
  }, [adminFetch]);

  const set = (k: keyof typeof FILTERS) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });

  const exportCsv = async () => {
    setExporting(true);
    setExportErr(null);
    const r = await adminDownload(`/api/admin/audit?${query({ format: "csv" })}`);
    setExporting(false);
    if (!r.ok) setExportErr(`Could not export: ${errorText(r)}`);
  };

  return (
    <div>
      {integrity && (
        <p className="mb-3 text-xs">
          {integrity.intact ? (
            <Badge tone="green">All {fmtNumber(integrity.expected)} entries present</Badge>
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
            // Apply with nothing changed reads the log again.
            if (JSON.stringify(draft) === appliedKey) setReload((n) => n + 1);
            else f.set(draft);
          }}
        >
          <FilterBar active={f.active} onClear={f.reset}>
            <Labeled label="Administrator" className="w-full sm:w-48">
              <input placeholder="Email" value={draft.actor} onChange={set("actor")} className={field} />
            </Labeled>
            <Labeled label="Action" className="w-full sm:w-auto">
              <select value={draft.action} onChange={set("action")} className={field}>
                {ACTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
                {/* An action linked from elsewhere that is not one of the groups above. */}
                {draft.action && !ACTIONS.some(([v]) => v === draft.action) && <option value={draft.action}>{draft.action}</option>}
              </select>
            </Labeled>
            <Labeled label="Target" className="w-full sm:w-48">
              <input placeholder="Email, id or name" value={draft.target} onChange={set("target")} className={field} />
            </Labeled>
            <Labeled label="Any text" className="w-full sm:w-48">
              <input type="search" value={draft.q} onChange={set("q")} className={field} />
            </Labeled>
            <Labeled label="Outcome" className="w-full sm:w-auto">
              <select value={draft.outcome} onChange={set("outcome")} className={field}>
                <option value="">Any outcome</option>
                <option value="ok">Done</option>
                <option value="denied">Denied</option>
                <option value="failed">Failed</option>
              </select>
            </Labeled>
            <Labeled label="From (UTC day)" className="w-full sm:w-auto">
              <input type="date" value={draft.from} max={draft.to || undefined} onChange={set("from")} className={field} />
            </Labeled>
            <Labeled label="To (UTC day)" className="w-full sm:w-auto">
              <input type="date" value={draft.to} min={draft.from || undefined} onChange={set("to")} className={field} />
            </Labeled>
            <button type="submit" className={btn.primary}>
              Apply
            </button>
            {can("reports:export") && (
              <button type="button" className={btn.ghost} onClick={exportCsv} disabled={exporting} aria-busy={exporting}>
                {exporting ? "Exporting…" : "Export CSV"}
              </button>
            )}
          </FilterBar>
        </form>
        <p className="text-xs text-zinc-400">
          The dates are whole days in UTC.
          {can("reports:export") && ` The CSV holds the newest ${fmtNumber(CSV_MAX)} entries that match the applied filters, with times in UTC.`}
        </p>
      </Panel>

      {exportErr && (
        <Notice kind="err" onClose={() => setExportErr(null)}>
          {exportErr}
        </Notice>
      )}

      <LoadState data={data} error={error} onRetry={() => setReload((n) => n + 1)} isEmpty={(d) => d.items.length === 0} empty={f.active ? "No administrator actions match." : "No administrator actions yet."}>
        {(d) => (
          <Panel>
            <ul className="divide-y divide-white/5">
              {d.items.map((e) => (
                <li key={e.seq} className="py-2">
                  <button
                    type="button"
                    onClick={() => setOpen(open === e.seq ? null : e.seq)}
                    aria-expanded={open === e.seq}
                    aria-controls={`audit-entry-${e.seq}`}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                  >
                    <span className="w-12 font-mono text-[11px] text-zinc-400">#{e.seq}</span>
                    <span className="text-xs text-zinc-400 sm:w-56">{fmtTime(e.ts)}</span>
                    <code className="break-all text-xs text-cyan-200">{e.action}</code>
                    {e.outcome !== "ok" && <Badge tone={e.outcome === "denied" ? "amber" : "red"}>{e.outcome}</Badge>}
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                      {e.targetLabel ?? e.targetId ?? ""} <span className="text-zinc-400">by {e.actorEmail}</span>
                    </span>
                  </button>
                  {open === e.seq && (
                    <div id={`audit-entry-${e.seq}`} className="mt-2 grid gap-2 rounded-lg bg-black/30 p-3 text-xs sm:grid-cols-2">
                      <Detail label="Before" value={e.before} />
                      <Detail label="After" value={e.after} />
                      {e.note && <p className="text-zinc-300 sm:col-span-2">Note: {e.note}</p>}
                      <p className="break-all text-zinc-400 sm:col-span-2">
                        Actor id {e.actorId} · target {e.targetType ?? "—"} {e.targetId ?? ""} · from {e.ip ?? "unknown address"}
                        {e.userAgent ? ` · ${e.userAgent}` : ""}
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <Pager page={Math.floor(offset / PAGE) + 1} pageSize={PAGE} total={d.total} noun="action" onPage={(p) => setOffset((p - 1) * PAGE)} />
          </Panel>
        )}
      </LoadState>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">{label}</p>
      <pre className="mt-1 whitespace-pre-wrap break-all text-zinc-200">{value === undefined || value === null ? "—" : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
