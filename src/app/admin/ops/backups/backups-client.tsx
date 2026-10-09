"use client";

// Backups: the app's own KV snapshots in R2 (size, keys, checksum,
// verification), and — for the platform owner only — a controlled restore
// by key prefix with a preview, a typed confirmation and an undo.

import { useCallback, useEffect, useState } from "react";
import { Time, errorText, fmtNumber, fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Confirm, Empty, LoadState, Notice, PageHeader, Panel, TableWrap, btn, field } from "../../ui";
import { StatusBadge, fmtBytes } from "../opsUi";

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
type Preview = {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
  protectedSkipped: number;
  erasedSkipped: string[];
  counts: { added: number; changed: number; removed: number; erasedSkipped: number };
};

export default function OpsBackupsClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("ops:write");
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [snap, setSnap] = useState("");
  const [prefixText, setPrefixText] = useState("");
  const [preview, setPreview] = useState<{ p: Preview; phrase: string; snapshotId: string; prefixes: string[] } | null>(null);
  const [undo, setUndo] = useState<{ snapshotId: string; prefixes: string[] } | null>(null);
  const [ask, setAsk] = useState<{ kind: "snapshot" } | { kind: "verify"; b: Backup } | { kind: "restore" } | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<Data>("/api/admin/ops/backups");
    if (r.ok) {
      setData(r.data);
      setLoadErr(null);
    } else setLoadErr(`Could not load backups. ${errorText(r)}`);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const snapshotNow = async () => {
    setBusy("snap");
    setMsg(null);
    const r = await adminFetch<{ run?: { summary?: string; error?: string } }>("/api/admin/ops/backups", { method: "POST" });
    setBusy(null);
    setAsk(null);
    setMsg(r.ok ? { kind: "ok", text: "Snapshot taken and verified." } : { kind: "err", text: `The snapshot failed. ${r.data.message ?? r.data.run?.error ?? errorText(r)}` });
    await load();
  };
  const verify = async (b: Backup) => {
    setBusy(b.id);
    setMsg(null);
    const r = await adminFetch<{ backup: Backup }>(`/api/admin/ops/backups/${encodeURIComponent(b.id)}/verify`, { method: "POST" });
    setBusy(null);
    setAsk(null);
    if (!r.ok) setMsg({ kind: "err", text: `Could not verify ${b.id}. ${errorText(r)}` });
    else setMsg({ kind: r.data.backup.verify?.ok ? "ok" : "err", text: `${b.id}: ${r.data.backup.verify?.detail}` });
    await load();
  };
  const doPreview = async (snapshotId = snap, prefixes = prefixText.split(/[\s,]+/).filter(Boolean)) => {
    setMsg(null);
    setPreview(null);
    setBusy("preview");
    const r = await adminFetch<{ preview: Preview; confirmPhrase: string }>("/api/admin/ops/backups/restore", { method: "POST", json: { snapshotId, prefixes, mode: "preview" } });
    setBusy(null);
    if (!r.ok) return setMsg({ kind: "err", text: `Could not preview. ${errorText(r)}` });
    setPreview({ p: r.data.preview, phrase: r.data.confirmPhrase, snapshotId, prefixes });
  };
  const apply = async () => {
    if (!preview) return;
    setBusy("restore");
    setMsg(null);
    // The dialog has checked the typed phrase (any case); the server wants it exactly.
    const r = await adminFetch<{ result: { written: number; removed: number; preRestoreId: string }; undo: { snapshotId: string; prefixes: string[] } }>("/api/admin/ops/backups/restore", {
      method: "POST",
      json: { snapshotId: preview.snapshotId, prefixes: preview.prefixes, mode: "apply", confirm: preview.phrase },
    });
    setBusy(null);
    setAsk(null);
    if (!r.ok) return setMsg({ kind: "err", text: `The restore did not run. ${errorText(r)}` });
    setMsg({
      kind: "ok",
      text: `Restored: ${fmtNumber(r.data.result.written)} keys written, ${fmtNumber(r.data.result.removed)} removed. The state before is saved as ${r.data.result.preRestoreId}.`,
    });
    setUndo(r.data.undo);
    setPreview(null);
    await load();
  };

  return (
    <div>
      <PageHeader
        title="Backups"
        sub="The app's own daily snapshot of KV, stored in R2. It is a second line, not the primary backup."
        actions={
          write &&
          data && (
            <>
              <button type="button" className={btn.primary} disabled={!!busy || !data.r2Configured} onClick={() => setAsk({ kind: "snapshot" })}>
                {busy === "snap" ? "Taking snapshot…" : "Snapshot now"}
              </button>
              {!data.r2Configured && <span className="text-xs text-zinc-400">R2 is not configured, so no snapshot can be taken.</span>}
            </>
          )
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <LoadState data={data} error={loadErr} onRetry={load}>
        {(d) => {
          const usable = d.backups.filter((b) => !b.truncated && b.verify?.ok);
          return (
            <>
              <Panel className="mb-4 text-sm text-zinc-400">
                <p>
                  <b className="text-zinc-200">Upstash&apos;s own backups and restore are only available in the Upstash console</b> (console.upstash.com → the database → Backups);
                  the app cannot start, list or restore them. The snapshots here are copied by the app: every key except caches, rate limits, presence and locks (
                  <span className="break-all font-mono text-xs">{d.config.exclude.join(" ")}</span>), compressed, with a SHA-256 checksum, read back and verified after writing.
                  Capped at {fmtNumber(d.config.maxKeys)} keys / {fmtBytes(d.config.maxRawBytes)}; the newest {d.config.keep} snapshots and {d.config.keepPreRestore} pre-restore
                  snapshots are kept.
                </p>
              </Panel>

              {d.backups.length === 0 ? (
                <Empty>No snapshots yet. The first is taken at 03:30 UTC{write ? ", or now with Snapshot now" : ""}.</Empty>
              ) : (
                <TableWrap minWidth={720}>
                  <thead className="text-xs text-zinc-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">Snapshot</th>
                      <th className="px-3 py-2 font-medium">Keys</th>
                      <th className="px-3 py-2 font-medium">Size</th>
                      <th className="px-3 py-2 font-medium">SHA-256</th>
                      <th className="px-3 py-2 font-medium">Verified</th>
                      <th className="px-3 py-2 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.backups.map((b) => (
                      <tr key={b.id} className="border-t border-white/5 align-top">
                        <td className="px-3 py-2">
                          <span className="font-mono text-xs text-zinc-200">{b.id}</span>
                          <div className="text-xs text-zinc-400">
                            {b.kind} · <Time ts={b.createdAt} mode="relative" /> · {b.createdBy}
                            {b.prefixes ? ` · ${b.prefixes.join(", ")}` : ""}
                            {b.restoreOf ? ` · before restoring ${b.restoreOf}` : ""}
                          </div>
                          {b.truncated && <Badge tone="amber">Incomplete: {b.truncatedReason}</Badge>}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-300">{fmtNumber(b.keyCount)}</td>
                        <td className="px-3 py-2 font-mono text-zinc-300">
                          {fmtBytes(b.bytes)} <span className="text-xs text-zinc-400">({fmtBytes(b.rawBytes)} raw)</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-400" title={b.sha256}>
                          {b.sha256.slice(0, 12)}…<span className="sr-only">{b.sha256}</span>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {b.verify ? (
                            <span>
                              <StatusBadge status={b.verify.ok ? "ok" : "failed"} />{" "}
                              <span className="text-zinc-400">
                                <Time ts={b.verify.at} mode="relative" />
                              </span>
                              {!b.verify.ok && <span className="block text-red-200">{b.verify.detail}</span>}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {write && (
                            <button type="button" className={btn.ghost} disabled={!!busy} aria-label={`Verify ${b.id}`} onClick={() => setAsk({ kind: "verify", b })}>
                              {busy === b.id ? "Verifying…" : "Verify"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}

              <h2 className="mb-2 mt-6 text-lg font-semibold text-cyan-50">Restore</h2>
              {!d.canRestore ? (
                <Panel className="text-sm text-zinc-400">Only the platform owner can restore from a snapshot.</Panel>
              ) : (
                <Panel>
                  <p className="text-sm text-zinc-400">
                    Restore chosen key prefixes from a verified snapshot. A preview shows what would be added, changed and removed; applying it first saves the current state
                    of those prefixes as a pre-restore snapshot, so it can be undone. Never restored over: <span className="break-all font-mono text-xs">{d.config.protected.join(" ")}</span>.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="min-w-0 text-sm text-zinc-300">
                      Snapshot
                      <select className={`${field} mt-1`} value={snap} onChange={(e) => setSnap(e.target.value)}>
                        <option value="">Choose…</option>
                        {usable.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.id} — {b.kind}, {fmtTime(b.createdAt)}, {fmtNumber(b.keyCount)} keys
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="min-w-0 text-sm text-zinc-300">
                      Key prefixes (space or comma separated)
                      <input className={`${field} mt-1 font-mono`} placeholder="neo:event: neo:slug:" value={prefixText} onChange={(e) => setPrefixText(e.target.value)} />
                    </label>
                  </div>
                  {usable.length === 0 && <p className="mt-2 text-xs text-zinc-400">No complete, verified snapshot to restore from yet.</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button type="button" className={btn.ghost} disabled={!snap || !prefixText.trim() || !!busy} onClick={() => doPreview()}>
                      {busy === "preview" ? "Previewing…" : "Preview"}
                    </button>
                    {(!snap || !prefixText.trim()) && <span className="text-xs text-zinc-400">Choose a snapshot and the key prefixes to preview.</span>}
                    {undo && (
                      <button type="button" className={btn.warn} disabled={!!busy} onClick={() => doPreview(undo.snapshotId, undo.prefixes)}>
                        Undo the last restore (preview)
                      </button>
                    )}
                  </div>
                  {preview && (
                    <div className="mt-4 rounded-lg border border-white/10 p-3">
                      <p className="text-sm text-zinc-200">
                        Restoring <span className="break-all font-mono">{preview.prefixes.join(", ")}</span> from <span className="font-mono">{preview.snapshotId}</span>:{" "}
                        <b className="text-emerald-300">{fmtNumber(preview.p.counts.added)} added</b>, <b className="text-amber-300">{fmtNumber(preview.p.counts.changed)} changed</b>,{" "}
                        <b className="text-red-300">{fmtNumber(preview.p.counts.removed)} removed</b>, {fmtNumber(preview.p.unchanged)} unchanged
                        {preview.p.protectedSkipped ? `, ${fmtNumber(preview.p.protectedSkipped)} protected skipped` : ""}
                        {preview.p.counts.erasedSkipped ? `, ${fmtNumber(preview.p.counts.erasedSkipped)} left as they are (erased accounts)` : ""}.
                      </p>
                      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                        {(["added", "changed", "removed"] as const).map((k) => (
                          <div key={k} className="min-w-0">
                            <h3 className="font-medium text-zinc-400">{k}</h3>
                            <ul className="mt-1 max-h-40 overflow-auto font-mono text-zinc-400">
                              {preview.p[k].map((key) => (
                                <li key={key} className="truncate" title={key}>
                                  {key}
                                </li>
                              ))}
                              {preview.p.counts[k] > preview.p[k].length && <li>… and {fmtNumber(preview.p.counts[k] - preview.p[k].length)} more</li>}
                            </ul>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        <button type="button" className={btn.ghost} disabled={busy === "restore"} onClick={() => setPreview(null)}>
                          Discard preview
                        </button>
                        <button type="button" className={btn.danger} disabled={!!busy} onClick={() => setAsk({ kind: "restore" })}>
                          {busy === "restore" ? "Restoring…" : "Apply restore…"}
                        </button>
                      </div>
                    </div>
                  )}
                </Panel>
              )}
            </>
          );
        }}
      </LoadState>

      {ask?.kind === "snapshot" && (
        <Confirm
          title="Take a snapshot now?"
          body="Copies KV into a new snapshot in R2 and verifies it. Retention then applies, so the oldest snapshot beyond the number kept is deleted."
          confirmLabel="Snapshot now"
          onConfirm={snapshotNow}
          onCancel={() => setAsk(null)}
        />
      )}
      {ask?.kind === "verify" && (
        <Confirm
          title={`Verify ${ask.b.id}?`}
          body="Reads the snapshot back from R2 and checks its SHA-256 checksum and key count. It changes nothing but the verification record."
          confirmLabel="Verify"
          onConfirm={() => verify(ask.b)}
          onCancel={() => setAsk(null)}
        />
      )}
      {ask?.kind === "restore" && preview && (
        <Confirm
          title="Apply this restore?"
          body={
            <>
              <span className="break-all font-mono text-zinc-200">{preview.prefixes.join(", ")}</span> is overwritten from <span className="font-mono text-zinc-200">{preview.snapshotId}</span>:{" "}
              {fmtNumber(preview.p.counts.added)} added, {fmtNumber(preview.p.counts.changed)} changed, {fmtNumber(preview.p.counts.removed)} removed. The current state of those
              prefixes is saved first as a pre-restore snapshot, so it can be undone. It asks for a fresh authenticator code.
            </>
          }
          confirmLabel="Apply restore"
          danger
          typeToConfirm={preview.phrase}
          onConfirm={apply}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}
