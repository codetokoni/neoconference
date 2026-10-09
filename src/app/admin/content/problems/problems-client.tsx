"use client";

// Content > Problems: failed uploads and processing, stuck processing,
// files missing from storage, orphans and likely duplicates, each with
// the actions that are safe for it. Nothing here deletes: "Move to trash"
// can be undone until the trash window closes.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PROBLEM_KINDS, type ProblemKind } from "@/lib/content/model";
import { fmtNumber, fmtTime, useAdmin } from "../../AdminApi";
import { Confirm, Dialog, Empty, FilterBar, Labeled, Loading, Notice, PageHeader, Pager, Panel, btn, field, useClientTable, useUrlFilters } from "../../ui";
import { Bytes, ContentTabs, OwnerLink, StatusBadge, TypeLabel, fileLabel, type FileRow } from "../content-ui";

type ProblemAction = "retry" | "relink" | "trash" | "ignore" | "forget";
type Problem = { kind: ProblemKind; id: string; fileIds: string[]; detail: string; actions: ProblemAction[]; at: number; files: FileRow[] };
type Resp = { counts: Record<ProblemKind, number>; problems: Problem[]; missingCheck: { at: number; objects: number } | null };

const ACTION_LABEL: Record<ProblemAction, string> = {
  retry: "Retry",
  relink: "Re-link",
  trash: "Move to trash",
  ignore: "Ignore",
  forget: "Remove from index",
};

const HELP: Record<ProblemKind, string> = {
  failed: "Uploads whose storage write failed, recordings LiveKit reported as failed, transcriptions that errored.",
  stuck: "Still pending or processing long after that kind of file normally finishes. Re-link checks storage; a transcription can be retried.",
  missing: "In the index and marked ready, but the last complete storage scan did not find it. Re-link checks again.",
  orphan: "In storage with no account the path names, or whose owner's account was deleted. Re-link gives it an owner.",
  duplicate: "The same bytes stored twice (same size and checksum), or recordings of one meeting made at overlapping times.",
};

