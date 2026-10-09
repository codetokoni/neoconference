"use client";

// One account's subscription: what it has, every change made to it, and
// (with subscriptions:write) the actions — assign, change plan, extend,
// pause/resume, cancel, complimentary, custom arrangement, add-ons. Each
// action is previewed by the server first (what happens, including the
// proration) and only then confirmed.
//
// Self-contained so other admin pages can embed it:
//   <SubscriptionPanel userId="user_…" />

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  CURRENCIES,
  CYCLES,
  CYCLE_DAYS,
  dailyPrice,
  espPrice,
  LIMIT_FIELDS,
  NOT_CONNECTED,
  effectiveLimits,
  type AddOn,
  type CatalogPlan,
  type Cycle,
  type SubHistoryEntry,
  type Subscription,
} from "@/lib/billing/model";
import type { PaymentRecord } from "@/lib/paymentsStore";
import { Time, fmtDate, fmtMoney, fmtNumber, useAdmin } from "../AdminApi";
import { Badge, Confirm, EmptyLine, Loading, Notice, Pager, Panel, btn, field, useClientTable } from "../ui";

type Data = {
  user: {
    userId: string;
    email: string;
    name: string;
    isOwner: boolean;
    clerk: {
      plan: string | null;
      planExpiresAt: number | null;
      planId: string | null;
      planVersion: number | null;
    };
  };
  subscription: Subscription | null;
  history: SubHistoryEntry[];
  payments: PaymentRecord[] | null;
  prorationRule: string[];
};

/** Settings → Registration: whether trials may start, and their default length. */
type TrialPolicy = { enabled: boolean; defaultDays: number };

type Action = "assign" | "change" | "extend" | "pause" | "resume" | "cancel" | "comp" | "custom" | "addons" | "unschedule";

const STATUS_TONE: Record<string, "green" | "cyan" | "amber" | "red" | "zinc"> = {
  active: "green",
  trialing: "cyan",
  complimentary: "cyan",
  paused: "amber",
  cancelled: "red",
  expired: "zinc",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "zinc"}>{status}</Badge>;
}

// Calendar days on the admin clock (hover a <Time> for the full time).
const day = (ms: number | null | undefined) => (ms ? fmtDate(ms) : "no end");

/** Rows per page in the history and payments lists. */
const PAGE = 10;

