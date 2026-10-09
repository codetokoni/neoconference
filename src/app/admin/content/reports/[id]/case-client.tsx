"use client";

// Content > Reports > a case: the reports, what was done and why, notes,
// and the actions — hide or trash the content, restore it, warn the owner
// in the app, or suspend the owner's account (phase 2's Suspend, recorded
// on the case). The owner is never told who reported.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtNumber, fmtTime, useAdmin } from "../../../AdminApi";
import { Badge, Confirm, EmptyLine, Loading, Notice, PageHeader, Panel, btn, field } from "../../../ui";
import { ContentTabs, StateBadge } from "../../content-ui";
import { reasonLabel, type CaseRow } from "../reports-client";

type CaseDetail = CaseRow & {
  reports: { id: string; at: number; reason: string; details: string; reporter: { userId?: string; anonymous?: boolean; hidden?: boolean }; sameSourceCount: number }[];
  history: { at: number; byEmail: string; action: string; note?: string }[];
  notes: { id: string; at: number; byEmail: string; text: string }[];
};
type Resp = { case: CaseDetail; target: { file: { id: string; state: "active" | "hidden" | "trashed"; name?: string; key: string } | null; eventHidden: boolean } };

type Ask = { action: "hide" | "trash" | "dismiss" | "suspend" | "unhide" | "restore" | "reopen" | "warn"; title: string; body: string; label: string; danger?: boolean } | null;
// These carry a note to the case; the others are plain confirmations.
const WITH_NOTE = new Set(["hide", "trash", "dismiss", "suspend"]);

