"use client";

// Groups: every group on the platform with its owner and size. A group
// opens to its members, invitations and history, where ownership can be
// transferred and members removed. The search and page live in the address
// bar (?q=, ?page=, ?pageSize=): the admin search's "all matching groups"
// links here.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Time, errorText, fmtNumber, fmtTime, useAdmin } from "../AdminApi";
import { Empty, FilterBar, Labeled, Loading, Notice, PageHeader, Pager, TableWrap, btn, field, useUrlFilters } from "../ui";

type GroupRow = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  memberCount: number;
  pendingCount: number;
};

const SIZES = [25, 50, 100];

export default function GroupsClient() {
  const { can, adminFetch } = useAdmin();
  const f = useUrlFilters({ q: "", page: "1", pageSize: "25" });
  const page = Math.max(1, Number(f.value.page) || 1);
  const pageSize = SIZES.includes(Number(f.value.pageSize)) ? Number(f.value.pageSize) : 25;
  const query = f.value.q.trim();
  const [draft, setDraft] = useState(f.value.q);
  const [items, setItems] = useState<GroupRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [backfilledAt, setBackfilledAt] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  // A link from the admin search while this page is open changes ?q= without remounting.
  useEffect(() => setDraft(f.value.q), [f.value.q]);

  const load = useCallback(async () => {
    setItems(null);
    setError(null);
    const r = await adminFetch<{ items: GroupRow[]; total: number; backfilledAt: number | null }>(
      `/api/admin/groups?q=${encodeURIComponent(query)}&page=${page}&pageSize=${pageSize}`,
    );
    if (!r.ok) return setError(errorText(r));
    setItems(r.data.items);
    setTotal(r.data.total);
    setBackfilledAt(r.data.backfilledAt);
  }, [adminFetch, query, page, pageSize]);
  useEffect(() => {
    load();
  }, [load]);

  const rebuild = async () => {
    setMsg(null);
    setRebuilding(true);
    const r = await adminFetch<{ scannedUsers: number; added: number; found: number }>("/api/admin/groups", { method: "POST", json: { action: "backfill" } });
    setRebuilding(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not rebuild the list." });
    setMsg({ kind: "ok", text: `Checked ${fmtNumber(r.data.scannedUsers)} members' group lists: ${fmtNumber(r.data.added)} group${r.data.added === 1 ? "" : "s"} added, ${fmtNumber(r.data.found)} in all.` });
    load();
  };

  return (
    <div>
      <PageHeader
        title="Groups"
        sub={
          items
            ? `${fmtNumber(total)} group${total === 1 ? "" : "s"}${query ? ` match “${query}”` : ""}, newest first.${backfilledAt ? ` List last rebuilt from members' group lists ${fmtTime(backfilledAt)}.` : ""}`
            : "Every group on NeoConference, newest first."
        }
        actions={
          can("users:write") ? (
            <button type="button" className={btn.ghost} onClick={rebuild} disabled={rebuilding} title="Find groups created before this list existed">
              {rebuilding ? "Rebuilding…" : "Rebuild list"}
            </button>
          ) : null
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          f.set({ q: draft.trim(), page: "1" });
        }}
      >
        <FilterBar
          active={f.value.q !== ""}
          onClear={() => {
            setDraft("");
            f.set({ q: "", page: "1" });
          }}
        >
          <Labeled label="Search" className="min-w-0 flex-1 basis-60">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Group name, id, or owner" className={field} />
          </Labeled>
          <button type="submit" className={btn.primary}>
            Search
          </button>
        </FilterBar>
      </form>
      {error ? (
        <Notice kind="err" onRetry={load}>
          {error}
        </Notice>
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>{query ? `No groups match “${query}”.` : "No groups yet."}</Empty>
      ) : (
        <>
          <TableWrap minWidth={640}>
            <thead className="border-b border-white/10 text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Group</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Members</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {items.map((gr) => (
                <tr key={gr.id} className="hover:bg-white/[0.03]">
                  <td className="px-3 py-2">
                    <Link href={`/admin/groups/${encodeURIComponent(gr.id)}`} className="font-medium text-cyan-200 hover:underline">
                      {gr.name}
                    </Link>
                    {gr.description && <span className="block max-w-xs truncate text-xs text-zinc-400">{gr.description}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {gr.ownerId ? (
                      <Link href={`/admin/users/${encodeURIComponent(gr.ownerId)}`} className="text-zinc-200 hover:underline">
                        {gr.ownerName || gr.ownerEmail || gr.ownerId}
                      </Link>
                    ) : (
                      <span className="text-amber-300">No owner</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">
                    <Link href={`/admin/groups/${encodeURIComponent(gr.id)}#members`} className="hover:underline" aria-label={`${gr.memberCount} members of ${gr.name}`}>
                      {fmtNumber(gr.memberCount)}
                    </Link>
                    {gr.pendingCount ? <span className="text-xs text-zinc-400"> + {fmtNumber(gr.pendingCount)} invited</span> : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    <Time ts={gr.createdAt} mode="date" />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pager
            page={page}
            pageSize={pageSize}
            total={total}
            sizes={SIZES}
            noun="group"
            onPage={(p) => f.set({ page: String(p) })}
            onPageSize={(n) => f.set({ pageSize: String(n), page: "1" })}
          />
        </>
      )}
    </div>
  );
}
