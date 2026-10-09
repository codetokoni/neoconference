"use client";

// Data: deletion requests and legal holds, retention periods and purges,
// the trash, and the data map. Every change previews first: the server lists
// exactly what would be affected and hands back a token that applying needs
// (src/lib/admin/bulk.ts), plus a typed phrase for anything destructive.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";

type Status = "requested" | "scheduled" | "completed" | "cancelled" | "refused";

type OpenRow = {
  id: string | null;
  userId: string;
  email: string;
  name: string;
  exists: boolean;
  owner: boolean;
  status: Status;
  source: "user" | "admin";
  requestedAt: number;
  deleteAfter: number;
  reason: string;
  requestedBy: string;
  held: boolean;
};
type ClosedRow = { id: string; userId: string; status: Status; source: string; requestedAt: number; deleteAfter: number; closedAt: number; closedBy: string; certificateId?: string; note?: string };
type HoldRow = { userId: string; email: string; name: string; at: number; byEmail: string; reason: string };
type RetentionDef = { id: string; label: string; meaning: string; defaultDays: number | null; minDays: number; maxDays: number; allowForever: boolean };
type PurgeRow = { id: string; label: string; days: number | null; unavailable: string | null };
type TrashRow = { id: string; kind: string; label: string; ownerId: string | null; ref: string; deletedAt: number; deletedBy: string; expiresAt: number; restoredAt: number | null; files: number; keys: number };
type MapRow = { id: string; store: string; pattern: string; holds: string; personal: string; exported: boolean | "summary"; onDelete: string; why: string; ttl?: string; pending?: string; unsure?: string };

type Overview = {
  now: number;
  canDelete: boolean;
  requests: OpenRow[];
  closed: ClosedRow[];
  holds: HoldRow[];
  retention: { values: Record<string, number | null>; updatedAt: number | null; updatedBy: string | null; defs: RetentionDef[] };
  purges: PurgeRow[];
  trash: { windowDays: number; items: TrashRow[] };
  dataMap: MapRow[];
};

type Preview = {
  action: string;
  count: number;
  sample: Record<string, unknown>[];
  totals: Record<string, number>;
  token: string;
  expiresAt: number;
  destructive: boolean;
  confirmPhrase: string | null;
  extra: Record<string, unknown>;
};

type BulkName = "complete-deletions" | "restore" | "purge" | "retention";
type BulkAsk = { name: BulkName; title: string; selection: unknown; applyLabel: string };

