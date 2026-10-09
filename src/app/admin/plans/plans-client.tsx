"use client";

// The plan catalog: plans and their versions, coupons, promotional offers
// and add-ons. Saving a plan's terms makes a new version; subscribers stay
// on theirs until migrated from the version list (previewed, then
// confirmed). Every write goes through /api/admin/* with plans:write.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CURRENCIES,
  CYCLES,
  LIMIT_FIELDS,
  NOT_CONNECTED,
  SHOWN_NOT_ENFORCED,
  TIER_LABELS,
  termsDiff,
  type AddOn,
  type CatalogPlan,
  type Coupon,
  type Cycle,
  type LimitField,
  type Offer,
  type PlanTerms,
  type PlanVersion,
  type Prices,
} from "@/lib/billing/model";
import type { PlanFeatureLimits } from "@/lib/planLimits";
import { Time, fmtMoney, fmtNumber, fmtTime, fromZonedInput, toZonedInput, useAdmin, zoneLabel } from "../AdminApi";
import {
  Badge,
  Confirm,
  FilterBar,
  Labeled,
  LoadState,
  Notice,
  PageHeader,
  Pager,
  Panel,
  SortTh,
  TabPanel,
  TableWrap,
  Tabs,
  btn,
  field,
  useClientTable,
  useUrlFilters,
} from "../ui";

type Counts = { total: number; live: number; byVersion: Record<string, number> };
type PlanRow = CatalogPlan & { subscribers: Counts };
type Msg = { kind: "ok" | "err"; text: string } | null;
type Tab = "plans" | "coupons" | "offers" | "addons";

const TABS: { id: Tab; label: string }[] = [
  { id: "plans", label: "Plans" },
  { id: "coupons", label: "Coupons" },
  { id: "offers", label: "Offers" },
  { id: "addons", label: "Add-ons" },
];

export default function PlansClient() {
  // The tab is in the address bar so a link can open on Coupons or Add-ons.
  const url = useUrlFilters({ tab: "plans" });
  const tab: Tab = TABS.some((t) => t.id === url.value.tab) ? (url.value.tab as Tab) : "plans";
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const { adminFetch } = useAdmin();

  const loadPlans = useCallback(async () => {
    setPlansError(null);
    const r = await adminFetch<{ plans: PlanRow[] }>("/api/admin/plans");
    if (r.ok) setPlans(r.data.plans);
    else setPlansError(r.data.message ?? "Could not load the plans.");
  }, [adminFetch]);
  useEffect(() => {
    loadPlans();
  }, [loadPlans]);

  return (
    <div>
      <PageHeader
        title="Plans & pricing"
        sub={
          <>
            What is sold and on what terms. eSPees (ESP) is the only payment gateway connected; prices in other currencies are shown but {NOT_CONNECTED}. Saving a plan&apos;s terms makes a new version
            — existing subscribers keep theirs until you migrate them.
          </>
        }
      />
      <Tabs
        label="Catalog"
        idBase="catalog"
        tabs={TABS}
        value={tab}
        onChange={(t) => {
          setMsg(null);
          url.set({ tab: t });
        }}
      />
      <TabPanel idBase="catalog" value={tab}>
        {msg && (
          <Notice kind={msg.kind} onClose={() => setMsg(null)}>
            {msg.text}
          </Notice>
        )}
        {tab === "plans" && (
          <LoadState data={plans} error={plansError} onRetry={loadPlans}>
            {(p) => <PlansTab plans={p} reload={loadPlans} say={setMsg} />}
          </LoadState>
        )}
        {/* The other tabs only use the plans for names; they still work if the plans did not load. */}
        {tab !== "plans" && plansError && !plans && (
          <Notice kind="err" onRetry={loadPlans}>
            {plansError} Plan names below show as ids.
          </Notice>
        )}
        {tab === "coupons" && <CouponsTab plans={plans ?? []} say={setMsg} />}
        {tab === "offers" && <OffersTab plans={plans ?? []} say={setMsg} />}
        {tab === "addons" && <AddOnsTab plans={plans ?? []} say={setMsg} />}
      </TabPanel>
    </div>
  );
}

/* ---------------------------------- helpers -------------------------------- */

const esp = (p: Prices, c: Cycle) => {
  const v = p.ESP?.[c];
  return v == null ? "—" : fmtMoney(v, "ESP");
};

function limitText(f: LimitField, v: unknown): string {
  if (f.kind === "bool") return v ? "Yes" : "No";
  if (v === null || v === undefined) return f.zero ?? "—";
  if (v === 0 && f.zero) return f.zero;
  return `${typeof v === "number" ? fmtNumber(v) : v}${f.unit ? ` ${f.unit}` : ""}`;
}

// Fixed discounts are in Espees: the only currency checkout takes.
function discountText(d: { kind: "percent" | "fixed"; value: number }) {
  return d.kind === "percent" ? `${fmtNumber(d.value)}% off` : `${fmtMoney(d.value, "ESP")} off`;
}

function planNames(ids: string[], plans: PlanRow[]) {
  if (!ids.length) return "All plans";
  return ids.map((id) => plans.find((p) => p.id === id)?.current.name ?? id).join(", ");
}

/** The subscriptions list filtered to one plan (it shows each subscriber's version). */
const subscribersHref = (planId: string) => `/admin/subscriptions?view=all&plan=${encodeURIComponent(planId)}`;

// Date-only inputs are days on the admin clock: a start is that day's first
// minute, an end its last second.
const toDateInput = (ms: number | null) => (ms ? toZonedInput(ms).slice(0, 10) : "");
const fromDateInput = (s: string, endOfDay: boolean) => {
  if (!s) return null;
  const t = fromZonedInput(`${s}T${endOfDay ? "23:59" : "00:00"}`);
  return t == null ? null : endOfDay ? t + 59_000 : t;
};

const matches = (q: string, ...parts: (string | null | undefined)[]) => {
  const n = q.trim().toLowerCase();
  return !n || parts.some((p) => (p ?? "").toLowerCase().includes(n));
};

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block text-sm text-zinc-300">
      {label}
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-0.5 block text-xs text-zinc-400">{hint}</span>}
    </label>
  );
}

