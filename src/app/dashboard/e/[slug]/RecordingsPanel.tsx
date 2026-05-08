'use client';

// src/app/dashboard/e/[slug]/RecordingsPanel.tsx
//
// Owner-side panel: list R2 recordings scoped to a room/event prefix, sign
// fresh download URLs, and delete with confirm.

import { useEffect, useState, useCallback } from "react";

type Recording = {
  key: string;
  size: number;
  lastModified?: string;
  downloadUrl: string;
};

type Props = { prefix: string };

function fmtBytes(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export default function RecordingsPanel({ prefix }: Props) {
  const [items, setItems] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/recordings?prefix=${encodeURIComponent(prefix)}&max=200`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load recordings");
      setConfigured(j.configured !== false);
      setItems(Array.isArray(j.recordings) ? j.recordings : []);
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => { load(); }, [load]);

  const filtered = items.filter((rec) => !query || rec.key.toLowerCase().includes(query.toLowerCase()));

  const rename = async (key: string) => {
    const cur = key.split("/").pop() || key;
    const next = window.prompt("Rename recording (filename only, safe chars only):", cur);
    if (!next || next === cur) return;
    if (!/^[A-Za-z0-9._\-]+$/.test(next)) { alert("Invalid characters in new name. Use letters, numbers, dots, underscores, dashes."); return; }
    const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
    const newKey = dir + next;
    setErr(null);
    try {
      const r = await fetch("/api/recordings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, newKey }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to rename");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to rename");
    }
  };

  const remove = async (key: string) => {
    if (!confirm("Permanently delete this recording? This cannot be undone.")) return;
    setDeleting(key);
    setErr(null);
    try {
      const r = await fetch(`/api/recordings?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || "Failed to delete");
      await load();
    } catch (e: any) {
      setErr(e?.message || "Failed to delete");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className={"rounded-2xl border border-cyan-500/15 bg-slate-900/40 backdrop-blur p-5 space-y-3"}>
      <header className={"flex items-center justify-between"}>
        <h2 className={"text-sm uppercase tracking-widest text-slate-400"}>Recordings</h2>
        <div className={"flex items-center gap-2"}>
          <span className={"text-[11px] text-slate-500"}>{items.length} file{items.length === 1 ? "" : "s"}</span>
          <button type={"button"} onClick={load} className={"text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"}>Refresh</button>
        </div>
      </header>

      {!configured && (
        <div className={"text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2"}>
          R2 storage not configured. Set <code>S3_ENDPOINT</code>, <code>S3_BUCKET</code>, <code>S3_ACCESS_KEY</code>, <code>S3_SECRET_KEY</code> in env.
        </div>
      )}

      {err && <div className={"text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2"}>{err}</div>}

      <div className={"flex items-center gap-2"}>
        <input type={"text"} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={"Filter recordings by name..."} className={"flex-1 bg-slate-950/60 border border-slate-700 rounded px-3 py-1.5 text-slate-200 text-xs"} />
        {query && <button type={"button"} onClick={() => setQuery("")} className={"text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"}>Clear</button>}
      </div>

      <ul className={"space-y-2"}>
        {loading && <li className={"text-xs text-slate-500"}>Loading...</li>}
        {!loading && filtered.length === 0 && configured && <li className={"text-xs text-slate-500"}>{query ? "No recordings match." : "No recordings yet for this room."}</li>}
        {filtered.map((rec) => (
          <li key={rec.key} className={"flex flex-col md:flex-row md:items-center gap-2 px-3 py-2 rounded-lg bg-slate-950/50 border border-slate-800"}>
            <div className={"flex-1 min-w-0"}>
              <div className={"text-xs text-slate-200 font-mono truncate"} title={rec.key}>{rec.key.split("/").pop()}</div>
              <div className={"text-[10px] text-slate-500 mt-0.5"}>
                {fmtBytes(rec.size)}{rec.lastModified ? " . " + new Date(rec.lastModified).toLocaleString() : ""}
              </div>
            </div>
            <div className={"flex items-center gap-2 shrink-0"}>
              <a href={rec.downloadUrl} target={"_blank"} rel={"noopener noreferrer"} className={"px-3 py-1.5 rounded bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 text-cyan-200 text-xs"}>Download</a>
              <button type={"button"} onClick={() => rename(rec.key)} className={"px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs"}>Rename</button>
              <button type={"button"} onClick={() => remove(rec.key)} disabled={deleting === rec.key} className={"px-3 py-1.5 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 text-xs disabled:opacity-50"}>
                {deleting === rec.key ? "Deleting..." : "Delete"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
