"use client";

// Content > a file: everything the index knows about it, and what can be
// done to it. Opening a private file's contents needs an open support
// session on its owner — the page says so before anyone tries.

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fmtTime, useAdmin } from "../../../AdminApi";
import { Badge, Confirm, Loading, Notice, PageHeader, Panel, btn, field } from "../../../ui";
import { Bytes, ContentTabs, OwnerLink, Related, StateBadge, StatusBadge, TypeLabel, VisibilityBadge, fileLabel, type FileRow } from "../../content-ui";

type Detail = {
  file: FileRow;
  owner: { id: string; email: string; name: string } | null;
  cases: { id: string; status: string; reportCount: number; label: string; updatedAt: number }[];
  stats: { views: number; downloads: number; shares: number } | null;
  restoreUntil: number | null;
  access: { private: boolean; canSupport: boolean; supportOpenOnOwner: boolean; viewable: boolean };
};

type Pending = { action: "hide" | "trash"; title: string } | null;

export default function FileClient({ id }: { id: string }) {
  const { can, adminFetch } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [opened, setOpened] = useState<{ url?: string; text?: string } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [ownerId, setOwnerId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await adminFetch<Detail>(`/api/admin/content/files/${encodeURIComponent(id)}`);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setD(r.data);
  }, [adminFetch, id]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (action: string, extra: Record<string, unknown> = {}, done?: string) => {
    setBusy(true);
    setMsg(null);
    const r = await adminFetch<{ inStorage?: boolean | null }>(`/api/admin/content/files/${encodeURIComponent(id)}/action`, { method: "POST", json: { action, ...extra } });
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: done ?? "Done." + (r.data.inStorage === false ? " It is not in storage." : r.data.inStorage ? " It is in storage." : "") });
    load();
  };

  const open = async () => {
    setMsg(null);
    setOpened(null);
    const r = await adminFetch<{ kind: "url" | "text"; url?: string; text?: string }>(`/api/admin/content/files/${encodeURIComponent(id)}/open`, { method: "POST" });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setOpened(r.data.kind === "url" ? { url: r.data.url } : { text: r.data.text });
  };

  if (!d) {
    return (
      <div>
        <PageHeader title="Content" />
        <ContentTabs />
        {msg ? <Notice kind={msg.kind}>{msg.text}</Notice> : <Loading />}
      </div>
    );
  }
  const f = d.file;
  const moderate = can("content:moderate");
  const needsSession = d.access.private;
  const row = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-words text-zinc-200">{value}</dd>
    </div>
  );

  return (
    <div>
      <PageHeader title={fileLabel(f)} sub={<TypeLabel t={f.type} />} />
      <ContentTabs />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Panel>
          <dl className="divide-y divide-white/5">
            {row("Owner", <OwnerLink id={f.ownerId} label={d.owner ? d.owner.name || d.owner.email : null} />)}
            {row("Belongs to", f.eventSlug || f.groupId || f.ticketId ? <Related f={f} /> : "—")}
            {row("Size", <Bytes n={f.size} />)}
            {row("Type", f.contentType)}
            {row("Status", (
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge s={f.status} detail={f.statusDetail} />
                {f.statusDetail && <span className="text-xs text-zinc-400">{f.statusDetail}</span>}
                <span className="text-xs text-zinc-500">since {fmtTime(f.statusAt)}</span>
              </span>
            ))}
            {row("Visibility", (
              <span className="flex flex-wrap items-center gap-2">
                <VisibilityBadge v={f.effectiveVisibility} />
                {f.effectiveVisibility !== f.visibility && <span className="text-xs text-zinc-500">(the meeting&apos;s replay is open; the file itself is {f.visibility})</span>}
              </span>
            ))}
            {row("Moderation", f.state === "active" ? "Published" : (
              <span className="flex flex-wrap items-center gap-2">
                <StateBadge s={f.state} />
                <span className="text-xs text-zinc-400">
                  {fmtTime(f.stateAt)} — {f.stateReason || "no reason given"}
                </span>
              </span>
            ))}
            {d.restoreUntil && row("Restorable until", fmtTime(d.restoreUntil))}
            {row("Checksum", <code className="text-xs">{f.checksum || "—"}</code>)}
            {row("Created", fmtTime(f.createdAt))}
            {row("Where", <code className="text-xs">{f.storage === "r2" ? `R2 · ${f.key}` : `KV · ${f.key}`}</code>)}
            {row("Indexed from", f.source === "backfill" ? "a storage scan (its upload point did not record it)" : f.source)}
            {f.r2SeenAt ? row("Last seen in storage", fmtTime(f.r2SeenAt)) : null}
            {d.stats && row("Views / downloads / shares", `${d.stats.views} / ${d.stats.downloads} / ${d.stats.shares}`)}
            {f.ignored?.length ? row("Ignored problems", f.ignored.join(", ")) : null}
          </dl>
        </Panel>
        <div className="space-y-4">
          <Panel>
            <h2 className="text-sm font-semibold text-white">Contents</h2>
            {needsSession ? (
              <p className="mt-1 text-xs text-zinc-400">
                Private. Opening it needs the support-access permission and an open support session on{" "}
                {f.ownerId ? (
                  <Link href={`/admin/users/${encodeURIComponent(f.ownerId)}`} className="text-cyan-300 underline">
                    its owner&apos;s account
                  </Link>
                ) : (
                  "its owner (it has none — re-link it first)"
                )}
                . {d.access.supportOpenOnOwner ? <Badge tone="green">session open</Badge> : null} Every open is recorded.
              </p>
            ) : (
              <p className="mt-1 text-xs text-zinc-400">Shared or public, so it can be opened without a support session. Every open is recorded.</p>
            )}
            {d.access.viewable ? (
              <button type="button" className={`${btn.ghost} mt-3`} onClick={open} disabled={needsSession && (!d.access.canSupport || !d.access.supportOpenOnOwner)}>
                Open contents
              </button>
            ) : (
              <p className="mt-2 text-xs text-zinc-500">Kept with what it belongs to; not viewable here.</p>
            )}
            {opened?.url && (
              <p className="mt-2 text-xs">
                <a href={opened.url} target="_blank" rel="noreferrer noopener" className="text-cyan-300 underline">
                  Download (link valid 5 minutes)
                </a>
              </p>
            )}
            {opened?.text != null && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-xs text-zinc-200">{opened.text}</pre>}
          </Panel>
          {moderate && (
            <Panel>
              <h2 className="text-sm font-semibold text-white">Actions</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {f.state === "active" && (
                  <button type="button" className={btn.warn} disabled={busy} onClick={() => setPending({ action: "hide", title: "Hide from public pages" })}>
                    Hide
                  </button>
                )}
                {f.state === "hidden" && (
                  <button type="button" className={btn.ghost} disabled={busy} onClick={() => act("unhide", {}, "Published again.")}>
                    Unhide
                  </button>
                )}
                {f.state !== "trashed" ? (
                  <button type="button" className={btn.danger} disabled={busy} onClick={() => setPending({ action: "trash", title: "Move to trash" })}>
                    Move to trash
                  </button>
                ) : (
                  <button type="button" className={btn.primary} disabled={busy} onClick={() => act("restore", {}, "Restored.")}>
                    Restore
                  </button>
                )}
                {f.type === "transcript" && (f.status === "failed" || f.status === "pending" || f.status === "processing") && (
                  <button type="button" className={btn.ghost} disabled={busy} onClick={() => act("retry", {}, "Transcription started again.")}>
                    Retry transcription
                  </button>
                )}
              </div>
              <form
                className="mt-3 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  act("relink", ownerId.trim() ? { ownerId: ownerId.trim() } : {});
                }}
              >
                <label className="block text-xs text-zinc-400">
                  Re-link: check storage again{f.storage === "r2" ? "" : " (not in R2)"}, and optionally give it an owner
                  <input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="Owner account id (optional)" className={`${field} mt-1`} />
                </label>
                <button type="submit" className={btn.ghost} disabled={busy}>
                  Re-link
                </button>
              </form>
            </Panel>
          )}
          {d.cases.length > 0 && (
            <Panel>
              <h2 className="text-sm font-semibold text-white">Reports</h2>
              <ul className="mt-2 space-y-1 text-sm">
                {d.cases.map((c) => (
                  <li key={c.id}>
                    <Link href={`/admin/content/reports/${c.id}`} className="text-cyan-200 hover:underline">
                      {c.label}
                    </Link>{" "}
                    <Badge tone={c.status === "open" ? "amber" : "zinc"}>{c.status}</Badge> <span className="text-xs text-zinc-500">{c.reportCount} reports</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>
      {pending && (
        <Confirm
          title={pending.title}
          body={
            pending.action === "hide"
              ? "The file stops showing on replay pages and share links. The owner still sees it. You can unhide it."
              : "The file leaves every list and public page. It goes to the trash, where an administrator can restore it until the trash window closes; after that the retention purge removes it."
          }
          confirmLabel={pending.action === "hide" ? "Hide" : "Move to trash"}
          danger={pending.action === "trash"}
          withReason="Why (kept in the audit log)"
          onCancel={() => setPending(null)}
          onConfirm={(reason) => {
            const a = pending.action;
            setPending(null);
            act(a, { reason }, a === "hide" ? "Hidden from public pages." : "Moved to the trash.");
          }}
        />
      )}
    </div>
  );
}
