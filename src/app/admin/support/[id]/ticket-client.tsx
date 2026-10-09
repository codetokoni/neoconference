"use client";

// src/app/admin/support/[id]/ticket-client.tsx — one ticket: the conversation
// with internal notes between it, the reply / note composer, the ticket's
// properties, its response targets, the account behind it and that account's
// other tickets.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  fmtDuration,
  type InternalNote,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/support/model";
import { errorText, fmtDate, fmtMoney, fmtNumber, fmtTime, useAdmin } from "../../AdminApi";
import { Badge, LoadState, Notice, Panel, TabPanel, Tabs, btn, field } from "../../ui";
import { PriorityBadge, SlaBadge, StatusBadge, assigneeLabel, type Assignee, type Row } from "../shared";

type Attachment = { name: string; size: number; type: string; url: string | null };
type Message = { id: string; ts: number; author: "user" | "agent" | "system"; authorName: string; body: string; attachments: Attachment[] };
type Account = {
  found: boolean;
  userId: string | null;
  email: string;
  name: string | null;
  plan: string | null;
  planExpiresAt: number | null;
  payments: { ref: string; plan: string; amountEsp: number; status: string; paidAt: number; periodEnd: number }[];
  meetings: { id: string; slug: string; name: string; state: string; startMs: number }[];
  meetingCount: number;
  href: string;
};
type History = { id: string; number: number; subject: string; status: TicketStatus; priority: TicketPriority; createdAt: number; overdue: boolean };
type Detail = { ticket: Row; messages: Message[]; notes: InternalNote[]; account: Account; history: History[]; assignees: Assignee[]; now: number };

type Entry = { kind: "message"; ts: number; m: Message } | { kind: "note"; ts: number; n: InternalNote };
/** Feedback for an action, shown beside the control that did it (the sidebar is far from the top on a phone). */
type Feedback = { where: "props" | "composer"; kind: "ok" | "err"; text: string };

const MODES = [
  { id: "reply", label: "Public reply" },
  { id: "note", label: "Internal note" },
] as const;

