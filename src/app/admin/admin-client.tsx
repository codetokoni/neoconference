"use client";

import { useEffect, useState } from "react";

type Role = "admin" | "staff" | "user";
type Item = { id: string; name: string; email: string; imageUrl: string; role: Role };

export default function AdminClient() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async (q?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/admin/users", window.location.origin);
      if (q) url.searchParams.set("query", q);
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const setRole = async (userId: string, role: Role) => {
    setBusyId(userId);
    setError(null);
    try {
      const res = await fetch("/api/admin/role", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setItems((prev) => prev.map((u) => (u.id === userId ? { ...u, role } : u)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-1">Admin · Users</h1>
      <p className="text-sm text-zinc-600 mb-5">Assign admin or staff roles. Default is user.</p>
      <form onSubmit={(e) => { e.preventDefault(); load(query.trim() || undefined); }} className="flex gap-2 mb-4">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" className="flex-1 border rounded px-3 py-2 text-sm" />
        <button type="submit" className="px-3 py-2 text-sm rounded bg-black text-white hover:bg-zinc-800">Search</button>
      </form>
      {error && <div className="text-sm text-red-600 mb-3">Error: {error}</div>}
      {loading && <div className="text-sm text-zinc-500 mb-3">Loading...</div>}
      <ul className="divide-y border rounded">
        {items.map((u) => (
          <li key={u.id} className="flex items-center gap-3 p-3">
            {u.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={u.imageUrl} alt="" width={32} height={32} className="rounded-full" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-zinc-200" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{u.name || u.email || u.id}</div>
              <div className="text-xs text-zinc-500 truncate">{u.email}</div>
            </div>
            <span className="text-xs px-2 py-0.5 rounded bg-zinc-100 mr-2">{u.role}</span>
            {(["admin","staff","user"] as Role[]).map((r) => (
              <button key={r} disabled={busyId === u.id || u.role === r} onClick={() => setRole(u.id, r)} className="text-xs px-2 py-1 rounded border mr-1 disabled:opacity-40">{r}</button>
            ))}
          </li>
        ))}
      </ul>
    </main>
  );
}
