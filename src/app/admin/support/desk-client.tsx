"use client";

// src/app/admin/support/desk-client.tsx — the ticket desk: the summary,
// filters, search, sorting, pages, and bulk changes (confirmed first).
// Filters, sort and page live in the address bar, so a view can be linked
// (the global search links here with ?q=).

import Link from "next/link";
import { useRouter } from "next/navigation";
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
  type TicketPriority,
} from "@/lib/support/model";
import { Time, errorText, fmtNumber, useAdmin } from "../AdminApi";
import {
  Confirm,
  Dialog,
  FilterBar,
  Labeled,
  LoadState,
  Notice,
  PageHeader,
  Pager,
  SelectBox,
  SortTh,
  StatTile,
  TableWrap,
  btn,
  field,
  useSelection,
  useUrlFilters,
} from "../ui";
import { PriorityBadge, SlaBadge, StatusBadge, assigneeLabel, type Assignee, type Row } from "./shared";

type Page = { items: Row[]; total: number; page: number; pages: number; summary: SupportSummary; assignees: Assignee[]; now: number };

// "any" stands for no status filter: an empty value would read back as the default.
const URL_DEFAULTS = { q: "", status: "unresolved", priority: "", category: "", assignee: "", overdue: "", sort: "updated", dir: "desc", page: "1" };
type Filters = typeof URL_DEFAULTS;
const PAGE_SIZE = 25;
const FILTER_KEYS = ["q", "status", "priority", "category", "assignee", "overdue"] as const;