export default function TicketClient({ id }: { id: string }) {
  const { can, adminFetch } = useAdmin();
  const write = can("support:write");
  const [d, setD] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [after, setAfter] = useState<TicketStatus>("pending_user");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState("");

  const load = useCallback(async () => {
    const r = await adminFetch<Detail>(`/api/admin/support/tickets/${encodeURIComponent(id)}`);
    if (!r.ok) return setLoadErr(errorText(r));
    setLoadErr(null);
    setD(r.data);
    setTags(r.data.ticket.tags.join(", "));
  }, [adminFetch, id]);
  useEffect(() => {
    load();
  }, [load]);

  const patch = async (json: Record<string, unknown>, label: string) => {
    setFeedback(null);
    setSaving(true);
    const r = await adminFetch(`/api/admin/support/tickets/${encodeURIComponent(id)}`, { method: "PATCH", json });
    if (!r.ok) {
      setSaving(false);
      return setFeedback({ where: "props", kind: "err", text: errorText(r) });
    }
    await load();
    setSaving(false);
    setFeedback({ where: "props", kind: "ok", text: label });
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    const r = await adminFetch<{ emailed?: boolean; emailError?: string | null; bell?: boolean }>(`/api/admin/support/tickets/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      json: mode === "reply" ? { kind: "reply", body: text, status: after } : { kind: "note", body: text },
    });
    setBusy(false);
    if (!r.ok) return setFeedback({ where: "composer", kind: "err", text: errorText(r) });
    setText("");
    setFeedback({
      where: "composer",
      kind: "ok",
      text:
        mode === "note"
          ? "Internal note added. The customer does not see it."
          : r.data.emailed
            ? `Reply sent and emailed${r.data.bell ? ", with a notification in their account" : ""}.`
            : `Reply saved${r.data.bell ? " and shown in their notifications" : ""}, but the email was not sent (${r.data.emailError}).`,
    });
    load();
  };

  const say = (where: Feedback["where"]) =>
    feedback?.where === where ? (
      <Notice kind={feedback.kind} onClose={() => setFeedback(null)}>
        {feedback.text}
      </Notice>
    ) : null;

  if (!d) {
    return (
      <div>
        <Link href="/admin/support" className="text-sm text-cyan-300">
          ← Tickets
        </Link>
        <div className="mt-3">
          <LoadState data={null} error={loadErr} onRetry={load}>
            {() => null}
          </LoadState>
        </div>
      </div>
    );
  }
  const t = d.ticket;
  const entries: Entry[] = [
    ...d.messages.map((m) => ({ kind: "message" as const, ts: m.ts, m })),
    ...d.notes.map((n) => ({ kind: "note" as const, ts: n.ts, n })),
  ].sort((a, b) => a.ts - b.ts);

  return (
    <div>
      <Link href="/admin/support" className="text-sm text-cyan-300 hover:text-cyan-200">
        ← Tickets
      </Link>
      <div className="mb-4 mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-cyan-50">
            <span className="font-mono text-base text-zinc-400">#{t.number}</span> {t.subject}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            <SlaBadge sla={t.sla} now={d.now} />
            <span>
              from {t.name} &lt;{t.email}&gt; · {t.source === "guest" ? "contact form, signed out" : t.source === "web" ? "contact form" : t.source === "chat" ? `NeoSupport chat${t.chatRef ? ` ${t.chatRef}` : ""}` : "opened by support"}
            </span>
          </p>
        </div>
      </div>
      {loadErr && (
        <Notice kind="err" onRetry={load}>
          Could not refresh this ticket: {loadErr}
        </Notice>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3">
          <ol className="space-y-3" aria-label="Conversation">
            {entries.map((e) =>
              e.kind === "note" ? (
                <li key={`n${e.n.id}`} className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-3">
                  <p className="text-xs text-amber-200/80">
                    <b>Internal note</b> · {e.n.authorEmail} · {fmtTime(e.n.ts)} · not visible to the customer
                  </p>
                  <p className="mt-1.5 whitespace-pre-line text-sm text-amber-50/90">{e.n.body}</p>
                </li>
              ) : e.m.author === "system" ? (
                <li key={e.m.id} className="text-center text-xs text-zinc-400">
                  {e.m.body} · {fmtTime(e.m.ts)}
                </li>
              ) : (
                <li key={e.m.id} className={`rounded-xl border p-3 ${e.m.author === "agent" ? "border-cyan-400/25 bg-cyan-400/[0.05]" : "border-white/10 bg-white/[0.03]"}`}>
                  <p className="text-xs text-zinc-400">
                    <b className="text-zinc-200">{e.m.authorName}</b> {e.m.author === "agent" ? "(support, public reply)" : "(customer)"} · {fmtTime(e.m.ts)}
                  </p>
                  <p className="mt-1.5 whitespace-pre-line text-sm text-zinc-100">{e.m.body}</p>
                  {e.m.attachments.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {e.m.attachments.map((a, i) => (
                        <li key={i}>
                          {a.url ? (
                            <a href={a.url} target="_blank" rel="noopener noreferrer" className="rounded border border-white/10 px-2 py-1 text-xs text-cyan-200 hover:bg-white/5">
                              📎 {a.name} ({Math.max(1, Math.round(a.size / 1024))} KB)
                            </a>
                          ) : (
                            <span className="text-xs text-zinc-400">📎 {a.name} (storage unavailable)</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ),
            )}
          </ol>

          {write && (
            <Panel>
              {say("composer")}
              <form onSubmit={send}>
                <Tabs label="Reply or note" tabs={MODES} value={mode} onChange={setMode} idBase="composer" />
                <TabPanel idBase="composer" value={mode}>
                  <textarea
                    aria-label={mode === "reply" ? "Reply to the customer" : "Internal note"}
                    required
                    rows={5}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={mode === "reply" ? `Emailed to ${t.email}${t.userId ? " and shown in their notifications" : ""}.` : "Only administrators see this."}
                    className={`${field} ${mode === "note" ? "border-amber-400/30" : ""}`}
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    {mode === "reply" && (
                      <label className="text-xs text-zinc-400">
                        Then set the status to{" "}
                        <select value={after} onChange={(e) => setAfter(e.target.value as TicketStatus)} className="ml-1 rounded-lg border border-white/12 bg-black/40 px-2 py-1 text-sm text-zinc-100">
                          {TICKET_STATUSES.filter((s) => s !== "new").map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button type="submit" disabled={busy || !text.trim()} className={mode === "note" ? btn.warn : btn.primary}>
                      {busy ? "Saving…" : mode === "reply" ? "Send reply" : "Add note"}
                    </button>
                  </div>
                </TabPanel>
              </form>
            </Panel>
          )}
        </div>

        <aside className="space-y-4">
          <Panel>
            <h2 className="mb-2 text-sm font-semibold text-zinc-100">Ticket</h2>
            {say("props")}
            {!write && <p className="mb-2 text-xs text-zinc-400">Changing a ticket needs the support:write permission.</p>}
            <dl className="space-y-2 text-sm" aria-busy={saving}>
              <Prop label="Status">
                <select aria-label="Status" disabled={!write || saving} value={t.status} onChange={(e) => patch({ status: e.target.value }, `Status set to ${STATUS_LABEL[e.target.value as TicketStatus]}.`)} className={field}>
                  {TICKET_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </Prop>
              <Prop label="Priority">
                <select aria-label="Priority" disabled={!write || saving} value={t.priority} onChange={(e) => patch({ priority: e.target.value }, `Priority set to ${PRIORITY_LABEL[e.target.value as TicketPriority]}.`)} className={field}>
                  {TICKET_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </Prop>
              <Prop label="Assignee">
                <select
                  aria-label="Assignee"
                  disabled={!write || saving}
                  value={t.assigneeId ?? ""}
                  onChange={(e) => patch({ assigneeId: e.target.value || null }, e.target.value ? `Assigned to ${assigneeLabel(e.target.value, d.assignees)}.` : "Unassigned.")}
                  className={field}
                >
                  <option value="">Unassigned</option>
                  {t.assigneeId && !d.assignees.some((a) => a.userId === t.assigneeId) && <option value={t.assigneeId}>{t.assigneeEmail ?? t.assigneeId} (no longer an assignee)</option>}
                  {d.assignees.map((a) => (
                    <option key={a.userId} value={a.userId}>
                      {a.name || a.email}
                      {a.isOwner ? " (owner)" : ""}
                    </option>
                  ))}
                </select>
              </Prop>
              <Prop label="Category">
                <select aria-label="Category" disabled={!write || saving} value={t.category} onChange={(e) => patch({ category: e.target.value }, "Category changed.")} className={field}>
                  {TICKET_CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Prop>
              <Prop label="Tags">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    patch({ tags: tags.split(",").map((x) => x.trim()).filter(Boolean) }, "Tags saved.");
                  }}
                  className="flex gap-1.5"
                >
                  <input
                    aria-label="Tags, separated by commas"
                    disabled={!write || saving}
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="comma, separated"
                    className={`${field} min-w-0`}
                  />
                  {write && (
                    <button type="submit" disabled={saving} className={btn.ghost} aria-label="Save tags">
                      Save
                    </button>
                  )}
                </form>
              </Prop>
            </dl>
          </Panel>

          <Panel>
            <h2 className="mb-2 text-sm font-semibold text-zinc-100">Response times</h2>
            <dl className="space-y-1 text-sm text-zinc-300">
              <Line label="Opened">{fmtTime(t.createdAt)}</Line>
              <Line label="First reply">
                {t.firstResponseAt ? (
                  <>
                    {fmtDuration(t.sla.firstResponseMs)} {t.sla.firstResponseBreached ? <Badge tone="amber">late</Badge> : <Badge tone="green">on time</Badge>}
                  </>
                ) : (
                  <>due {fmtTime(t.sla.firstResponseDue)}</>
                )}
              </Line>
              <Line label="Resolution">{t.sla.resolutionMs != null ? fmtDuration(t.sla.resolutionMs) : <>due {fmtTime(t.sla.resolutionDue)}</>}</Line>
            </dl>
          </Panel>

          <Panel>
            <h2 className="mb-2 text-sm font-semibold text-zinc-100">Account</h2>
            {d.account.found ? (
              <div className="space-y-2 text-sm text-zinc-300">
                <p>
                  <Link href={d.account.href} className="font-medium text-cyan-200 hover:text-cyan-100">
                    {d.account.name}
                  </Link>
                  <span className="block text-xs text-zinc-400">{d.account.email}</span>
                </p>
                <dl className="space-y-2">
                  <Line label="Plan">
                    <span className="capitalize">{d.account.plan}</span>
                  </Line>
                  <Line label="Plan ends">{d.account.planExpiresAt ? fmtTime(d.account.planExpiresAt) : "—"}</Line>
                </dl>
                <div>
                  <p className="text-xs text-zinc-400">Recent payments</p>
                  {d.account.payments.length ? (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {d.account.payments.map((p) => (
                        <li key={p.ref}>
                          <span title={fmtTime(p.paidAt)}>{fmtDate(p.paidAt)}</span> · <span className="capitalize">{p.plan}</span> · {fmtMoney(p.amountEsp, "ESP")} · {p.status}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-zinc-400">None</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-zinc-400">Meetings ({fmtNumber(d.account.meetingCount)})</p>
                  {d.account.meetings.length ? (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {d.account.meetings.map((m) => (
                        <li key={m.id} className="truncate">
                          <span title={m.startMs ? fmtTime(m.startMs) : undefined}>{fmtDate(m.startMs)}</span> · {m.name} · {m.state}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-zinc-400">None</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-400">
                No account has verified {t.email}.{" "}
                <Link href={d.account.href} className="text-cyan-300">
                  Search users
                </Link>
              </p>
            )}
          </Panel>

          <Panel>
            <h2 className="mb-2 text-sm font-semibold text-zinc-100">Support history ({d.history.length})</h2>
            <ul className="space-y-1.5 text-sm">
              {d.history.map((h) => (
                <li key={h.id} className="flex items-center gap-2">
                  {h.id === t.id ? (
                    <span className="min-w-0 flex-1 truncate text-zinc-400">
                      #{h.number} {h.subject} (this one)
                    </span>
                  ) : (
                    <Link href={`/admin/support/${h.id}`} className="min-w-0 flex-1 truncate text-cyan-200 hover:text-cyan-100">
                      #{h.number} {h.subject}
                    </Link>
                  )}
                  <StatusBadge status={h.status} />
                  {h.overdue && <Badge tone="red">overdue</Badge>}
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="mb-0.5 text-xs text-zinc-400">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-zinc-400">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