export default function CaseClient({ id }: { id: string }) {
  const { can, adminFetch } = useAdmin();
  const [d, setD] = useState<Resp | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [note, setNote] = useState("");
  const [warning, setWarning] = useState("");
  const [ask, setAsk] = useState<Ask>(null);
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<Resp>(`/api/admin/content/reports/${encodeURIComponent(id)}`);
    if (!r.ok) return setLoadErr(r.data.message ?? `HTTP ${r.status}`);
    setD(r.data);
  }, [adminFetch, id]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (action: string, extra: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMsg(null);
    const r = await adminFetch(`/api/admin/content/reports/${encodeURIComponent(id)}`, { method: "POST", json: { action, ...extra } });
    setBusy(false);
    if (!r.ok) {
      if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
      return false;
    }
    setMsg({ kind: "ok", text: (r.data as { unchanged?: boolean }).unchanged ? "Nothing to change." : done });
    load();
    return true;
  };

  // Suspension is phase 2's action, with its own checks (owner protected,
  // not yourself, rank); the case then records that it happened.
  const suspendOwner = async (reason: string) => {
    if (!d?.case.ownerId) return;
    setBusy(true);
    setMsg(null);
    const r = await adminFetch(`/api/admin/users/${encodeURIComponent(d.case.ownerId)}/suspend`, {
      method: "POST",
      json: { reason: `Content report ${d.case.id}: ${reason}` },
    });
    setBusy(false);
    if (!r.ok) {
      if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? `Could not suspend (HTTP ${r.status}).` });
      return;
    }
    await act("escalate", { note: reason }, "The owner's account is suspended and the case records it.");
  };

  if (!d) {
    return (
      <div>
        <PageHeader title="Content" />
        <ContentTabs />
        {loadErr ? (
          <Notice kind="err" onRetry={load}>
            {loadErr}
          </Notice>
        ) : (
          <Loading />
        )}
      </div>
    );
  }
  const c = d.case;
  const file = d.target.file;
  const hidden = file ? file.state === "hidden" : d.target.eventHidden;
  const trashed = file?.state === "trashed";
  const moderate = can("content:moderate");

  return (
    <div>
      <PageHeader
        title={c.label}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={c.status === "open" ? "amber" : c.status === "actioned" ? "green" : "zinc"}>{c.status}</Badge>
            {c.targetType === "event" ? (
              <a href={`/e/${encodeURIComponent(c.eventSlug ?? "")}/replay`} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline">
                Meeting replay
              </a>
            ) : file ? (
              <Link href={`/admin/content/files/${file.id}`} className="text-cyan-300 underline">
                The reported file
              </Link>
            ) : (
              "The file is no longer indexed"
            )}
            {file && <StateBadge s={file.state} />}
            {!file && hidden && <Badge tone="amber">hidden</Badge>}
            {c.ownerId && (
              <Link href={`/admin/users/${encodeURIComponent(c.ownerId)}`} className="text-zinc-300 underline">
                Owner&apos;s account
              </Link>
            )}
          </span>
        }
      />
      <ContentTabs />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {loadErr && (
        <Notice kind="err" onRetry={load}>
          {loadErr}
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Panel>
            <h2 className="text-sm font-semibold text-white">
              {fmtNumber(c.reportCount)} report{c.reportCount === 1 ? "" : "s"}
            </h2>
            <ul className="mt-2 divide-y divide-white/5">
              {c.reports.map((r) => (
                <li key={r.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-zinc-100">{reasonLabel(r.reason)}</span>
                    <span className="text-xs text-zinc-400">{fmtTime(r.at)}</span>
                  </div>
                  {r.details && <p className="mt-1 whitespace-pre-wrap text-zinc-300">{r.details}</p>}
                  <p className="mt-1 text-xs text-zinc-400">
                    {r.reporter.hidden ? "Reporter hidden for your role" : r.reporter.userId ? `Signed in: ${r.reporter.userId}` : "Signed out"}
                    {r.sameSourceCount > 1 ? ` · ${r.sameSourceCount} reports on this case from the same address` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel>
            <h2 className="text-sm font-semibold text-white">History</h2>
            {c.history.length === 0 ? (
              <EmptyLine>Nothing done yet.</EmptyLine>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm">
                {c.history.map((h, i) => (
                  <li key={i} className="text-zinc-300">
                    <span className="text-xs text-zinc-400">{fmtTime(h.at)}</span> · <b className="font-medium">{h.action}</b> by {h.byEmail}
                    {h.note ? <span className="text-zinc-400"> — {h.note}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel>
            <h2 className="text-sm font-semibold text-white">Notes</h2>
            {c.notes.map((n) => (
              <p key={n.id} className="mt-2 text-sm text-zinc-300">
                <span className="text-xs text-zinc-400">
                  {fmtTime(n.at)} · {n.byEmail}
                </span>
                <br />
                {n.text}
              </p>
            ))}
            {moderate && (
              <form
                className="mt-3 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (note.trim() && (await act("note", { note: note.trim() }, "Note added."))) setNote("");
                }}
              >
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for other administrators" aria-label="Note for other administrators" className={`${field} min-w-0 flex-1`} maxLength={1000} />
                <button type="submit" className={btn.ghost} disabled={busy || !note.trim()}>
                  Add
                </button>
              </form>
            )}
          </Panel>
        </div>
        {moderate && (
          <div className="space-y-4">
            <Panel>
              <h2 className="text-sm font-semibold text-white">The content</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {!hidden && !trashed && (
                  <button type="button" className={btn.warn} disabled={busy} onClick={() => setAsk({ action: "hide", title: "Hide from public view", body: "It stops showing on the replay page, the explore page and share links. The owner and hosts still see it. You can put it back.", label: "Hide" })}>
                    Hide / unpublish
                  </button>
                )}
                {hidden && (
                  <button type="button" className={btn.ghost} disabled={busy} onClick={() => setAsk({ action: "unhide", title: "Put it back on public view?", body: "It shows again on the replay page, the explore page and share links, wherever its own settings allow.", label: "Put it back" })}>
                    Put it back
                  </button>
                )}
                {file && !trashed && (
                  <button type="button" className={btn.danger} disabled={busy} onClick={() => setAsk({ action: "trash", title: "Move to trash", body: "It leaves every list and public page. It goes to the trash, where it can be restored until the trash window closes; after that the retention purge removes it.", label: "Move to trash", danger: true })}>
                    Move to trash
                  </button>
                )}
                {trashed && (
                  <button type="button" className={btn.primary} disabled={busy} onClick={() => setAsk({ action: "restore", title: "Restore it from the trash?", body: "The file goes back to where it was, in the state it had before it was trashed.", label: "Restore" })}>
                    Restore
                  </button>
                )}
              </div>
            </Panel>
            <Panel>
              <h2 className="text-sm font-semibold text-white">The owner</h2>
              {c.ownerId ? (
                <>
                  <form
                    className="mt-2 space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      // The warning reaches the owner directly, so it is confirmed first.
                      if (warning.trim()) setAsk({ action: "warn", title: "Send this warning to the owner?", body: `“${warning.trim()}” — an in-app notification. It does not say who reported.`, label: "Send warning" });
                    }}
                  >
                    <label className="block text-xs text-zinc-400">
                      Warn the owner (an in-app notification; it does not say who reported)
                      <textarea value={warning} onChange={(e) => setWarning(e.target.value)} rows={3} maxLength={500} className={`${field} mt-1`} />
                    </label>
                    <button type="submit" className={btn.ghost} disabled={busy || !warning.trim()}>
                      Send warning
                    </button>
                  </form>
                  {can("users:suspend") && (
                    <button
                      type="button"
                      className={`${btn.danger} mt-3`}
                      disabled={busy}
                      onClick={() => setAsk({ action: "suspend", title: "Suspend the owner's account", body: "Their account is banned and every session ends (Users → Suspend). Reactivate it from their Users page.", label: "Suspend account", danger: true })}
                    >
                      Suspend the owner
                    </button>
                  )}
                </>
              ) : (
                <p className="mt-1 text-sm text-zinc-400">No owner on record.</p>
              )}
            </Panel>
            <Panel>
              <h2 className="text-sm font-semibold text-white">The case</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {c.status !== "dismissed" && (
                  <button type="button" className={btn.ghost} disabled={busy} onClick={() => setAsk({ action: "dismiss", title: "Dismiss the case", body: "Closes it without action. New reports still add to it.", label: "Dismiss" })}>
                    Dismiss
                  </button>
                )}
                {c.status !== "open" && (
                  <button type="button" className={btn.ghost} disabled={busy} onClick={() => setAsk({ action: "reopen", title: "Reopen the case?", body: "It goes back into the open queue.", label: "Reopen" })}>
                    Reopen
                  </button>
                )}
              </div>
            </Panel>
          </div>
        )}
      </div>
      {ask && (
        <Confirm
          title={ask.title}
          body={ask.body}
          confirmLabel={ask.label}
          danger={ask.danger}
          typeToConfirm={ask.action === "suspend" ? "suspend" : undefined}
          withReason={WITH_NOTE.has(ask.action) ? "Why (kept on the case and in the audit log)" : undefined}
          onCancel={() => setAsk(null)}
          onConfirm={async (reason) => {
            const a = ask.action;
            if (a === "suspend") await suspendOwner(reason || "Reported content");
            else if (a === "unhide") await act("unhide", {}, "Published again.");
            else if (a === "restore") await act("restore", {}, "Restored from the trash.");
            else if (a === "reopen") await act("reopen", {}, "Reopened.");
            else if (a === "warn") {
              if (await act("warn", { message: warning.trim() }, "The owner has been sent your message in the app.")) setWarning("");
            } else await act(a, { note: reason }, a === "hide" ? "Hidden from public view." : a === "trash" ? "Moved to the trash." : "Dismissed.");
            setAsk(null);
          }}
        />
      )}
    </div>
  );
}