function PlanPicker({ plans, value, onChange }: { plans: PlanRow[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="text-sm text-zinc-300">
      <legend>Plans (none ticked = every plan)</legend>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {plans
          .filter((p) => p.id !== "free")
          .map((p) => (
            <label key={p.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="h-4 w-4 accent-cyan-500"
                checked={value.includes(p.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))}
              />
              {p.current.name}
            </label>
          ))}
      </div>
    </fieldset>
  );
}

function CyclePicker({ value, onChange }: { value: Cycle[]; onChange: (v: Cycle[]) => void }) {
  return (
    <fieldset className="text-sm text-zinc-300">
      <legend>Billing (none ticked = both)</legend>
      <div className="mt-1 flex gap-4">
        {CYCLES.map((c) => (
          <label key={c} className="flex items-center gap-1.5">
            <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={value.includes(c)} onChange={(e) => onChange(e.target.checked ? [...value, c] : value.filter((x) => x !== c))} />
            {c}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Search box for a catalog list. */
function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <Labeled label="Search" className="w-full sm:w-64">
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={field} />
    </Labeled>
  );
}

/* ----------------------------------- plans --------------------------------- */

function PlansTab({ plans, reload, say }: { plans: PlanRow[]; reload: () => Promise<void>; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const [editing, setEditing] = useState<PlanRow | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [moving, setMoving] = useState(false);
  const shown = plans.filter((p) => showArchived || !p.archived);

  const move = async (p: PlanRow, dir: -1 | 1) => {
    const ids = plans.map((x) => x.id);
    const i = ids.indexOf(p.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length || moving) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    say(null);
    setMoving(true);
    const r = await adminFetch("/api/admin/plans/reorder", { method: "POST", json: { ids } });
    if (!r.ok) say({ kind: "err", text: r.data.message ?? "Could not reorder." });
    else say({ kind: "ok", text: `Moved ${p.current.name} ${dir < 0 ? "up" : "down"}. /pricing and checkout list the plans in this order.` });
    await reload();
    setMoving(false);
  };

  if (editing) {
    return (
      <PlanEditor
        plan={editing === "new" ? null : editing}
        onDone={async (text) => {
          setEditing(null);
          if (text) say({ kind: "ok", text });
          await reload();
        }}
        say={say}
      />
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived plans
        </label>
        {write && (
          <button
            type="button"
            className={btn.primary}
            onClick={() => {
              say(null);
              setEditing("new");
            }}
          >
            New plan
          </button>
        )}
      </div>
      <TableWrap minWidth={720}>
        <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
          <tr>
            {write && <th className="px-3 py-2">Order</th>}
            <th className="px-3 py-2">Plan</th>
            <th className="px-3 py-2">Monthly</th>
            <th className="px-3 py-2">Annual</th>
            <th className="px-3 py-2">Version</th>
            <th className="px-3 py-2">Subscribers</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => {
            const i = plans.indexOf(p);
            return (
              <tr key={p.id} className="border-t border-white/5">
                {write && (
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label={`Move ${p.current.name} up`}
                        disabled={moving || i === 0}
                        className="rounded px-1.5 text-zinc-400 hover:bg-white/5 disabled:opacity-30"
                        onClick={() => move(p, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${p.current.name} down`}
                        disabled={moving || i === plans.length - 1}
                        className="rounded px-1.5 text-zinc-400 hover:bg-white/5 disabled:opacity-30"
                        onClick={() => move(p, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  </td>
                )}
                <td className="px-3 py-2">
                  <div className="font-medium text-zinc-100">{p.current.name}</div>
                  <div className="font-mono text-xs text-zinc-400">
                    {p.id}
                    {p.baseTier !== p.id && <> · treated as {TIER_LABELS[p.baseTier]}</>}
                  </div>
                </td>
                <td className="px-3 py-2 text-zinc-300">{esp(p.current.prices, "monthly")}</td>
                <td className="px-3 py-2 text-zinc-300">{esp(p.current.prices, "annual")}</td>
                <td className="px-3 py-2 text-zinc-300">v{p.current.version}</td>
                <td className="px-3 py-2 text-zinc-300">
                  {p.id === "free" ? (
                    <span className="text-zinc-400">everyone without a plan</span>
                  ) : (
                    <>
                      <Link href={subscribersHref(p.id)} className="text-cyan-300 hover:underline" title="Open the subscriptions list for this plan">
                        {fmtNumber(p.subscribers.live)}
                        <span className="sr-only"> subscribers of {p.current.name}</span>
                      </Link>
                      {Object.keys(p.subscribers.byVersion).length > 1 && (
                        <span className="ml-1 text-xs text-zinc-400">
                          (
                          {Object.entries(p.subscribers.byVersion)
                            .map(([v, n]) => `v${v}: ${fmtNumber(n)}`)
                            .join(", ")}
                          )
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {p.archived && <Badge tone="red">Archived</Badge>}
                    {p.selfServe && !p.archived && <Badge tone="green">On sale</Badge>}
                    {p.public && !p.archived && <Badge tone="cyan">On /pricing</Badge>}
                    {p.highlight && <Badge tone="amber">Highlighted</Badge>}
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    className={btn.ghost}
                    aria-label={`${write ? "Edit" : "View"} ${p.current.name}`}
                    onClick={() => {
                      say(null);
                      setEditing(p);
                    }}
                  >
                    {write ? "Edit" : "View"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
    </div>
  );
}

const blankTerms = (limits: PlanFeatureLimits): PlanTerms => ({ name: "", description: "", prices: {}, trialDays: 0, limits });

type SaleSettings = { selfServe: boolean; public: boolean; highlight: boolean; archived: boolean };

/** What a change to a plan's sale settings does, for the confirmation. */
const SETTING_EFFECT: Record<keyof SaleSettings, [on: string, off: string]> = {
  selfServe: ["Put on sale: buyers can pay for it at eSPees checkout.", "Taken off sale: nobody can buy it at checkout. Current subscribers keep it."],
  public: ["Listed on /pricing.", "Taken off /pricing."],
  highlight: ["Highlighted as most popular on /pricing.", "No longer highlighted."],
  archived: ["Archived: not sold and not listed. Current subscribers keep it.", "Unarchived: it can be sold and listed again as ticked."],
};

function PlanEditor({ plan, onDone, say }: { plan: PlanRow | null; onDone: (msg?: string) => void; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const isFree = plan?.id === "free";
  const [terms, setTerms] = useState<PlanTerms>(() =>
    plan
      ? { name: plan.current.name, description: plan.current.description, prices: plan.current.prices, trialDays: plan.current.trialDays, limits: plan.current.limits }
      : blankTerms(LIMIT_FIELDS.reduce((o, f) => ({ ...o, [f.key]: f.kind === "bool" ? false : f.kind === "nullable" ? null : 0 }), {} as PlanFeatureLimits)),
  );
  const [settings, setSettings] = useState<SaleSettings>({
    selfServe: plan?.selfServe ?? false,
    public: plan?.public ?? false,
    highlight: plan?.highlight ?? false,
    archived: plan?.archived ?? false,
  });
  const [id, setId] = useState("");
  const [baseTier, setBaseTier] = useState<"starter" | "pro" | "business" | "enterprise">("business");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tierError, setTierError] = useState<string | null>(null);
  const [tierTry, setTierTry] = useState(0);

  const changes = useMemo(() => (plan ? termsDiff(plan.current, terms) : {}), [plan, terms]);
  const nChanges = Object.keys(changes).length;
  // Sale settings change what buyers see at once, so they are confirmed too.
  const settingChanges = plan ? (Object.keys(settings) as (keyof SaleSettings)[]).filter((k) => settings[k] !== plan[k]) : [];

  // A new plan starts from the limits of the tier it is treated as.
  useEffect(() => {
    if (plan) return;
    let live = true;
    setTierError(null);
    adminFetch<{ plans: PlanRow[] }>("/api/admin/plans").then((r) => {
      if (!live) return;
      const tier = r.ok ? r.data.plans.find((p) => p.id === baseTier) : null;
      if (tier) setTerms((t) => ({ ...t, limits: tier.current.limits }));
      else
        setTierError(
          r.ok
            ? `There is no ${TIER_LABELS[baseTier]} plan to copy limits from; set them below.`
            : `${r.data.message ?? "Could not read the plans."} The limits below were not copied from ${TIER_LABELS[baseTier]}.`,
        );
    });
    return () => {
      live = false;
    };
  }, [adminFetch, baseTier, plan, tierTry]);

  const save = async () => {
    setBusy(true);
    setError(null);
    say(null);
    const r = plan
      ? await adminFetch<{ newVersion: number | null }>(`/api/admin/plans/${encodeURIComponent(plan.id)}`, {
          method: "PATCH",
          json: { terms, settings, note },
        })
      : await adminFetch("/api/admin/plans", { method: "POST", json: { ...terms, id: id || undefined, baseTier, ...settings } });
    setBusy(false);
    if (!r.ok) {
      setConfirm(false);
      return setError(r.data.message ?? "Could not save the plan.");
    }
    const nv = (r.data as { newVersion?: number | null }).newVersion;
    onDone(plan ? (nv ? `Saved "${terms.name}" as version ${nv}. Existing subscribers stay on their version.` : `Saved "${terms.name}".`) : `Created "${terms.name}".`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">{plan ? `${plan.current.name} — v${plan.current.version}` : "New plan"}</h2>
        <button type="button" className={btn.ghost} onClick={() => onDone()}>
          Back to plans
        </button>
      </div>
      {error && (
        <Notice kind="err" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {tierError && (
        <Notice kind="err" onRetry={() => setTierTry((n) => n + 1)} onClose={() => setTierError(null)}>
          {tierError}
        </Notice>
      )}
      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            if (plan && (nChanges || settingChanges.length)) setConfirm(true);
            else save();
          }}
        >
          <fieldset disabled={!write || busy} className="space-y-4">
            {!plan && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Plan id" hint="Lowercase letters, digits and dashes. Left empty, made from the name. Cannot change later.">
                  <input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} className={field} placeholder="schools-plus" maxLength={40} />
                </Field>
                <Field label="Treated as" hint="What the rest of the app sees: labels, which pricing card it resembles. Limits come from this plan.">
                  <select value={baseTier} onChange={(e) => setBaseTier(e.target.value as typeof baseTier)} className={field}>
                    {(["starter", "pro", "business", "enterprise"] as const).map((t) => (
                      <option key={t} value={t}>
                        {TIER_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <TermsFields terms={terms} setTerms={setTerms} isFree={isFree} />
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["selfServe", "On sale at checkout (eSPees)", isFree],
                  ["public", "Listed on /pricing", false],
                  ["highlight", "Highlighted as most popular", false],
                  ["archived", "Archived (not sold, not listed; subscribers keep it)", isFree],
                ] as const
              ).map(([k, label, off]) => (
                <label key={k} className={`flex items-center gap-2 text-sm ${off ? "text-zinc-400" : "text-zinc-200"}`}>
                  <input type="checkbox" disabled={off} className="h-4 w-4 accent-cyan-500" checked={settings[k]} onChange={(e) => setSettings({ ...settings, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
            {plan && (
              <Field label="What changed (kept with the version and in the audit log)">
                <input value={note} onChange={(e) => setNote(e.target.value)} className={field} maxLength={300} />
              </Field>
            )}
          </fieldset>
          {write && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="submit" disabled={busy || !terms.name.trim()} className={btn.primary}>
                {busy ? "Saving…" : plan ? (nChanges ? `Save as version ${plan.current.version + 1}` : "Save settings") : "Create plan"}
              </button>
              {!terms.name.trim() && <span className="text-xs text-zinc-400">Give the plan a name first.</span>}
              {plan && nChanges > 0 && <span className="text-xs text-zinc-400">{nChanges} term(s) changed — new purchases get the new version.</span>}
            </div>
          )}
        </form>
      </Panel>
      {plan && <VersionsPanel plan={plan} say={say} />}
      {confirm && plan && (
        <Confirm
          title={nChanges ? `Save ${plan.current.name} as version ${plan.current.version + 1}?` : `Change how ${plan.current.name} is sold?`}
          body={
            <div>
              {nChanges > 0 && (
                <>
                  <ul className="mt-2 space-y-1 text-xs">
                    {Object.entries(changes).map(([k, [a, b]]) => (
                      <li key={k}>
                        <span className="font-mono text-zinc-300">{k}</span>: <span className="text-red-300">{JSON.stringify(a)}</span> → <span className="text-emerald-300">{JSON.stringify(b)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3">
                    New purchases get version {plan.current.version + 1}. The {fmtNumber(plan.subscribers.live)} current subscriber(s) keep the version they bought until you migrate them.
                    {isFree && " Free has no buyers: the change reaches every account without a plan at once."}
                  </p>
                </>
              )}
              {settingChanges.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {settingChanges.map((k) => (
                    <li key={k}>{SETTING_EFFECT[k][settings[k] ? 0 : 1]}</li>
                  ))}
                </ul>
              )}
            </div>
          }
          confirmLabel={nChanges ? "Save new version" : "Save settings"}
          onConfirm={() => save()}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

function TermsFields({ terms, setTerms, isFree }: { terms: PlanTerms; setTerms: (t: PlanTerms) => void; isFree: boolean }) {
  const setPrice = (code: string, cycle: Cycle, v: string) => {
    const cur = terms.prices[code as keyof Prices] ?? { monthly: null, annual: null };
    setTerms({ ...terms, prices: { ...terms.prices, [code]: { ...cur, [cycle]: v === "" ? null : Number(v) } } });
  };
  const setLimit = (f: LimitField, v: unknown) => setTerms({ ...terms, limits: { ...terms.limits, [f.key]: v } });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
        <Field label="Name">
          <input required maxLength={60} value={terms.name} onChange={(e) => setTerms({ ...terms, name: e.target.value })} className={field} />
        </Field>
        <Field label="Description">
          <input maxLength={400} value={terms.description} onChange={(e) => setTerms({ ...terms, description: e.target.value })} className={field} />
        </Field>
        <Field label="Trial days">
          <input
            type="number"
            min={0}
            max={365}
            disabled={isFree}
            value={terms.trialDays}
            onChange={(e) => setTerms({ ...terms, trialDays: Number(e.target.value) || 0 })}
            className={`${field} sm:w-24`}
          />
        </Field>
      </div>
      <div>
        <h3 className="text-sm font-medium text-zinc-200">Prices</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="text-xs text-zinc-400">
              <tr>
                <th className="py-1 text-left font-normal">Currency</th>
                <th className="py-1 text-left font-normal">Monthly</th>
                <th className="py-1 text-left font-normal">Annual</th>
              </tr>
            </thead>
            <tbody>
              {CURRENCIES.map((c) => (
                <tr key={c.code}>
                  <td className="py-1 pr-3 align-top">
                    <div className="text-zinc-200">{c.label}</div>
                    <div className={`text-xs ${c.live ? "text-emerald-400" : "text-amber-400"}`}>{c.live ? `Charged through ${c.gateway}` : NOT_CONNECTED}</div>
                  </td>
                  {CYCLES.map((cy) => (
                    <td key={cy} className="py-1 pr-3">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`${c.code} ${cy} price`}
                        disabled={isFree}
                        value={terms.prices[c.code]?.[cy] ?? ""}
                        onChange={(e) => setPrice(c.code, cy, e.target.value)}
                        placeholder="not offered"
                        className={field}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <h3 className="text-sm font-medium text-zinc-200">Features and limits</h3>
        <p className="text-xs text-zinc-400">Marked “{SHOWN_NOT_ENFORCED}” means the app shows the value but nothing checks it today.</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LIMIT_FIELDS.map((f) => {
            const v = terms.limits[f.key];
            return (
              <div key={f.key} className="min-w-0 rounded-lg border border-white/5 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm text-zinc-200">{f.label}</span>
                  {f.enforced ? <Badge tone="green">enforced</Badge> : <Badge tone="amber">{SHOWN_NOT_ENFORCED}</Badge>}
                </div>
                <div className="mt-1.5">
                  {f.kind === "bool" ? (
                    <label className="flex items-center gap-2 text-sm text-zinc-300">
                      <input type="checkbox" aria-label={f.label} className="h-4 w-4 accent-cyan-500" checked={!!v} onChange={(e) => setLimit(f, e.target.checked)} />
                      Included
                    </label>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      aria-label={f.label}
                      value={v === null || v === undefined ? "" : String(v)}
                      placeholder={f.kind === "nullable" ? f.zero : undefined}
                      onChange={(e) => setLimit(f, e.target.value === "" ? (f.kind === "nullable" ? null : 0) : Math.max(0, Math.floor(Number(e.target.value))))}
                      className={field}
                    />
                  )}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-zinc-400">
                  {f.zero && f.kind !== "bool" ? `${f.kind === "nullable" ? "Empty" : "0"} = ${f.zero}. ` : ""}
                  {f.how}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type MigrationRow = { userId: string; email: string; status: string; fromVersion: number; changes: Record<string, [unknown, unknown]> };

function VersionsPanel({ plan, say }: { plan: PlanRow; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const [data, setData] = useState<{ versions: PlanVersion[]; subscribers: Counts } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ to: number; from: number[] | null; rows: MigrationRow[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const r = await adminFetch<{ versions: PlanVersion[]; subscribers: Counts }>(`/api/admin/plans/${encodeURIComponent(plan.id)}`);
    if (r.ok) setData(r.data);
    else setError(r.data.message ?? "Could not load the versions.");
  }, [adminFetch, plan.id]);
  useEffect(() => {
    load();
  }, [load]);

  const ask = async (to: number, from: number[] | null) => {
    say(null);
    setBusy(true);
    const r = await adminFetch<{ rows: MigrationRow[] }>(`/api/admin/plans/${encodeURIComponent(plan.id)}/migrate`, { method: "POST", json: { toVersion: to, fromVersions: from } });
    setBusy(false);
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not preview the migration." });
    setPreview({ to, from, rows: r.data.rows });
  };
  const run = async (reason: string) => {
    if (!preview) return;
    const p = preview;
    const r = await adminFetch<{ applied: number; failed: { userId: string; reason: string }[] }>(`/api/admin/plans/${encodeURIComponent(plan.id)}/migrate`, {
      method: "POST",
      json: { toVersion: p.to, fromVersions: p.from, confirm: true, reason },
    });
    setPreview(null);
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "The migration failed." });
    say({
      kind: r.data.failed.length ? "err" : "ok",
      text: `Moved ${r.data.applied} subscriber(s) to v${p.to}.${r.data.failed.length ? ` ${r.data.failed.length} could not be moved: ${r.data.failed.map((f) => f.reason).join("; ")}` : ""}`,
    });
    load();
  };

  const mayMigrate = can("plans:write") && can("subscriptions:write") && plan.id !== "free";
  return (
    <Panel>
      <h3 className="text-base font-semibold text-white">Versions</h3>
      <p className="mt-0.5 text-sm text-zinc-400">Each subscriber stays on the version they bought. Migrating moves them to another version&apos;s terms; their period and price paid do not change.</p>
      <div className="mt-3">
        <LoadState data={data} error={error} onRetry={load}>
          {(d) => (
            <ul className="divide-y divide-white/5">
              {d.versions.map((v) => {
                const n = d.subscribers.byVersion[String(v.version)] ?? 0;
                const others = Object.entries(d.subscribers.byVersion).filter(([k, c]) => Number(k) !== v.version && c > 0);
                return (
                  <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <div className="text-sm text-zinc-100">
                        v{v.version} — {v.name} {v.version === plan.currentVersion && <Badge tone="cyan">current</Badge>}
                      </div>
                      <div className="text-xs text-zinc-400">
                        {v.createdAt ? fmtTime(v.createdAt) : "built in"} · {v.createdBy} · {esp(v.prices, "monthly")} / {esp(v.prices, "annual")}
                        {v.note ? ` · ${v.note}` : ""}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-400">
                        {LIMIT_FIELDS.filter((f) => f.enforced)
                          .map((f) => `${f.label}: ${limitText(f, v.limits[f.key])}`)
                          .join(" · ")}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {plan.id !== "free" &&
                        (n > 0 ? (
                          <Link href={subscribersHref(plan.id)} className="text-sm text-cyan-300 hover:underline" title="Open the subscriptions list for this plan; it shows each subscriber's version">
                            {fmtNumber(n)} subscriber(s)
                            <span className="sr-only"> on v{v.version}</span>
                          </Link>
                        ) : (
                          <span className="text-sm text-zinc-400">no subscribers</span>
                        ))}
                      {mayMigrate && others.length > 0 && (
                        <button type="button" disabled={busy} className={btn.warn} onClick={() => ask(v.version, null)}>
                          {busy ? "Working…" : `Move others to v${v.version}…`}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </LoadState>
      </div>
      {preview && (
        <Confirm
          title={`Move ${preview.rows.length} subscriber(s) to v${preview.to}?`}
          body={
            preview.rows.length ? (
              <div className="max-h-72 overflow-y-auto">
                <ul className="mt-2 space-y-1.5 text-xs">
                  {preview.rows.map((r) => (
                    <li key={r.userId}>
                      <span className="text-zinc-200">{r.email || r.userId}</span> (v{r.fromVersion}, {r.status}):{" "}
                      {Object.keys(r.changes).length
                        ? Object.entries(r.changes)
                            .map(([k, [a, b]]) => `${k} ${JSON.stringify(a)} → ${JSON.stringify(b)}`)
                            .join(", ")
                        : "no limit changes"}
                    </li>
                  ))}
                </ul>
                <p className="mt-3">Their limits change at once. Periods and prices paid stay as they are.</p>
              </div>
            ) : (
              "Nobody would move."
            )
          }
          confirmLabel="Migrate"
          danger
          typeToConfirm={preview.rows.length ? "migrate" : undefined}
          withReason="Reason (kept in the audit log)"
          onConfirm={(reason) => (preview.rows.length ? run(reason) : setPreview(null))}
          onCancel={() => setPreview(null)}
        />
      )}
    </Panel>
  );
}

/* ---------------------------------- coupons -------------------------------- */

type CouponRow = Coupon & { redemptions: number };

function couponState(c: CouponRow, now: number): "off" | "expired" | "used up" | "not started" | "active" {
  if (!c.active) return "off";
  if (c.expiresAt && c.expiresAt < now) return "expired";
  if (c.maxRedemptions != null && c.redemptions >= c.maxRedemptions) return "used up";
  if (c.startsAt && c.startsAt > now) return "not started";
  return "active";
}
const COUPON_TONE = { off: "zinc", expired: "red", "used up": "amber", "not started": "amber", active: "green" } as const;

function CouponsTab({ plans, say }: { plans: PlanRow[]; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const [rows, setRows] = useState<CouponRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Coupon> | null>(null);
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState<{ kind: "toggle" | "delete"; c: CouponRow } | null>(null);
  const [q, setQ] = useState("");
  const [state, setState] = useState("");

  const load = useCallback(async () => {
    setError(null);
    const r = await adminFetch<{ coupons: CouponRow[] }>("/api/admin/coupons");
    if (r.ok) setRows(r.data.coupons);
    else setError(r.data.message ?? "Could not load coupons.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const now = Date.now();
  const shown = useMemo(
    () => (rows ? rows.filter((c) => matches(q, c.code, c.description) && (!state || couponState(c, now) === state)) : null),
    // `now` moves every render; the states only need re-reading when the list or filters change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, q, state],
  );
  const t = useClientTable(
    shown,
    (c, k) => (k === "code" ? c.code : k === "used" ? c.redemptions : k === "valid" ? (c.expiresAt ?? Number.MAX_SAFE_INTEGER) : (c.createdAt ?? 0)),
    { key: "created", dir: "desc" },
  );

  const save = async () => {
    if (!form || saving) return;
    say(null);
    setSaving(true);
    const editing = rows?.some((c) => c.code === form.code) && form.createdAt;
    const r = editing
      ? await adminFetch(`/api/admin/coupons/${encodeURIComponent(form.code!)}`, { method: "PATCH", json: form })
      : await adminFetch("/api/admin/coupons", { method: "POST", json: form });
    setSaving(false);
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not save the coupon." });
    say({ kind: "ok", text: `Saved coupon ${(form.code ?? "").toUpperCase()}.` });
    setForm(null);
    load();
  };
  const toggle = async (c: CouponRow) => {
    say(null);
    const r = await adminFetch(`/api/admin/coupons/${encodeURIComponent(c.code)}`, { method: "PATCH", json: { active: !c.active } });
    setAsk(null);
    if (!r.ok) say({ kind: "err", text: r.data.message ?? "Could not change the coupon." });
    else say({ kind: "ok", text: `${c.code} is ${c.active ? "switched off" : "switched on"}.` });
    await load();
  };
  const remove = async (c: CouponRow) => {
    say(null);
    const r = await adminFetch(`/api/admin/coupons/${encodeURIComponent(c.code)}`, { method: "DELETE" });
    setAsk(null);
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not delete the coupon." });
    say({ kind: "ok", text: `Deleted ${c.code}.` });
    await load();
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Codes buyers enter at eSPees checkout. A redemption counts when the payment comes back paid. A coupon and a running offer do not stack — the larger discount applies — and nothing can bring a
        price below {fmtMoney(1, "ESP")}.
      </p>
      {write && !form && (
        <button
          type="button"
          className={btn.primary}
          onClick={() => {
            say(null);
            setForm({ kind: "percent", value: 10, planIds: [], cycles: [], oncePerUser: true, active: true, maxRedemptions: null });
          }}
        >
          New coupon
        </button>
      )}
      {form && (
        <Panel>
          <h3 className="mb-3 text-sm font-semibold text-white">{form.createdAt ? `Edit ${form.code}` : "New coupon"}</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <fieldset disabled={saving} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Code">
                  <input
                    required
                    disabled={!!form.createdAt}
                    value={form.code ?? ""}
                    onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                    className={field}
                    maxLength={32}
                    placeholder="LAUNCH20"
                  />
                </Field>
                <Field label="Discount">
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Coupon["kind"] })} className={field}>
                    <option value="percent">Percent off</option>
                    <option value="fixed">ESP off</option>
                  </select>
                </Field>
                <Field label={form.kind === "percent" ? "Percent" : "Amount (ESP)"}>
                  <input type="number" min={0.01} step="0.01" required value={form.value ?? ""} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} className={field} />
                </Field>
                <Field label="Max redemptions" hint="Empty = no limit">
                  <input
                    type="number"
                    min={1}
                    value={form.maxRedemptions ?? ""}
                    onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value ? Number(e.target.value) : null })}
                    className={field}
                  />
                </Field>
                <Field label="Starts" hint={`Start of that day, ${zoneLabel()}`}>
                  <input type="date" value={toDateInput(form.startsAt ?? null)} onChange={(e) => setForm({ ...form, startsAt: fromDateInput(e.target.value, false) })} className={field} />
                </Field>
                <Field label="Expires" hint={`End of that day, ${zoneLabel()}`}>
                  <input type="date" value={toDateInput(form.expiresAt ?? null)} onChange={(e) => setForm({ ...form, expiresAt: fromDateInput(e.target.value, true) })} className={field} />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Description (admins only)">
                    <input value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} className={field} maxLength={300} />
                  </Field>
                </div>
              </div>
              <PlanPicker plans={plans} value={form.planIds ?? []} onChange={(planIds) => setForm({ ...form, planIds })} />
              <CyclePicker value={form.cycles ?? []} onChange={(cycles) => setForm({ ...form, cycles })} />
              <div className="flex flex-wrap gap-4 text-sm text-zinc-300">
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={form.oncePerUser ?? true} onChange={(e) => setForm({ ...form, oncePerUser: e.target.checked })} />
                  Once per account
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={form.active ?? true} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Active
                </label>
              </div>
              <div className="flex gap-2">
                <button type="submit" className={btn.primary}>
                  {saving ? "Saving…" : "Save coupon"}
                </button>
                <button type="button" className={btn.ghost} onClick={() => setForm(null)}>
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        </Panel>
      )}
      <LoadState data={rows} error={error} onRetry={load} empty="No coupons yet.">
        {() => (
          <>
            <FilterBar
              active={!!q || !!state}
              onClear={() => {
                setQ("");
                setState("");
              }}
            >
              <SearchBox value={q} onChange={setQ} placeholder="Code or description" />
              <Labeled label="State">
                <select value={state} onChange={(e) => setState(e.target.value)} className={`${field} sm:w-40`}>
                  <option value="">Any</option>
                  {(["active", "not started", "used up", "expired", "off"] as const).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Labeled>
            </FilterBar>
            {t.total === 0 ? (
              <Notice kind="info">No coupon matches these filters.</Notice>
            ) : (
              <>
                <TableWrap minWidth={760}>
                  <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
                    <tr>
                      <SortTh label="Code" k="code" sort={t.sort} onSort={t.onSort} />
                      <th className="px-3 py-2">Discount</th>
                      <th className="px-3 py-2">For</th>
                      <SortTh label="Valid" k="valid" sort={t.sort} onSort={t.onSort} />
                      <SortTh label="Used" k="used" sort={t.sort} onSort={t.onSort} />
                      <th className="px-3 py-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.visible.map((c) => {
                      const st = couponState(c, now);
                      return (
                        <tr key={c.code} className="border-t border-white/5">
                          <td className="px-3 py-2">
                            <span className="font-mono text-zinc-100">{c.code}</span> <Badge tone={COUPON_TONE[st]}>{st}</Badge>
                            {c.description && <div className="text-xs text-zinc-400">{c.description}</div>}
                          </td>
                          <td className="px-3 py-2 text-zinc-300">{discountText(c)}</td>
                          <td className="px-3 py-2 text-zinc-300">
                            {planNames(c.planIds, plans)}
                            <div className="text-xs text-zinc-400">{c.cycles.length ? c.cycles.join(", ") : "monthly and annual"}</div>
                          </td>
                          <td className="px-3 py-2 text-xs text-zinc-400">
                            {c.startsAt ? (
                              <>
                                from <Time ts={c.startsAt} />
                              </>
                            ) : (
                              "now"
                            )}
                            <br />
                            {c.expiresAt ? (
                              <>
                                until <Time ts={c.expiresAt} />
                              </>
                            ) : (
                              "no expiry"
                            )}
                          </td>
                          <td className="px-3 py-2 text-zinc-300">
                            {fmtNumber(c.redemptions)}
                            {c.maxRedemptions != null ? ` / ${fmtNumber(c.maxRedemptions)}` : ""}
                            {c.oncePerUser && <div className="text-xs text-zinc-400">once per account</div>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {write && (
                              <div className="flex flex-wrap justify-end gap-1.5">
                                <button
                                  type="button"
                                  className={btn.ghost}
                                  aria-label={`Edit ${c.code}`}
                                  onClick={() => {
                                    say(null);
                                    setForm(c);
                                  }}
                                >
                                  Edit
                                </button>
                                <button type="button" className={btn.ghost} aria-label={`${c.active ? "Switch off" : "Switch on"} ${c.code}`} onClick={() => setAsk({ kind: "toggle", c })}>
                                  {c.active ? "Switch off" : "Switch on"}
                                </button>
                                {c.redemptions === 0 && (
                                  <button type="button" className={btn.danger} aria-label={`Delete ${c.code}`} onClick={() => setAsk({ kind: "delete", c })}>
                                    Delete
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableWrap>
                <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="coupon" />
              </>
            )}
          </>
        )}
      </LoadState>
      {ask?.kind === "toggle" && (
        <Confirm
          title={`${ask.c.active ? "Switch off" : "Switch on"} ${ask.c.code}?`}
          body={
            ask.c.active
              ? "Buyers can no longer use it at checkout. Redemptions so far stay counted, and you can switch it on again."
              : "Buyers can use it at checkout again, within its dates, plans and redemption limit."
          }
          confirmLabel={ask.c.active ? "Switch off" : "Switch on"}
          onConfirm={() => toggle(ask.c)}
          onCancel={() => setAsk(null)}
        />
      )}
      {ask?.kind === "delete" && (
        <Confirm title={`Delete ${ask.c.code}?`} body="Nobody has used it, so nothing refers to it." confirmLabel="Delete" danger onConfirm={() => remove(ask.c)} onCancel={() => setAsk(null)} />
      )}
    </div>
  );
}

/* ---------------------------------- offers --------------------------------- */

function offerState(o: Offer, now: number): "running" | "scheduled" | "ended" | "off" {
  if (!o.active) return "off";
  if (o.startsAt && now < o.startsAt) return "scheduled";
  if (o.endsAt && now > o.endsAt) return "ended";
  return "running";
}
const OFFER_TONE = { running: "green", scheduled: "amber", ended: "zinc", off: "zinc" } as const;

function OffersTab({ plans, say }: { plans: PlanRow[]; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const [rows, setRows] = useState<Offer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Offer> | null>(null);
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState<{ kind: "toggle" | "delete"; o: Offer } | null>(null);
  const [q, setQ] = useState("");
  const [state, setState] = useState("");

  const load = useCallback(async () => {
    setError(null);
    const r = await adminFetch<{ offers: Offer[] }>("/api/admin/offers");
    if (r.ok) setRows(r.data.offers);
    else setError(r.data.message ?? "Could not load offers.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const now = Date.now();
  const shown = useMemo(
    () => (rows ? rows.filter((o) => matches(q, o.name, o.label) && (!state || offerState(o, now) === state)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, q, state],
  );
  const t = useClientTable(shown, (o, k) => (k === "name" ? o.name : k === "starts" ? (o.startsAt ?? 0) : k === "ends" ? (o.endsAt ?? Number.MAX_SAFE_INTEGER) : (o.startsAt ?? 0)), {
    key: "starts",
    dir: "desc",
  });

  const save = async () => {
    if (!form || saving) return;
    say(null);
    setSaving(true);
    const r = form.id ? await adminFetch(`/api/admin/offers/${encodeURIComponent(form.id)}`, { method: "PATCH", json: form }) : await adminFetch("/api/admin/offers", { method: "POST", json: form });
    setSaving(false);
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not save the offer." });
    say({ kind: "ok", text: `Saved offer "${form.name}".` });
    setForm(null);
    load();
  };
  const patch = async (o: Offer, body: Record<string, unknown>, method = "PATCH") => {
    say(null);
    const r = await adminFetch(`/api/admin/offers/${encodeURIComponent(o.id)}`, { method, json: method === "PATCH" ? body : undefined });
    setAsk(null);
    if (!r.ok) say({ kind: "err", text: r.data.message ?? "Could not change the offer." });
    else say({ kind: "ok", text: method === "DELETE" ? `Deleted offer "${o.name}".` : `Offer "${o.name}" is ${body.active ? "switched on" : "switched off"}.` });
    await load();
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">A discount with no code, taken off at eSPees checkout while it runs and shown on /pricing with its label.</p>
      {write && !form && (
        <button
          type="button"
          className={btn.primary}
          onClick={() => {
            say(null);
            setForm({ kind: "percent", value: 20, planIds: [], cycles: ["annual"], active: true });
          }}
        >
          New offer
        </button>
      )}
      {form && (
        <Panel>
          <h3 className="mb-3 text-sm font-semibold text-white">{form.id ? `Edit "${form.name}"` : "New offer"}</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <fieldset disabled={saving} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Name (admins)">
                  <input required value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} maxLength={80} />
                </Field>
                <Field label="Label on /pricing">
                  <input value={form.label ?? ""} onChange={(e) => setForm({ ...form, label: e.target.value })} className={field} maxLength={80} placeholder="Back to school: 20% off" />
                </Field>
                <Field label="Discount">
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Offer["kind"] })} className={field}>
                    <option value="percent">Percent off</option>
                    <option value="fixed">ESP off</option>
                  </select>
                </Field>
                <Field label={form.kind === "percent" ? "Percent" : "Amount (ESP)"}>
                  <input type="number" min={0.01} step="0.01" required value={form.value ?? ""} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} className={field} />
                </Field>
                <Field label="Starts" hint={`Start of that day, ${zoneLabel()}`}>
                  <input type="date" value={toDateInput(form.startsAt ?? null)} onChange={(e) => setForm({ ...form, startsAt: fromDateInput(e.target.value, false) })} className={field} />
                </Field>
                <Field label="Ends" hint={`End of that day, ${zoneLabel()}`}>
                  <input type="date" value={toDateInput(form.endsAt ?? null)} onChange={(e) => setForm({ ...form, endsAt: fromDateInput(e.target.value, true) })} className={field} />
                </Field>
              </div>
              <PlanPicker plans={plans} value={form.planIds ?? []} onChange={(planIds) => setForm({ ...form, planIds })} />
              <CyclePicker value={form.cycles ?? []} onChange={(cycles) => setForm({ ...form, cycles })} />
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" className="h-4 w-4 accent-cyan-500" checked={form.active ?? true} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                Active
              </label>
              <div className="flex gap-2">
                <button type="submit" className={btn.primary}>
                  {saving ? "Saving…" : "Save offer"}
                </button>
                <button type="button" className={btn.ghost} onClick={() => setForm(null)}>
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        </Panel>
      )}
      <LoadState data={rows} error={error} onRetry={load} empty="No offers yet.">
        {() => (
          <>
            <FilterBar
              active={!!q || !!state}
              onClear={() => {
                setQ("");
                setState("");
              }}
            >
              <SearchBox value={q} onChange={setQ} placeholder="Name or label" />
              <Labeled label="State">
                <select value={state} onChange={(e) => setState(e.target.value)} className={`${field} sm:w-40`}>
                  <option value="">Any</option>
                  {(["running", "scheduled", "ended", "off"] as const).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Labeled>
            </FilterBar>
            {t.total === 0 ? (
              <Notice kind="info">No offer matches these filters.</Notice>
            ) : (
              <>
                <TableWrap minWidth={760}>
                  <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
                    <tr>
                      <SortTh label="Offer" k="name" sort={t.sort} onSort={t.onSort} />
                      <th className="px-3 py-2">Discount</th>
                      <th className="px-3 py-2">For</th>
                      <SortTh label="Starts" k="starts" sort={t.sort} onSort={t.onSort} />
                      <SortTh label="Ends" k="ends" sort={t.sort} onSort={t.onSort} />
                      <th className="px-3 py-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.visible.map((o) => {
                      const st = offerState(o, now);
                      return (
                        <tr key={o.id} className="border-t border-white/5">
                          <td className="px-3 py-2">
                            <span className="text-zinc-100">{o.name}</span> <Badge tone={OFFER_TONE[st]}>{st}</Badge>
                            {o.label && <div className="text-xs text-cyan-300">“{o.label}”</div>}
                          </td>
                          <td className="px-3 py-2 text-zinc-300">{discountText(o)}</td>
                          <td className="px-3 py-2 text-zinc-300">
                            {planNames(o.planIds, plans)}
                            <div className="text-xs text-zinc-400">{o.cycles.length ? o.cycles.join(", ") : "monthly and annual"}</div>
                          </td>
                          <td className="px-3 py-2 text-xs text-zinc-400">{o.startsAt ? <Time ts={o.startsAt} /> : "now"}</td>
                          <td className="px-3 py-2 text-xs text-zinc-400">{o.endsAt ? <Time ts={o.endsAt} /> : "no end"}</td>
                          <td className="px-3 py-2 text-right">
                            {write && (
                              <div className="flex flex-wrap justify-end gap-1.5">
                                <button
                                  type="button"
                                  className={btn.ghost}
                                  aria-label={`Edit ${o.name}`}
                                  onClick={() => {
                                    say(null);
                                    setForm(o);
                                  }}
                                >
                                  Edit
                                </button>
                                <button type="button" className={btn.ghost} aria-label={`${o.active ? "Switch off" : "Switch on"} ${o.name}`} onClick={() => setAsk({ kind: "toggle", o })}>
                                  {o.active ? "Switch off" : "Switch on"}
                                </button>
                                <button type="button" className={btn.danger} aria-label={`Delete ${o.name}`} onClick={() => setAsk({ kind: "delete", o })}>
                                  Delete
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableWrap>
                <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="offer" />
              </>
            )}
          </>
        )}
      </LoadState>
      {ask?.kind === "toggle" && (
        <Confirm
          title={`${ask.o.active ? "Switch off" : "Switch on"} "${ask.o.name}"?`}
          body={
            ask.o.active
              ? "Checkout stops taking it off and /pricing stops showing its label. You can switch it on again."
              : "Checkout takes it off and /pricing shows its label while it runs (within its dates)."
          }
          confirmLabel={ask.o.active ? "Switch off" : "Switch on"}
          onConfirm={() => patch(ask.o, { active: !ask.o.active })}
          onCancel={() => setAsk(null)}
        />
      )}
      {ask?.kind === "delete" && (
        <Confirm
          title={`Delete "${ask.o.name}"?`}
          body="The offer is removed from checkout and /pricing at once. This cannot be undone; switch it off instead to keep it for later."
          confirmLabel="Delete offer"
          danger
          onConfirm={() => patch(ask.o, {}, "DELETE")}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}

/* ---------------------------------- add-ons -------------------------------- */

const GRANT_FIELDS: { key: string; label: string; kind: "number" | "bool" }[] = [
  { key: "maxParticipants", label: "Extra participants", kind: "number" },
  { key: "recordingHoursPerMonth", label: "Extra recording hours / month", kind: "number" },
  { key: "groupMembers", label: "Extra group members", kind: "number" },
  { key: "seats", label: "Extra host seats (shown, not enforced yet)", kind: "number" },
  { key: "storageGb", label: "Extra storage GB", kind: "number" },
  { key: "recording", label: "Cloud recording", kind: "bool" },
  { key: "livestream", label: "Livestream", kind: "bool" },
  { key: "translation", label: "Choose translation languages", kind: "bool" },
  { key: "breakouts", label: "Breakout rooms", kind: "bool" },
  { key: "branding", label: "Custom branding (shown, not enforced yet)", kind: "bool" },
];

function grantText(g: Record<string, unknown>) {
  return GRANT_FIELDS.filter((f) => g[f.key])
    .map((f) => (f.kind === "bool" ? f.label.replace(/ \(.*\)$/, "") : `+${g[f.key]} ${f.label.replace(/^Extra /, "").replace(/ \(.*\)$/, "")}`))
    .join(", ");
}

function AddOnsTab({ plans, say }: { plans: PlanRow[]; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const [rows, setRows] = useState<AddOn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<AddOn> | null>(null);
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState<AddOn | null>(null);
  const [q, setQ] = useState("");
  const [state, setState] = useState("current");

  const load = useCallback(async () => {
    setError(null);
    const r = await adminFetch<{ addOns: AddOn[] }>("/api/admin/addons");
    if (r.ok) setRows(r.data.addOns);
    else setError(r.data.message ?? "Could not load add-ons.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const shown = useMemo(
    () => (rows ? rows.filter((a) => matches(q, a.name, a.description) && (state === "all" || (state === "archived" ? a.archived : !a.archived))) : null),
    [rows, q, state],
  );
  const t = useClientTable(shown, (a, k) => (k === "price" ? (a.prices.ESP?.monthly ?? null) : a.name), { key: "name", dir: "asc" });

  const save = async () => {
    if (!form || saving) return;
    say(null);
    setSaving(true);
    const r = form.id ? await adminFetch(`/api/admin/addons/${encodeURIComponent(form.id)}`, { method: "PATCH", json: form }) : await adminFetch("/api/admin/addons", { method: "POST", json: form });
    setSaving(false);
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not save the add-on." });
    say({ kind: "ok", text: `Saved add-on "${form.name}".` });
    setForm(null);
    load();
  };
  const archive = async (a: AddOn) => {
    say(null);
    const r = await adminFetch(`/api/admin/addons/${encodeURIComponent(a.id)}`, { method: "PATCH", json: { archived: !a.archived } });
    setAsk(null);
    if (!r.ok) say({ kind: "err", text: r.data.message ?? "Could not change the add-on." });
    else say({ kind: "ok", text: `"${a.name}" is ${a.archived ? "back in the list of add-ons" : "archived"}.` });
    await load();
  };

  const grants = (form?.grants ?? {}) as Record<string, unknown>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Extras attached to a subscription from its page. They are enforced like the plan&apos;s own limits. There is no self-serve purchase of add-ons yet: charge for them off-band.
      </p>
      {write && !form && (
        <button
          type="button"
          className={btn.primary}
          onClick={() => {
            say(null);
            setForm({ grants: {}, planIds: [], prices: {} });
          }}
        >
          New add-on
        </button>
      )}
      {form && (
        <Panel>
          <h3 className="mb-3 text-sm font-semibold text-white">{form.id ? `Edit "${form.name}"` : "New add-on"}</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <fieldset disabled={saving} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Name">
                  <input required value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} className={field} maxLength={80} />
                </Field>
                <Field label="Description">
                  <input value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} className={field} maxLength={300} />
                </Field>
                <Field label="Price, ESP monthly" hint="Charged off-band">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.prices?.ESP?.monthly ?? ""}
                    onChange={(e) => setForm({ ...form, prices: { ...form.prices, ESP: { monthly: e.target.value === "" ? null : Number(e.target.value), annual: form.prices?.ESP?.annual ?? null } } })}
                    className={field}
                  />
                </Field>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {GRANT_FIELDS.map((f) =>
                  f.kind === "bool" ? (
                    <label key={f.key} className="flex items-center gap-2 text-sm text-zinc-300">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-cyan-500"
                        checked={grants[f.key] === true}
                        onChange={(e) => setForm({ ...form, grants: { ...grants, [f.key]: e.target.checked || undefined } })}
                      />
                      {f.label}
                    </label>
                  ) : (
                    <label key={f.key} className="flex items-center justify-between gap-2 text-sm text-zinc-300">
                      {f.label}
                      <input
                        type="number"
                        min={0}
                        value={(grants[f.key] as number | undefined) ?? ""}
                        onChange={(e) => setForm({ ...form, grants: { ...grants, [f.key]: e.target.value ? Number(e.target.value) : undefined } })}
                        className={`${field} w-28 shrink-0`}
                      />
                    </label>
                  ),
                )}
              </div>
              <PlanPicker plans={plans} value={form.planIds ?? []} onChange={(planIds) => setForm({ ...form, planIds })} />
              <div className="flex gap-2">
                <button type="submit" className={btn.primary}>
                  {saving ? "Saving…" : "Save add-on"}
                </button>
                <button type="button" className={btn.ghost} onClick={() => setForm(null)}>
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        </Panel>
      )}
      <LoadState data={rows} error={error} onRetry={load} empty="No add-ons yet.">
        {() => (
          <>
            <FilterBar
              active={!!q || state !== "current"}
              onClear={() => {
                setQ("");
                setState("current");
              }}
            >
              <SearchBox value={q} onChange={setQ} placeholder="Name or description" />
              <Labeled label="Show">
                <select value={state} onChange={(e) => setState(e.target.value)} className={`${field} sm:w-40`}>
                  <option value="current">Not archived</option>
                  <option value="archived">Archived</option>
                  <option value="all">All</option>
                </select>
              </Labeled>
            </FilterBar>
            {t.total === 0 ? (
              <Notice kind="info">No add-on matches these filters.</Notice>
            ) : (
              <>
                <TableWrap minWidth={720}>
                  <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-400">
                    <tr>
                      <SortTh label="Add-on" k="name" sort={t.sort} onSort={t.onSort} />
                      <th className="px-3 py-2">Grants</th>
                      <th className="px-3 py-2">For</th>
                      <SortTh label="Price (off-band)" k="price" sort={t.sort} onSort={t.onSort} />
                      <th className="px-3 py-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.visible.map((a) => (
                      <tr key={a.id} className="border-t border-white/5">
                        <td className="px-3 py-2">
                          <span className="text-zinc-100">{a.name}</span> {a.archived && <Badge tone="red">archived</Badge>}
                          {a.description && <div className="text-xs text-zinc-400">{a.description}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs text-zinc-300">{grantText(a.grants as Record<string, unknown>) || "—"}</td>
                        <td className="px-3 py-2 text-xs text-zinc-300">{planNames(a.planIds, plans)}</td>
                        <td className="px-3 py-2 text-zinc-300">{a.prices.ESP?.monthly != null ? `${fmtMoney(a.prices.ESP.monthly, "ESP")}/month` : "—"}</td>
                        <td className="px-3 py-2 text-right">
                          {write && (
                            <div className="flex flex-wrap justify-end gap-1.5">
                              <button
                                type="button"
                                className={btn.ghost}
                                aria-label={`Edit ${a.name}`}
                                onClick={() => {
                                  say(null);
                                  setForm(a);
                                }}
                              >
                                Edit
                              </button>
                              <button type="button" className={btn.ghost} aria-label={`${a.archived ? "Unarchive" : "Archive"} ${a.name}`} onClick={() => setAsk(a)}>
                                {a.archived ? "Unarchive" : "Archive"}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
                <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="add-on" />
              </>
            )}
          </>
        )}
      </LoadState>
      {ask && (
        <Confirm
          title={`${ask.archived ? "Unarchive" : "Archive"} "${ask.name}"?`}
          body={
            ask.archived
              ? "It can be attached to subscriptions again from their pages."
              : "It can no longer be attached to a subscription. Subscriptions that have it now keep it until it is taken off their page."
          }
          confirmLabel={ask.archived ? "Unarchive" : "Archive"}
          onConfirm={() => archive(ask)}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}
