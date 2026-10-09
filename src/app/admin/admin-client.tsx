"use client";

import { useCallback, useEffect, useState } from "react";
import { useAdmin } from "./AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "./ui";

type Role = "admin" | "staff" | "user";
type Item = { id: string; name: string; email: string; imageUrl: string; role: Role; access: string | null };

export default function AdminClient() {
  const { can, adminFetch } = useAdmin();
  const [items, setItems] = useState<Item[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (q?: string) => {
      setItems(null);
      setError(null);
      const url = new URL("/api/admin/users", window.location.origin);
      if (q) url.searchParams.set("query", q);
      const r = await adminFetch<{ items: Item[]; total: number }>(url.toString());
      if (!r.ok) {
        setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
        setItems([]);
        return;
      }
      setItems(r.data.items ?? []);
      setTotal(r.data.total ?? 0);
    },
    [adminFetch],
  );

  useEffect(() => {
    load();
  }, [load]);

  const setRole = async (userId: string, role: Role) => {
    setBusyId(userId);
    setError(null);
    const r = await adminFetch("/api/admin/role", { method: "POST", json: { userId, role } });
    setBusyId(null);
    if (!r.ok) return setError(r.data.message ?? r.data.error ?? `HTTP ${r.status}`);
    setItems((prev) => (prev ?? []).map((u) => (u.id === userId ? { ...u, role } : u)));
  };

  return (
    <div>
      <PageHeader title="Users" sub={`${total} account${total === 1 ? "" : "s"}. Staff can run video rooms. Administrators are appointed on the Administrators page.`} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          load(query.trim() || undefined);
        }}
        className="mb-4 flex gap-2"
      >
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" aria-label="Search users" className={field} />
        <button type="submit" className={btn.primary}>
          Search
        </button>
      </form>
      {error && <Notice kind="err">{error}</Notice>}
      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>No users match.</Empty>
      ) : (
        <Panel className="p-0">
          <ul className="divide-y divide-white/5">
            {items.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 p-3">
                {u.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={u.imageUrl} alt="" width={32} height={32} className="rounded-full" />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-white/10" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-zinc-100">{u.name || u.email || u.id}</div>
                  <div className="truncate text-xs text-zinc-500">{u.email}</div>
                </div>
                {u.access && <Badge tone={u.access === "owner" ? "amber" : u.access === "admin" ? "cyan" : "red"}>{u.access}</Badge>}
                {u.role !== "admin" && <Badge tone={u.role === "staff" ? "cyan" : "zinc"}>{u.role}</Badge>}
                {can("users:write") && u.role !== "admin" && u.access !== "owner" &&
                  (["staff", "user"] as Role[]).map((r) => (
                    <button key={r} type="button" disabled={busyId === u.id || u.role === r} onClick={() => setRole(u.id, r)} className={`${btn.ghost} px-2 py-1 text-xs`}>
                      Make {r}
                    </button>
                  ))}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
