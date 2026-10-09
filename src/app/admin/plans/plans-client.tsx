"use client";

// The plan catalog: plans and their versions, coupons, promotional offers
// and add-ons. Saving a plan's terms makes a new version; subscribers stay
// on theirs until migrated from the version list (previewed, then
// confirmed). Every write goes through /api/admin/* with plans:write.

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
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";

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
  const [tab, setTab] = useState<Tab>("plans");
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const { adminFetch } = useAdmin();

  const loadPlans = useCallback(async () => {
    const r = await adminFetch<{ plans: PlanRow[] }>("/api/admin/plans");
    if (r.ok) setPlans(r.data.plans);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load the plans." });
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
      <div role="tablist" aria-label="Catalog" className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t.id ? "border-cyan-400 text-cyan-100" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {tab === "plans" && (plans ? <PlansTab plans={plans} reload={loadPlans} say={setMsg} /> : <Loading />)}
      {tab === "coupons" && <CouponsTab plans={plans ?? []} say={setMsg} />}
      {tab === "offers" && <OffersTab plans={plans ?? []} say={setMsg} />}
      {tab === "addons" && <AddOnsTab plans={plans ?? []} say={setMsg} />}
    </div>
  );
}

/* ---------------------------------- helpers -------------------------------- */

const esp = (p: Prices, c: Cycle) => {
  const v = p.ESP?.[c];
  return v == null ? "—" : `${v} ESP`;
};

function limitText(f: LimitField, v: unknown): string {
  if (f.kind === "bool") return v ? "Yes" : "No";
  if (v === null || v === undefined) return f.zero ?? "—";
  if (v === 0 && f.zero) return f.zero;
  return `${v}${f.unit ? ` ${f.unit}` : ""}`;
}

function discountText(d: { kind: "percent" | "fixed"; value: number }) {
  return d.kind === "percent" ? `${d.value}% off` : `${d.value} ESP off`;
}

function planNames(ids: string[], plans: PlanRow[]) {
  if (!ids.length) return "All plans";
  return ids.map((id) => plans.find((p) => p.id === id)?.current.name ?? id).join(", ");
}

const toDateInput = (ms: number | null) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : "");
const fromDateInput = (s: string, endOfDay: boolean) => (s ? new Date(`${s}T${endOfDay ? "23:59:59" : "00:00:00"}`).getTime() : null);

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block text-sm text-zinc-300">
      {label}
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>}
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

/* ----------------------------------- plans --------------------------------- */

