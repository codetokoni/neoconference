"use client";

// Groups: every group on the platform with its owner and size. A group
// opens to its members, invitations and history, where ownership can be
// transferred and members removed.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import { Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";

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

export default function GroupsClient() {
  const { can, adminFetch } = useAdmin();
  const [items, setItems] = useState<GroupRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  // ?q= opens the list searched (the admin search's "all matching groups" links here).
  const sp = useSearchParams();
  const [q, setQ] = useState(sp?.get("q") ?? "");
  const [query, setQuery] = useState(sp?.get("q") ?? "");
  const [backfilledAt, setBackfilledAt] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const pageSize = 25;

  const load = useCallback(async () => {
    setItems(null);
    const r = await adminFetch<{ items: GroupRow[]; total: number; backfilledAt: number | null }>(
      `/api/admin/groups?q=${encodeURIComponent(query)}&page=${page}&pageSize=${pageSize}`,
    );
    if (!r.ok) {
      setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
      setItems([]);
      return;
    }
    setItems(r.data.items);
    setTotal(r.data.total);
    setBackfilledAt(r.data.backfilledAt);
  }, [adminFetch, query, page]);
  useEffect(() => {
    load();
  }, [load]);

  const rebuild = async () => {
    setMsg(null);
    const r = await adminFetch<{ scannedUsers: number; added: number; found: number }>("/api/admin/groups", { method: "POST", json: { action: "backfill" } });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not rebuild the list." });
    setMsg({ kind: "ok", text: `Checked ${r.data.scannedUsers} members' group lists: ${r.data.added} group${r.data.added === 1 ? "" : "s"} added, ${r.data.found} in all.` });
    load();
  };
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <PageHeader
        title="Groups"
        sub={`${total} group${total === 1 ? "" : "s"}. ${backfilledAt ? `List last rebuilt from members' group lists ${fmtTime(backfilledAt)}.` : ""}`}
        actions={
          can("users:write") ? (
            <button type="button" className={btn.ghost} onClick={rebuild} title="Find groups created before this list existed">
              Rebuild list
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
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q.trim());
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search group name, id, or owner" aria-label="Search groups" className={field} />
        <button type="submit" className={btn.primary}>
          Search
        </button>
      </form>
      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>No groups.</Empty>
      ) : (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-white/10 text-xs text-zinc-500">
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
                    {gr.description && <span className="block max-w-xs truncate text-xs text-zinc-500">{gr.description}</span>}
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
                    {gr.memberCount}
                    {gr.pendingCount ? <span className="text-xs text-zinc-500"> + {gr.pendingCount} invited</span> : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">{gr.createdAt ? new Date(gr.createdAt).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      {total > pageSize && (
        <nav aria-label="Pages" className="mt-3 flex items-center justify-end gap-2 text-sm text-zinc-400">
          <span>
            Page {page} of {pages}
          </span>
          <button type="button" className={btn.ghost} disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <button type="button" className={btn.ghost} disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
