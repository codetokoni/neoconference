"use client";

// Backups: the app's own KV snapshots in R2 (size, keys, checksum,
// verification), and — for the platform owner only — a controlled restore
// by key prefix with a preview, a typed confirmation and an undo.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
import { StatusBadge, ago, fmtBytes } from "../opsUi";

type Backup = {
  id: string;
  kind: string;
  createdAt: number;
  createdBy: string;
  r2Key: string;
  bytes: number;
  rawBytes: number;
  keyCount: number;
  sha256: string;
  truncated: boolean;
  truncatedReason?: string;
  prefixes: string[] | null;
  verify?: { at: number; ok: boolean; detail: string };
  restoreOf?: string;
};
type Data = {
  backups: Backup[];
  r2Configured: boolean;
  canRestore: boolean;
  config: { exclude: string[]; protected: string[]; maxKeys: number; maxRawBytes: number; keep: number; keepPreRestore: number };
};
type Preview = { added: string[]; changed: string[]; removed: string[]; unchanged: number; protectedSkipped: number; counts: { added: number; changed: number; removed: number } };

export default function OpsBackupsClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("ops:write");
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [snap, setSnap] = useState("");
  const [prefixText, setPrefixText] = useState("");
  const [preview, setPreview] = useState<{ p: Preview; phrase: string; snapshotId: string; prefixes: string[] } | null>(null);
  const [typed, setTyped] = useState("");
  const [undo, setUndo] = useState<{ snapshotId: string; prefixes: string[] } | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<Data>("/api/admin/ops/backups");
    if (r.ok) setData(r.data);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load backups." });
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const snapshotNow = async () => {
    setBusy("snap");
    setMsg(null);
    const r = await adminFetch<{ run?: { summary?: string; error?: string } }>("/api/admin/ops/backups", { method: "POST" });
    setBusy(null);
    setMsg(r.ok ? { kind: "ok", text: "Snapshot taken and verified." } : { kind: "err", text: r.data.message ?? r.data.run?.error ?? "The snapshot failed." });
    load();
  };
  const verify = async (b: Backup) => {
    setBusy(b.id);
    const r = await adminFetch<{ backup: Backup }>(`/api/admin/ops/backups/${encodeURIComponent(b.id)}/verify`, { method: "POST" });
    setBusy(null);
    if (!r.ok) setMsg({ kind: "err", text: r.data.message ?? "Could not verify." });
    else setMsg({ kind: r.data.backup.verify?.ok ? "ok" : "err", text: `${b.id}: ${r.data.backup.verify?.detail}` });
    load();
  };
  const doPreview = async (snapshotId = snap, prefixes = prefixText.split(/[\s,]+/).filter(Boolean)) => {
    setMsg(null);
    setPreview(null);
    setTyped("");
    const r = await adminFetch<{ preview: Preview; confirmPhrase: string }>("/api/admin/ops/backups/restore", { method: "POST", json: { snapshotId, prefixes, mode: "preview" } });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not preview." });
    setPreview({ p: r.data.preview, phrase: r.data.confirmPhrase, snapshotId, prefixes });
  };
  const apply = async () => {
    if (!preview) return;
    setBusy("restore");
    const r = await adminFetch<{ result: { written: number; removed: number; preRestoreId: string }; undo: { snapshotId: string; prefixes: string[] } }>("/api/admin/ops/backups/restore", {
      method: "POST",
      json: { snapshotId: preview.snapshotId, prefixes: preview.prefixes, mode: "apply", confirm: typed },
    });
    setBusy(null);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "The restore did not run." });
    setMsg({ kind: "ok", text: `Restored: ${r.data.result.written} keys written, ${r.data.result.removed} removed. The state before is saved as ${r.data.result.preRestoreId}.` });
    setUndo(r.data.undo);
    setPreview(null);
    load();
  };

  if (!data) return <Loading />;
  const usable = data.backups.filter((b) => !b.truncated && b.verify?.ok);

  return (
    <div>
      <PageHeader
        title="Backups"
        sub="The app's own daily snapshot of KV, stored in R2. It is a second line, not the primary backup."
        actions={
          write && (
            <button type="button" className={btn.primary} disabled={!!busy || !data.r2Configured} onClick={snapshotNow}>
              {busy === "snap" ? "Taking snapshot…" : "Snapshot now"}
            </button>
          )
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <Panel className="mb-4 text-sm text-zinc-400">
        <p>
          <b className="text-zinc-200">Upstash&apos;s own backups and restore are only available in the Upstash console</b> (console.upstash.com → the database → Backups); the
          app cannot start, list or restore them. The snapshots here are copied by the app: every key except caches, rate limits, presence and locks (
          <span className="font-mono text-xs">{data.config.exclude.join(" ")}</span>), compressed, with a SHA-256 checksum, read back and verified after writing. Capped at{" "}
          {data.config.maxKeys.toLocaleString()} keys / {fmtBytes(data.config.maxRawBytes)}; the newest {data.config.keep} snapshots and {data.config.keepPreRestore} pre-restore
          snapshots are kept.
        </p>
      </Panel>

      {data.backups.length === 0 ? (
        <Empty>No snapshots yet. The first is taken at 03:30 UTC{write ? ", or now with Snapshot now" : ""}.</Empty>
      ) : (
        <Panel className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">Snapshot</th>
                <th className="px-3 py-2 font-medium">Keys</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">SHA-256</th>
                <th className="px-3 py-2 font-medium">Verified</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {data.backups.map((b) => (
                <tr key={b.id} className="border-t border-white/5 align-top">
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs text-zinc-200">{b.id}</span>
                    <div className="text-xs text-zinc-500" title={fmtTime(b.createdAt)}>
                      {b.kind} · {ago(b.createdAt)} · {b.createdBy}
                      {b.prefixes ? ` · ${b.prefixes.join(", ")}` : ""}
                      {b.restoreOf ? ` · before restoring ${b.restoreOf}` : ""}
                    </div>
                    {b.truncated && <Badge tone="amber">Incomplete: {b.truncatedReason}</Badge>}
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-300">{b.keyCount.toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono text-zinc-300">
                    {fmtBytes(b.bytes)} <span className="text-xs text-zinc-500">({fmtBytes(b.rawBytes)} raw)</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-400" title={b.sha256}>
                    {b.sha256.slice(0, 12)}…
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {b.verify ? (
                      <span title={b.verify.detail}>
                        <StatusBadge status={b.verify.ok ? "ok" : "failed"} /> <span className="text-zinc-500">{ago(b.verify.at)}</span>
                        {!b.verify.ok && <div className="text-red-200">{b.verify.detail}</div>}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {write && (
                      <button type="button" className={btn.ghost} disabled={!!busy} onClick={() => verify(b)}>
                        {busy === b.id ? "Verifying…" : "Verify"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <h2 className="mb-2 mt-6 text-lg font-semibold text-cyan-50">Restore</h2>
      {!data.canRestore ? (
        <Panel className="text-sm text-zinc-400">Only the platform owner can restore from a snapshot.</Panel>
      ) : (
        <Panel>
          <p className="text-sm text-zinc-400">
            Restore chosen key prefixes from a verified snapshot. A preview shows what would be added, changed and removed; applying it first saves the current state of
            those prefixes as a pre-restore snapshot, so it can be undone. Never restored over: <span className="font-mono text-xs">{data.config.protected.join(" ")}</span>.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-zinc-300">
              Snapshot
              <select className={`${field} mt-1`} value={snap} onChange={(e) => setSnap(e.target.value)}>
                <option value="">Choose…</option>
                {usable.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id} — {b.kind}, {fmtTime(b.createdAt)}, {b.keyCount} keys
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-zinc-300">
              Key prefixes (space or comma separated)
              <input className={`${field} mt-1 font-mono`} placeholder="neo:event: neo:slug:" value={prefixText} onChange={(e) => setPrefixText(e.target.value)} />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btn.ghost} disabled={!snap || !prefixText.trim()} onClick={() => doPreview()}>
              Preview
            </button>
            {undo && (
              <button type="button" className={btn.warn} onClick={() => doPreview(undo.snapshotId, undo.prefixes)}>
                Undo the last restore (preview)
              </button>
            )}
          </div>
          {preview && (
            <div className="mt-4 rounded-lg border border-white/10 p-3">
              <p className="text-sm text-zinc-200">
                Restoring <span className="font-mono">{preview.prefixes.join(", ")}</span> from <span className="font-mono">{preview.snapshotId}</span>:{" "}
                <b className="text-emerald-300">{preview.p.counts.added} added</b>, <b className="text-amber-300">{preview.p.counts.changed} changed</b>,{" "}
                <b className="text-red-300">{preview.p.counts.removed} removed</b>, {preview.p.unchanged} unchanged
                {preview.p.protectedSkipped ? `, ${preview.p.protectedSkipped} protected skipped` : ""}.
              </p>
              <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                {(["added", "changed", "removed"] as const).map((k) => (
                  <div key={k}>
                    <h3 className="font-medium text-zinc-400">{k}</h3>
                    <ul className="mt-1 max-h-40 overflow-auto font-mono text-zinc-400">
                      {preview.p[k].map((key) => (
                        <li key={key} className="truncate">
                          {key}
                        </li>
                      ))}
                      {preview.p.counts[k] > preview.p[k].length && <li>… and {preview.p.counts[k] - preview.p[k].length} more</li>}
                    </ul>
                  </div>
                ))}
              </div>
              <label className="mt-3 block text-sm text-zinc-300">
                Type <b className="font-mono text-white">{preview.phrase}</b> to apply
                <input className={`${field} mt-1 font-mono`} value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
              <div className="mt-3 text-right">
                <button type="button" className={btn.danger} disabled={typed.trim() !== preview.phrase || busy === "restore"} onClick={apply}>
                  {busy === "restore" ? "Restoring…" : "Apply restore"}
                </button>
              </div>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
