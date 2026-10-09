"use client";

// Subscriptions across the platform: what renews or ends soon (periods,
// trials and scheduled changes), what ended recently, everything by status,
// and finding one account to open. Opening a row shows its
// SubscriptionPanel.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SUB_STATUSES, type CatalogPlan } from "@/lib/billing/model";
import type { SubRow } from "@/lib/billing/adminViews";
import { Time, fmtMoney, fmtNumber, useAdmin } from "../AdminApi";
import {
  Confirm,
  EmptyLine,
  FilterBar,
  Labeled,
  LoadState,
  Notice,
  PageHeader,
  Pager,
  Panel,
  SortTh,
  StatTile,
  TableWrap,
  btn,
  field,
  useClientTable,
  useUrlFilters,
} from "../ui";
import { StatusBadge } from "./SubscriptionPanel";

type View = "upcoming" | "ended" | "all";
type Found = { userId: string; email: string; name: string; plan: string; isOwner: boolean };
type Msg = { kind: "ok" | "err"; text: string } | null;

const DAY_OPTIONS = [7, 30, 90, 365];
/** "All" returns at most this many records (src/app/api/admin/subscriptions/route.ts). */
const LIST_CAP = 1000;

export default function SubscriptionsClient() {
  const { can, adminFetch } = useAdmin();
  // ?view= &days= &status= &plan= &q= open the list filtered (the Overview
  // links here) and stay in the address bar so the view can be shared.
  const { value: fv, set: setF } = useUrlFilters({ view: "upcoming", days: "30", status: "", plan: "", q: "" });
  const view: View = fv.view === "ended" || fv.view === "all" ? fv.view : "upcoming";
  const days = Math.max(1, Math.min(Number(fv.days) || 30, 3650));
  const status = (SUB_STATUSES as string[]).includes(fv.status) ? fv.status : "";
  const plan = fv.plan;
  const [rows, setRows] = useState<SubRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [plans, setPlans] = useState<CatalogPlan[] | null>(null);
  const [qDraft, setQDraft] = useState(fv.q);
  const [find, setFind] = useState("");
  const [finding, setFinding] = useState(false);
  const [findNote, setFindNote] = useState<string | null>(null);
  const [found, setFound] = useState<Found[] | null>(null);
  const [backfill, setBackfill] = useState(false);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    const qs = new URLSearchParams({ view, days: String(days), ...(status ? { status } : {}), ...(view === "all" && plan ? { plan } : {}) });
    const r = await adminFetch<{ rows: SubRow[]; counts?: Record<string, number>; total?: number }>(`/api/admin/subscriptions?${qs}`);
    if (r.ok) {
      setRows(r.data.rows);
      if (r.data.counts) setCounts(r.data.counts);
      if (typeof r.data.total === "number") setTotal(r.data.total);
    } else setError(r.data.message ?? "Could not load subscriptions.");
  }, [adminFetch, view, days, status, plan]);
  useEffect(() => {
    load();
  }, [load]);

  // Plan names for the plan filter; without them the filter still shows the id.
  useEffect(() => {
    adminFetch<{ plans: CatalogPlan[] }>("/api/admin/plans").then((r) => r.ok && setPlans(r.data.plans));
  }, [adminFetch]);

  // The text filter follows typing after a pause, so the address bar is not rewritten per key.
  useEffect(() => {
    if (qDraft === fv.q) return;
    const id = setTimeout(() => setF({ q: qDraft }), 300);
    return () => clearTimeout(id);
  }, [qDraft, fv.q, setF]);

  const shown = useMemo(() => {
    if (!rows) return null;
    const n = fv.q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((r) => [r.email, r.userId, r.planName, r.planId, r.source].some((s) => (s ?? "").toLowerCase().includes(n)));
  }, [rows, fv.q]);
  const order = useMemo(() => new Map((rows ?? []).map((r, i) => [r, i])), [rows]);
  const t = useClientTable(
    shown,
    (r, k) =>
      k === "account"
        ? r.email || r.userId
        : k === "plan"
          ? r.planName
          : k === "status"
            ? r.status
            : k === "end"
              ? ((view === "ended" ? r.endedAt : r.periodEnd) ?? null)
              : k === "source"
                ? r.source
                : (order.get(r) ?? 0),
    // The server's own order first: soonest ending, most recently ended, or those with access first.
    { key: "server", dir: "asc" },
  );
  const { setPage } = t;
  useEffect(() => setPage(1), [setPage, view, days, status, plan, fv.q]);

  const search = async () => {
    setFindNote(null);
    if (find.trim().length < 2) {
      setFound(null);
      return setFindNote("Type at least 2 characters of an email, name or user id.");
    }
    setFinding(true);
    const r = await adminFetch<{ users: Found[] }>(`/api/admin/subscriptions/lookup?q=${encodeURIComponent(find)}`);
    setFinding(false);
    if (r.ok) setFound(r.data.users);
    else setFindNote(r.data.message ?? "Search failed.");
  };

  const runBackfill = async () => {
    setMsg(null);
    const r = await adminFetch<{ scanned: number; created: number; skipped: number; owner: number }>("/api/admin/subscriptions/backfill", { method: "POST" });
    setBackfill(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "The backfill failed." });
    setMsg({ kind: "ok", text: `Scanned ${r.data.scanned} accounts: ${r.data.created} records created, ${r.data.skipped} already recorded or expired, ${r.data.owner} owner account(s) left alone.` });
    load();
  };

  const planOptions = plans ? plans.map((p) => ({ id: p.id, name: p.current.name })) : [];
  if (plan && !planOptions.some((p) => p.id === plan)) planOptions.push({ id: plan, name: plan });
  const dayOptions = DAY_OPTIONS.includes(days) ? DAY_OPTIONS : [...DAY_OPTIONS, days].sort((a, b) => a - b);
  const filtered = !!(status || plan || fv.q);

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        sub="Renewals, expiries and scheduled changes, and every account's subscription. Nothing renews by itself: eSPees cannot charge automatically, so an ending period is a reminder to collect payment."
        actions={
          can("subscriptions:write") ? (
            <button
              type="button"
              className={btn.ghost}
              onClick={() => {
                setMsg(null);
                setBackfill(true);
              }}
              title="Create records for accounts that had a paid plan before the plan catalog"
            >
              Backfill from Clerk
            </button>
          ) : undefined
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}

      <Panel className="mb-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <Labeled label="Open any account (also those without a subscription record)" className="w-full sm:w-96">
            <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Email, name or user id" className={field} />
          </Labeled>
          <button type="submit" className={btn.ghost} disabled={finding}>
            {finding ? "Finding…" : "Find"}
          </button>
        </form>
        {findNote && <p className="mt-2 text-sm text-amber-200">{findNote}</p>}
        {found &&
          (found.length === 0 ? (
            <EmptyLine>No accounts found.</EmptyLine>
          ) : (
            <ul className="mt-2">
              {found.map((u) => (
                <li key={u.userId}>
                  <Link href={`/admin/subscriptions/${encodeURIComponent(u.userId)}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">
                    <span className="min-w-0 break-all text-zinc-100">
                      {u.email} {u.name && <span className="text-zinc-400">· {u.name}</span>}
                    </span>
                    <span className="text-xs text-zinc-400">{u.isOwner ? "owner (always Enterprise)" : u.plan}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ))}
      </Panel>

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Which subscriptions">
        {(
          [
            ["upcoming", "Renewing / ending soon"],
            ["ended", "Ended recently"],
            ["all", "All"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={view === v} className={view === v ? btn.primary : btn.ghost} onClick={() => setF({ view: v, status: "", plan: "" })}>
            {label}
          </button>
        ))}
      </div>

      {view === "all" && counts && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <StatTile label="Every status" value={fmtNumber(total ?? Object.values(counts).reduce((a, b) => a + b, 0))} active={!status} onClick={() => setF({ status: "" })} />
          {SUB_STATUSES.map((s) => (
            <StatTile key={s} label={s} value={fmtNumber(counts[s] ?? 0)} active={status === s} onClick={() => setF({ status: status === s ? "" : s })} />
          ))}
        </div>
      )}

      <FilterBar
        active={filtered}
        onClear={() => {
          setQDraft("");
          setF({ status: "", plan: "", q: "" });
        }}
      >
        <Labeled label="Search this list" className="w-full sm:w-64">
          <input type="search" value={qDraft} onChange={(e) => setQDraft(e.target.value)} placeholder="Email, user id, plan, source" className={field} />
        </Labeled>
        {view !== "all" ? (
          <Labeled label={view === "upcoming" ? "Ending within" : "Ended within"}>
            <select value={days} onChange={(e) => setF({ days: e.target.value })} className={`${field} sm:w-36`}>
              {dayOptions.map((d) => (
                <option key={d} value={d}>
                  {view === "upcoming" ? "next" : "last"} {d} days
                </option>
              ))}
            </select>
          </Labeled>
        ) : (
          <Labeled label="Plan">
            <select value={plan} onChange={(e) => setF({ plan: e.target.value })} className={`${field} sm:w-44`}>
              <option value="">Every plan</option>
              {planOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Labeled>
        )}
      </FilterBar>

      <LoadState
        data={rows}
        error={error}
        onRetry={load}
        empty={
          view === "upcoming"
            ? `Nothing renews or ends in the next ${days} days.`
            : view === "ended"
              ? `Nothing ended in the last ${days} days.`
              : status || plan
                ? "No subscription records match these filters."
                : "No subscription records yet."
        }
      >
        {(all) => (
          <>
            {view === "all" && all.length >= LIST_CAP && (
              <Notice kind="info">
                Showing the first {fmtNumber(LIST_CAP)} records{total != null ? ` of ${fmtNumber(total)}` : ""}, those with access first. Filter by status or plan to see the rest.
              </Notice>
            )}
            {t.total === 0 ? (
              <Notice kind="info">Nothing in this list matches “{fv.q}”.</Notice>
            ) : (
              <>
                <TableWrap minWidth={760}>
                  <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
                    <tr>
                      <SortTh label="Account" k="account" sort={t.sort} onSort={t.onSort} />
                      <SortTh label="Plan" k="plan" sort={t.sort} onSort={t.onSort} />
                      <SortTh label="Status" k="status" sort={t.sort} onSort={t.onSort} />
                      <SortTh label={view === "ended" ? "Ended" : "Period ends"} k="end" sort={t.sort} onSort={t.onSort} />
                      <th className="px-3 py-2">Then</th>
                      <SortTh label="Source" k="source" sort={t.sort} onSort={t.onSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {t.visible.map((r) => (
                      <tr key={r.userId} className="border-t border-white/5">
                        <td className="max-w-[16rem] break-all px-3 py-2">
                          <Link href={`/admin/subscriptions/${encodeURIComponent(r.userId)}`} className="text-cyan-200 hover:underline">
                            {r.email || r.userId}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-zinc-200">
                          {r.planName} <span className="text-xs text-zinc-400">v{r.version}</span>
                          <div className="text-xs text-zinc-400">
                            {r.cycle ?? "no cycle"}
                            {r.pricePaid ? ` · ${fmtMoney(r.pricePaid.amount, r.pricePaid.currency)}` : ""}
                            {r.addOns.length ? ` · +${r.addOns.join(", ")}` : ""}
                            {r.custom ? " · custom" : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-3 py-2 text-zinc-300">
                          <Time ts={view === "ended" ? r.endedAt : r.periodEnd} />
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-400">
                          {r.scheduled
                            ? `moves to ${r.scheduled.planId} (${r.scheduled.cycle})`
                            : r.status === "trialing"
                              ? "trial ends → Free unless paid"
                              : r.status === "cancelled"
                                ? "→ Free"
                                : r.live
                                  ? "→ Free unless renewed"
                                  : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-400">{r.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
                <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="subscription" />
              </>
            )}
          </>
        )}
      </LoadState>
      {backfill && (
        <Confirm
          title="Backfill subscription records from Clerk?"
          body="Every account with a paid plan in Clerk and no record yet gets one, on version 1 of its tier (the terms it was sold). Nothing in Clerk changes and nobody's limits change. Safe to run again."
          confirmLabel="Run backfill"
          onConfirm={runBackfill}
          onCancel={() => setBackfill(false)}
        />
      )}
    </div>
  );
}
