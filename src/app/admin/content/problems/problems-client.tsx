"use client";

// Content > Problems: failed uploads and processing, stuck processing,
// files missing from storage, orphans and likely duplicates, each with
// the actions that are safe for it. Nothing here deletes: "Move to trash"
// can be undone until the trash window closes.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PROBLEM_KINDS, type ProblemKind } from "@/lib/content/model";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
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
  const [kind, setKind] = useState<ProblemKind | "">("");
  const [stuck, setStuck] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ fileId: string; action: "trash" | "forget"; problem: ProblemKind } | null>(null);

  const load = useCallback(async () => {
    setData(null);
    const p = new URLSearchParams();
    if (kind) p.set("kind", kind);
    if (Number(stuck) > 0) p.set("stuckMinutes", String(Number(stuck)));
    const r = await adminFetch<Resp>(`/api/admin/content/problems?${p}`);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setData(r.data);
  }, [adminFetch, kind, stuck]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fileId: string, action: ProblemAction, problem: ProblemKind, reason = "") => {
    setMsg(null);
    if (action === "relink" && problem === "orphan") {
      const owner = window.prompt("Owner account id for this file (user_…). Leave empty to only check storage.") ?? null;
      if (owner === null) return;
      return send(fileId, { action, ownerId: owner.trim() || undefined });
    }
    return send(fileId, { action, problem, reason: reason || `From Problems: ${problem}` });
  };
  const send = async (fileId: string, json: Record<string, unknown>) => {
    const r = await adminFetch<{ inStorage?: boolean | null }>(`/api/admin/content/files/${fileId}/action`, { method: "POST", json });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: `Done.${r.data.inStorage === false ? " Not found in storage." : r.data.inStorage ? " Found in storage." : ""}` });
    load();
  };

  return (
    <div>
      <PageHeader title="Content" sub="Problems in stored files, and what can safely be done about each." />
      <ContentTabs />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setKind("")} className={kind === "" ? btn.primary : btn.ghost}>
          All {data ? `(${Object.values(data.counts).reduce((a, b) => a + b, 0)})` : ""}
        </button>
        {PROBLEM_KINDS.map((k) => (
          <button key={k.id} type="button" onClick={() => setKind(k.id)} className={kind === k.id ? btn.primary : btn.ghost}>
            {k.label} {data ? `(${data.counts[k.id]})` : ""}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
          Stuck after
          <input value={stuck} onChange={(e) => setStuck(e.target.value)} inputMode="numeric" placeholder="per type" className={`${field} w-24`} aria-label="Stuck after minutes" />
          minutes
        </label>
      </div>
      {kind && <p className="mb-3 text-xs text-zinc-500">{HELP[kind]}</p>}
      {data && !data.missingCheck && (kind === "" || kind === "missing") && (
        <p className="mb-3 text-xs text-amber-300">Files missing from storage show here only after a complete storage scan (Files → Scan storage).</p>
      )}
      {!data ? (
        <Loading />
      ) : data.problems.length === 0 ? (
        <Empty>No problems found.</Empty>
      ) : (
        <ul className="space-y-3">
          {data.problems.map((p) => (
            <li key={p.id}>
              <Panel>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-white">
                    {PROBLEM_KINDS.find((k) => k.id === p.kind)?.label}: <span className="font-normal text-zinc-300">{p.detail}</span>
                  </p>
                  <span className="text-xs text-zinc-500">{fmtTime(p.at)}</span>
                </div>
                <ul className="mt-2 divide-y divide-white/5">
                  {p.files.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="min-w-0">
                        <Link href={`/admin/content/files/${f.id}`} className="block truncate text-cyan-200 hover:underline" title={f.key}>
                          {fileLabel(f)}
                        </Link>
                        <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          <TypeLabel t={f.type} /> · <Bytes n={f.size} /> · <OwnerLink id={f.ownerId} /> · <StatusBadge s={f.status} detail={f.statusDetail} />
                        </span>
                      </span>
                      {can("content:moderate") && (
                        <span className="flex flex-wrap gap-1.5">
                          {p.actions.map((a) => (
                            <button
                              key={a}
                              type="button"
                              className={a === "trash" || a === "forget" ? btn.danger : btn.ghost}
                              onClick={() => (a === "trash" || a === "forget" ? setConfirm({ fileId: f.id, action: a, problem: p.kind }) : run(f.id, a, p.kind))}
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
      )}
      {confirm && (
        <Confirm
          title={confirm.action === "trash" ? "Move to trash" : "Remove from the index"}
          body={
            confirm.action === "trash"
              ? "It leaves every list and public page. Nothing is deleted from storage now; it can be restored until the trash window closes."
              : "Only possible when the file is no longer in storage: its index entry is removed. The audit log keeps what it was."
          }
          confirmLabel={confirm.action === "trash" ? "Move to trash" : "Remove"}
          danger
          withReason="Why (kept in the audit log)"
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            const c = confirm;
            setConfirm(null);
            run(c.fileId, c.action, c.problem, reason);
          }}
        />
      )}
    </div>
  );
}
