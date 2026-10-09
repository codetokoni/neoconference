"use client";

// Data: deletion requests and legal holds, retention periods and purges,
// the trash, and the data map. Every change previews first: the server lists
// exactly what would be affected and hands back a token that applying needs
// (src/lib/admin/bulk.ts), plus a typed phrase for anything destructive.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "@/lib/content/model";
import { fmtNumber, fmtTime, useAdmin } from "../AdminApi";
import {
  Badge,
  Confirm,
  Dialog,
  Empty,
  EmptyLine,
  Labeled,
  Loading,
  Notice,
  PageHeader,
  Pager,
  Panel,
  SelectBox,
  SortTh,
  TabPanel,
  Tabs,
  btn,
  field,
  useClientTable,
  useSelection,
  useUrlFilters,
} from "../ui";

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
type Msg = { kind: "ok" | "err"; text: string } | null;

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

const days = (v: number | null) => (v == null ? "Keep" : `${fmtNumber(v)} day${v === 1 ? "" : "s"}`);
// Refusals that mean the preview no longer stands: the answer is a fresh preview.
const STALE = new Set(["preview_expired", "selection_changed", "token_used", "preview_required", "bad_token"]);

export default function DataClient() {
  const { adminFetch } = useAdmin();
  const [d, setD] = useState<Overview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const filters = useUrlFilters({ tab: "requests" });
  const tab: Tab = TABS.some((t) => t.id === filters.value.tab) ? (filters.value.tab as Tab) : "requests";
  const [msg, setMsg] = useState<Msg>(null);
  const [bulk, setBulk] = useState<BulkAsk | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<Overview>("/api/admin/data");
    if (!r.ok) return setLoadErr(r.data.message ?? `HTTP ${r.status}`);
    setD(r.data);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  // /admin/data?complete=<userId> (from an account page) opens that completion's preview.
  useEffect(() => {
    const uid = new URLSearchParams(window.location.search).get("complete");
    if (uid) setBulk({ name: "complete-deletions", title: "Complete this deletion", selection: { userIds: [uid] }, applyLabel: "Delete for good" });
  }, []);

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
      <Tabs label="Data sections" tabs={TABS} value={tab} onChange={(t) => filters.set({ tab: t })} idBase="data" />
      <TabPanel idBase="data" value={tab}>
        {!d ? (
          loadErr ? (
            <Notice kind="err" onRetry={load}>
              {loadErr}
            </Notice>
          ) : (
            <Loading />
          )
        ) : (
          <>
            {loadErr && (
              <Notice kind="err" onRetry={load}>
                {loadErr}
              </Notice>
            )}
            {tab === "requests" && <Requests d={d} reload={load} setMsg={setMsg} openBulk={setBulk} />}
            {tab === "retention" && <Retention d={d} openBulk={setBulk} />}
            {tab === "trash" && <Trash d={d} openBulk={setBulk} />}
            {tab === "map" && <DataMap rows={d.dataMap} />}
          </>
        )}
      </TabPanel>
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

function Requests({ d, reload, setMsg, openBulk }: { d: Overview; reload: () => void; setMsg: (m: Msg) => void; openBulk: (b: BulkAsk) => void }) {
  const { adminFetch } = useAdmin();
  const [ask, setAsk] = useState<{ title: string; body: string; confirmLabel: string; withReason?: string; reasonRequired?: boolean; danger?: boolean; run: (reason: string) => Promise<void> } | null>(null);
  const [holdId, setHoldId] = useState("");
  const due = d.requests.filter((r) => r.status === "scheduled" && !r.held);
  const open = useClientTable(
    d.requests,
    (r, k) => (k === "account" ? r.name || r.email || r.userId : k === "status" ? r.status : k === "by" ? r.requestedBy : k === "requested" ? r.requestedAt : r.deleteAfter),
    { key: "after", dir: "asc" },
  );
  const closed = useClientTable(d.closed, (c, k) => (k === "status" ? c.status : k === "requested" ? c.requestedAt : c.closedAt), { key: "closed", dir: "desc" });

  const act = async (uid: string, action: "cancel" | "hold" | "release", reason = "", done: string) => {
    setMsg(null);
    const r = await adminFetch(`/api/admin/data/requests/${encodeURIComponent(uid)}`, { method: "POST", json: { action, reason } });
    if (r.ok) setMsg({ kind: "ok", text: done });
    else if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    reload();
  };

  return (
    <div className="space-y-4">
      <Panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">Open requests ({fmtNumber(d.requests.length)})</h2>
            <p className="text-sm text-zinc-400">
              <b className="text-zinc-200">Requested</b>: in the grace period, can be cancelled. <b className="text-zinc-200">Scheduled</b>: the grace period is over; complete it to delete the account.
            </p>
          </div>
          {d.canDelete && (
            <span className="flex flex-col items-end gap-1">
              <button
                type="button"
                className={btn.danger}
                disabled={!due.length}
                onClick={() => openBulk({ name: "complete-deletions", title: "Complete every due deletion", selection: { due: true }, applyLabel: "Delete for good" })}
              >
                Complete all due ({fmtNumber(due.length)})
              </button>
              {!due.length && <span className="text-xs text-zinc-400">None is past its grace period.</span>}
            </span>
          )}
        </div>
        {d.requests.length === 0 ? (
          <Empty>No account is waiting to be deleted.</Empty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-zinc-400">
                  <tr>
                    <SortTh label="Account" k="account" sort={open.sort} onSort={open.onSort} className="pl-0" />
                    <SortTh label="Status" k="status" sort={open.sort} onSort={open.onSort} />
                    <SortTh label="Asked by" k="by" sort={open.sort} onSort={open.onSort} />
                    <SortTh label="Requested" k="requested" sort={open.sort} onSort={open.onSort} />
                    <SortTh label="Scheduled for" k="after" sort={open.sort} onSort={open.onSort} />
                    <th className="py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {open.visible.map((r) => {
                    const who = r.name || r.email || r.userId;
                    return (
                      <tr key={r.userId} className="align-top">
                        <td className="py-2 pr-3">
                          <Link href={`/admin/users/${encodeURIComponent(r.userId)}`} className="text-cyan-300 hover:underline">
                            {who}
                          </Link>
                          <div className="text-xs text-zinc-400">{r.email}</div>
                          {r.reason && <div className="mt-0.5 text-xs text-zinc-400">“{r.reason}”</div>}
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={statusTone[r.status]}>{r.status}</Badge>
                          {r.held && (
                            <div className="mt-1">
                              <Badge tone="red">legal hold</Badge>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-zinc-300">{r.requestedBy}</td>
                        <td className="px-3 py-2 text-zinc-300">{fmtTime(r.requestedAt)}</td>
                        <td className="px-3 py-2 text-zinc-300">{fmtTime(r.deleteAfter)}</td>
                        <td className="py-2 text-right">
                          {d.canDelete && (
                            <>
                              <div className="flex flex-wrap justify-end gap-1.5">
                                <button
                                  type="button"
                                  className={btn.ghost}
                                  aria-label={`Cancel the deletion of ${who}`}
                                  onClick={() =>
                                    setAsk({
                                      title: "Cancel this deletion?",
                                      body: `${who}'s account is kept. If an administrator's request suspended it, it is reactivated.`,
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
                                  aria-label={`Place a legal hold on ${who}`}
                                  onClick={() =>
                                    setAsk({
                                      title: "Place a legal hold?",
                                      body: `On ${who}. The request is refused and the account cannot be deleted — by its holder or an administrator — until the hold is lifted.`,
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
                                  aria-label={`Complete the deletion of ${who}`}
                                  disabled={r.status !== "scheduled" || r.held}
                                  onClick={() =>
                                    openBulk({ name: "complete-deletions", title: `Complete the deletion of ${r.email || r.userId}`, selection: { userIds: [r.userId] }, applyLabel: "Delete for good" })
                                  }
                                >
                                  Complete…
                                </button>
                              </div>
                              {(r.status !== "scheduled" || r.held) && (
                                <p className="mt-1 text-xs text-zinc-400">{r.held ? "On legal hold." : `Can be completed from ${fmtTime(r.deleteAfter)}.`}</p>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={open.page} pageSize={open.pageSize} total={open.total} onPage={open.setPage} onPageSize={open.setPageSize} noun="request" />
          </>
        )}
      </Panel>

      <Panel>
        <h2 className="text-base font-semibold text-white">Legal holds ({fmtNumber(d.holds.length)})</h2>
        <p className="mb-3 text-sm text-zinc-400">An account under hold cannot be deleted. Its holder is told only that it can&apos;t be deleted right now.</p>
        {d.holds.length === 0 ? (
          <EmptyLine>No legal holds.</EmptyLine>
        ) : (
          <ul className="max-h-96 divide-y divide-white/5 overflow-auto text-sm">
            {d.holds.map((h) => {
              const who = h.name || h.email || h.userId;
              return (
                <li key={h.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 break-words">
                    <Link href={`/admin/users/${encodeURIComponent(h.userId)}`} className="text-cyan-300 hover:underline">
                      {who}
                    </Link>{" "}
                    <span className="text-zinc-400">
                      — {h.reason} · by {h.byEmail} · {fmtTime(h.at)}
                    </span>
                  </span>
                  {d.canDelete && (
                    <button
                      type="button"
                      className={btn.ghost}
                      aria-label={`Lift the legal hold on ${who}`}
                      onClick={() => setAsk({ title: "Lift the legal hold?", body: `${who} can be deleted again if a new request is made.`, confirmLabel: "Lift hold", run: () => act(h.userId, "release", "", "Hold lifted.") })}
                    >
                      Lift
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {d.canDelete && (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
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
            <Labeled label="Account id to hold" className="w-full sm:w-72">
              <input value={holdId} onChange={(e) => setHoldId(e.target.value)} placeholder="user_…" className={field} />
            </Labeled>
            <button type="submit" className={btn.warn} disabled={!holdId.trim()}>
              Place hold…
            </button>
          </form>
        )}
      </Panel>

      <Panel>
        <h2 className="mb-2 text-base font-semibold text-white">Closed requests ({fmtNumber(d.closed.length)})</h2>
        {d.closed.length === 0 ? (
          <EmptyLine>None yet.</EmptyLine>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-zinc-400">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Request</th>
                    <th className="px-3 py-2 font-medium">Account</th>
                    <SortTh label="Status" k="status" sort={closed.sort} onSort={closed.onSort} />
                    <SortTh label="Requested" k="requested" sort={closed.sort} onSort={closed.onSort} />
                    <SortTh label="Closed" k="closed" sort={closed.sort} onSort={closed.onSort} />
                    <th className="px-3 py-2 font-medium">Certificate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {closed.visible.map((c) => (
                    <tr key={`${c.id}-${c.closedAt}`}>
                      <td className="py-2 pr-3 font-mono text-xs text-zinc-400">{c.id}</td>
                      <td className="px-3 py-2 font-mono text-xs text-zinc-300">{c.status === "completed" ? `${c.userId} (deleted)` : c.userId}</td>
                      <td className="px-3 py-2">
                        <Badge tone={statusTone[c.status]}>{c.status}</Badge>
                        {c.note && <span className="ml-1 text-xs text-zinc-400">{c.note}</span>}
                      </td>
                      <td className="px-3 py-2 text-zinc-300">{fmtTime(c.requestedAt)}</td>
                      <td className="px-3 py-2 text-zinc-300">
                        {fmtTime(c.closedAt)} <span className="text-xs text-zinc-400">by {c.closedBy === "user" ? "the account holder" : c.closedBy}</span>
                      </td>
                      <td className="px-3 py-2">
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
            <Pager page={closed.page} pageSize={closed.pageSize} total={closed.total} onPage={closed.setPage} onPageSize={closed.setPageSize} noun="request" />
          </>
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
            await ask.run(reason);
            setAsk(null);
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
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {fmtNumber(def.minDays)}–{fmtNumber(def.maxDays)} days{def.allowForever ? "; empty = keep" : ""} · default {days(def.defaultDays)}
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
              <span className="min-w-0">
                <span className="text-zinc-100">{p.label}</span> <span className="text-zinc-400">· {days(p.days)}</span>
                {p.unavailable && <span className="block text-xs text-zinc-400">{p.unavailable}</span>}
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
  const t = useClientTable(
    d.trash.items,
    (x, k) => (k === "what" ? x.label : k === "kind" ? x.kind : k === "deleted" ? x.deletedAt : x.expiresAt),
    { key: "deleted", dir: "desc" },
  );
  const restorable = (x: TrashRow) => !x.restoredAt && x.expiresAt > d.now;
  const live = d.trash.items.filter(restorable);
  const selectable = t.visible.filter(restorable).map((x) => x.id);
  const sel = useSelection(selectable);
  // A fresh load (after a restore or purge) starts with nothing selected.
  const clear = useRef(sel.clear);
  clear.current = sel.clear;
  useEffect(() => clear.current(), [d]);
  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white">Trash</h2>
          <p className="text-sm text-zinc-400">
            Meetings, groups and recordings their owners deleted, restorable for {fmtNumber(d.trash.windowDays)} days. Restoring puts them back exactly where they were; it is refused if
            something has taken their place.
          </p>
        </div>
        {d.canDelete && (
          <button type="button" className={btn.primary} disabled={!sel.count} onClick={() => openBulk({ name: "restore", title: `Restore ${sel.count} item${sel.count === 1 ? "" : "s"}`, selection: { ids: [...sel.selected] }, applyLabel: "Restore" })}>
            Restore selected ({sel.count})
          </button>
        )}
      </div>
      {d.trash.items.length === 0 ? (
        <Empty>The trash is empty.</Empty>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-400">
                <tr>
                  <th className="py-2 pr-2">{d.canDelete && selectable.length > 0 && <SelectBox checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select every restorable item on this page" />}</th>
                  <SortTh label="What" k="what" sort={t.sort} onSort={t.onSort} />
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <SortTh label="Deleted" k="deleted" sort={t.sort} onSort={t.onSort} />
                  <SortTh label="Restorable until" k="until" sort={t.sort} onSort={t.onSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {t.visible.map((x) => {
                  const expired = x.expiresAt <= d.now;
                  return (
                    <tr key={x.id}>
                      <td className="py-2 pr-2">{d.canDelete && restorable(x) && <SelectBox checked={sel.selected.has(x.id)} onChange={() => sel.toggle(x.id)} label={`Select ${x.label}`} />}</td>
                      <td className="px-3 py-2">
                        <Badge>{x.kind}</Badge> <span className="text-zinc-100">{x.label}</span>
                        <div className="break-all font-mono text-xs text-zinc-400">{x.ref}</div>
                      </td>
                      <td className="px-3 py-2">
                        {x.ownerId ? (
                          <Link href={`/admin/users/${encodeURIComponent(x.ownerId)}`} className="font-mono text-xs text-cyan-300 hover:underline">
                            {x.ownerId}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-3 py-2 text-zinc-300">{fmtTime(x.deletedAt)}</td>
                      <td className="px-3 py-2 text-zinc-300">{x.restoredAt ? <Badge tone="green">restored {fmtTime(x.restoredAt)}</Badge> : expired ? <Badge tone="red">expired</Badge> : fmtTime(x.expiresAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="item" />
        </>
      )}
      {live.length > 0 && <p className="mt-2 text-xs text-zinc-400">{fmtNumber(live.length)} restorable.</p>}
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
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white">Where people&apos;s data lives</h2>
          <p className="text-sm text-zinc-400">Every place an account&apos;s data is kept, whether it is in the export, and what deleting the account does to it.</p>
        </div>
        <Labeled label="Filter the data map" className="w-full sm:w-72">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Any word" className={field} />
        </Labeled>
      </div>
      {q && (
        <p className="mb-2 text-xs text-zinc-400">
          {fmtNumber(shown.length)} of {fmtNumber(rows.length)} places match.
        </p>
      )}
      {shown.length === 0 ? (
        <EmptyLine>Nothing matches.</EmptyLine>
      ) : (
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
                <span className="text-zinc-400">Personal data:</span> {r.personal}
              </p>
              <p className="text-zinc-400">{r.why}</p>
              {r.ttl && <p className="text-xs text-zinc-400">Expires: {r.ttl}</p>}
              {r.pending && <p className="text-xs text-amber-300/80">{r.pending}</p>}
              {r.unsure && <p className="text-xs text-amber-300/80">Open question: {r.unsure}</p>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------ bulk dialog ------------------------------ */

/** A sample cell: timestamps on the admin clock, everything else as text. */
function sampleValue(v: unknown): string {
  if (typeof v === "number" && v > 1e12) return fmtTime(v);
  if (typeof v === "number") return fmtNumber(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v))) return fmtTime(v);
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v ?? "");
}

function BulkDialog({ ask, onClose }: { ask: BulkAsk; onClose: (done: string | null) => void }) {
  const { adminFetch } = useAdmin();
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The preview no longer stands (expired, used, or the records changed): offer a fresh one.
  const [stale, setStale] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const preview = useCallback(async () => {
    setErr(null);
    setStale(false);
    setP(null);
    setTyped("");
    const r = await adminFetch<Preview>(`/api/admin/data/bulk/${ask.name}/preview`, { method: "POST", json: { selection: ask.selection } });
    if (!r.ok) return setErr(r.data.error === "cancelled" ? "Cancelled — preview again to carry on." : r.data.message ?? `HTTP ${r.status}`);
    setP(r.data);
    setNow(Date.now());
  }, [adminFetch, ask]);
  useEffect(() => {
    preview();
  }, [preview]);
  // Re-check the clock so an expired preview says so without a click.
  useEffect(() => {
    if (!p) return;
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [p]);

  const apply = async () => {
    if (!p) return;
    setBusy(true);
    setErr(null);
    const r = await adminFetch<{ count: number; result: Record<string, unknown> }>(`/api/admin/data/bulk/${ask.name}/apply`, {
      method: "POST",
      json: { selection: ask.selection, token: p.token, confirm: typed },
    });
    setBusy(false);
    if (!r.ok) {
      if (r.data.error === "cancelled") return;
      if (STALE.has(String(r.data.error))) setStale(true);
      return setErr(r.data.message ?? `HTTP ${r.status}`);
    }
    const res = r.data.result ?? {};
    const failed = (res.failed as unknown[] | undefined)?.length ?? 0;
    onClose(`Done: ${fmtNumber(r.data.count)} record${r.data.count === 1 ? "" : "s"}.${failed ? ` ${failed} could not be completed — see the audit log.` : ""}`);
  };

  const extra = p?.extra ?? {};
  const skipped = (extra.skipped as { userId: string; reason: string }[] | undefined) ?? [];
  const conflicts = (extra.conflicts as { id: string; error: string; detail?: string }[] | undefined) ?? [];
  const plans = (extra.plans as Record<string, Record<string, number>> | undefined) ?? {};
  const ready = !!p && (!p.destructive || typed.trim().toLowerCase() === (p.confirmPhrase ?? "").trim().toLowerCase());
  const expired = !!p && p.expiresAt <= now;
  const nothing = !!p && p.count === 0 && ask.name !== "retention";

  return (
    <Dialog title={ask.title} onClose={() => !busy && onClose(null)} wide>
      {!p && !err && <Loading label="Working out what this affects…" />}
      {err && (
        <div className="mt-3">
          <Notice kind="err" onRetry={!p || stale ? preview : undefined}>
            {err}
          </Notice>
        </div>
      )}
      {p && (
        <form
          className="mt-2 space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy && !expired && !stale && !nothing) apply();
          }}
        >
          <p className="text-zinc-300">
            <b className="text-white">{fmtNumber(p.count)}</b> record{p.count === 1 ? "" : "s"} affected
            {Object.entries(p.totals)
              .filter(([k]) => k !== "records")
              .map(([k, v]) => ` · ${k === "bytes" ? formatBytes(v) : `${fmtNumber(v)} ${k}`}`)
              .join("")}
            . {expired ? <span className="text-amber-300">This preview has expired.</span> : <>This preview is valid until {fmtTime(p.expiresAt)}.</>}
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
                  {p.sample.map((s, i) => (
                    <tr key={String(s.id ?? i)}>
                      {Object.entries(s).map(([k, v]) => (
                        <td key={k} className="px-2 py-1.5 align-top text-zinc-300">
                          <span className="block text-[10px] uppercase text-zinc-400">{k}</span>
                          {sampleValue(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {p.count > p.sample.length && <p className="px-2 py-1 text-xs text-zinc-400">…and {fmtNumber(p.count - p.sample.length)} more.</p>}
            </div>
          )}
          {Object.keys(plans).length > 0 && (
            <div>
              <p className="font-medium text-zinc-200">What completing removes (per data map step)</p>
              {Object.entries(plans).map(([uid, counts]) => (
                <p key={uid} className="mt-1 break-words text-xs text-zinc-400">
                  <span className="font-mono text-zinc-300">{uid}</span>:{" "}
                  {Object.entries(counts)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${k} ${fmtNumber(n)}`)
                    .join(" · ") || "nothing besides the account"}
                </p>
              ))}
            </div>
          )}
          {skipped.length > 0 && (
            <div>
              <p className="font-medium text-amber-200">Left out</p>
              {skipped.map((s) => (
                <p key={s.userId} className="break-words text-xs text-zinc-400">
                  <span className="font-mono">{s.userId}</span>: {s.reason}
                </p>
              ))}
            </div>
          )}
          {conflicts.length > 0 && (
            <div>
              <p className="font-medium text-amber-200">Will not restore</p>
              {conflicts.map((c) => (
                <p key={c.id} className="break-words text-xs text-zinc-400">
                  <span className="font-mono">{c.id}</span>: {c.error}
                  {c.detail ? ` — ${c.detail}` : ""}
                </p>
              ))}
            </div>
          )}
          {p.destructive && p.count > 0 && !expired && !stale && (
            <label className="block text-zinc-300">
              This cannot be undone. Type <b className="font-mono text-white">{p.confirmPhrase}</b> to confirm
              <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className={`${field} mt-1`} />
            </label>
          )}
          {nothing && <p className="text-zinc-400">Nothing to do.</p>}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button type="button" onClick={() => onClose(null)} disabled={busy} className={btn.ghost}>
              Close
            </button>
            {(expired || stale) && (
              <button type="button" onClick={preview} className={btn.ghost}>
                Preview again
              </button>
            )}
            <button type="submit" disabled={!ready || busy || expired || stale || nothing} aria-busy={busy} className={p.destructive ? btn.danger : btn.primary}>
              {busy ? "Working…" : ask.applyLabel}
            </button>
          </div>
        </form>
      )}
      {!p && (
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={() => onClose(null)} className={btn.ghost}>
            Close
          </button>
        </div>
      )}
    </Dialog>
  );
}
