"use client";

// Feature controls and maintenance mode. Every change asks for a fresh
// authenticator code (features:write is sensitive); looking does not.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtTime, fromZonedInput, toZonedInput, useAdmin, zoneLabel } from "../AdminApi";
import { Badge, Confirm, LoadState, Notice, PageHeader, Panel, btn, field } from "../ui";
import type { AccountOverride, FeatureDecision, FeatureKey, Maintenance } from "@/lib/platform/model";
import type { Plan } from "@/lib/planLimits";

type FeatureRow = { key: FeatureKey; label: string; catalog: boolean; enforcedAt: string | null };
type Data = {
  features: FeatureRow[];
  plans: Plan[];
  global: Partial<Record<FeatureKey, boolean>>;
  perPlan: Partial<Record<FeatureKey, Partial<Record<Plan, boolean>>>>;
  catalog: Record<Plan, Partial<Record<FeatureKey, boolean>>>;
  accounts: { userId: string; overrides: Partial<Record<FeatureKey, AccountOverride>> }[];
  maintenance: Maintenance;
};
type Account = {
  account: { userId: string; email: string; isOwner: boolean };
  plan: Plan;
  overrides: Partial<Record<FeatureKey, AccountOverride>>;
  decisions: Record<FeatureKey, FeatureDecision>;
};
type Msg = { kind: "ok" | "err"; text: string } | null;

const SOURCE: Record<FeatureDecision["source"], string> = {
  global: "turned off for everyone",
  account: "account override",
  plan: "plan switch",
  plan_default: "plan default",
  exempt: "operator (plan limits do not apply)",
};

const PLAN_VALUE: Record<string, string> = { default: "the default (on)", on: "on", off: "off" };
const OVERRIDE_VALUE: Record<string, string> = { plan: "follow the plan", allow: "allowed", deny: "denied" };

export default function FeaturesClient() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<Data>("/api/admin/features");
    if (r.ok) setData(r.data);
    else setLoadErr(r.data.message ?? "Could not load.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const patch = async (json: unknown, done: string) => {
    setMsg(null);
    const r = await adminFetch("/api/admin/features", { method: "PATCH", json });
    if (r.ok) {
      setMsg({ kind: "ok", text: done });
      await load();
    } else if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? "Not saved." });
  };

  return (
    <div>
      <PageHeader
        title="Features"
        sub="Turn each feature on or off for everyone, per plan, or for one account. Off for everyone wins over everything; an account's allow or deny wins over its plan."
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <LoadState data={data} error={loadErr} onRetry={load}>
        {(d) => (
          <div className="space-y-4">
            {/* Keyed on what is stored, so the form starts again from the saved values after each change. */}
            <MaintenancePanel
              key={`${d.maintenance.enabled}-${d.maintenance.startedAt}-${d.maintenance.endsAt}-${d.maintenance.message}`}
              maintenance={d.maintenance}
              onChanged={load}
              setMsg={setMsg}
            />
            <Matrix data={d} patch={patch} />
            <AccountOverrides data={d} setMsg={setMsg} onChanged={load} />
          </div>
        )}
      </LoadState>
    </div>
  );
}

/* ---------------------------------- matrix --------------------------------- */