export default function SubscriptionPanel({ userId }: { userId: string }) {
  const { can, adminFetch } = useAdmin();
  const [data, setData] = useState<Data | null>(null);
  const [plans, setPlans] = useState<CatalogPlan[]>([]);
  const [trialPolicy, setTrialPolicy] = useState<TrialPolicy | null>(null);
  const [addOns, setAddOns] = useState<AddOn[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The plan and add-on lists the action forms offer; without them the forms have nothing to pick.
  const [listsError, setListsError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const history = useClientTable(data?.history, (h) => h.ts, { key: "ts", dir: "desc", pageSize: PAGE });
  const payments = useClientTable(data?.payments, (p) => p.paidAt, { key: "paidAt", dir: "desc", pageSize: PAGE });

  const load = useCallback(async () => {
    setLoadError(null);
    const r = await adminFetch<Data>(`/api/admin/subscriptions/${encodeURIComponent(userId)}`);
    if (r.ok) setData(r.data);
    else setLoadError(r.data.message ?? "Could not load this account.");
  }, [adminFetch, userId]);
  const loadLists = useCallback(async () => {
    setListsError(null);
    const [p, a] = await Promise.all([adminFetch<{ plans: CatalogPlan[]; trialPolicy: TrialPolicy }>("/api/admin/plans"), adminFetch<{ addOns: AddOn[] }>("/api/admin/addons")]);
    if (p.ok) {
      setPlans(p.data.plans);
      setTrialPolicy(p.data.trialPolicy);
    }
    if (a.ok) setAddOns(a.data.addOns);
    const failed = [!p.ok && `the plans (${p.data.message ?? p.status})`, !a.ok && `the add-ons (${a.data.message ?? a.status})`].filter(Boolean);
    if (failed.length) setListsError(`Could not read ${failed.join(" or ")}, so the forms below cannot offer them.`);
  }, [adminFetch]);
  useEffect(() => {
    load();
    loadLists();
  }, [load, loadLists]);

  if (!data)
    return loadError ? (
      <Notice kind="err" onRetry={load}>
        {loadError}
      </Notice>
    ) : (
      <Loading />
    );
  const { user, subscription: sub } = data;
  const write = can("subscriptions:write") && !user.isOwner;
  const now = Date.now();
  const live = !!sub && sub.status !== "paused" && sub.status !== "expired" && (sub.periodEnd == null || sub.periodEnd > now);

  const available: { id: Action; label: string; show: boolean }[] = [
    {
      id: "assign",
      label: "Assign a plan",
      show: !live && sub?.status !== "paused",
    },
    {
      id: "change",
      label: "Change plan",
      show: live && sub?.status !== "cancelled",
    },
    { id: "extend", label: "Extend", show: live || sub?.status === "paused" },
    { id: "pause", label: "Pause", show: live && sub?.status !== "cancelled" },
    {
      id: "resume",
      label: sub?.status === "cancelled" ? "Withdraw cancellation" : "Resume",
      show: sub?.status === "paused" || (sub?.status === "cancelled" && live && !!sub.cancelled?.atPeriodEnd),
    },
    { id: "cancel", label: "Cancel", show: live || sub?.status === "paused" },
    { id: "comp", label: "Complimentary", show: true },
    { id: "custom", label: "Custom arrangement", show: true },
    { id: "addons", label: "Add-ons", show: live || sub?.status === "paused" },
    {
      id: "unschedule",
      label: "Withdraw scheduled change",
      show: !!sub?.scheduled,
    },
  ];

  return (
    <div className="space-y-4">
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {loadError && (
        <Notice kind="err" onRetry={load} onClose={() => setLoadError(null)}>
          {loadError} What is shown may be out of date.
        </Notice>
      )}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-white">{user.name || user.email}</h2>
            <p className="text-sm text-zinc-400">
              {user.email} · <span className="font-mono text-xs">{user.userId}</span>
            </p>
          </div>
          {sub && <StatusBadge status={sub.status} />}
        </div>
        {user.isOwner ? (
          <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
            Platform owner. This account is always Enterprise, by identity rather than by subscription — no plan can be assigned, changed, paused or cancelled here.
          </p>
        ) : sub ? (
          <SubSummaryCard sub={sub} />
        ) : (
          <p className="mt-3 text-sm text-zinc-400">
            No subscription record. Clerk says: <b className="text-zinc-200">{user.clerk.plan ?? "free"}</b>
            {user.clerk.planExpiresAt ? ` until ${day(user.clerk.planExpiresAt)}` : ""}. Accounts from before the plan catalog get a record from the backfill on the Subscriptions page.
          </p>
        )}
      </Panel>

      {write && (
        <Panel>
          <h3 className="text-sm font-semibold text-white">Change this subscription</h3>
          {listsError && (
            <div className="mt-2">
              <Notice kind="err" onRetry={loadLists}>
                {listsError}
              </Notice>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {available
              .filter((a) => a.show)
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-expanded={action === a.id}
                  onClick={() => {
                    setMsg(null);
                    setAction(action === a.id ? null : a.id);
                  }}
                  className={action === a.id ? btn.primary : btn.ghost}
                >
                  {a.label}
                </button>
              ))}
          </div>
          {action && (
            <ActionForm
              key={action}
              action={action}
              userId={user.userId}
              sub={sub}
              plans={plans}
              trialPolicy={trialPolicy}
              addOns={addOns}
              rule={data.prorationRule}
              onDone={(text) => {
                setAction(null);
                setMsg({ kind: "ok", text });
                load();
              }}
              onError={(text) => setMsg({ kind: "err", text })}
            />
          )}
        </Panel>
      )}

      <Panel>
        <h3 className="text-sm font-semibold text-white">History</h3>
        {data.history.length === 0 ? (
          <EmptyLine>Nothing yet.</EmptyLine>
        ) : (
          <>
          <ol className="mt-2 divide-y divide-white/5">
            {history.visible.map((h, i) => (
              <li key={`${h.ts}-${i}`} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 text-zinc-100">{h.summary}</span>
                  <Time ts={h.ts} className="text-xs text-zinc-400" />
                </div>
                <div className="text-xs text-zinc-400">
                  {h.action} · by {h.by.email}
                  {h.note ? ` · ${h.note}` : ""}
                </div>
                {(h.before || h.after) && (
                  <div className="mt-0.5 text-xs text-zinc-400">
                    {h.before ? `${h.before.planId} v${h.before.version} ${h.before.status}, ends ${day(h.before.periodEnd)}` : "none"} →{" "}
                    {h.after ? `${h.after.planId} v${h.after.version} ${h.after.status}, ends ${day(h.after.periodEnd)}` : "none"}
                  </div>
                )}
              </li>
            ))}
          </ol>
          {history.total > PAGE && <Pager page={history.page} pageSize={history.pageSize} total={history.total} onPage={history.setPage} noun="change" />}
          </>
        )}
      </Panel>

      {data.payments && (
        <Panel>
          <h3 className="text-sm font-semibold text-white">Payments</h3>
          {data.payments.length === 0 ? (
            <EmptyLine>No payments recorded.</EmptyLine>
          ) : (
            <>
            <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Payments (scrolls sideways)">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="text-xs text-zinc-400">
                  <tr>
                    <th className="py-1 font-normal">Paid</th>
                    <th className="py-1 font-normal">Plan</th>
                    <th className="py-1 font-normal">Amount</th>
                    <th className="py-1 font-normal">Period end</th>
                    <th className="py-1 font-normal">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.visible.map((p) => (
                    <tr key={p.paymentRef} className="border-t border-white/5">
                      <td className="py-1.5 text-zinc-300">
                        <Time ts={p.paidAt} />
                      </td>
                      <td className="py-1.5 text-zinc-300">
                        {p.planId ?? p.plan} ({p.billingCycle})
                      </td>
                      <td className="py-1.5 text-zinc-300">
                        {fmtMoney(p.amountEsp, "ESP")}
                        {p.couponCode ? ` (coupon ${p.couponCode})` : ""}
                      </td>
                      <td className="py-1.5 text-zinc-300">{day(p.periodEnd)}</td>
                      <td className="py-1.5 text-xs text-zinc-400">{p.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {payments.total > PAGE && <Pager page={payments.page} pageSize={payments.pageSize} total={payments.total} onPage={payments.setPage} noun="payment" />}
            </>
          )}
        </Panel>
      )}
    </div>
  );
}

function SubSummaryCard({ sub }: { sub: Subscription }) {
  const limits = effectiveLimits(sub);
  return (
    <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-zinc-400">Plan</dt>
        <dd className="text-zinc-100">
          {sub.snapshot.name} <span className="text-zinc-400">v{sub.version}</span> <span className="font-mono text-xs text-zinc-400">{sub.planId}</span>
        </dd>
        <dt className="text-zinc-400">Billing</dt>
        <dd className="text-zinc-200">{sub.cycle ?? "no cycle"}</dd>
        <dt className="text-zinc-400">Period</dt>
        <dd className="text-zinc-200">
          {day(sub.periodStart)} →{" "}
          {sub.status === "paused" ? `paused, ${sub.paused?.remainingMs != null ? fmtNumber(Math.ceil(sub.paused.remainingMs / 86_400_000)) + " days kept" : "no end"}` : day(sub.periodEnd)}
        </dd>
        <dt className="text-zinc-400">Source</dt>
        <dd className="text-zinc-200">{sub.source}</dd>
        <dt className="text-zinc-400">Paid</dt>
        <dd className="text-zinc-200">
          {sub.pricePaid ? fmtMoney(sub.pricePaid.amount, sub.pricePaid.currency) : "nothing recorded"}
          {sub.couponCode ? ` (coupon ${sub.couponCode})` : ""}
        </dd>
        {sub.scheduled && (
          <>
            <dt className="text-zinc-400">Scheduled</dt>
            <dd className="text-amber-200">
              {sub.scheduled.planId} v{sub.scheduled.version} ({sub.scheduled.cycle}) on {day(sub.scheduled.effectiveAt)}
            </dd>
          </>
        )}
        {sub.cancelled?.atPeriodEnd && sub.status === "cancelled" && (
          <>
            <dt className="text-zinc-400">Cancels</dt>
            <dd className="text-red-300">at period end</dd>
          </>
        )}
        {sub.addOns.length > 0 && (
          <>
            <dt className="text-zinc-400">Add-ons</dt>
            <dd className="text-zinc-200">{sub.addOns.map((a) => a.name).join(", ")}</dd>
          </>
        )}
        {sub.custom && (
          <>
            <dt className="text-zinc-400">Custom</dt>
            <dd className="text-zinc-200">
              {sub.custom.price ? `${fmtMoney(sub.custom.price.amount, sub.custom.price.currency)} ${sub.custom.price.cycle}` : "no price"}
              {sub.custom.notes ? ` — ${sub.custom.notes}` : ""}
            </dd>
          </>
        )}
      </dl>
      <div>
        <p className="text-xs uppercase tracking-wide text-zinc-400">Limits in force</p>
        <ul className="mt-1 grid grid-cols-1 gap-y-0.5 text-xs text-zinc-300">
          {LIMIT_FIELDS.map((f) => {
            const v = limits[f.key];
            const text = f.kind === "bool" ? (v ? "yes" : "no") : v === null ? f.zero : v === 0 && f.zero ? f.zero : String(v);
            return (
              <li key={f.key}>
                {f.label}: <span className="text-zinc-100">{text}</span>
                {!f.enforced && <span className="text-amber-400"> (not enforced)</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

type Preview = {
  summary: string;
  lines: string[];
  proration: { direction: string } | null;
};

function ActionForm({
  action,
  userId,
  sub,
  plans,
  trialPolicy,
  addOns,
  rule,
  onDone,
  onError,
}: {
  action: Action;
  userId: string;
  sub: Subscription | null;
  plans: CatalogPlan[];
  trialPolicy: TrialPolicy | null;
  addOns: AddOn[];
  rule: string[];
  onDone: (text: string) => void;
  onError: (text: string) => void;
}) {
  const { adminFetch } = useAdmin();
  const sellable = plans.filter((p) => !p.archived && p.baseTier !== "free");
  const [planId, setPlanId] = useState(
    sub?.planId && sellable.some((p) => p.id === sub.planId) ? sub.planId : (sellable.find((p) => p.id === (action === "custom" ? "enterprise" : "pro"))?.id ?? sellable[0]?.id ?? ""),
  );
  const [cycle, setCycle] = useState<Cycle>(sub?.cycle ?? "monthly");
  const [days, setDays] = useState<string>(action === "extend" ? "30" : "");
  const [trial, setTrial] = useState(false);
  const [when, setWhen] = useState<"now" | "period_end">("now");
  const [newPeriod, setNewPeriod] = useState(false);
  const [paidAmount, setPaidAmount] = useState("");
  const [paidCurrency, setPaidCurrency] = useState("ESP");
  const [limits, setLimits] = useState<Record<string, unknown>>({});
  const [notes, setNotes] = useState("");
  const [picked, setPicked] = useState<string[]>(sub?.addOns.map((a) => a.id) ?? []);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  // Shown next to the button that was pressed, not at the top of the page.
  const [problem, setProblem] = useState<string | null>(null);

  const target = plans.find((p) => p.id === planId);
  // Mirrors the server: no trials when Settings turns them off; a plan
  // without its own length gets the platform default.
  const trialDays = trialPolicy?.enabled ? target?.current.trialDays || trialPolicy.defaultDays : 0;
  // The proration rule: a downgrade waits for the period end unless chosen
  // otherwise; an upgrade applies now.
  const newDaily = target ? (espPrice(target.current.prices, cycle) ?? 0) / CYCLE_DAYS[cycle] : 0;
  const direction = !sub ? null : newDaily > dailyPrice(sub) ? "upgrade" : newDaily < dailyPrice(sub) ? "downgrade" : "switch";
  useEffect(() => {
    if (action === "change") setWhen(direction === "downgrade" && sub?.periodEnd ? "period_end" : "now");
    if (action === "cancel") setWhen(sub?.periodEnd && sub.status !== "paused" ? "period_end" : "now");
  }, [action, direction, sub?.periodEnd, sub?.status]);
  const body = (): Record<string, unknown> => {
    const paid = paidAmount !== "" ? { amount: Number(paidAmount), currency: paidCurrency } : null;
    switch (action) {
      case "assign":
        return { action, planId, cycle, trial, days: days || null, paid };
      case "change":
        return { action, planId, cycle, when, newPeriod, paid };
      case "extend":
        return { action, days: Number(days) };
      case "cancel":
        return { action, when };
      case "comp":
        return { action, planId, days: days || null };
      case "custom":
        return {
          action,
          planId,
          days: days || null,
          limits,
          notes,
          price: paid ? { ...paid, cycle } : null,
        };
      case "addons":
        return { action, addOnIds: picked };
      default:
        return { action };
    }
  };

  const ask = async () => {
    setBusy(true);
    setProblem(null);
    const r = await adminFetch<Preview>(`/api/admin/subscriptions/${encodeURIComponent(userId)}`, { method: "POST", json: { ...body(), preview: true } });
    setBusy(false);
    if (!r.ok) return setProblem(r.data.message ?? "That cannot be done.");
    setPreview(r.data);
  };
  // The confirmation stays open, showing that it is working, until the server answers.
  const run = async (reason: string) => {
    setBusy(true);
    const r = await adminFetch<{ summary: string }>(`/api/admin/subscriptions/${encodeURIComponent(userId)}`, { method: "POST", json: { ...body(), reason } });
    setBusy(false);
    setPreview(null);
    if (!r.ok) return onError(r.data.message ?? "That did not work.");
    onDone(`${r.data.summary}.`);
  };

  const planSelect = (
    <Row label="Plan">
      <select value={planId} onChange={(e) => setPlanId(e.target.value)} className={field}>
        {sellable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.current.name} (v{p.current.version})
            {p.current.prices.ESP?.monthly
              ? ` — ${fmtMoney(p.current.prices.ESP.monthly, "ESP")}/mo, ${p.current.prices.ESP.annual != null ? fmtMoney(p.current.prices.ESP.annual, "ESP") : "–"}/yr`
              : ""}
          </option>
        ))}
      </select>
    </Row>
  );
  const cycleSelect = (
    <Row label="Billing">
      <select value={cycle} onChange={(e) => setCycle(e.target.value as Cycle)} className={field}>
        {CYCLES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </Row>
  );
  const paidFields = (label: string) => (
    <Row label={label} hint={paidCurrency === "ESP" ? "Off-band: nothing is charged from here." : `${paidCurrency} is ${NOT_CONNECTED}.`}>
      <div className="flex gap-2">
        <input type="number" min={0} step="0.01" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} className={`${field} min-w-0`} placeholder="amount" />
        <select aria-label={`${label}: currency`} value={paidCurrency} onChange={(e) => setPaidCurrency(e.target.value)} className={`${field} w-28 shrink-0`}>
          {CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code}
            </option>
          ))}
        </select>
      </div>
    </Row>
  );

  // The confirmation is a form of its own, so it sits beside this one: a
  // form inside a form is invalid HTML, and its submit reloaded the page.
  return (
    <>
      <form
        className="mt-4 space-y-3 rounded-lg border border-white/10 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        {action === "assign" && (
          <>
            {planSelect}
            {cycleSelect}
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={trial} disabled={!trialDays} onChange={(e) => setTrial(e.target.checked)} />
              {trialPolicy && !trialPolicy.enabled
                ? "Free trials are turned off in Settings → Registration"
                : `Start with ${target?.current.trialDays ? "the plan's" : "the platform default"} ${trialDays}-day trial`}
            </label>
            {!trial && (
              <>
                <Row label="Length in days" hint="Empty = one billing cycle (30 or 365 days)">
                  <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className={field} />
                </Row>
                {paidFields("Paid off-band (optional)")}
              </>
            )}
          </>
        )}
        {action === "change" && (
          <>
            {planSelect}
            {cycleSelect}
            {direction && (
              <p className="text-xs text-zinc-400">
                This is{" "}
                {direction === "upgrade" ? "an upgrade: it applies now" : direction === "downgrade" ? "a downgrade: by default it waits for the period end" : "a change at the same price per day"}.
              </p>
            )}
            <Row label="When">
              <select value={when} onChange={(e) => setWhen(e.target.value as typeof when)} className={field}>
                <option value="now">Now (unused days are converted)</option>
                <option value="period_end" disabled={!sub?.periodEnd}>
                  At the period end
                  {sub?.periodEnd ? ` (${day(sub.periodEnd)})` : ""} — usual for downgrades
                </option>
              </select>
            </Row>
            {when === "now" && (
              <>
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={newPeriod} onChange={(e) => setNewPeriod(e.target.checked)} />
                  Also start a new {cycle} period (the customer paid for it off-band)
                </label>
                {newPeriod && paidFields("Paid off-band (defaults to the list price)")}
              </>
            )}
          </>
        )}
        {action === "extend" && (
          <Row label="Days to add">
            <input type="number" min={1} max={3650} required value={days} onChange={(e) => setDays(e.target.value)} className={field} />
          </Row>
        )}
        {action === "cancel" && (
          <Row label="When">
            <select value={when} onChange={(e) => setWhen(e.target.value as typeof when)} className={field}>
              <option value="period_end" disabled={!sub?.periodEnd || sub.status === "paused"}>
                At the period end — keeps the plan until {day(sub?.periodEnd)}
              </option>
              <option value="now">Now — back to Free immediately, no refund</option>
            </select>
          </Row>
        )}
        {(action === "comp" || action === "custom") && (
          <>
            {planSelect}
            <Row label="Length in days" hint="Empty = no end date">
              <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className={field} />
            </Row>
          </>
        )}
        {action === "custom" && (
          <>
            {cycleSelect}
            {paidFields("Agreed price (collected off-band)")}
            <Row label="Notes (who agreed what)">
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={field} rows={2} maxLength={1000} />
            </Row>
            <div>
              <p className="text-sm text-zinc-300">Limits — leave empty to keep {target?.current.name ?? "the plan"}&apos;s</p>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {LIMIT_FIELDS.map((f) => (
                  <label key={f.key} className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                    <span>
                      {f.label}
                      {!f.enforced && <span className="text-amber-400"> (not enforced)</span>}
                    </span>
                    {f.kind === "bool" ? (
                      <select
                        value={limits[f.key] === undefined ? "" : String(limits[f.key])}
                        onChange={(e) =>
                          setLimits({
                            ...limits,
                            [f.key]: e.target.value === "" ? undefined : e.target.value === "true",
                          })
                        }
                        className={`${field} w-28`}
                      >
                        <option value="">plan&apos;s ({target ? (target.current.limits[f.key] ? "yes" : "no") : "—"})</option>
                        <option value="true">yes</option>
                        <option value="false">no</option>
                      </select>
                    ) : (
                      <input
                        type="number"
                        min={0}
                        placeholder={target ? String(target.current.limits[f.key] ?? f.zero ?? "") : ""}
                        value={limits[f.key] === undefined ? "" : String(limits[f.key])}
                        onChange={(e) =>
                          setLimits({
                            ...limits,
                            [f.key]: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                        className={`${field} w-28`}
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
        {action === "addons" &&
          (addOns.filter((a) => !a.archived).length === 0 ? (
            <p className="text-sm text-zinc-400">
              No add-ons exist yet. Make them under{" "}
              <Link href="/admin/plans" className="text-cyan-300 underline">
                Plans → Add-ons
              </Link>
              .
            </p>
          ) : (
            <div className="space-y-1">
              {addOns
                .filter((a) => !a.archived || picked.includes(a.id))
                .map((a) => {
                  const offered = !a.planIds.length || (sub && a.planIds.includes(sub.planId));
                  return (
                    <label key={a.id} className={`flex items-center gap-2 text-sm ${offered ? "text-zinc-200" : "text-zinc-400"}`}>
                      <input
                        type="checkbox"
                        disabled={!offered}
                        className="h-4 w-4 accent-cyan-500"
                        checked={picked.includes(a.id)}
                        onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))}
                      />
                      {a.name}
                      {!offered && " (not offered with this plan)"}
                    </label>
                  );
                })}
            </div>
          ))}
        {(action === "pause" || action === "resume" || action === "unschedule") && <p className="text-sm text-zinc-400">Preview to see exactly what happens.</p>}
        {problem && (
          <Notice kind="err" onClose={() => setProblem(null)}>
            {problem}
          </Notice>
        )}
        <button type="submit" disabled={busy || ((action === "assign" || action === "change" || action === "comp" || action === "custom") && !planId)} className={btn.primary}>
          {busy ? "Working…" : "Preview"}
        </button>
      </form>
      {preview && (
        <Confirm
          title={`Confirm: ${preview.summary}`}
          body={
            <div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {preview.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-zinc-300">The proration rule</summary>
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  {rule.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ol>
              </details>
            </div>
          }
          confirmLabel={action === "cancel" && when === "now" ? "Cancel now" : "Confirm"}
          danger={action === "cancel"}
          // Ending a plan at once cannot be undone from here: no refund, back to Free immediately.
          typeToConfirm={action === "cancel" && when === "now" ? "cancel" : undefined}
          withReason="Reason (kept in the history and the audit log)"
          onConfirm={run}
          onCancel={() => setPreview(null)}
        />
      )}
    </>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm text-zinc-300 sm:grid sm:grid-cols-[12rem_1fr] sm:items-center sm:gap-3">
      <span>{label}</span>
      <span className="mt-1 block sm:mt-0">
        {children}
        {hint && <span className="mt-0.5 block text-xs text-zinc-400">{hint}</span>}
      </span>
    </label>
  );
}
