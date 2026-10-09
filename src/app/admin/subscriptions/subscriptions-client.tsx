"use client";

// Subscriptions across the platform: what renews or ends soon (periods,
// trials and scheduled changes), what ended recently, everything by status,
// and finding one account to open. Opening a row shows its
// SubscriptionPanel.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SUB_STATUSES } from "@/lib/billing/model";
import type { SubRow } from "@/lib/billing/adminViews";
import { fmtTime, useAdmin } from "../AdminApi";
import { Confirm, Empty, Loading, Notice, PageHeader, btn, field } from "../ui";
import { StatusBadge } from "./SubscriptionPanel";

type View = "upcoming" | "ended" | "all";
type Found = { userId: string; email: string; name: string; plan: string; isOwner: boolean };

export default function SubscriptionsClient() {
  const { can, adminFetch } = useAdmin();
  // ?view= &days= &status= &plan= open the list filtered (the Overview links here).
  const sp = useSearchParams();
  const [view, setView] = useState<View>(() => {
    const v = sp?.get("view");
    return v === "ended" || v === "all" ? v : "upcoming";
  });
  const [days, setDays] = useState(() => Math.max(1, Math.min(Number(sp?.get("days")) || 30, 3650)));
  const [status, setStatus] = useState(() => {
    const s = sp?.get("status") ?? "";
    return (SUB_STATUSES as string[]).includes(s) ? s : "";
  });
  const [plan, setPlan] = useState(sp?.get("plan") ?? "");
  const [rows, setRows] = useState<SubRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [backfill, setBackfill] = useState(false);

  const load = useCallback(async () => {
    setRows(null);
    const qs = new URLSearchParams({ view, days: String(days), ...(status ? { status } : {}), ...(view === "all" && plan ? { plan } : {}) });
    const r = await adminFetch<{ rows: SubRow[]; counts?: Record<string, number> }>(`/api/admin/subscriptions?${qs}`);
    if (r.ok) {
      setRows(r.data.rows);
      if (r.data.counts) setCounts(r.data.counts);
    } else setMsg({ kind: "err", text: r.data.message ?? "Could not load subscriptions." });
  }, [adminFetch, view, days, status, plan]);
  useEffect(() => {
    load();
  }, [load]);

  const search = async () => {
    const r = await adminFetch<{ users: Found[] }>(`/api/admin/subscriptions/lookup?q=${encodeURIComponent(q)}`);
    if (r.ok) setFound(r.data.users);
    else setMsg({ kind: "err", text: r.data.message ?? "Search failed." });
  };

  const runBackfill = async () => {
    setBackfill(false);
    const r = await adminFetch<{ scanned: number; created: number; skipped: number; owner: number }>("/api/admin/subscriptions/backfill", { method: "POST" });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "The backfill failed." });
    setMsg({ kind: "ok", text: `Scanned ${r.data.scanned} accounts: ${r.data.created} records created, ${r.data.skipped} already recorded or expired, ${r.data.owner} owner account(s) left alone.` });
    load();
  };

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        sub="Renewals, expiries and scheduled changes, and every account's subscription. Nothing renews by itself: eSPees cannot charge automatically, so an ending period is a reminder to collect payment."
        actions={
          can("subscriptions:write") ? (
            <button type="button" className={btn.ghost} onClick={() => setBackfill(true)} title="Create records for accounts that had a paid plan before the plan catalog">
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

      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) search();
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an account by email, name or user id" aria-label="Find an account" className={`${field} max-w-md`} />
        <button type="submit" className={btn.ghost}>
          Find
        </button>
      </form>
      {found && (
        <div className="mb-4 rounded-xl border border-white/10 p-2">
          {found.length === 0 ? (
            <p className="px-2 py-1 text-sm text-zinc-500">No accounts found.</p>
          ) : (
            <ul>
              {found.map((u) => (
                <li key={u.userId}>
                  <Link href={`/admin/subscriptions/${encodeURIComponent(u.userId)}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-white/5">
                    <span className="text-zinc-100">
                      {u.email} {u.name && <span className="text-zinc-500">· {u.name}</span>}
                    </span>
                    <span className="text-xs text-zinc-400">{u.isOwner ? "owner (always Enterprise)" : u.plan}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(
          [
            ["upcoming", "Renewing / ending soon"],
            ["ended", "Ended recently"],
            ["all", "All"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={view === v} className={view === v ? btn.primary : btn.ghost} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
        {view !== "all" ? (
          <select aria-label="Window" value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${field} !w-auto`}>
            {[7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {view === "upcoming" ? "next" : "last"} {d} days
              </option>
            ))}
          </select>
        ) : (
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={`${field} !w-auto`}>
            <option value="">every status</option>
            {SUB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
                {counts ? ` (${counts[s] ?? 0})` : ""}
              </option>
            ))}
          </select>
        )}
        {view === "all" && plan && (
          <button type="button" className={btn.ghost} onClick={() => setPlan("")} title="Show every plan">
            Plan: {plan} ✕
          </button>
        )}
      </div>

      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>{view === "upcoming" ? `Nothing renews or ends in the next ${days} days.` : view === "ended" ? `Nothing ended in the last ${days} days.` : "No subscription records yet."}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">{view === "ended" ? "Ended" : "Period ends"}</th>
                <th className="px-3 py-2">Then</th>
                <th className="px-3 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-t border-white/5">
                  <td className="px-3 py-2">
                    <Link href={`/admin/subscriptions/${encodeURIComponent(r.userId)}`} className="text-cyan-200 hover:underline">
                      {r.email || r.userId}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-zinc-200">
                    {r.planName} <span className="text-xs text-zinc-500">v{r.version}</span>
                    <div className="text-xs text-zinc-500">
                      {r.cycle ?? "no cycle"}
                      {r.pricePaid ? ` · ${r.pricePaid.amount} ${r.pricePaid.currency}` : ""}
                      {r.addOns.length ? ` · +${r.addOns.join(", ")}` : ""}
                      {r.custom ? " · custom" : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{fmtTime(view === "ended" ? r.endedAt : r.periodEnd)}</td>
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
                  <td className="px-3 py-2 text-xs text-zinc-500">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
