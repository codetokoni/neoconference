"use client";

// Alerts: what fired, acknowledge / resolve, and the rules (thresholds,
// cooldown, channels). Rules are evaluated after every 5-minute health check.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
import { StatusBadge, ago } from "../opsUi";

type Kind = { kind: string; label: string; unit: string };
type Rule = { id: string; kind: string; target: string; threshold: number; cooldownMinutes: number; enabled: boolean; email: boolean; inApp: boolean; updatedBy?: string };
type Alert = {
  id: string;
  ruleId: string;
  title: string;
  message: string;
  status: string;
  openedAt: number;
  lastSeenAt: number;
  occurrences: number;
  notified: boolean;
  suppressed?: string;
  notifyResult?: { recipients: number; emailed: number; inApp: number; emailSkipped?: string };
  acknowledgedBy?: string;
  resolvedBy?: string;
  resolvedAt?: number;
  resolution?: string;
};
type Data = {
  alerts: Alert[];
  rules: Rule[];
  kinds: Kind[];
  targets: { services: { id: string; label: string }[]; jobs: { id: string; label: string }[] };
  recipients: { email: string; owner: boolean }[];
  emailConfigured: boolean;
};

const blank: Rule = { id: "", kind: "service_down", target: "*", threshold: 10, cooldownMinutes: 60, enabled: true, email: true, inApp: true };