const TABS = [
  { id: "requests", label: "Deletion requests" },
  { id: "retention", label: "Retention & purges" },
  { id: "trash", label: "Trash" },
  { id: "map", label: "Data map" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const statusTone: Record<Status, "zinc" | "cyan" | "amber" | "red" | "green"> = {
  requested: "cyan",
  scheduled: "amber",
  completed: "green",
  cancelled: "zinc",
  refused: "red",
};

const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${n} B`);
const days = (v: number | null) => (v == null ? "Keep" : `${v} day${v === 1 ? "" : "s"}`);

export default function DataClient() {
  const { adminFetch } = useAdmin();
  const [d, setD] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>("requests");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [bulk, setBulk] = useState<BulkAsk | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<Overview>("/api/admin/data");
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setD(r.data);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  // /admin/data?complete=<userId> (from an account page) opens that completion's preview.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("tab");
    if (t && TABS.some((x) => x.id === t)) setTab(t as Tab);
    const uid = p.get("complete");
    if (uid) setBulk({ name: "complete-deletions", title: "Complete this deletion", selection: { userIds: [uid] }, applyLabel: "Delete for good" });
  }, []);

  if (!d) return msg ? <Notice kind="err">{msg.text}</Notice> : <Loading />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data"
        sub="Deletion requests, legal holds, how long data is kept, the trash, and where people's data lives. Every change is previewed first and recorded in the audit log."
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <div role="tablist" aria-label="Data sections" className="flex flex-wrap gap-1 border-b border-white/10">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-t-lg px-3 py-2 text-sm ${tab === t.id ? "bg-cyan-400/10 text-cyan-200" : "text-zinc-400 hover:text-zinc-100"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "requests" && <Requests d={d} reload={load} setMsg={setMsg} openBulk={setBulk} />}
      {tab === "retention" && <Retention d={d} openBulk={setBulk} />}
      {tab === "trash" && <Trash d={d} openBulk={setBulk} />}
      {tab === "map" && <DataMap rows={d.dataMap} />}
      {bulk && (
        <BulkDialog
          ask={bulk}
          onClose={(done) => {
            setBulk(null);
            if (done) {
              setMsg({ kind: "ok", text: done });
              load();
            }
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------- requests ------------------------------- */

function Requests({
  d,
  reload,
  setMsg,
  openBulk,
}: {
  d: Overview;
  reload: () => void;
  setMsg: (m: { kind: "ok" | "err"; text: string } | null) => void;
  openBulk: (b: BulkAsk) => void;
}) {
  const { adminFetch } = useAdmin();
  const [ask, setAsk] = useState<{ title: string; body: string; confirmLabel: string; withReason?: string; danger?: boolean; run: (reason: string) => Promise<void> } | null>(null);
  const [holdId, setHoldId] = useState("");
  const due = d.requests.filter((r) => r.status === "scheduled" && !r.held);

  const act = async (uid: string, action: "cancel" | "hold" | "release", reason = "", done: string) => {
    const r = await adminFetch(`/api/admin/data/requests/${encodeURIComponent(uid)}`, { method: "POST", json: { action, reason } });
    setMsg(r.ok ? { kind: "ok", text: done } : { kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    reload();
  };

  return (
    <div className="space-y-4">
      <Panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-white">Open requests</h2>
            <p className="text-sm text-zinc-400">
              <b className="text-zinc-200">Requested</b>: in the grace period, can be cancelled. <b className="text-zinc-200">Scheduled</b>: the grace period is over; complete it to delete the account.
            </p>
          </div>
          {d.canDelete && (
            <button
              type="button"
              className={btn.danger}
              disabled={!due.length}
              onClick={() => openBulk({ name: "complete-deletions", title: "Complete every due deletion", selection: { due: true }, applyLabel: "Delete for good" })}
            >
              Complete all due ({due.length})
            </button>
          )}
        </div>
        {d.requests.length === 0 ? (
          <Empty>No account is waiting to be deleted.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 pr-3">Account</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Asked by</th>
                  <th className="py-2 pr-3">Requested</th>
                  <th className="py-2 pr-3">Scheduled for</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {d.requests.map((r) => (
                  <tr key={r.userId} className="align-top">
                    <td className="py-2 pr-3">
                      <Link href={`/admin/users/${encodeURIComponent(r.userId)}`} className="text-cyan-300 hover:underline">
                        {r.name || r.email || r.userId}
                      </Link>
                      <div className="text-xs text-zinc-500">{r.email}</div>
                      {r.reason && <div className="mt-0.5 text-xs text-zinc-400">“{r.reason}”</div>}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge tone={statusTone[r.status]}>{r.status}</Badge>
                      {r.held && (
                        <div className="mt-1">
                          <Badge tone="red">legal hold</Badge>
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-zinc-300">{r.requestedBy}</td>
                    <td className="py-2 pr-3 text-zinc-300">{fmtTime(r.requestedAt)}</td>
                    <td className="py-2 pr-3 text-zinc-300">{fmtTime(r.deleteAfter)}</td>
                    <td className="py-2 text-right">
                      {d.canDelete && (
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <button
                            type="button"
                            className={btn.ghost}
                            onClick={() =>
                              setAsk({
                                title: "Cancel this deletion?",
                                body: "The account is kept. If an administrator's request suspended it, it is reactivated.",
                                confirmLabel: "Cancel deletion",
                                run: () => act(r.userId, "cancel", "", "Deletion cancelled."),
                              })
                            }
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className={btn.warn}
                            onClick={() =>
                              setAsk({
                                title: "Place a legal hold?",
                                body: "The request is refused and the account cannot be deleted — by its holder or an administrator — until the hold is lifted.",
                                confirmLabel: "Place hold",
                                withReason: "Reason (recorded in the audit log)",
                                danger: true,
                                run: (reason) => act(r.userId, "hold", reason, "Legal hold placed; the request was refused."),
                              })
                            }
                          >
                            Hold
                          </button>
                          <button
                            type="button"
                            className={btn.danger}
                            disabled={r.status !== "scheduled" || r.held}
                            title={r.status !== "scheduled" ? `Grace period runs until ${fmtTime(r.deleteAfter)}` : undefined}
                            onClick={() =>
                              openBulk({ name: "complete-deletions", title: `Complete the deletion of ${r.email || r.userId}`, selection: { userIds: [r.userId] }, applyLabel: "Delete for good" })
                            }
                          >
                            Complete…
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel>
        <h2 className="text-base font-semibold text-white">Legal holds</h2>
        <p className="mb-3 text-sm text-zinc-400">An account under hold cannot be deleted. Its holder is told only that it can&apos;t be deleted right now.</p>
        {d.holds.length === 0 ? (
          <Empty>No legal holds.</Empty>
        ) : (
          <ul className="divide-y divide-white/5 text-sm">
            {d.holds.map((h) => (
              <li key={h.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <Link href={`/admin/users/${encodeURIComponent(h.userId)}`} className="text-cyan-300 hover:underline">
                    {h.name || h.email || h.userId}
                  </Link>{" "}
                  <span className="text-zinc-400">
                    — {h.reason} · by {h.byEmail} · {fmtTime(h.at)}
                  </span>
                </span>
                {d.canDelete && (
                  <button
                    type="button"
                    className={btn.ghost}
                    onClick={() =>
                      setAsk({ title: "Lift the legal hold?", body: "The account can be deleted again if a new request is made.", confirmLabel: "Lift hold", run: () => act(h.userId, "release", "", "Hold lifted.") })
                    }
                  >
                    Lift
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {d.canDelete && (
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const uid = holdId.trim();
              if (!uid) return;
              setAsk({
                title: "Place a legal hold?",
                body: `On account ${uid}. Any open deletion request is refused.`,
                confirmLabel: "Place hold",
                withReason: "Reason (recorded in the audit log)",
                danger: true,
                run: async (reason) => {
                  await act(uid, "hold", reason, "Legal hold placed.");
                  setHoldId("");
                },
              });
            }}
          >
            <input value={holdId} onChange={(e) => setHoldId(e.target.value)} placeholder="Account id (user_…)" aria-label="Account id to hold" className={`${field} max-w-xs`} />
            <button type="submit" className={btn.warn} disabled={!holdId.trim()}>
              Place hold…
            </button>
          </form>
        )}
      </Panel>

      <Panel>
        <h2 className="mb-2 text-base font-semibold text-white">Closed requests</h2>
        {d.closed.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 pr-3">Request</th>
                  <th className="py-2 pr-3">Account</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Requested</th>
                  <th className="py-2 pr-3">Closed</th>
                  <th className="py-2">Certificate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {d.closed.map((c) => (
                  <tr key={`${c.id}-${c.closedAt}`}>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-400">{c.id}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-300">{c.status === "completed" ? `${c.userId} (deleted)` : c.userId}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={statusTone[c.status]}>{c.status}</Badge>
                      {c.note && <span className="ml-1 text-xs text-zinc-500">{c.note}</span>}
                    </td>
                    <td className="py-2 pr-3 text-zinc-300">{fmtTime(c.requestedAt)}</td>
                    <td className="py-2 pr-3 text-zinc-300">
                      {fmtTime(c.closedAt)} <span className="text-xs text-zinc-500">by {c.closedBy === "user" ? "the account holder" : c.closedBy}</span>
                    </td>
                    <td className="py-2">
                      {c.certificateId ? (
                        <Link href={`/admin/audit-log?q=${encodeURIComponent(c.certificateId)}`} className="font-mono text-xs text-cyan-300 hover:underline">
                          {c.certificateId}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {ask && (
        <Confirm
          title={ask.title}
          body={ask.body}
          confirmLabel={ask.confirmLabel}
          withReason={ask.withReason}
          danger={ask.danger}
          onCancel={() => setAsk(null)}
          onConfirm={async (reason) => {
            const a = ask;
            setAsk(null);
            await a.run(reason);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------- retention ------------------------------- */

function Retention({ d, openBulk }: { d: Overview; openBulk: (b: BulkAsk) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  return (
    <div className="space-y-4">
      <Panel>
        <h2 className="text-base font-semibold text-white">How long data is kept</h2>
        <p className="mb-3 text-sm text-zinc-400">
          Changing a period needs a fresh authenticator code and shows what it would affect first. Saving deletes nothing; purges below do, each after its own preview.
          {d.retention.updatedAt && (
            <>
              {" "}
              Last changed {fmtTime(d.retention.updatedAt)} by {d.retention.updatedBy}.
            </>
          )}
        </p>
        <div className="divide-y divide-white/5">
          {d.retention.defs.map((def) => {
            const cur = d.retention.values[def.id];
            const v = draft[def.id] ?? (cur == null ? "" : String(cur));
            const next: number | null = v.trim() === "" ? null : Number(v);
            const same = next === cur;
            return (
              <div key={def.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 max-w-xl">
                  <p className="font-medium text-zinc-100">
                    {def.label} <span className="ml-1 text-sm font-normal text-cyan-300">{days(cur)}</span>
                  </p>
                  <p className="text-sm text-zinc-400">{def.meaning}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {def.minDays}–{def.maxDays} days{def.allowForever ? "; empty = keep" : ""} · default {days(def.defaultDays)}
                  </p>
                </div>
                {d.canDelete && (
                  <div className="flex items-center gap-2">
                    <input
                      inputMode="numeric"
                      aria-label={`${def.label} in days`}
                      value={v}
                      placeholder={def.allowForever ? "keep" : String(def.defaultDays ?? "")}
                      onChange={(e) => setDraft({ ...draft, [def.id]: e.target.value.replace(/[^0-9]/g, "") })}
                      className={`${field} w-24`}
                    />
                    <button
                      type="button"
                      className={btn.ghost}
                      aria-label={`Preview changing ${def.label.toLowerCase()}`}
                      disabled={same || (next == null && !def.allowForever)}
                      onClick={() =>
                        openBulk({ name: "retention", title: `Change ${def.label.toLowerCase()} to ${days(next)}`, selection: { category: def.id, days: next }, applyLabel: "Save period" })
                      }
                    >
                      Preview change
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      <Panel>
        <h2 className="text-base font-semibold text-white">Purges</h2>
        <p className="mb-3 text-sm text-zinc-400">Remove what is past its period. The preview lists exactly what would go; nothing runs on its own.</p>
        <ul className="divide-y divide-white/5">
          {d.purges.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
              <span>
                <span className="text-zinc-100">{p.label}</span> <span className="text-zinc-500">· {days(p.days)}</span>
                {p.unavailable && <span className="block text-xs text-zinc-500">{p.unavailable}</span>}
              </span>
              {d.canDelete && (
                <button type="button" className={btn.warn} aria-label={`Preview purge: ${p.label.toLowerCase()}`} disabled={!!p.unavailable} onClick={() => openBulk({ name: "purge", title: `Purge: ${p.label.toLowerCase()}`, selection: { category: p.id }, applyLabel: "Purge" })}>
                  Preview purge
                </button>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/* --------------------------------- trash --------------------------------- */

function Trash({ d, openBulk }: { d: Overview; openBulk: (b: BulkAsk) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  // A fresh load (after a restore or purge) starts with nothing selected.
  useEffect(() => setSel(new Set()), [d]);
  const live = d.trash.items.filter((t) => !t.restoredAt);
  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-white">Trash</h2>
          <p className="text-sm text-zinc-400">
            Meetings, groups and recordings their owners deleted, restorable for {d.trash.windowDays} days. Restoring puts them back exactly where they were; it is refused if
            something has taken their place.
          </p>
        </div>
        {d.canDelete && (
          <button type="button" className={btn.primary} disabled={!sel.size} onClick={() => openBulk({ name: "restore", title: `Restore ${sel.size} item${sel.size === 1 ? "" : "s"}`, selection: { ids: [...sel] }, applyLabel: "Restore" })}>
            Restore selected ({sel.size})
          </button>
        )}
      </div>
      {d.trash.items.length === 0 ? (
        <Empty>The trash is empty.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="py-2 pr-2" />
                <th className="py-2 pr-3">What</th>
                <th className="py-2 pr-3">Owner</th>
                <th className="py-2 pr-3">Deleted</th>
                <th className="py-2 pr-3">Restorable until</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {d.trash.items.map((t) => {
                const expired = t.expiresAt <= d.now;
                return (
                  <tr key={t.id}>
                    <td className="py-2 pr-2">
                      <input type="checkbox" aria-label={`Select ${t.label}`} disabled={!!t.restoredAt || expired} checked={sel.has(t.id)} onChange={() => toggle(t.id)} />
                    </td>
                    <td className="py-2 pr-3">
                      <Badge>{t.kind}</Badge> <span className="text-zinc-100">{t.label}</span>
                      <div className="font-mono text-xs text-zinc-500">{t.ref}</div>
                    </td>
                    <td className="py-2 pr-3">
                      {t.ownerId ? (
                        <Link href={`/admin/users/${encodeURIComponent(t.ownerId)}`} className="font-mono text-xs text-cyan-300 hover:underline">
                          {t.ownerId}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-2 pr-3 text-zinc-300">{fmtTime(t.deletedAt)}</td>
                    <td className="py-2 pr-3 text-zinc-300">{t.restoredAt ? <Badge tone="green">restored {fmtTime(t.restoredAt)}</Badge> : expired ? <Badge tone="red">expired</Badge> : fmtTime(t.expiresAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {live.length > 0 && <p className="mt-2 text-xs text-zinc-500">{live.length} restorable.</p>}
    </Panel>
  );
}

/* -------------------------------- data map -------------------------------- */

function DataMap({ rows }: { rows: MapRow[] }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => rows.filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase())), [rows, q]);
  const tone = (o: string) => (o === "delete" ? "red" : o === "anonymise" ? "amber" : o === "keep" ? "cyan" : "zinc");
  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-white">Where people&apos;s data lives</h2>
          <p className="text-sm text-zinc-400">Every place an account&apos;s data is kept, whether it is in the export, and what deleting the account does to it.</p>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter the data map" className={`${field} max-w-xs`} />
      </div>
      <div className="space-y-2">
        {shown.map((r) => (
          <div key={r.id} className="rounded-lg border border-white/5 bg-black/20 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>{r.store}</Badge>
              <Badge tone={tone(r.onDelete)}>{r.onDelete}</Badge>
              <Badge tone={r.exported === true ? "green" : r.exported === "summary" ? "cyan" : "zinc"}>{r.exported === true ? "exported" : r.exported === "summary" ? "exported (summary)" : "not exported"}</Badge>
              {r.pending && <Badge tone="amber">not on main yet</Badge>}
              <span className="font-medium text-zinc-100">{r.holds}</span>
            </div>
            <p className="mt-1 break-words font-mono text-xs text-zinc-400">{r.pattern}</p>
            <p className="mt-1 text-zinc-300">
              <span className="text-zinc-500">Personal data:</span> {r.personal}
            </p>
            <p className="text-zinc-400">{r.why}</p>
            {r.ttl && <p className="text-xs text-zinc-500">Expires: {r.ttl}</p>}
            {r.pending && <p className="text-xs text-amber-300/80">{r.pending}</p>}
            {r.unsure && <p className="text-xs text-amber-300/80">Open question: {r.unsure}</p>}
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ------------------------------ bulk dialog ------------------------------ */

function BulkDialog({ ask, onClose }: { ask: BulkAsk; onClose: (done: string | null) => void }) {
  const { adminFetch } = useAdmin();
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const preview = useCallback(async () => {
    setErr(null);
    setP(null);
    setTyped("");
    const r = await adminFetch<Preview>(`/api/admin/data/bulk/${ask.name}/preview`, { method: "POST", json: { selection: ask.selection } });
    if (!r.ok) return setErr(r.data.message ?? `HTTP ${r.status}`);
    setP(r.data);
  }, [adminFetch, ask]);
  useEffect(() => {
    preview();
  }, [preview]);

  const apply = async () => {
    if (!p) return;
    setBusy(true);
    setErr(null);
    const r = await adminFetch<{ count: number; result: Record<string, unknown> }>(`/api/admin/data/bulk/${ask.name}/apply`, {
      method: "POST",
      json: { selection: ask.selection, token: p.token, confirm: typed },
    });
    setBusy(false);
    if (!r.ok) return setErr(r.data.message ?? `HTTP ${r.status}`);
    const res = r.data.result ?? {};
    const failed = (res.failed as unknown[] | undefined)?.length ?? 0;
    onClose(`Done: ${r.data.count} record${r.data.count === 1 ? "" : "s"}.${failed ? ` ${failed} could not be completed — see the audit log.` : ""}`);
  };

  const extra = p?.extra ?? {};
  const skipped = (extra.skipped as { userId: string; reason: string }[] | undefined) ?? [];
  const conflicts = (extra.conflicts as { id: string; error: string; detail?: string }[] | undefined) ?? [];
  const plans = (extra.plans as Record<string, Record<string, number>> | undefined) ?? {};
  const ready = !!p && (!p.destructive || typed.trim().toLowerCase() === (p.confirmPhrase ?? "").toLowerCase());
  const expired = !!p && p.expiresAt <= Date.now();

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="bulk-title" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-[#0B1220] p-5 shadow-2xl">
        <h2 id="bulk-title" className="text-base font-semibold text-white">
          {ask.title}
        </h2>
        {!p && !err && <Loading />}
        {err && <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</p>}
        {p && (
          <div className="mt-2 space-y-3 text-sm">
            <p className="text-zinc-300">
              <b className="text-white">{p.count}</b> record{p.count === 1 ? "" : "s"} affected
              {Object.entries(p.totals)
                .filter(([k]) => k !== "records")
                .map(([k, v]) => ` · ${k === "bytes" ? bytes(v) : `${v} ${k}`}`)
                .join("")}
              . This preview is valid until {new Date(p.expiresAt).toLocaleTimeString()}.
            </p>
            {typeof extra.note === "string" && <p className="text-zinc-400">{extra.note}</p>}
            {typeof extra.unavailable === "string" && <p className="text-amber-300">{extra.unavailable}</p>}
            {"current" in extra && (
              <p className="text-zinc-300">
                Now: <b>{days(extra.current as number | null)}</b> → after saving: <b>{days(extra.next as number | null)}</b>
              </p>
            )}
            {p.sample.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-white/5">
                <table className="w-full text-left text-xs">
                  <tbody className="divide-y divide-white/5">
                    {p.sample.map((s) => (
                      <tr key={String(s.id)}>
                        {Object.entries(s).map(([k, v]) => (
                          <td key={k} className="px-2 py-1.5 align-top text-zinc-300">
                            <span className="block text-[10px] uppercase text-zinc-500">{k}</span>
                            {typeof v === "number" && v > 1e12 ? fmtTime(v) : typeof v === "object" ? JSON.stringify(v) : String(v ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {p.count > p.sample.length && <p className="px-2 py-1 text-xs text-zinc-500">…and {p.count - p.sample.length} more.</p>}
              </div>
            )}
            {Object.keys(plans).length > 0 && (
              <div>
                <p className="font-medium text-zinc-200">What completing removes (per data map step)</p>
                {Object.entries(plans).map(([uid, counts]) => (
                  <p key={uid} className="mt-1 text-xs text-zinc-400">
                    <span className="font-mono text-zinc-300">{uid}</span>:{" "}
                    {Object.entries(counts)
                      .filter(([, n]) => n > 0)
                      .map(([k, n]) => `${k} ${n}`)
                      .join(" · ") || "nothing besides the account"}
                  </p>
                ))}
              </div>
            )}
            {skipped.length > 0 && (
              <div>
                <p className="font-medium text-amber-200">Left out</p>
                {skipped.map((s) => (
                  <p key={s.userId} className="text-xs text-zinc-400">
                    <span className="font-mono">{s.userId}</span>: {s.reason}
                  </p>
                ))}
              </div>
            )}
            {conflicts.length > 0 && (
              <div>
                <p className="font-medium text-amber-200">Will not restore</p>
                {conflicts.map((c) => (
                  <p key={c.id} className="text-xs text-zinc-400">
                    <span className="font-mono">{c.id}</span>: {c.error}
                    {c.detail ? ` — ${c.detail}` : ""}
                  </p>
                ))}
              </div>
            )}
            {p.destructive && p.count > 0 && (
              <label className="block text-zinc-300">
                This cannot be undone. Type <b className="font-mono text-white">{p.confirmPhrase}</b> to confirm
                <input autoFocus aria-label={`Type ${p.confirmPhrase} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} className={`${field} mt-1`} />
              </label>
            )}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onClose(null)} className={btn.ghost}>
            Close
          </button>
          {p && expired && (
            <button type="button" onClick={preview} className={btn.ghost}>
              Preview again
            </button>
          )}
          <button type="button" disabled={!p || !ready || busy || expired || (p.count === 0 && ask.name !== "retention")} onClick={apply} className={p?.destructive ? btn.danger : btn.primary}>
            {busy ? "Working…" : ask.applyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