function PlansTab({ plans, reload, say }: { plans: PlanRow[]; reload: () => Promise<void>; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const [editing, setEditing] = useState<PlanRow | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const shown = plans.filter((p) => showArchived || !p.archived);

  const move = async (id: string, dir: -1 | 1) => {
    const ids = plans.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await adminFetch("/api/admin/plans/reorder", { method: "POST", json: { ids } });
    if (!r.ok) say({ kind: "err", text: r.data.message ?? "Could not reorder." });
    await reload();
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
          <button type="button" className={btn.primary} onClick={() => setEditing("new")}>
            New plan
          </button>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              {write && <th className="px-3 py-2">Order</th>}
              <th className="px-3 py-2">Plan</th>
              <th className="px-3 py-2">Monthly</th>
              <th className="px-3 py-2">Annual</th>
              <th className="px-3 py-2">Version</th>
              <th className="px-3 py-2">Subscribers</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className="border-t border-white/5">
                {write && (
                  <td className="px-3 py-2">
                    <div className="flex gap-1">
                      <button type="button" aria-label={`Move ${p.current.name} up`} className="rounded px-1.5 text-zinc-400 hover:bg-white/5" onClick={() => move(p.id, -1)}>
                        ↑
                      </button>
                      <button type="button" aria-label={`Move ${p.current.name} down`} className="rounded px-1.5 text-zinc-400 hover:bg-white/5" onClick={() => move(p.id, 1)}>
                        ↓
                      </button>
                    </div>
                  </td>
                )}
                <td className="px-3 py-2">
                  <div className="font-medium text-zinc-100">{p.current.name}</div>
                  <div className="font-mono text-xs text-zinc-500">
                    {p.id}
                    {p.baseTier !== p.id && <> · treated as {TIER_LABELS[p.baseTier]}</>}
                  </div>
                </td>
                <td className="px-3 py-2 text-zinc-300">{esp(p.current.prices, "monthly")}</td>
                <td className="px-3 py-2 text-zinc-300">{esp(p.current.prices, "annual")}</td>
                <td className="px-3 py-2 text-zinc-300">v{p.current.version}</td>
                <td className="px-3 py-2 text-zinc-300">
                  {p.id === "free" ? (
                    <span className="text-zinc-500">everyone without a plan</span>
                  ) : (
                    <>
                      {p.subscribers.live}
                      {Object.keys(p.subscribers.byVersion).length > 1 && (
                        <span className="ml-1 text-xs text-zinc-500">
                          (
                          {Object.entries(p.subscribers.byVersion)
                            .map(([v, n]) => `v${v}: ${n}`)
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
                  <button type="button" className={btn.ghost} onClick={() => setEditing(p)}>
                    {write ? "Edit" : "View"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const blankTerms = (limits: PlanFeatureLimits): PlanTerms => ({ name: "", description: "", prices: {}, trialDays: 0, limits });

function PlanEditor({ plan, onDone, say }: { plan: PlanRow | null; onDone: (msg?: string) => void; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const isFree = plan?.id === "free";
  const [terms, setTerms] = useState<PlanTerms>(() =>
    plan
      ? { name: plan.current.name, description: plan.current.description, prices: plan.current.prices, trialDays: plan.current.trialDays, limits: plan.current.limits }
      : blankTerms(LIMIT_FIELDS.reduce((o, f) => ({ ...o, [f.key]: f.kind === "bool" ? false : f.kind === "nullable" ? null : 0 }), {} as PlanFeatureLimits)),
  );
  const [settings, setSettings] = useState({
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

  const changes = useMemo(() => (plan ? termsDiff(plan.current, terms) : {}), [plan, terms]);
  const nChanges = Object.keys(changes).length;

  // A new plan starts from the limits of the tier it is treated as.
  useEffect(() => {
    if (plan) return;
    adminFetch<{ plans: PlanRow[] }>("/api/admin/plans").then((r) => {
      const tier = r.ok ? r.data.plans.find((p) => p.id === baseTier) : null;
      if (tier) setTerms((t) => ({ ...t, limits: tier.current.limits }));
    });
  }, [adminFetch, baseTier, plan]);

  const save = async () => {
    setConfirm(false);
    setBusy(true);
    setError(null);
    const r = plan
      ? await adminFetch<{ newVersion: number | null }>(`/api/admin/plans/${encodeURIComponent(plan.id)}`, {
          method: "PATCH",
          json: { terms, settings, note },
        })
      : await adminFetch("/api/admin/plans", { method: "POST", json: { ...terms, id: id || undefined, baseTier, ...settings } });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "Could not save the plan.");
    const nv = (r.data as { newVersion?: number | null }).newVersion;
    onDone(plan ? (nv ? `Saved "${terms.name}" as version ${nv}. Existing subscribers stay on their version.` : `Saved "${terms.name}".`) : `Created "${terms.name}".`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">{plan ? `${plan.current.name} — v${plan.current.version}` : "New plan"}</h2>
        <button type="button" className={btn.ghost} onClick={() => onDone()}>
          Back to plans
        </button>
      </div>
      {error && <Notice kind="err">{error}</Notice>}
      <Panel>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (plan && nChanges) setConfirm(true);
            else save();
          }}
        >
          <fieldset disabled={!write} className="space-y-4">
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
                <label key={k} className={`flex items-center gap-2 text-sm ${off ? "text-zinc-600" : "text-zinc-200"}`}>
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
              {plan && nChanges > 0 && <span className="text-xs text-zinc-400">{nChanges} term(s) changed — new purchases get the new version.</span>}
            </div>
          )}
        </form>
      </Panel>
      {plan && <VersionsPanel plan={plan} say={say} />}
      {confirm && plan && (
        <Confirm
          title={`Save ${plan.current.name} as version ${plan.current.version + 1}?`}
          body={
            <div>
              <ul className="mt-2 space-y-1 text-xs">
                {Object.entries(changes).map(([k, [a, b]]) => (
                  <li key={k}>
                    <span className="font-mono text-zinc-300">{k}</span>: <span className="text-red-300">{JSON.stringify(a)}</span> → <span className="text-emerald-300">{JSON.stringify(b)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3">
                New purchases get version {plan.current.version + 1}. The {plan.subscribers.live} current subscriber(s) keep the version they bought until you migrate them.
                {isFree && " Free has no buyers: the change reaches every account without a plan at once."}
              </p>
            </div>
          }
          confirmLabel="Save new version"
          onConfirm={save}
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
            <thead className="text-xs text-zinc-500">
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
        <p className="text-xs text-zinc-500">Marked “{SHOWN_NOT_ENFORCED}” means the app shows the value but nothing checks it today.</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LIMIT_FIELDS.map((f) => {
            const v = terms.limits[f.key];
            return (
              <div key={f.key} className="rounded-lg border border-white/5 p-2.5">
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
                <p className="mt-1 text-[11px] leading-snug text-zinc-500">
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
  const [preview, setPreview] = useState<{ to: number; from: number[] | null; rows: MigrationRow[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await adminFetch<{ versions: PlanVersion[]; subscribers: Counts }>(`/api/admin/plans/${encodeURIComponent(plan.id)}`);
    if (r.ok) setData(r.data);
  }, [adminFetch, plan.id]);
  useEffect(() => {
    load();
  }, [load]);

  const ask = async (to: number, from: number[] | null) => {
    setBusy(true);
    const r = await adminFetch<{ rows: MigrationRow[] }>(`/api/admin/plans/${encodeURIComponent(plan.id)}/migrate`, { method: "POST", json: { toVersion: to, fromVersions: from } });
    setBusy(false);
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not preview the migration." });
    setPreview({ to, from, rows: r.data.rows });
  };
  const run = async (reason: string) => {
    if (!preview) return;
    const p = preview;
    setPreview(null);
    const r = await adminFetch<{ applied: number; failed: { userId: string; reason: string }[] }>(`/api/admin/plans/${encodeURIComponent(plan.id)}/migrate`, {
      method: "POST",
      json: { toVersion: p.to, fromVersions: p.from, confirm: true, reason },
    });
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "The migration failed." });
    say({
      kind: r.data.failed.length ? "err" : "ok",
      text: `Moved ${r.data.applied} subscriber(s) to v${p.to}.${r.data.failed.length ? ` ${r.data.failed.length} could not be moved: ${r.data.failed.map((f) => f.reason).join("; ")}` : ""}`,
    });
    load();
  };

  if (!data) return <Loading />;
  const mayMigrate = can("plans:write") && can("subscriptions:write") && plan.id !== "free";
  return (
    <Panel>
      <h3 className="text-base font-semibold text-white">Versions</h3>
      <p className="mt-0.5 text-sm text-zinc-400">Each subscriber stays on the version they bought. Migrating moves them to another version&apos;s terms; their period and price paid do not change.</p>
      <ul className="mt-3 divide-y divide-white/5">
        {data.versions.map((v) => {
          const n = data.subscribers.byVersion[String(v.version)] ?? 0;
          const others = Object.entries(data.subscribers.byVersion).filter(([k, c]) => Number(k) !== v.version && c > 0);
          return (
            <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <div className="text-sm text-zinc-100">
                  v{v.version} — {v.name} {v.version === plan.currentVersion && <Badge tone="cyan">current</Badge>}
                </div>
                <div className="text-xs text-zinc-500">
                  {v.createdAt ? fmtTime(v.createdAt) : "built in"} · {v.createdBy} · {esp(v.prices, "monthly")} / {esp(v.prices, "annual")}
                  {v.note ? ` · ${v.note}` : ""}
                </div>
                <div className="mt-0.5 text-xs text-zinc-400">
                  {LIMIT_FIELDS.filter((f) => f.enforced)
                    .map((f) => `${f.label}: ${limitText(f, v.limits[f.key])}`)
                    .join(" · ")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {plan.id !== "free" && <span className="text-sm text-zinc-300">{n} subscriber(s)</span>}
                {mayMigrate && others.length > 0 && (
                  <button type="button" disabled={busy} className={btn.warn} onClick={() => ask(v.version, null)}>
                    Move others to v{v.version}…
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
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

function CouponsTab({ plans, say }: { plans: PlanRow[]; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const [rows, setRows] = useState<CouponRow[] | null>(null);
  const [form, setForm] = useState<Partial<Coupon> | null>(null);
  const [del, setDel] = useState<CouponRow | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ coupons: CouponRow[] }>("/api/admin/coupons");
    if (r.ok) setRows(r.data.coupons);
    else say({ kind: "err", text: r.data.message ?? "Could not load coupons." });
  }, [adminFetch, say]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    const editing = rows?.some((c) => c.code === form.code) && form.createdAt;
    const r = editing
      ? await adminFetch(`/api/admin/coupons/${encodeURIComponent(form.code!)}`, { method: "PATCH", json: form })
      : await adminFetch("/api/admin/coupons", { method: "POST", json: form });
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not save the coupon." });
    say({ kind: "ok", text: `Saved coupon ${(form.code ?? "").toUpperCase()}.` });
    setForm(null);
    load();
  };
  const toggle = async (c: CouponRow) => {
    const r = await adminFetch(`/api/admin/coupons/${encodeURIComponent(c.code)}`, { method: "PATCH", json: { active: !c.active } });
    if (!r.ok) say({ kind: "err", text: r.data.message ?? "Could not change the coupon." });
    load();
  };
  const remove = async (c: CouponRow) => {
    setDel(null);
    const r = await adminFetch(`/api/admin/coupons/${encodeURIComponent(c.code)}`, { method: "DELETE" });
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not delete the coupon." });
    say({ kind: "ok", text: `Deleted ${c.code}.` });
    load();
  };

  if (!rows) return <Loading />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Codes buyers enter at eSPees checkout. A redemption counts when the payment comes back paid. A coupon and a running offer do not stack — the larger discount applies — and nothing can bring a
        price below 1 ESP.
      </p>
      {write && !form && (
        <button type="button" className={btn.primary} onClick={() => setForm({ kind: "percent", value: 10, planIds: [], cycles: [], oncePerUser: true, active: true, maxRedemptions: null })}>
          New coupon
        </button>
      )}
      {form && (
        <Panel>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
            className="space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-4">
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
              <Field label={form.kind === "percent" ? "Percent" : "ESP"}>
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
              <Field label="Starts">
                <input type="date" value={toDateInput(form.startsAt ?? null)} onChange={(e) => setForm({ ...form, startsAt: fromDateInput(e.target.value, false) })} className={field} />
              </Field>
              <Field label="Expires" hint="End of that day, your time">
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
                Save coupon
              </button>
              <button type="button" className={btn.ghost} onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      )}
      {rows.length === 0 ? (
        <Empty>No coupons yet.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-white/[0.03] text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Discount</th>
                <th className="px-3 py-2">For</th>
                <th className="px-3 py-2">Valid</th>
                <th className="px-3 py-2">Used</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.code} className="border-t border-white/5">
                  <td className="px-3 py-2">
                    <span className="font-mono text-zinc-100">{c.code}</span>{" "}
                    {!c.active ? (
                      <Badge>off</Badge>
                    ) : c.expiresAt && c.expiresAt < Date.now() ? (
                      <Badge tone="red">expired</Badge>
                    ) : c.maxRedemptions != null && c.redemptions >= c.maxRedemptions ? (
                      <Badge tone="amber">used up</Badge>
                    ) : c.startsAt && c.startsAt > Date.now() ? (
                      <Badge tone="amber">not started</Badge>
                    ) : (
                      <Badge tone="green">active</Badge>
                    )}
                    {c.description && <div className="text-xs text-zinc-500">{c.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{discountText(c)}</td>
                  <td className="px-3 py-2 text-zinc-300">
                    {planNames(c.planIds, plans)}
                    <div className="text-xs text-zinc-500">{c.cycles.length ? c.cycles.join(", ") : "monthly and annual"}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-400">
                    {c.startsAt ? `from ${fmtTime(c.startsAt)}` : "now"}
                    <br />
                    {c.expiresAt ? `until ${fmtTime(c.expiresAt)}` : "no expiry"}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">
                    {c.redemptions}
                    {c.maxRedemptions != null ? ` / ${c.maxRedemptions}` : ""}
                    {c.oncePerUser && <div className="text-xs text-zinc-500">once per account</div>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {write && (
                      <div className="flex justify-end gap-1.5">
                        <button type="button" className={btn.ghost} onClick={() => setForm(c)}>
                          Edit
                        </button>
                        <button type="button" className={btn.ghost} onClick={() => toggle(c)}>
                          {c.active ? "Switch off" : "Switch on"}
                        </button>
                        {c.redemptions === 0 && (
                          <button type="button" className={btn.danger} onClick={() => setDel(c)}>
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {del && <Confirm title={`Delete ${del.code}?`} body="Nobody has used it, so nothing refers to it." confirmLabel="Delete" danger onConfirm={() => remove(del)} onCancel={() => setDel(null)} />}
    </div>
  );
}

/* ---------------------------------- offers --------------------------------- */

function OffersTab({ plans, say }: { plans: PlanRow[]; say: (m: Msg) => void }) {
  const { can, adminFetch } = useAdmin();
  const write = can("plans:write");
  const [rows, setRows] = useState<Offer[] | null>(null);
  const [form, setForm] = useState<Partial<Offer> | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ offers: Offer[] }>("/api/admin/offers");
    if (r.ok) setRows(r.data.offers);
    else say({ kind: "err", text: r.data.message ?? "Could not load offers." });
  }, [adminFetch, say]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    const r = form.id ? await adminFetch(`/api/admin/offers/${encodeURIComponent(form.id)}`, { method: "PATCH", json: form }) : await adminFetch("/api/admin/offers", { method: "POST", json: form });
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not save the offer." });
    say({ kind: "ok", text: `Saved offer "${form.name}".` });
    setForm(null);
    load();
  };
  const patch = async (o: Offer, body: Record<string, unknown>, method = "PATCH") => {
    const r = await adminFetch(`/api/admin/offers/${encodeURIComponent(o.id)}`, { method, json: method === "PATCH" ? body : undefined });
    if (!r.ok) say({ kind: "err", text: r.data.message ?? "Could not change the offer." });
    load();
  };

  if (!rows) return <Loading />;
  const now = Date.now();
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">A discount with no code, taken off at eSPees checkout while it runs and shown on /pricing with its label.</p>
      {write && !form && (
        <button type="button" className={btn.primary} onClick={() => setForm({ kind: "percent", value: 20, planIds: [], cycles: ["annual"], active: true })}>
          New offer
        </button>
      )}
      {form && (
        <Panel>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
            className="space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-4">
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
              <Field label={form.kind === "percent" ? "Percent" : "ESP"}>
                <input type="number" min={0.01} step="0.01" required value={form.value ?? ""} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} className={field} />
              </Field>
              <Field label="Starts">
                <input type="date" value={toDateInput(form.startsAt ?? null)} onChange={(e) => setForm({ ...form, startsAt: fromDateInput(e.target.value, false) })} className={field} />
              </Field>
              <Field label="Ends">
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
                Save offer
              </button>
              <button type="button" className={btn.ghost} onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      )}
      {rows.length === 0 ? (
        <Empty>No offers yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((o) => {
            const running = o.active && (!o.startsAt || now >= o.startsAt) && (!o.endsAt || now <= o.endsAt);
            return (
              <li key={o.id}>
                <Panel className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm text-zinc-100">
                      {o.name} {running ? <Badge tone="green">running</Badge> : o.active ? <Badge tone="amber">scheduled / ended</Badge> : <Badge>off</Badge>}
                    </div>
                    <div className="text-xs text-zinc-400">
                      {discountText(o)} · {planNames(o.planIds, plans)} · {o.cycles.length ? o.cycles.join(", ") : "monthly and annual"} · {o.startsAt ? fmtTime(o.startsAt) : "now"} →{" "}
                      {o.endsAt ? fmtTime(o.endsAt) : "no end"}
                    </div>
                    {o.label && <div className="text-xs text-cyan-300">“{o.label}”</div>}
                  </div>
                  {write && (
                    <div className="flex gap-1.5">
                      <button type="button" className={btn.ghost} onClick={() => setForm(o)}>
                        Edit
                      </button>
                      <button type="button" className={btn.ghost} onClick={() => patch(o, { active: !o.active })}>
                        {o.active ? "Switch off" : "Switch on"}
                      </button>
                      <button type="button" className={btn.danger} onClick={() => patch(o, {}, "DELETE")}>
                        Delete
                      </button>
                    </div>
                  )}
                </Panel>
              </li>
            );
          })}
        </ul>
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
  const [form, setForm] = useState<Partial<AddOn> | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ addOns: AddOn[] }>("/api/admin/addons");
    if (r.ok) setRows(r.data.addOns);
    else say({ kind: "err", text: r.data.message ?? "Could not load add-ons." });
  }, [adminFetch, say]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    const r = form.id ? await adminFetch(`/api/admin/addons/${encodeURIComponent(form.id)}`, { method: "PATCH", json: form }) : await adminFetch("/api/admin/addons", { method: "POST", json: form });
    if (!r.ok) return say({ kind: "err", text: r.data.message ?? "Could not save the add-on." });
    say({ kind: "ok", text: `Saved add-on "${form.name}".` });
    setForm(null);
    load();
  };
  const archive = async (a: AddOn) => {
    const r = await adminFetch(`/api/admin/addons/${encodeURIComponent(a.id)}`, { method: "PATCH", json: { archived: !a.archived } });
    if (!r.ok) say({ kind: "err", text: r.data.message ?? "Could not change the add-on." });
    load();
  };

  if (!rows) return <Loading />;
  const grants = (form?.grants ?? {}) as Record<string, unknown>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-400">
        Extras attached to a subscription from its page. They are enforced like the plan&apos;s own limits. There is no self-serve purchase of add-ons yet: charge for them off-band.
      </p>
      {write && !form && (
        <button type="button" className={btn.primary} onClick={() => setForm({ grants: {}, planIds: [], prices: {} })}>
          New add-on
        </button>
      )}
      {form && (
        <Panel>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
            className="space-y-3"
          >
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
                      className={`${field} w-28`}
                    />
                  </label>
                ),
              )}
            </div>
            <PlanPicker plans={plans} value={form.planIds ?? []} onChange={(planIds) => setForm({ ...form, planIds })} />
            <div className="flex gap-2">
              <button type="submit" className={btn.primary}>
                Save add-on
              </button>
              <button type="button" className={btn.ghost} onClick={() => setForm(null)}>
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      )}
      {rows.length === 0 ? (
        <Empty>No add-ons yet.</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.id}>
              <Panel className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm text-zinc-100">
                    {a.name} {a.archived && <Badge tone="red">archived</Badge>}
                  </div>
                  <div className="text-xs text-zinc-400">
                    {grantText(a.grants as Record<string, unknown>)} · {planNames(a.planIds, plans)}
                    {a.prices.ESP?.monthly != null ? ` · ${a.prices.ESP.monthly} ESP/month (off-band)` : ""}
                  </div>
                </div>
                {write && (
                  <div className="flex gap-1.5">
                    <button type="button" className={btn.ghost} onClick={() => setForm(a)}>
                      Edit
                    </button>
                    <button type="button" className={btn.ghost} onClick={() => archive(a)}>
                      {a.archived ? "Unarchive" : "Archive"}
                    </button>
                  </div>
                )}
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
