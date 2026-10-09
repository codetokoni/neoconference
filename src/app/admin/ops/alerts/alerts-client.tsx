"use client";

// Alerts: what fired, acknowledge / resolve (one at a time or a selection),
// and the rules (thresholds, cooldown, channels). Rules are evaluated after
// every 5-minute health check. The status filter and search are kept in the
// address bar.

import { useCallback, useEffect, useState } from "react";
import { Time, errorText, fmtNumber, useAdmin } from "../../AdminApi";
import {
  Badge,
  Confirm,
  Dialog,
  Empty,
  FilterBar,
  Labeled,
  LoadState,
  Notice,
  PageHeader,
  Pager,
  Panel,
  SelectBox,
  TableWrap,
  btn,
  field,
  useClientTable,
  useSelection,
  useUrlFilters,
} from "../../ui";
import { StatusBadge } from "../opsUi";

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
type Ask = { action: "acknowledge" | "resolve"; alerts: Alert[] };

// The server sends at most this many alerts.
const SENT = 200;

const blank: Rule = { id: "", kind: "service_down", target: "*", threshold: 10, cooldownMinutes: 60, enabled: true, email: true, inApp: true };

export default function OpsAlertsClient() {
  const { can, adminFetch } = useAdmin();
  const write = can("ops:write");
  const filters = useUrlFilters({ status: "active", q: "" });
  const status = filters.value.status;
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<Rule | null>(null);
  const [del, setDel] = useState<Rule | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    const qs = status === "active" || status === "resolved" ? `?status=${status}` : "";
    const r = await adminFetch<Data>(`/api/admin/ops/alerts${qs}`);
    if (r.ok) {
      setData(r.data);
      setLoadErr(null);
    } else setLoadErr(`Could not load alerts. ${errorText(r)}`);
  }, [adminFetch, status]);
  useEffect(() => {
    load();
  }, [load]);

  const needle = filters.value.q.trim().toLowerCase();
  const shown = data ? (needle ? data.alerts.filter((a) => `${a.title} ${a.message}`.toLowerCase().includes(needle)) : data.alerts) : null;
  const table = useClientTable(shown, (a, k) => (k === "occurrences" ? a.occurrences : k === "openedAt" ? a.openedAt : a.lastSeenAt), { key: "lastSeenAt", dir: "desc" });
  const actionable = table.visible.filter((a) => a.status !== "resolved");
  const sel = useSelection(actionable.map((a) => a.id));
  const selected = actionable.filter((a) => sel.selected.has(a.id));

  // One PATCH per alert, the same call the row buttons make.
  const run = async ({ action, alerts }: Ask, note: string) => {
    setMsg(null);
    let done = 0;
    const failed: string[] = [];
    for (const a of alerts) {
      const r = await adminFetch(`/api/admin/ops/alerts/${encodeURIComponent(a.id)}`, { method: "PATCH", json: action === "resolve" && note ? { action, note } : { action } });
      if (r.ok) done++;
      else failed.push(`${a.title}: ${errorText(r)}`);
      if (r.data?.error === "cancelled") break;
    }
    const verb = action === "acknowledge" ? "Acknowledged" : "Resolved";
    const noun = (n: number) => (alerts.length === 1 ? `"${alerts[0].title}"` : `${n} alert${n === 1 ? "" : "s"}`);
    if (failed.length) setMsg({ kind: "err", text: `${done ? `${verb} ${noun(done)}. ` : ""}${failed.length} did not change — ${failed[0]}` });
    else setMsg({ kind: "ok", text: `${verb} ${noun(done)}.` });
    sel.clear();
    setAsk(null);
    await load();
  };
  // Returns the error to show inside the rule dialog, or null when saved.
  const save = async (rule: Rule): Promise<string | null> => {
    setMsg(null);
    const r = await adminFetch("/api/admin/ops/alerts/rules", { method: "POST", json: { ...rule, id: rule.id || undefined } });
    if (!r.ok) return `Could not save the rule. ${errorText(r)}`;
    setEdit(null);
    setMsg({ kind: "ok", text: rule.id ? "Rule saved." : "Rule created." });
    await load();
    return null;
  };
  const remove = async (rule: Rule) => {
    setMsg(null);
    const r = await adminFetch(`/api/admin/ops/alerts/rules?id=${encodeURIComponent(rule.id)}`, { method: "DELETE" });
    setDel(null);
    if (!r.ok) return setMsg({ kind: "err", text: `Could not delete the rule. ${errorText(r)}` });
    setMsg({ kind: "ok", text: "Rule deleted." });
    await load();
  };

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
      <LoadState data={data} error={loadErr} onRetry={load}>
        {(d) => {
          const kindOf = (k: string) => d.kinds.find((x) => x.kind === k);
          const targetLabel = (r: Rule) =>
            r.target === "*"
              ? r.kind.startsWith("service")
                ? "any service"
                : r.kind === "job_failures"
                  ? "any job"
                  : ""
              : [...d.targets.services, ...d.targets.jobs].find((t) => t.id === r.target)?.label ?? r.target;
          const ruleName = (r: Rule) => `${kindOf(r.kind)?.label ?? r.kind}${targetLabel(r) ? ` · ${targetLabel(r)}` : ""}`;
          return (
            <>
              <Panel className="mb-4 text-sm text-zinc-400">
                Notified: {d.recipients.length ? d.recipients.map((r) => `${r.email}${r.owner ? " (owner)" : ""}`).join(", ") : "nobody yet"} — in the app&apos;s notification bell
                {d.emailConfigured ? " and by email." : ". Email is not configured (RESEND_API_KEY is not set), so alerts are in-app only."}
              </Panel>

              <h2 className="mb-2 text-lg font-semibold text-cyan-50">History</h2>
              <FilterBar active={filters.active} onClear={filters.reset}>
                <Labeled label="Show">
                  <select className={`${field} w-auto`} value={status} onChange={(e) => filters.set({ status: e.target.value })}>
                    <option value="active">Open or acknowledged</option>
                    <option value="resolved">Resolved</option>
                    <option value="all">All</option>
                  </select>
                </Labeled>
                <Labeled label="Search" className="min-w-[12rem] flex-1">
                  <input type="search" className={field} value={filters.value.q} placeholder="Title or message" onChange={(e) => filters.set({ q: e.target.value })} />
                </Labeled>
                <Labeled label="Sort by">
                  <select className={`${field} w-auto`} value={table.sort.key} onChange={(e) => table.onSort(e.target.value, "desc")}>
                    <option value="lastSeenAt">Last seen</option>
                    <option value="openedAt">Opened</option>
                    <option value="occurrences">Times seen</option>
                  </select>
                </Labeled>
              </FilterBar>

              {write && actionable.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                  <SelectBox checked={sel.all} indeterminate={sel.some} onChange={sel.toggleAll} label="Select every open alert on this page" />
                  <span>{sel.count ? `${sel.count} selected` : "Select alerts to acknowledge or resolve them together"}</span>
                  {sel.count > 0 && (
                    <>
                      <button
                        type="button"
                        className={btn.ghost}
                        disabled={!selected.some((a) => a.status === "open")}
                        onClick={() => setAsk({ action: "acknowledge", alerts: selected.filter((a) => a.status === "open") })}
                      >
                        Acknowledge selected
                      </button>
                      <button type="button" className={btn.ghost} onClick={() => setAsk({ action: "resolve", alerts: selected })}>
                        Resolve selected
                      </button>
                      {!selected.some((a) => a.status === "open") && <span className="text-xs text-zinc-400">All selected are already acknowledged.</span>}
                    </>
                  )}
                </div>
              )}

              {table.total === 0 ? (
                <Empty>
                  {needle ? "No alerts match this search." : status === "active" ? "Nothing open." : status === "resolved" ? "No resolved alerts." : "No alerts yet."}
                </Empty>
              ) : (
                <div className="grid gap-2">
                  {table.visible.map((a) => (
                    <Panel key={a.id} className="min-w-0">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 max-w-3xl items-start gap-3">
                          {write && a.status !== "resolved" && (
                            <span className="pt-0.5">
                              <SelectBox checked={sel.selected.has(a.id)} onChange={() => sel.toggle(a.id)} label={`Select ${a.title}`} />
                            </span>
                          )}
                          <div className="min-w-0">
                            <p className="font-medium text-white">
                              <StatusBadge status={a.status} /> {a.title}
                            </p>
                            <p className="mt-1 break-words text-sm text-zinc-400">{a.message}</p>
                            <p className="mt-1 text-xs text-zinc-400">
                              Opened <Time ts={a.openedAt} mode="relative" /> · seen {fmtNumber(a.occurrences)}× (last <Time ts={a.lastSeenAt} mode="relative" />) ·{" "}
                              {a.notified
                                ? `notified ${a.notifyResult?.recipients ?? 0} (email ${a.notifyResult?.emailed ?? 0}${a.notifyResult?.emailSkipped ? `, ${a.notifyResult.emailSkipped}` : ""}, in-app ${a.notifyResult?.inApp ?? 0})`
                                : a.suppressed === "cooldown"
                                  ? "not notified (cooldown)"
                                  : "not notified (channels off)"}
                              {a.acknowledgedBy ? ` · acknowledged by ${a.acknowledgedBy}` : ""}
                              {a.resolvedAt && (
                                <>
                                  {" "}
                                  · resolved by {a.resolvedBy} <Time ts={a.resolvedAt} mode="relative" />
                                  {a.resolution ? ` (${a.resolution})` : ""}
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                        {write && a.status !== "resolved" && (
                          <div className="flex shrink-0 flex-wrap gap-2">
                            {a.status === "open" && (
                              <button type="button" className={btn.ghost} aria-label={`Acknowledge: ${a.title}`} onClick={() => setAsk({ action: "acknowledge", alerts: [a] })}>
                                Acknowledge
                              </button>
                            )}
                            <button type="button" className={btn.ghost} aria-label={`Resolve: ${a.title}`} onClick={() => setAsk({ action: "resolve", alerts: [a] })}>
                              Resolve
                            </button>
                          </div>
                        )}
                      </div>
                    </Panel>
                  ))}
                </div>
              )}
              {table.total > 0 && <Pager page={table.page} pageSize={table.pageSize} total={table.total} onPage={table.setPage} onPageSize={table.setPageSize} noun="alert" />}
              {d.alerts.length >= SENT && <p className="mt-1 text-xs text-zinc-400">Only the latest {SENT} alerts are listed here.</p>}

              <div className="mb-2 mt-6 flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-cyan-50">Rules</h2>
                {write && (
                  <button type="button" className={`${btn.ghost} ml-auto`} onClick={() => setEdit({ ...blank })}>
                    New rule
                  </button>
                )}
              </div>
              {d.rules.length === 0 ? (
                <Empty>No rules — nothing raises an alert.</Empty>
              ) : (
                <TableWrap minWidth={640}>
                  <thead className="text-xs text-zinc-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">When</th>
                      <th className="px-3 py-2 font-medium">Threshold</th>
                      <th className="px-3 py-2 font-medium">Cooldown</th>
                      <th className="px-3 py-2 font-medium">Notify</th>
                      <th className="px-3 py-2 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rules.map((r) => (
                      <tr key={r.id} className="border-t border-white/5">
                        <td className="px-3 py-2 text-zinc-200">
                          {kindOf(r.kind)?.label ?? r.kind} {targetLabel(r) && <span className="text-zinc-400">· {targetLabel(r)}</span>} {!r.enabled && <Badge>Off</Badge>}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-300">
                          {fmtNumber(r.threshold)} {kindOf(r.kind)?.unit}
                        </td>
                        <td className="px-3 py-2 text-zinc-400">{fmtNumber(r.cooldownMinutes)} min</td>
                        <td className="px-3 py-2 text-zinc-400">{[r.email && "email", r.inApp && "in-app"].filter(Boolean).join(", ") || "—"}</td>
                        <td className="px-3 py-2 text-right">
                          {write && (
                            <span className="flex justify-end gap-2">
                              <button type="button" className={btn.ghost} aria-label={`Edit rule: ${ruleName(r)}`} onClick={() => setEdit({ ...r })}>
                                Edit
                              </button>
                              <button type="button" className={btn.ghost} aria-label={`Delete rule: ${ruleName(r)}`} onClick={() => setDel(r)}>
                                Delete
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}

              {edit && <RuleForm rule={edit} data={d} onSave={save} onCancel={() => setEdit(null)} />}
              {del && (
                <Confirm
                  title="Delete this rule?"
                  body={
                    <>
                      <b className="text-zinc-200">{ruleName(del)}</b> stops raising alerts. Open alerts it raised stay until resolved.
                    </>
                  }
                  confirmLabel="Delete rule"
                  danger
                  typeToConfirm="delete"
                  onConfirm={() => remove(del)}
                  onCancel={() => setDel(null)}
                />
              )}
            </>
          );
        }}
      </LoadState>

      {ask && (
        <Confirm
          title={
            ask.action === "acknowledge"
              ? ask.alerts.length === 1
                ? "Acknowledge this alert?"
                : `Acknowledge ${ask.alerts.length} alerts?`
              : ask.alerts.length === 1
                ? "Resolve this alert?"
                : `Resolve ${ask.alerts.length} alerts?`
          }
          body={
            <>
              {ask.alerts.length === 1 ? <b className="text-zinc-200">{ask.alerts[0].title}</b> : `${ask.alerts.length} alerts`}
              {ask.action === "acknowledge"
                ? " — marked as seen by you. It stays open and keeps counting repeats until it is resolved."
                : " — closed now. If the condition is still there it opens again on the next check."}
            </>
          }
          confirmLabel={ask.action === "acknowledge" ? "Acknowledge" : "Resolve"}
          withReason={ask.action === "resolve" ? "Resolution note (optional)" : undefined}
          onConfirm={(note) => run(ask, note)}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}

function RuleForm({ rule, data, onSave, onCancel }: { rule: Rule; data: Data; onSave: (r: Rule) => Promise<string | null>; onCancel: () => void }) {
  const [r, setR] = useState<Rule>(rule);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const unit = data.kinds.find((k) => k.kind === r.kind)?.unit;
  const targets = r.kind.startsWith("service") ? data.targets.services : r.kind === "job_failures" ? data.targets.jobs : null;
  return (
    <Dialog title={rule.id ? "Edit rule" : "New rule"} onClose={() => !saving && onCancel()}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (saving) return;
          setSaving(true);
          setErr(null);
          const e2 = await onSave(r);
          // On success the dialog is already gone.
          if (e2) {
            setErr(e2);
            setSaving(false);
          }
        }}
      >
        {err && (
          <div className="mt-3">
            <Notice kind="err" onClose={() => setErr(null)}>
              {err}
            </Notice>
          </div>
        )}
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
          <button type="button" className={btn.ghost} disabled={saving} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={btn.primary} disabled={saving} aria-busy={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