function Matrix({ data, patch }: { data: Data; patch: (json: unknown, done: string) => Promise<void> }) {
  const [confirm, setConfirm] = useState<{ feature: FeatureRow; on: boolean } | null>(null);
  const [planAsk, setPlanAsk] = useState<{ feature: FeatureRow; plan: Plan; value: string } | null>(null);
  const setPlan = (f: FeatureKey, plan: Plan, value: string) => {
    const row = { ...(data.perPlan[f] ?? {}) };
    if (value === "default") delete row[plan];
    else row[plan] = value === "on";
    return patch({ perPlan: { [f]: Object.keys(row).length ? row : null } }, "Plan switch saved. Live within a few seconds.");
  };
  return (
    <Panel>
      <h2 className="mb-1 text-base font-semibold text-white">Switches</h2>
      <p className="mb-3 text-xs text-zinc-400">
        Per-plan values for recording, translation, livestream, breakouts and branding come from the plan itself — change them in{" "}
        <Link className="text-cyan-300 underline" href="/admin/plans">
          Plans
        </Link>
        .
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-400">
              <th className="py-2 pr-3 font-medium">Feature</th>
              <th className="py-2 pr-3 font-medium">Everyone</th>
              {data.plans.map((p) => (
                <th key={p} className="py-2 pr-3 font-medium capitalize">
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.features.map((f) => {
              const on = data.global[f.key] !== false;
              return (
                <tr key={f.key} className="border-t border-white/5 align-top" data-feature={f.key}>
                  <td className="py-2 pr-3">
                    <p className="text-zinc-100">{f.label}</p>
                    <p className="text-xs text-zinc-400">{f.enforcedAt ? `Checked at: ${f.enforcedAt}` : "Not checked anywhere yet — switching it has no effect."}</p>
                  </td>
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      className={on ? btn.ghost : btn.danger}
                      aria-pressed={on}
                      aria-label={`${f.label} for everyone: ${on ? "on" : "off"}`}
                      onClick={() => setConfirm({ feature: f, on: !on })}
                    >
                      {on ? "On" : "Off"}
                    </button>
                  </td>
                  {data.plans.map((p) => (
                    <td key={p} className="py-2 pr-3">
                      {f.catalog ? (
                        <span title="Set in Plans" className={data.catalog[p]?.[f.key] ? "text-emerald-300" : "text-zinc-400"}>
                          {data.catalog[p]?.[f.key] ? "✓ plan" : "✗ plan"}
                        </span>
                      ) : (
                        <select
                          aria-label={`${f.label} on ${p}`}
                          className={`${field} w-24 py-1 text-xs`}
                          value={data.perPlan[f.key]?.[p] === undefined ? "default" : data.perPlan[f.key]?.[p] ? "on" : "off"}
                          onChange={(e) => setPlanAsk({ feature: f, plan: p, value: e.target.value })}
                        >
                          <option value="default">Default (on)</option>
                          <option value="on">On</option>
                          <option value="off">Off</option>
                        </select>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {confirm && (
        <Confirm
          title={`${confirm.on ? "Turn on" : "Turn off"} ${confirm.feature.label} for everyone?`}
          body={confirm.on ? "Each plan and account goes back to its own setting." : "Nobody can use it — whatever their plan or account override says — until it is turned back on."}
          confirmLabel={confirm.on ? "Turn on" : "Turn off"}
          danger={!confirm.on}
          onConfirm={async () => {
            await patch({ global: { [confirm.feature.key]: confirm.on } }, `${confirm.feature.label} is ${confirm.on ? "on" : "off"} for everyone.`);
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {planAsk && (
        <Confirm
          title={`${planAsk.feature.label} on the ${planAsk.plan} plan`}
          body={`Every account on ${planAsk.plan} gets ${planAsk.feature.label} ${PLAN_VALUE[planAsk.value]}, unless an account override or "off for everyone" says otherwise. Live within a few seconds.`}
          confirmLabel="Save"
          danger={planAsk.value === "off"}
          onConfirm={async () => {
            await setPlan(planAsk.feature.key, planAsk.plan, planAsk.value);
            setPlanAsk(null);
          }}
          onCancel={() => setPlanAsk(null)}
        />
      )}
    </Panel>
  );
}

/* ----------------------------- account overrides --------------------------- */

function AccountOverrides({ data, setMsg, onChanged }: { data: Data; setMsg: (m: Msg) => void; onChanged: () => void }) {
  const { adminFetch } = useAdmin();
  const [q, setQ] = useState("");
  const [acct, setAcct] = useState<Account | null>(null);
  const [looking, setLooking] = useState(false);
  const [ask, setAsk] = useState<{ feature: FeatureRow; value: string } | null>(null);
  const lookup = async (who = q) => {
    if (!who.trim()) return;
    setMsg(null);
    setLooking(true);
    const r = await adminFetch<Account>(`/api/admin/features/accounts?user=${encodeURIComponent(who.trim())}`);
    setLooking(false);
    if (r.ok) setAcct(r.data);
    else {
      setAcct(null);
      if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? "Not found." });
    }
  };
  const set = async (feature: FeatureKey, value: string) => {
    if (!acct) return;
    setMsg(null);
    const r = await adminFetch<Account>("/api/admin/features/accounts", {
      method: "PUT",
      json: { user: acct.account.userId, feature, value: value === "plan" ? null : value },
    });
    if (r.ok) {
      setAcct(r.data);
      setMsg({ kind: "ok", text: "Override saved." });
      onChanged();
    } else if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? "Not saved." });
  };
  const who = acct ? acct.account.email || acct.account.userId : "";
  return (
    <Panel>
      <h2 className="mb-1 text-base font-semibold text-white">One account</h2>
      <p className="mb-3 text-sm text-zinc-400">Allow a feature an account&apos;s plan does not include, or deny one it does.</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          lookup();
        }}
      >
        <input className={`${field} min-w-0 flex-1`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email address or user id" aria-label="Account" />
        <button type="submit" className={btn.ghost} disabled={looking || !q.trim()}>
          {looking ? "Looking…" : "Look up"}
        </button>
      </form>
      {acct && (
        <div className="mt-4" data-account={acct.account.userId}>
          <p className="break-all text-sm text-zinc-200">
            {who} <Badge>{acct.plan}</Badge> {acct.account.isOwner && <Badge tone="amber">Owner — always every feature</Badge>}
          </p>
          {acct.account.isOwner && <p className="mt-1 text-xs text-zinc-400">The owner&apos;s account cannot be given overrides: nothing stored can lower it.</p>}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <tbody>
                {data.features.map((f) => {
                  const d = acct.decisions[f.key];
                  return (
                    <tr key={f.key} className="border-t border-white/5">
                      <td className="py-1.5 pr-3 text-zinc-300">{f.label}</td>
                      <td className="py-1.5 pr-3">
                        {d?.enabled ? <Badge tone="green">On</Badge> : <Badge tone="red">Off</Badge>} <span className="text-xs text-zinc-400">{d ? SOURCE[d.source] : ""}</span>
                      </td>
                      <td className="py-1.5">
                        <select
                          aria-label={`${f.label} override for ${who}`}
                          disabled={acct.account.isOwner}
                          className={`${field} w-36 py-1 text-xs`}
                          value={acct.overrides[f.key] ?? "plan"}
                          onChange={(e) => setAsk({ feature: f, value: e.target.value })}
                        >
                          <option value="plan">Follow the plan</option>
                          <option value="allow">Allow</option>
                          <option value="deny">Deny</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {data.accounts.length > 0 && (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-wide text-zinc-400">Accounts with overrides ({data.accounts.length})</p>
          <ul className="mt-1 max-h-64 space-y-1 overflow-auto text-sm">
            {data.accounts.map((a) => (
              <li key={a.userId} className="break-all">
                <button type="button" className="font-mono text-xs text-cyan-300 underline" onClick={() => lookup(a.userId)} aria-label={`Look up ${a.userId}`}>
                  {a.userId}
                </button>{" "}
                <span className="text-xs text-zinc-400">
                  {Object.entries(a.overrides)
                    .map(([f, v]) => `${f}: ${v}`)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ask && acct && (
        <Confirm
          title={`${ask.feature.label} for ${who}`}
          body={
            ask.value === "plan"
              ? `The override is removed: ${ask.feature.label} follows the ${acct.plan} plan again.`
              : `${ask.feature.label} is ${OVERRIDE_VALUE[ask.value]} for this account whatever its plan says (turning it off for everyone still wins).`
          }
          confirmLabel="Save override"
          danger={ask.value === "deny"}
          onConfirm={async () => {
            await set(ask.feature.key, ask.value);
            setAsk(null);
          }}
          onCancel={() => setAsk(null)}
        />
      )}
    </Panel>
  );
}

/* -------------------------------- maintenance ------------------------------ */

function MaintenancePanel({ maintenance, onChanged, setMsg }: { maintenance: Maintenance; onChanged: () => void; setMsg: (m: Msg) => void }) {
  const { adminFetch } = useAdmin();
  const active = maintenance.enabled && !(maintenance.endsAt && Date.now() >= maintenance.endsAt);
  const [message, setMessage] = useState(maintenance.message);
  // Starts from the stored end time: the server takes the body as the whole
  // state, so sending an empty end would clear a scheduled one.
  const [endsAt, setEndsAt] = useState(active && maintenance.endsAt ? toZonedInput(maintenance.endsAt) : "");
  const [confirm, setConfirm] = useState<"on" | "off" | "update" | null>(null);
  const zone = zoneLabel();
  const put = async (enabled: boolean) => {
    setMsg(null);
    const r = await adminFetch("/api/admin/maintenance", {
      method: "PUT",
      json: { enabled, message, endsAt: fromZonedInput(endsAt) },
    });
    if (r.ok) {
      setMsg({
        kind: "ok",
        text: !enabled ? "Maintenance mode is off." : active ? "The maintenance screen is updated." : "Maintenance mode is on. Everyone but administrators sees the maintenance screen within a few seconds.",
      });
      onChanged();
    } else if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? "Not changed." });
  };
  const end = fromZonedInput(endsAt);
  return (
    <Panel className={active ? "border-amber-500/40 bg-amber-500/[0.06]" : ""}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-white">Maintenance mode</h2>
          {active ? <Badge tone="amber">ON</Badge> : <Badge>Off</Badge>}
        </div>
        {active ? (
          <button type="button" className={btn.primary} onClick={() => setConfirm("off")}>
            Turn off
          </button>
        ) : (
          <button type="button" className={btn.warn} onClick={() => setConfirm("on")}>
            Turn on…
          </button>
        )}
      </div>
      {active && (
        <p className="mt-1 text-sm text-amber-200">
          On since {fmtTime(maintenance.startedAt)} by {maintenance.startedBy}
          {maintenance.endsAt ? `, ends by itself at ${fmtTime(maintenance.endsAt)}` : ""}.
        </p>
      )}
      <p className="mt-2 text-sm text-zinc-400">
        While on, every page shows a maintenance screen and API calls are answered 503 with the message. The owner, administrators, this admin area, sign-in, health checks, scheduled jobs and incoming webhooks keep working.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-[2fr_1fr]">
        <label className="text-sm text-zinc-300">
          Message
          <textarea className={`${field} mt-1`} rows={2} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <label className="text-sm text-zinc-300">
          Ends by itself at (optional, {zone})
          <input className={`${field} mt-1`} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
      </div>
      {active && (
        <button type="button" className={`${btn.ghost} mt-2`} onClick={() => setConfirm("update")}>
          Update message
        </button>
      )}
      {confirm && (
        <Confirm
          title={confirm === "on" ? "Turn maintenance mode on?" : confirm === "off" ? "Turn maintenance mode off?" : "Update the maintenance screen?"}
          body={
            confirm === "on"
              ? "Everyone except the owner and administrators is shown the maintenance screen until you turn it off" + (end ? ` or ${fmtTime(end)} passes.` : ".")
              : confirm === "off"
                ? "The site opens to everyone again within a few seconds."
                : `Everyone still locked out sees the new message${end ? `, and the site opens by itself at ${fmtTime(end)}` : ", and maintenance stays on until you turn it off"}.`
          }
          confirmLabel={confirm === "on" ? "Turn on" : confirm === "off" ? "Turn off" : "Update"}
          danger={confirm === "on"}
          typeToConfirm={confirm === "on" ? "maintenance" : undefined}
          onConfirm={async () => {
            await put(confirm !== "off");
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Panel>
  );
}
