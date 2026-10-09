"use client";

// src/components/account/YourData.tsx
//
// "Your data" on the account page: download a copy of everything the app
// holds about you, and ask for your account to be deleted (with a grace
// period in which you can take it back). The server decides everything —
// this only shows where things stand.

import { useCallback, useEffect, useState } from "react";

type Exp = {
  id: string;
  status: "running" | "ready" | "failed";
  createdAt: number;
  expiresAt: number;
  size: number | null;
  progress: { done: number; total: number };
  error: string | null;
};

type Deletion = {
  owner: boolean;
  graceDays: number;
  confirmWord: string;
  request: { status: "requested" | "scheduled"; requestedAt: number; deleteAfter: number; byYou: boolean; canCancel: boolean } | null;
  last: { status: string; closedAt: number } | null;
};

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const button =
  "inline-flex items-center justify-center rounded-lg border border-white/15 px-3.5 py-2 text-sm text-zinc-100 transition hover:bg-white/5 disabled:opacity-40";
const danger =
  "inline-flex items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-40";

async function call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<{ ok: boolean; data: T & { message?: string } }> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: init?.json !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as T & { message?: string } };
  } catch {
    return { ok: false, data: { message: "Could not reach the server." } as T & { message?: string } };
  }
}

export default function YourData() {
  const [exports, setExports] = useState<Exp[]>([]);
  const [busy, setBusy] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [del, setDel] = useState<Deletion | null>(null);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [delErr, setDelErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [e, d] = await Promise.all([call<{ items: Exp[] }>("/api/me/data/export"), call<Deletion>("/api/me/data/deletion")]);
    if (e.ok) setExports(e.data.items);
    if (d.ok) setDel(d.data);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const advance = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      const r = await call<{ export: Exp | null }>("/api/me/data/export", { method: "POST", json: { id } });
      if (!r.ok || !r.data.export) return setExportErr(r.data.message ?? "The export stopped. Try again.");
      const x = r.data.export;
      setExports((cur) => [x, ...cur.filter((y) => y.id !== id)]);
      if (x.status !== "running") return;
    }
  };

  const startExport = async () => {
    setBusy(true);
    setExportErr(null);
    const r = await call<{ export: Exp }>("/api/me/data/export", { method: "POST", json: {} });
    if (!r.ok) {
      setBusy(false);
      return setExportErr(r.data.message ?? "Could not start the export.");
    }
    await advance(r.data.export.id);
    setBusy(false);
  };

  const download = async (id: string) => {
    const r = await call<{ url: string }>(`/api/me/data/export?download=${encodeURIComponent(id)}`);
    if (!r.ok) return setExportErr(r.data.message ?? "Could not get the download link.");
    window.location.assign(r.data.url);
  };

  const requestDeletion = async () => {
    setDelErr(null);
    const r = await call<{ request: unknown }>("/api/me/data/deletion", { method: "POST", json: { confirm: typed.trim() } });
    if (!r.ok) return setDelErr(r.data.message ?? "Could not request the deletion.");
    setAsking(false);
    setTyped("");
    load();
  };

  const cancelDeletion = async () => {
    setDelErr(null);
    const r = await call("/api/me/data/deletion", { method: "DELETE" });
    if (!r.ok) return setDelErr(r.data.message ?? "Could not cancel.");
    load();
  };

  const latest = exports[0];

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="font-medium text-zinc-100">Download my data</h3>
        <p className="mt-1 text-sm text-zinc-400">
          A ZIP file with your account, meetings, attendance, chat messages, groups, notifications, devices, payments and API keys (names only), as JSON and CSV. Recordings
          are listed with where to download them. The link works for a few minutes; the file is kept for 7 days.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={button} disabled={busy} onClick={startExport}>
            {busy ? `Preparing… ${latest && latest.status === "running" ? `(${latest.progress.done}/${latest.progress.total})` : ""}` : "Download my data"}
          </button>
          {latest?.status === "ready" && (
            <button type="button" className={button} onClick={() => download(latest.id)}>
              Download the file ({Math.max(1, Math.round((latest.size ?? 0) / 1024))} KB)
            </button>
          )}
          {latest?.status === "running" && !busy && (
            <button type="button" className={button} onClick={() => advance(latest.id)}>
              Finish preparing
            </button>
          )}
        </div>
        {latest?.status === "failed" && <p className="mt-2 text-sm text-red-300">The last export failed. Try again.</p>}
        {exportErr && (
          <p role="alert" className="mt-2 text-sm text-red-300">
            {exportErr}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-4">
        <h3 className="font-medium text-zinc-100">Delete my account</h3>
        {!del ? (
          <p className="mt-1 text-sm text-zinc-500">Loading…</p>
        ) : del.owner ? (
          <p className="mt-1 text-sm text-zinc-400">This is the platform owner&apos;s account. It cannot be deleted.</p>
        ) : del.request ? (
          <div className="mt-1 space-y-2 text-sm">
            <p className="text-zinc-300" role="status">
              Your account is scheduled to be deleted on <b>{when(del.request.deleteAfter)}</b>
              {del.request.status === "scheduled" ? " — that date has passed; it will be deleted shortly." : "."}
            </p>
            {del.request.canCancel ? (
              <button type="button" className={button} onClick={cancelDeletion}>
                Keep my account
              </button>
            ) : (
              <p className="text-zinc-400">An administrator asked for this deletion. Contact support if it is a mistake.</p>
            )}
          </div>
        ) : (
          <div className="mt-1 space-y-2 text-sm">
            <p className="text-zinc-400">
              Your meetings, recordings, groups you alone are in, messages, notifications and devices are deleted, and your name is removed from other people&apos;s meetings and
              groups. Payment records are kept for the law, without your name. You have {del.graceDays} days to change your mind, and you can keep using your account until
              then. Download your data first if you want a copy.
            </p>
            {del.last?.status === "refused" && <p className="text-amber-300">Your account can&apos;t be deleted right now. Contact support for details.</p>}
            {!asking ? (
              <button type="button" className={danger} onClick={() => setAsking(true)}>
                Delete my account…
              </button>
            ) : (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  requestDeletion();
                }}
              >
                <label className="text-zinc-300">
                  Type <b className="font-mono text-white">{del.confirmWord}</b> to confirm
                  <input
                    autoFocus
                    aria-label={`Type ${del.confirmWord} to confirm`}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    className="mt-1 block w-48 rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-red-400"
                  />
                </label>
                <button type="submit" className={danger} disabled={typed.trim() !== del.confirmWord}>
                  Delete my account
                </button>
                <button type="button" className={button} onClick={() => setAsking(false)}>
                  Cancel
                </button>
              </form>
            )}
          </div>
        )}
        {delErr && (
          <p role="alert" className="mt-2 text-sm text-red-300">
            {delErr}
          </p>
        )}
      </div>
    </div>
  );
}
