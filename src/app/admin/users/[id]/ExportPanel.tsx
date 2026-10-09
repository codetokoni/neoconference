"use client";

// An account's data export, from its admin page (data:export): start one,
// watch it build, and download it through a link that works for 5 minutes.
// Every step is in the audit log.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../../AdminApi";
import { btn } from "../../ui";

type Exp = {
  id: string;
  status: "running" | "ready" | "failed";
  createdAt: number;
  readyAt: number | null;
  expiresAt: number;
  size: number | null;
  progress: { done: number; total: number };
  error: string | null;
};

export default function ExportPanel({ userId }: { userId: string }) {
  const { adminFetch } = useAdmin();
  const [items, setItems] = useState<Exp[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const base = `/api/admin/users/${encodeURIComponent(userId)}/export`;

  const load = useCallback(async () => {
    const r = await adminFetch<{ items: Exp[] }>(base);
    if (r.ok) setItems(r.data.items);
  }, [adminFetch, base]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      const r = await adminFetch<{ export: Exp | null }>(`/api/admin/data/exports/${id}`, { method: "POST" });
      if (!r.ok || !r.data.export) return setErr(r.data.message ?? "The export stopped.");
      setItems((cur) => [r.data.export!, ...(cur ?? []).filter((x) => x.id !== id)]);
      if (r.data.export.status !== "running") return;
      // Another export's step may hold the runner's lock: give it a moment.
      await new Promise((ok) => setTimeout(ok, 700));
    }
  };

  const start = async () => {
    setBusy(true);
    setErr(null);
    const r = await adminFetch<{ export: Exp }>(base, { method: "POST" });
    if (!r.ok) {
      setBusy(false);
      return setErr(r.data.message ?? `HTTP ${r.status}`);
    }
    await run(r.data.export.id);
    setBusy(false);
  };

  const download = async (id: string) => {
    const r = await adminFetch<{ url: string }>(`/api/admin/data/exports/${id}?download=1`);
    if (!r.ok) return setErr(r.data.message ?? "Could not get a link.");
    window.location.assign(r.data.url);
  };

  return (
    <div>
      <p className="text-sm text-zinc-400">A ZIP of everything the app holds about this account (JSON and CSV), without other people&apos;s data or secrets. Kept 7 days.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={btn.ghost} disabled={busy} onClick={start}>
          {busy ? "Preparing…" : "Export data"}
        </button>
        {err && <span className="text-sm text-red-300">{err}</span>}
      </div>
      {items && items.length > 0 && (
        <ul className="mt-2 divide-y divide-white/5 text-sm">
          {items.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span className="text-zinc-300">
                {fmtTime(x.createdAt)} ·{" "}
                {x.status === "running" ? `preparing (${x.progress.done}/${x.progress.total})` : x.status === "failed" ? `failed: ${x.error ?? ""}` : `ready, ${Math.max(1, Math.round((x.size ?? 0) / 1024))} KB`}
              </span>
              {x.status === "ready" && (
                <button type="button" className={btn.ghost} onClick={() => download(x.id)}>
                  Download
                </button>
              )}
              {x.status === "running" && !busy && (
                <button type="button" className={btn.ghost} onClick={() => run(x.id)}>
                  Continue
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