export default function OpsAlertsClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("ops:write");
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [edit, setEdit] = useState<Rule | null>(null);
  const [del, setDel] = useState<Rule | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<Data>(`/api/admin/ops/alerts${filter === "active" ? "?status=active" : ""}`);
    if (r.ok) setData(r.data);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load alerts." });
  }, [adminFetch, filter]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (a: Alert, action: "acknowledge" | "resolve") => {
    const r = await adminFetch(`/api/admin/ops/alerts/${encodeURIComponent(a.id)}`, { method: "PATCH", json: { action } });
    if (!r.ok) setMsg({ kind: "err", text: r.data.message ?? "That did not work." });
    load();
  };
  const save = async (rule: Rule) => {
    const r = await adminFetch("/api/admin/ops/alerts/rules", { method: "POST", json: { ...rule, id: rule.id || undefined } });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not save the rule." });
    setEdit(null);
    setMsg({ kind: "ok", text: "Rule saved." });
    load();
  };
  const remove = async (rule: Rule) => {
    setDel(null);
    const r = await adminFetch(`/api/admin/ops/alerts/rules?id=${encodeURIComponent(rule.id)}`, { method: "DELETE" });
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? "Could not delete the rule." });
    load();
  };

  if (!data) return <Loading />;
  const kindOf = (k: string) => data.kinds.find((x) => x.kind === k);
  const targetLabel = (r: Rule) =>
    r.target === "*" ? (r.kind.startsWith("service") ? "any service" : r.kind === "job_failures" ? "any job" : "") : [...data.targets.services, ...data.targets.jobs].find((t) => t.id === r.target)?.label ?? r.target;

  return (
    <div>
      <PageHeader
        title="Alerts"
        sub="One open alert per rule and subject (repeats only count up); it resolves itself when the condition clears. After someone is notified, the cooldown keeps the same alert from notifying again."
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <Panel className="mb-4 text-sm text-zinc-400">
        Notified: {data.recipients.length ? data.recipients.map((r) => `${r.email}${r.owner ? " (owner)" : ""}`).join(", ") : "nobody yet"} — in the app&apos;s notification bell
        {data.emailConfigured ? " and by email." : ". Email is not configured (RESEND_API_KEY is not set), so alerts are in-app only."}
      </Panel>

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-cyan-50">History</h2>
        <div className="ml-auto flex gap-1" role="group" aria-label="Show">
          {(["active", "all"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={`${btn.ghost} ${filter === f ? "bg-white/10" : ""}`}>
              {f === "active" ? "Open" : "All"}
            </button>
          ))}
        </div>
      </div>
      {data.alerts.length === 0 ? (
        <Empty>{filter === "active" ? "Nothing open." : "No alerts yet."}</Empty>
      ) : (
        <div className="grid gap-2">
          {data.alerts.map((a) => (
            <Panel key={a.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-3xl">
                  <p className="font-medium text-white">
                    <StatusBadge status={a.status} /> {a.title}
                  </p>
                  <p className="mt-1 text-sm text-zinc-400">{a.message}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Opened <span title={fmtTime(a.openedAt)}>{ago(a.openedAt)}</span> · seen {a.occurrences}× (last {ago(a.lastSeenAt)}) ·{" "}
                    {a.notified
                      ? `notified ${a.notifyResult?.recipients ?? 0} (email ${a.notifyResult?.emailed ?? 0}${a.notifyResult?.emailSkipped ? `, ${a.notifyResult.emailSkipped}` : ""}, in-app ${a.notifyResult?.inApp ?? 0})`
                      : a.suppressed === "cooldown"
                        ? "not notified (cooldown)"
                        : "not notified (channels off)"}
                    {a.acknowledgedBy ? ` · acknowledged by ${a.acknowledgedBy}` : ""}
                    {a.resolvedAt ? ` · resolved by ${a.resolvedBy} ${ago(a.resolvedAt)}${a.resolution ? ` (${a.resolution})` : ""}` : ""}
                  </p>
                </div>
                {write && a.status !== "resolved" && (
                  <div className="flex shrink-0 gap-2">
                    {a.status === "open" && (
                      <button type="button" className={btn.ghost} onClick={() => act(a, "acknowledge")}>
                        Acknowledge
                      </button>
                    )}
                    <button type="button" className={btn.ghost} onClick={() => act(a, "resolve")}>
                      Resolve
                    </button>
                  </div>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}

      <div className="mb-2 mt-6 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-cyan-50">Rules</h2>
        {write && (
          <button type="button" className={`${btn.ghost} ml-auto`} onClick={() => setEdit({ ...blank })}>
            New rule
          </button>
        )}
      </div>
      <Panel className="overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Threshold</th>
              <th className="px-3 py-2 font-medium">Cooldown</th>
              <th className="px-3 py-2 font-medium">Notify</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r.id} className="border-t border-white/5">
                <td className="px-3 py-2 text-zinc-200">
                  {kindOf(r.kind)?.label ?? r.kind} {targetLabel(r) && <span className="text-zinc-400">· {targetLabel(r)}</span>} {!r.enabled && <Badge>Off</Badge>}
                </td>
                <td className="px-3 py-2 font-mono text-zinc-300">
                  {r.threshold.toLocaleString()} {kindOf(r.kind)?.unit}
                </td>
                <td className="px-3 py-2 text-zinc-400">{r.cooldownMinutes} min</td>
                <td className="px-3 py-2 text-zinc-400">{[r.email && "email", r.inApp && "in-app"].filter(Boolean).join(", ") || "—"}</td>
                <td className="px-3 py-2 text-right">
                  {write && (
                    <span className="flex justify-end gap-2">
                      <button type="button" className={btn.ghost} onClick={() => setEdit({ ...r })}>
                        Edit
                      </button>
                      <button type="button" className={btn.ghost} onClick={() => setDel(r)}>
                        Delete
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {edit && <RuleForm rule={edit} data={data} onSave={save} onCancel={() => setEdit(null)} />}
      {del && (
        <Confirm title="Delete this rule?" body="Open alerts it raised stay until resolved." confirmLabel="Delete" danger onConfirm={() => remove(del)} onCancel={() => setDel(null)} />
      )}
    </div>
  );
}

function RuleForm({ rule, data, onSave, onCancel }: { rule: Rule; data: Data; onSave: (r: Rule) => void; onCancel: () => void }) {
  const [r, setR] = useState<Rule>(rule);
  const unit = data.kinds.find((k) => k.kind === r.kind)?.unit;
  const targets = r.kind.startsWith("service") ? data.targets.services : r.kind === "job_failures" ? data.targets.jobs : null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="rule-title" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(r);
        }}
        className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0B1220] p-5 shadow-2xl"
      >
        <h2 id="rule-title" className="text-base font-semibold text-white">
          {rule.id ? "Edit rule" : "New rule"}
        </h2>
        <label className="mt-3 block text-sm text-zinc-300">
          Alert when
          <select className={`${field} mt-1`} value={r.kind} onChange={(e) => setR({ ...r, kind: e.target.value, target: "*" })}>
            {data.kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        {targets && (
          <label className="mt-3 block text-sm text-zinc-300">
            For
            <select className={`${field} mt-1`} value={r.target} onChange={(e) => setR({ ...r, target: e.target.value })}>
              <option value="*">Any</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="mt-3 block text-sm text-zinc-300">
          Threshold ({unit})
          <input type="number" min={0} className={`${field} mt-1`} value={r.threshold} onChange={(e) => setR({ ...r, threshold: Number(e.target.value) })} />
        </label>
        <label className="mt-3 block text-sm text-zinc-300">
          Cooldown (minutes between notifications)
          <input type="number" min={0} className={`${field} mt-1`} value={r.cooldownMinutes} onChange={(e) => setR({ ...r, cooldownMinutes: Number(e.target.value) })} />
        </label>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-zinc-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> On
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={r.email} onChange={(e) => setR({ ...r, email: e.target.checked })} /> Email
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={r.inApp} onChange={(e) => setR({ ...r, inApp: e.target.checked })} /> In-app
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={btn.primary}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