export default function DeskClient() {
  const { can, adminFetch } = useAdmin();
  const f = useUrlFilters(URL_DEFAULTS);
  const filters = f.value;
  const [search, setSearch] = useState(filters.q);
  const [data, setData] = useState<Page | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ field: "assigneeId" | "status" | "priority"; value: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const write = can("support:write");
  const page = Math.max(1, Number(filters.page) || 1);

  // The search box follows the address bar (a tile, Clear filters or a link resets it).
  useEffect(() => setSearch(filters.q), [filters.q]);

  const load = useCallback(async () => {
    setLoadErr(null);
    const u = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), sort: filters.sort, dir: filters.dir });
    for (const k of ["q", "priority", "category", "assignee"] as const) if (filters[k]) u.set(k, filters[k]);
    if (filters.status && filters.status !== "any") u.set("status", filters.status);
    if (filters.overdue === "1") u.set("overdue", "1");
    const r = await adminFetch<Page>(`/api/admin/support/tickets?${u}`);
    if (!r.ok) return setLoadErr(errorText(r));
    setData(r.data);
  }, [adminFetch, filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  const items = data?.items ?? [];
  const sel = useSelection(items.map((t) => t.id));

  const set = (patch: Partial<Filters>) => f.set({ ...patch, page: "1" });
  /** A summary tile: every filter back to its default, then this one. */
  const only = (patch: Partial<Filters>) => f.set({ ...URL_DEFAULTS, ...patch });
  const isOnly = (patch: Partial<Filters>) => FILTER_KEYS.every((k) => filters[k] === (patch[k] ?? URL_DEFAULTS[k]));

  const applyBulk = async () => {
    if (!bulk) return;
    setError(null);
    setOk(null);
    const value = bulk.field === "assigneeId" && bulk.value === "none" ? null : bulk.value;
    const r = await adminFetch<{ changed: number }>("/api/admin/support/tickets/bulk", {
      method: "POST",
      json: { ids: [...sel.selected], set: { [bulk.field]: value } },
    });
    setBulk(null);
    if (!r.ok) return setError(errorText(r));
    setOk(`Changed ${fmtNumber(r.data.changed)} ticket${r.data.changed === 1 ? "" : "s"}.`);
    sel.clear();
    load();
  };

  const s = data?.summary;
  const assignees = data?.assignees ?? [];
  const bulkLabel = bulk
    ? bulk.field === "assigneeId"
      ? `assign them to ${bulk.value === "none" ? "nobody (unassigned)" : assigneeLabel(bulk.value, assignees)}`
      : bulk.field === "status"
        ? `set their status to ${STATUS_LABEL[bulk.value as keyof typeof STATUS_LABEL]}`
        : `set their priority to ${PRIORITY_LABEL[bulk.value as keyof typeof PRIORITY_LABEL]}`
    : "";
  const sortState = { key: filters.sort, dir: filters.dir === "asc" ? ("asc" as const) : ("desc" as const) };
  const onSort = (k: string, dir: "asc" | "desc") => set({ sort: k, dir });

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
      {error && (
        <Notice kind="err" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {ok && (
        <Notice kind="ok" onClose={() => setOk(null)}>
          {ok}
        </Notice>
      )}

      {s && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <StatTile label="Open" value={fmtNumber(s.open)} hint="not resolved or closed" active={isOnly({})} onClick={() => only({})} />
          <StatTile label="Overdue" value={fmtNumber(s.overdue)} tone={s.overdue ? "red" : undefined} active={isOnly({ overdue: "1" })} onClick={() => only({ overdue: "1" })} />
          <StatTile label="Unassigned" value={fmtNumber(s.unassigned)} active={isOnly({ assignee: "none" })} onClick={() => only({ assignee: "none" })} />
          {(["urgent", "high", "normal", "low"] as TicketPriority[]).map((p) => (
            <StatTile
              key={p}
              label={`${PRIORITY_LABEL[p]} · open`}
              value={fmtNumber(s.openByPriority[p])}
              tone={p === "urgent" && s.openByPriority[p] ? "red" : p === "high" && s.openByPriority[p] ? "amber" : undefined}
              active={isOnly({ priority: p })}
              onClick={() => only({ priority: p })}
            />
          ))}
          <StatTile
            label="Median first reply"
            value={fmtDuration(s.medianFirstResponseThisWeek)}
            hint={`last 7 days (${fmtNumber(s.answeredThisWeek)} replies)`}
          />
          <StatTile label="The 7 days before" value={fmtDuration(s.medianFirstResponseLastWeek)} hint={`median first reply (${fmtNumber(s.answeredLastWeek)} replies)`} />
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          set({ q: search.trim() });
        }}
      >
        <FilterBar active={f.active} onClear={f.reset}>
          <Labeled label="Search" className="min-w-[12rem] flex-1">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="#1042, subject, email, tag" className={field} />
          </Labeled>
          <Select label="Status" value={filters.status} onChange={(v) => set({ status: v })} options={[["any", "Any"], ["unresolved", "Unresolved"], ...TICKET_STATUSES.map((x) => [x, STATUS_LABEL[x]] as [string, string])]} />
          <Select label="Priority" value={filters.priority} onChange={(v) => set({ priority: v })} options={[["", "Any"], ...TICKET_PRIORITIES.map((x) => [x, PRIORITY_LABEL[x]] as [string, string])]} />
          <Select label="Category" value={filters.category} onChange={(v) => set({ category: v })} options={[["", "Any"], ...TICKET_CATEGORIES.map((c) => [c.key, c.label] as [string, string])]} />
          <Select
            label="Assignee"
            value={filters.assignee}
            onChange={(v) => set({ assignee: v })}
            options={[
              ["", "Anyone"],
              ["me", "Me"],
              ["none", "Unassigned"],
              ...(filters.assignee && !["me", "none"].includes(filters.assignee) && !assignees.some((a) => a.userId === filters.assignee)
                ? [[filters.assignee, filters.assignee] as [string, string]]
                : []),
              ...assignees.map((a) => [a.userId, a.name || a.email] as [string, string]),
            ]}
          />
          <Select
            label="Sort by"
            value={filters.sort}
            onChange={(v) => set({ sort: v, dir: v === "due" ? "asc" : "desc" })}
            options={[["updated", "Last activity"], ["created", "Opened"], ["priority", "Priority"], ["due", "Next deadline"], ["number", "Number"]]}
          />
          <Select label="Order" value={sortState.dir} onChange={(v) => set({ dir: v })} options={[["desc", "Descending"], ["asc", "Ascending"]]} />
          <label className="flex items-center gap-1.5 pb-2 text-sm text-zinc-300">
            <input type="checkbox" checked={filters.overdue === "1"} onChange={(e) => set({ overdue: e.target.checked ? "1" : "" })} /> Overdue only
          </label>
          <button type="submit" className={btn.primary}>
            Search
          </button>
        </FilterBar>
      </form>

      {write && sel.count > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-2 text-sm text-cyan-100">
          <span>{fmtNumber(sel.count)} selected</span>
          <BulkSelect label="Assign to" onPick={(v) => setBulk({ field: "assigneeId", value: v })} options={[["none", "Unassigned"], ...assignees.map((a) => [a.userId, a.name || a.email] as [string, string])]} />
          <BulkSelect label="Status" onPick={(v) => setBulk({ field: "status", value: v })} options={TICKET_STATUSES.map((x) => [x, STATUS_LABEL[x]] as [string, string])} />
          <BulkSelect label="Priority" onPick={(v) => setBulk({ field: "priority", value: v })} options={TICKET_PRIORITIES.map((x) => [x, PRIORITY_LABEL[x]] as [string, string])} />
          <button type="button" className={`${btn.ghost} ml-auto`} onClick={sel.clear}>
            Clear selection
          </button>
        </div>
      )}

      <LoadState data={data} error={loadErr} onRetry={load} empty={f.active ? "No tickets match." : "No open tickets."} isEmpty={(d) => d.items.length === 0}>
        {(d) => (
          <>
            <TableWrap minWidth={896}>
              <thead className="border-b border-white/10 text-left text-xs text-zinc-400">
                <tr>
                  {write && (
                    <th className="w-8 px-3 py-2">
                      <SelectBox checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select every ticket on this page" />
                    </th>
                  )}
                  <SortTh label="Ticket" k="number" sort={sortState} onSort={onSort} />
                  <th className="px-3 py-2 font-medium">Status</th>
                  <SortTh label="Priority" k="priority" sort={sortState} onSort={onSort} />
                  <th className="px-3 py-2 font-medium">Assignee</th>
                  <SortTh label="Response target" k="due" sort={sortState} onSort={onSort} />
                  <SortTh label="Last activity" k="updated" sort={sortState} onSort={onSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {d.items.map((t) => (
                  <tr key={t.id} className={t.sla.overdue ? "bg-red-500/[0.04]" : undefined}>
                    {write && (
                      <td className="px-3 py-2.5">
                        <SelectBox checked={sel.selected.has(t.id)} onChange={() => sel.toggle(t.id)} label={`Select #${t.number}`} />
                      </td>
                    )}
                    <td className="max-w-[24rem] px-3 py-2.5">
                      <Link href={`/admin/support/${t.id}`} className="block truncate font-medium text-zinc-100 hover:text-cyan-200">
                        <span className="font-mono text-xs text-zinc-400">#{t.number}</span> {t.subject}
                      </Link>
                      <span className="block truncate text-xs text-zinc-400">
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
                    <td className="px-3 py-2.5 text-zinc-300">{assigneeLabel(t.assigneeId, d.assignees, t.assigneeEmail)}</td>
                    <td className="px-3 py-2.5">
                      <SlaBadge sla={t.sla} now={d.now} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-zinc-400">
                      <Time ts={t.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pager page={d.page} pageSize={PAGE_SIZE} total={d.total} onPage={(p) => f.set({ page: String(p) })} noun="ticket" />
          </>
        )}
      </LoadState>

      {bulk && (
        <Confirm
          title={`Change ${fmtNumber(sel.count)} ticket${sel.count === 1 ? "" : "s"}?`}
          body={<>This will {bulkLabel}. Each change is recorded in the audit log.</>}
          confirmLabel="Apply"
          onConfirm={applyBulk}
          onCancel={() => setBulk(null)}
        />
      )}
      {creating && <NewTicket onClose={() => setCreating(false)} />}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <Labeled label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${field} w-auto`}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Labeled>
  );
}

function BulkSelect({ label, options, onPick }: { label: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <select
      aria-label={`${label} (for the selected tickets)`}
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="max-w-full rounded-lg border border-white/12 bg-black/40 px-2 py-1 text-sm text-zinc-100"
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

function NewTicket({ onClose }: { onClose: () => void }) {
  const { adminFetch } = useAdmin();
  const router = useRouter();
  const [f, setF] = useState({ email: "", name: "", subject: "", category: "other", priority: "normal", body: "", chatRef: "", notifyUser: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await adminFetch<{ ticket: { id: string } }>("/api/admin/support/tickets", { method: "POST", json: f });
    if (!r.ok) {
      setBusy(false);
      return setError(errorText(r));
    }
    // Stays "Creating…" until the ticket page takes over.
    router.push(`/admin/support/${r.data.ticket.id}`);
  };
  const up = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));
  return (
    <Dialog title="New ticket" onClose={() => !busy && onClose()} wide>
      <form onSubmit={submit} className="mt-1 space-y-3">
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
            Chat reference (optional)
            <input value={f.chatRef} onChange={up("chatRef")} className={`${field} mt-1`} />
          </label>
        </div>
        <label className="block text-xs text-zinc-400">
          The request, or the chat transcript
          <textarea required rows={6} value={f.body} onChange={up("body")} className={`${field} mt-1`} />
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={f.notifyUser} onChange={up("notifyUser")} /> Email the customer that we opened a ticket
        </label>
        {error && (
          <Notice kind="err" onClose={() => setError(null)}>
            {error}
          </Notice>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={btn.ghost}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={btn.primary}>
            {busy ? "Creating…" : "Create ticket"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