export default function ProblemsClient() {
  const { can, adminFetch } = useAdmin();
  const filters = useUrlFilters({ kind: "", stuck: "" });
  const kind = (PROBLEM_KINDS.some((k) => k.id === filters.value.kind) ? filters.value.kind : "") as ProblemKind | "";
  const stuck = filters.value.stuck;
  const [stuckDraft, setStuckDraft] = useState(stuck);
  useEffect(() => setStuckDraft(stuck), [stuck]);
  const [data, setData] = useState<Resp | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ fileId: string; label: string; action: "trash" | "forget"; problem: ProblemKind } | null>(null);
  const [relink, setRelink] = useState<{ fileId: string; label: string } | null>(null);
  const [owner, setOwner] = useState("");
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    const p = new URLSearchParams();
    if (kind) p.set("kind", kind);
    if (Number(stuck) > 0) p.set("stuckMinutes", String(Number(stuck)));
    const r = await adminFetch<Resp>(`/api/admin/content/problems?${p}`);
    setLoading(false);
    if (!r.ok) return setLoadErr(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch, kind, stuck]);
  useEffect(() => {
    load();
  }, [load]);

  const t = useClientTable(data?.problems, (p) => p.at, { key: "at", dir: "desc", pageSize: 25 });

  const send = async (fileId: string, json: Record<string, unknown>) => {
    setMsg(null);
    setRunning(fileId);
    const r = await adminFetch<{ inStorage?: boolean | null }>(`/api/admin/content/files/${fileId}/action`, { method: "POST", json });
    setRunning(null);
    if (!r.ok) {
      if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
      return;
    }
    setMsg({ kind: "ok", text: `Done.${r.data.inStorage === false ? " Not found in storage." : r.data.inStorage ? " Found in storage." : ""}` });
    load();
  };
  const run = (f: FileRow, action: ProblemAction, problem: ProblemKind, reason = "") => {
    if (action === "relink" && problem === "orphan") {
      setOwner("");
      setRelink({ fileId: f.id, label: fileLabel(f) });
      return;
    }
    return send(f.id, { action, problem, reason: reason || `From Problems: ${problem}` });
  };

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : null;

  return (
    <div>
      <PageHeader title="Content" sub="Problems in stored files, and what can safely be done about each." />
      <ContentTabs />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <FilterBar active={filters.active} onClear={filters.reset}>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Kind of problem">
          <button type="button" aria-pressed={kind === ""} onClick={() => filters.set({ kind: "" })} className={kind === "" ? btn.primary : btn.ghost}>
            All {total != null ? `(${fmtNumber(total)})` : ""}
          </button>
          {PROBLEM_KINDS.map((k) => (
            <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => filters.set({ kind: k.id })} className={kind === k.id ? btn.primary : btn.ghost}>
              {k.label} {data ? `(${fmtNumber(data.counts[k.id])})` : ""}
            </button>
          ))}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            filters.set({ stuck: stuckDraft.trim() });
          }}
        >
          <Labeled label="Stuck after (minutes)" className="w-32">
            <input value={stuckDraft} onChange={(e) => setStuckDraft(e.target.value)} inputMode="numeric" placeholder="per type" className={field} />
          </Labeled>
          <button type="submit" className={btn.ghost}>
            Apply
          </button>
        </form>
      </FilterBar>
      {kind && <p className="mb-3 text-xs text-zinc-400">{HELP[kind]}</p>}
      {data && !data.missingCheck && (kind === "" || kind === "missing") && (
        <p className="mb-3 text-xs text-amber-300">Files missing from storage show here only after a complete storage scan (Files → Scan storage).</p>
      )}
      {loadErr && (
        <Notice kind="err" onRetry={load}>
          {loadErr}
        </Notice>
      )}
      {!data ? (
        !loadErr && <Loading />
      ) : data.problems.length === 0 ? (
        <Empty>No problems found.</Empty>
      ) : (
        <div aria-busy={loading} className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <ul className="space-y-3">
            {t.visible.map((p) => (
              <li key={p.id}>
                <Panel>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-medium text-white">
                      {PROBLEM_KINDS.find((k) => k.id === p.kind)?.label}: <span className="font-normal text-zinc-300">{p.detail}</span>
                    </p>
                    <span className="text-xs text-zinc-400">{fmtTime(p.at)}</span>
                  </div>
                  <ul className="mt-2 divide-y divide-white/5">
                    {p.files.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span className="min-w-0">
                          <Link href={`/admin/content/files/${f.id}`} className="block truncate text-cyan-200 hover:underline" title={f.key}>
                            {fileLabel(f)}
                          </Link>
                          <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                            <TypeLabel t={f.type} /> · <Bytes n={f.size} /> · <OwnerLink id={f.ownerId} /> · <StatusBadge s={f.status} detail={f.statusDetail} />
                          </span>
                        </span>
                        {can("content:moderate") && (
                          <span className="flex flex-wrap gap-1.5">
                            {p.actions.map((a) => (
                              <button
                                key={a}
                                type="button"
                                disabled={running === f.id}
                                aria-label={`${ACTION_LABEL[a]}: ${fileLabel(f)}`}
                                className={a === "trash" || a === "forget" ? btn.danger : btn.ghost}
                                onClick={() => (a === "trash" || a === "forget" ? setConfirm({ fileId: f.id, label: fileLabel(f), action: a, problem: p.kind }) : run(f, a, p.kind))}
                              >
                                {ACTION_LABEL[a]}
                              </button>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </Panel>
              </li>
            ))}
          </ul>
          <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="problem" />
        </div>
      )}
      {confirm && (
        <Confirm
          title={confirm.action === "trash" ? "Move to trash" : "Remove from the index"}
          body={
            <>
              <span className="block break-all text-zinc-300">{confirm.label}</span>
              <span className="mt-2 block">
                {confirm.action === "trash"
                  ? "It leaves every list and public page. It goes to the trash, where it can be restored until the trash window closes; after that the retention purge removes it."
                  : "Only possible when the file is no longer in storage: its index entry is removed for good. The audit log keeps what it was."}
              </span>
            </>
          }
          confirmLabel={confirm.action === "trash" ? "Move to trash" : "Remove"}
          danger
          typeToConfirm={confirm.action === "forget" ? "remove" : undefined}
          withReason="Why (kept in the audit log)"
          onCancel={() => setConfirm(null)}
          onConfirm={async (reason) => {
            await send(confirm.fileId, { action: confirm.action, problem: confirm.problem, reason: reason || `From Problems: ${confirm.problem}` });
            setConfirm(null);
          }}
        />
      )}
      {relink && (
        <Dialog title="Re-link this file" onClose={() => setRelink(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await send(relink.fileId, { action: "relink", ownerId: owner.trim() || undefined });
              setRelink(null);
            }}
          >
            <p className="mt-1 break-all text-sm text-zinc-400">{relink.label}</p>
            <p className="mt-2 text-sm text-zinc-400">Storage is checked again. Give it an owner to hand it to that account, or leave the box empty to only check storage.</p>
            <label className="mt-3 block text-sm text-zinc-300">
              Owner account id (optional)
              <input autoFocus value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="user_…" className={`${field} mt-1`} />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={btn.ghost} onClick={() => setRelink(null)}>
                Cancel
              </button>
              <button type="submit" className={btn.primary} disabled={running === relink.fileId}>
                {running === relink.fileId ? "Working…" : owner.trim() ? "Re-link to this owner" : "Check storage"}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
