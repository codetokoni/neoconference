"use client";

// src/app/admin/support/desk-client.tsx — the ticket desk: the summary,
// filters, search, sorting, pages, and bulk changes (confirmed first).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  categoryLabel,
  fmtDuration,
  type SupportSummary,
} from "@/lib/support/model";
import { fmtTime, useAdmin } from "../AdminApi";
import { Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";
import { PriorityBadge, SlaBadge, StatusBadge, assigneeLabel, type Assignee, type Row } from "./shared";

type Page = { items: Row[]; total: number; page: number; pages: number; summary: SupportSummary; assignees: Assignee[]; now: number };
type Filters = { q: string; status: string; priority: string; category: string; assignee: string; overdue: boolean; sort: string; dir: "asc" | "desc" };

const START: Filters = { q: "", status: "unresolved", priority: "", category: "", assignee: "", overdue: false, sort: "updated", dir: "desc" };

export default function DeskClient() {
  const { can, adminFetch } = useAdmin();
  const [filters, setFilters] = useState<Filters>(START);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ field: "assigneeId" | "status" | "priority"; value: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const write = can("support:write");

  const load = useCallback(async () => {
    setError(null);
    const u = new URLSearchParams({ page: String(page), limit: "25", sort: filters.sort, dir: filters.dir });
    for (const k of ["q", "status", "priority", "category", "assignee"] as const) if (filters[k]) u.set(k, filters[k]);
    if (filters.overdue) u.set("overdue", "1");
    const r = await adminFetch<Page>(`/api/admin/support/tickets?${u}`);
    if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch, filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
    setSelected(new Set());
  };

  const applyBulk = async () => {
    if (!bulk) return;
    const value = bulk.field === "assigneeId" && bulk.value === "none" ? null : bulk.value;
    const r = await adminFetch<{ changed: number }>("/api/admin/support/tickets/bulk", {
      method: "POST",
      json: { ids: [...selected], set: { [bulk.field]: value } },
    });
    setBulk(null);
    if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
    setOk(`Changed ${r.data.changed} ticket${r.data.changed === 1 ? "" : "s"}.`);
    setSelected(new Set());
    load();
  };

  const s = data?.summary;
  const assignees = data?.assignees ?? [];
  const items = data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((t) => selected.has(t.id));
  const bulkLabel = bulk
    ? bulk.field === "assigneeId"
      ? `assign them to ${bulk.value === "none" ? "nobody (unassigned)" : assigneeLabel(bulk.value, assignees)}`
      : bulk.field === "status"
        ? `set their status to ${STATUS_LABEL[bulk.value as keyof typeof STATUS_LABEL]}`
        : `set their priority to ${PRIORITY_LABEL[bulk.value as keyof typeof PRIORITY_LABEL]}`
    : "";

  return (
    <div>
      <PageHeader
        title="Support tickets"
        sub="Requests from the contact form, and chats copied in by the team. Replies are emailed to the customer; internal notes are not."
        actions={
          <>
            <Link href="/admin/support/settings" className={btn.ghost}>
              Response targets
            </Link>
            {write && (
              <button type="button" onClick={() => setCreating(true)} className={btn.primary}>
                New ticket
              </button>
            )}
          </>
        }
      />
      {error && <Notice kind="err" onClose={() => setError(null)}>{error}</Notice>}
      {ok && <Notice kind="ok" onClose={() => setOk(null)}>{ok}</Notice>}

      {s && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="Open" value={s.open} onClick={() => set({ ...START })} />
          <Stat label="Overdue" value={s.overdue} tone={s.overdue ? "red" : undefined} onClick={() => set({ ...START, overdue: true })} />
          <Stat label="Unassigned" value={s.unassigned} onClick={() => set({ ...START, assignee: "none" })} />
          <Stat label="Urgent · High" value={`${s.openByPriority.urgent} · ${s.openByPriority.high}`} onClick={() => set({ ...START, sort: "priority" })} />
          <Stat label="Normal · Low" value={`${s.openByPriority.normal} · ${s.openByPriority.low}`} />
          <Stat
            label="Median first reply"
            value={fmtDuration(s.medianFirstResponseThisWeek)}
            hint={`last 7 days (${s.answeredThisWeek}) · ${fmtDuration(s.medianFirstResponseLastWeek)} the 7 before (${s.answeredLastWeek})`}
          />
        </div>
      )}

      <Panel className="mb-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: search.trim() });
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="min-w-[14rem] flex-1 text-xs text-zinc-400">
            Search
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="#1042, subject, email, tag" className={`${field} mt-1`} />
          </label>
          <Select label="Status" value={filters.status} onChange={(v) => set({ status: v })} options={[["", "Any"], ["unresolved", "Unresolved"], ...TICKET_STATUSES.map((x) => [x, STATUS_LABEL[x]] as [string, string])]} />
          <Select label="Priority" value={filters.priority} onChange={(v) => set({ priority: v })} options={[["", "Any"], ...TICKET_PRIORITIES.map((x) => [x, PRIORITY_LABEL[x]] as [string, string])]} />
          <Select label="Category" value={filters.category} onChange={(v) => set({ category: v })} options={[["", "Any"], ...TICKET_CATEGORIES.map((c) => [c.key, c.label] as [string, string])]} />
          <Select
            label="Assignee"
            value={filters.assignee}
            onChange={(v) => set({ assignee: v })}
            options={[["", "Anyone"], ["me", "Me"], ["none", "Unassigned"], ...assignees.map((a) => [a.userId, a.name || a.email] as [string, string])]}
          />
          <Select
            label="Sort"
            value={filters.sort}
            onChange={(v) => set({ sort: v, dir: v === "due" ? "asc" : "desc" })}
            options={[["updated", "Last activity"], ["created", "Opened"], ["priority", "Priority"], ["due", "Next deadline"], ["number", "Number"]]}
          />
          <button type="button" className={btn.ghost} onClick={() => set({ dir: filters.dir === "asc" ? "desc" : "asc" })} aria-label="Reverse the order">
            {filters.dir === "asc" ? "↑ Ascending" : "↓ Descending"}
          </button>
          <label className="flex items-center gap-1.5 pb-2 text-sm text-zinc-300">
            <input type="checkbox" checked={filters.overdue} onChange={(e) => set({ overdue: e.target.checked })} /> Overdue only
          </label>
          <button type="submit" className={btn.primary}>
            Search
          </button>
        </form>
      </Panel>

      {write && selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-2 text-sm text-cyan-100">
          <span>{selected.size} selected</span>
          <BulkSelect label="Assign to" onPick={(v) => setBulk({ field: "assigneeId", value: v })} options={[["none", "Unassigned"], ...assignees.map((a) => [a.userId, a.name || a.email] as [string, string])]} />
          <BulkSelect label="Status" onPick={(v) => setBulk({ field: "status", value: v })} options={TICKET_STATUSES.map((x) => [x, STATUS_LABEL[x]] as [string, string])} />
          <BulkSelect label="Priority" onPick={(v) => setBulk({ field: "priority", value: v })} options={TICKET_PRIORITIES.map((x) => [x, PRIORITY_LABEL[x]] as [string, string])} />
          <button type="button" className={`${btn.ghost} ml-auto`} onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {!data ? (
        error ? null : <Loading />
      ) : items.length === 0 ? (
        <Empty>No tickets match.</Empty>
      ) : (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-b border-white/10 text-left text-xs text-zinc-500">
              <tr>
                {write && (
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select every ticket on this page"
                      checked={allOnPage}
                      onChange={(e) => setSelected(new Set(e.target.checked ? items.map((t) => t.id) : []))}
                    />
                  </th>
                )}
                <th className="px-3 py-2">Ticket</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Assignee</th>
                <th className="px-3 py-2">Response target</th>
                <th className="px-3 py-2">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {items.map((t) => (
                <tr key={t.id} className={t.sla.overdue ? "bg-red-500/[0.04]" : undefined}>
                  {write && (
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`Select #${t.number}`}
                        checked={selected.has(t.id)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const n = new Set(prev);
                            if (e.target.checked) n.add(t.id);
                            else n.delete(t.id);
                            return n;
                          })
                        }
                      />
                    </td>
                  )}
                  <td className="max-w-[24rem] px-3 py-2.5">
                    <Link href={`/admin/support/${t.id}`} className="block truncate font-medium text-zinc-100 hover:text-cyan-200">
                      <span className="font-mono text-xs text-zinc-500">#{t.number}</span> {t.subject}
                    </Link>
                    <span className="block truncate text-xs text-zinc-500">
                      {t.email} · {categoryLabel(t.category)}
                      {t.userId ? "" : " · not signed in"}
                      {t.tags.length ? ` · ${t.tags.join(", ")}` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <PriorityBadge priority={t.priority} />
                  </td>
                  <td className="px-3 py-2.5 text-zinc-300">{assigneeLabel(t.assigneeId, assignees, t.assigneeEmail)}</td>
                  <td className="px-3 py-2.5">
                    <SlaBadge sla={t.sla} now={data.now} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-zinc-400">{fmtTime(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {data && data.pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm text-zinc-400">
          <span>
            {data.total} tickets · page {data.page} of {data.pages}
          </span>
          <div className="flex gap-2">
            <button type="button" className={btn.ghost} disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
              Previous
            </button>
            <button type="button" className={btn.ghost} disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>
              Next
            </button>
          </div>
        </div>
      )}

      {bulk && (
        <Confirm
          title={`Change ${selected.size} ticket${selected.size === 1 ? "" : "s"}?`}
          body={<>This will {bulkLabel}. Each change is recorded in the audit log.</>}
          confirmLabel="Apply"
          onConfirm={applyBulk}
          onCancel={() => setBulk(null)}
        />
      )}
      {creating && (
        <NewTicket
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            window.location.href = `/admin/support/${id}`;
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone, onClick }: { label: string; value: number | string; hint?: string; tone?: "red"; onClick?: () => void }) {
  const body = (
    <>
      <span className="block text-xs text-zinc-500">{label}</span>
      <span className={`mt-0.5 block text-xl font-semibold ${tone === "red" ? "text-red-300" : "text-zinc-100"}`}>{value}</span>
      {hint && <span className="mt-0.5 block text-[11px] leading-tight text-zinc-500">{hint}</span>}
    </>
  );
  const cls = "rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} hover:bg-white/[0.06]`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="text-xs text-zinc-400">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} mt-1 w-auto`}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function BulkSelect({ label, options, onPick }: { label: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <select
      aria-label={label}
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="rounded-lg border border-white/12 bg-black/40 px-2 py-1 text-sm text-zinc-100"
    >
      <option value="">{label}…</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { adminFetch } = useAdmin();
  const [f, setF] = useState({ email: "", name: "", subject: "", category: "other", priority: "normal", body: "", chatRef: "", notifyUser: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await adminFetch<{ ticket: { id: string } }>("/api/admin/support/tickets", { method: "POST", json: f });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
    onCreated(r.data.ticket.id);
  };
  const up = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="new-ticket-title" className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto bg-black/70 p-4">
      <form onSubmit={submit} className="w-full max-w-lg space-y-3 rounded-2xl border border-white/10 bg-[#0B1220] p-5 shadow-2xl">
        <h2 id="new-ticket-title" className="text-base font-semibold text-white">
          New ticket
        </h2>
        <p className="text-sm text-zinc-400">
          For a NeoSupport chat that needs following up, or a request that came in another way. Paste the chat and its conversation reference so the history stays together.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-zinc-400">
            Customer email
            <input required type="email" value={f.email} onChange={up("email")} className={`${field} mt-1`} />
          </label>
          <label className="text-xs text-zinc-400">
            Name
            <input value={f.name} onChange={up("name")} className={`${field} mt-1`} />
          </label>
        </div>
        <label className="block text-xs text-zinc-400">
          Subject
          <input required minLength={3} value={f.subject} onChange={up("subject")} className={`${field} mt-1`} />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-zinc-400">
            Category
            <select value={f.category} onChange={up("category")} className={`${field} mt-1`}>
              {TICKET_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-zinc-400">
            Priority
            <select value={f.priority} onChange={up("priority")} className={`${field} mt-1`}>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-zinc-400">
            Chat reference
            <input value={f.chatRef} onChange={up("chatRef")} placeholder="optional" className={`${field} mt-1`} />
          </label>
        </div>
        <label className="block text-xs text-zinc-400">
          The request, or the chat transcript
          <textarea required rows={6} value={f.body} onChange={up("body")} className={`${field} mt-1`} />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={f.notifyUser} onChange={up("notifyUser")} /> Email the customer that we opened a ticket
        </label>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btn.ghost}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={btn.primary}>
            {busy ? "Creating…" : "Create ticket"}
          </button>
        </div>
      </form>
    </div>
  );
}
