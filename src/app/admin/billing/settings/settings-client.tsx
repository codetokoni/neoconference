"use client";

// Billing settings: payment gateways (status from the environment, never a
// value), tax rules, the seller details on invoices, and the reminder emails
// for failed payments, abandoned checkouts and renewals.

import { useCallback, useEffect, useState } from "react";
import { Time, fmtMoney, fmtNumber, useAdmin } from "../../AdminApi";
import { Badge, Confirm, Empty, EmptyLine, Loading, Notice, PageHeader, Pager, Panel, btn, field, useClientTable } from "../../ui";
import { BillingNav } from "../shared";

// `rate` is kept as typed ("7." on the way to "7.5"); the server reads it as a number.
type TaxRule = { id?: string; country: string; region?: string; rate: number | string; inclusive: boolean; label: string };
type Settings = {
  gateways: { espees: { enabled: boolean }; stripe: { enabled: boolean } };
  tax: { rules: TaxRule[] };
  invoice: { companyName: string; address: string; taxId: string; email: string; footer: string };
  updatedAt?: number;
  updatedBy?: string;
};
type Gateway = {
  id: string;
  name: string;
  configured: boolean;
  vars: { name: string; set: boolean; secret: boolean }[];
  notes: string[];
  capabilities: { verify: boolean; webhook: boolean; refund: boolean };
};
type Rules = {
  failed: { enabled: boolean; afterDays: number[] };
  abandoned: { enabled: boolean; afterDays: number[] };
  renewal: { enabled: boolean; beforeDays: number[] };
  updatedAt?: number;
  updatedBy?: string;
};
type Reminders = {
  rules: Rules;
  mailConfigured: boolean;
  log: { at: number; kind: string; email: string | null; outcome: string; detail?: string; by: string }[];
  preview: { ran: boolean; skipped?: string; alreadySent: number; preview?: { kind: string; email: string | null; step: number; subjectLine: string; amount: number | null; currency: string }[] };
};

const GATEWAY_EFFECT = { espees: "eSPees plan checkout stops taking payments", stripe: "Stripe ticket checkout stops taking payments" } as const;
const ruleName = (r: TaxRule) => `${r.country || "?"}${r.region ? `/${r.region}` : ""} ${r.label} ${r.rate}%${r.inclusive ? " (in price)" : ""}`;

export default function SettingsClient() {
  const { can, adminFetch } = useAdmin();
  const editable = can("billing:settings");
  const [s, setS] = useState<Settings | null>(null);
  // What the server holds, to tell which changes switch something off.
  const [saved, setSaved] = useState<Settings | null>(null);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const r = await adminFetch<{ settings: Settings; gateways: Gateway[] }>("/api/admin/billing/settings");
    if (r.ok) {
      setS(r.data.settings);
      setSaved(r.data.settings);
      setGateways(r.data.gateways);
    } else setLoadError(r.data.message ?? "Could not load billing settings.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  // Changes that stop something working: confirmed before saving.
  const risky = (): string[] => {
    if (!s || !saved) return [];
    const out: string[] = [];
    for (const g of ["espees", "stripe"] as const) if (saved.gateways[g].enabled && !s.gateways[g].enabled) out.push(`${GATEWAY_EFFECT[g]}.`);
    // Rules saved before ids existed are matched by where they apply.
    const key = (r: TaxRule) => r.id ?? `${r.country}|${r.region ?? ""}`;
    const kept = new Set(s.tax.rules.map(key));
    for (const r of saved.tax.rules) if (!kept.has(key(r))) out.push(`Tax rule ${ruleName(r)} is removed from invoices issued from now on.`);
    return out;
  };

  const save = async () => {
    if (!s) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await adminFetch<{ settings: Settings; unchanged?: boolean }>("/api/admin/billing/settings", {
      method: "PUT",
      json: { gateways: s.gateways, tax: s.tax, invoice: s.invoice },
    });
    setBusy(false);
    setAsking(null);
    if (!r.ok) return setError(r.data.message ?? "Could not save.");
    setS(r.data.settings);
    setSaved(r.data.settings);
    setNotice(r.data.unchanged ? "Nothing had changed." : "Billing settings saved.");
  };
  const askSave = () => {
    const list = risky();
    if (list.length) setAsking(list);
    else save();
  };

  return (
    <div>
      <PageHeader
        title="Billing"
        sub={
          editable
            ? "Changes here need a fresh authenticator code and are recorded in the audit log."
            : "You can see these settings; changing them needs the billing:settings permission."
        }
      />
      <BillingNav active="settings" />
      {notice && (
        <Notice kind="ok" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      )}
      {error && (
        <Notice kind="err" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {!s ? (
        loadError ? (
          <Notice kind="err" onRetry={load}>
            {loadError}
          </Notice>
        ) : (
          <Loading />
        )
      ) : (
        <div className="space-y-4">
          <Panel>
            <h2 className="text-sm font-semibold text-white">Payment gateways</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              Credentials live in the Vercel project&apos;s environment variables, not here. This page only says whether each is set — no value, or any part of one, is ever shown or stored.
            </p>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {gateways.map((g) => {
                const toggle = g.id === "espees" || g.id === "stripe" ? (g.id as "espees" | "stripe") : null;
                return (
                  <div key={g.id} className="min-w-0 rounded-lg border border-white/10 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-zinc-100">{g.name}</p>
                      <Badge tone={g.configured ? "green" : "amber"}>{g.configured ? "Configured" : "Not configured"}</Badge>
                    </div>
                    <ul className="mt-2 space-y-0.5 font-mono text-[11px]">
                      {g.vars.map((v) => (
                        <li key={v.name} className="flex flex-wrap justify-between gap-x-2">
                          <span className="break-all text-zinc-300">{v.name}</span>
                          <span className={v.set ? "text-emerald-300" : "text-amber-300"}>{v.set ? (v.secret ? "set · ••••••" : "set") : "missing"}</span>
                        </li>
                      ))}
                    </ul>
                    {(g.id === "espees" || g.id === "stripe") && (
                      <p className="mt-2 flex flex-wrap gap-1">
                        <Badge tone={g.capabilities.verify ? "green" : "red"}>{g.capabilities.verify ? "confirms payments" : "cannot confirm payments"}</Badge>
                        <Badge tone={g.capabilities.webhook ? "green" : "red"}>{g.capabilities.webhook ? "webhook" : "no webhook"}</Badge>
                        <Badge tone={g.capabilities.refund ? "green" : "red"}>{g.capabilities.refund ? "refund API" : "no refund API"}</Badge>
                      </p>
                    )}
                    {g.notes.map((n) => (
                      <p key={n} className="mt-1.5 text-xs text-zinc-400">
                        {n}
                      </p>
                    ))}
                    {toggle && (
                      <label className="mt-2 flex items-center gap-2 text-sm text-zinc-200">
                        <input
                          type="checkbox"
                          disabled={!editable}
                          checked={s.gateways[toggle].enabled}
                          onChange={(e) => setS({ ...s, gateways: { ...s.gateways, [toggle]: { enabled: e.target.checked } } })}
                        />
                        Take payments through {toggle === "espees" ? "eSPees (plan checkout)" : "Stripe (ticket checkout)"}
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel>
            <h2 className="text-sm font-semibold text-white">Tax rules</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              Applied to invoices by the buyer&apos;s country (from their connection when they paid, or Stripe&apos;s billing address). The most specific rule wins; “*” covers everywhere else. Checkout charges the listed price either way, so an inclusive rule splits the tax out of it, and an exclusive rule shows the tax as still owed.
            </p>
            {s.tax.rules.length === 0 && <EmptyLine>No tax rules: invoices show no tax.</EmptyLine>}
            <div className="mt-3 space-y-2">
              {s.tax.rules.map((r, i) => {
                const upd = (patch: Partial<TaxRule>) => setS({ ...s, tax: { rules: s.tax.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) } });
                const n = `Rule ${i + 1}`;
                return (
                  <div key={r.id ?? i} className="grid grid-cols-2 gap-2 sm:grid-cols-[5rem_1fr_6rem_6rem_auto_auto] sm:items-center">
                    <input aria-label={`${n}: country`} placeholder="NG or *" value={r.country} disabled={!editable} onChange={(e) => upd({ country: e.target.value.toUpperCase() })} className={field} maxLength={2} />
                    <input aria-label={`${n}: region`} placeholder="Region (optional)" value={r.region ?? ""} disabled={!editable} onChange={(e) => upd({ region: e.target.value })} className={field} />
                    <input aria-label={`${n}: rate %`} inputMode="decimal" value={String(r.rate)} disabled={!editable} onChange={(e) => upd({ rate: e.target.value.replace(/[^0-9.]/g, "") })} className={field} />
                    <input aria-label={`${n}: label`} placeholder="VAT" value={r.label} disabled={!editable} onChange={(e) => upd({ label: e.target.value })} className={field} />
                    <label className="flex items-center gap-1.5 text-xs text-zinc-300">
                      <input type="checkbox" checked={r.inclusive} disabled={!editable} onChange={(e) => upd({ inclusive: e.target.checked })} />
                      in price
                    </label>
                    {editable && (
                      <button type="button" className={btn.ghost} aria-label={`Remove ${n.toLowerCase()} (${r.country || "no country"})`} onClick={() => setS({ ...s, tax: { rules: s.tax.rules.filter((_, j) => j !== i) } })}>
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {editable && (
              <button type="button" className={`${btn.ghost} mt-2`} onClick={() => setS({ ...s, tax: { rules: [...s.tax.rules, { country: "", rate: 0, inclusive: true, label: "VAT" }] } })}>
                Add a rule
              </button>
            )}
            {editable && <p className="mt-2 text-xs text-zinc-400">Removing a rule takes effect when you save the billing settings below.</p>}
          </Panel>

          <Panel>
            <h2 className="text-sm font-semibold text-white">Invoice details</h2>
            <p className="mt-0.5 text-xs text-zinc-400">Printed on invoices issued from now on. An invoice already issued keeps the details it was issued with.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["companyName", "Company name"],
                  ["taxId", "Tax ID"],
                  ["email", "Billing email"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="text-xs text-zinc-400">
                  {l}
                  <input value={s.invoice[k]} disabled={!editable} onChange={(e) => setS({ ...s, invoice: { ...s.invoice, [k]: e.target.value } })} className={`${field} mt-1`} />
                </label>
              ))}
              <label className="text-xs text-zinc-400 sm:col-span-2">
                Address
                <textarea rows={3} value={s.invoice.address} disabled={!editable} onChange={(e) => setS({ ...s, invoice: { ...s.invoice, address: e.target.value } })} className={`${field} mt-1`} />
              </label>
              <label className="text-xs text-zinc-400 sm:col-span-2">
                Footer
                <textarea rows={2} value={s.invoice.footer} disabled={!editable} onChange={(e) => setS({ ...s, invoice: { ...s.invoice, footer: e.target.value } })} className={`${field} mt-1`} />
              </label>
            </div>
          </Panel>

          {editable && (
            <div className="flex flex-wrap items-center justify-end gap-3">
              {s.updatedAt && (
                <span className="text-xs text-zinc-400">
                  Last changed <Time ts={s.updatedAt} /> by {s.updatedBy}
                </span>
              )}
              <button type="button" className={btn.primary} disabled={busy} onClick={askSave}>
                {busy ? "Saving…" : "Save billing settings"}
              </button>
            </div>
          )}

          <RemindersPanel editable={editable} />
        </div>
      )}
      {asking && (
        <Confirm
          title="Save these billing settings?"
          body={
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {asking.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          }
          confirmLabel="Save"
          danger
          onConfirm={save}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}

const daysText = (d: number[]) => d.join(", ");
const parseDays = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number);

type Form = { failed: [boolean, string]; abandoned: [boolean, string]; renewal: [boolean, string] };

function RemindersPanel({ editable }: { editable: boolean }) {
  const { adminFetch } = useAdmin();
  const [d, setD] = useState<Reminders | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const log = useClientTable(d?.log, (l) => l.at, { key: "at", dir: "desc", pageSize: 25 });

  const load = useCallback(async () => {
    setLoadError(null);
    const r = await adminFetch<Reminders>("/api/admin/billing/reminders");
    if (!r.ok) return setLoadError(r.data.message ?? "Could not load reminders.");
    setD(r.data);
    const x = r.data.rules;
    setForm({
      failed: [x.failed.enabled, daysText(x.failed.afterDays)],
      abandoned: [x.abandoned.enabled, daysText(x.abandoned.afterDays)],
      renewal: [x.renewal.enabled, daysText(x.renewal.beforeDays)],
    });
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!form) return;
    setError(null);
    setNotice(null);
    const r = await adminFetch("/api/admin/billing/reminders", {
      method: "PUT",
      json: {
        failed: { enabled: form.failed[0], afterDays: parseDays(form.failed[1]) },
        abandoned: { enabled: form.abandoned[0], afterDays: parseDays(form.abandoned[1]) },
        renewal: { enabled: form.renewal[0], beforeDays: parseDays(form.renewal[1]) },
      },
    });
    setConfirmSave(false);
    if (!r.ok) return setError(r.data.message ?? "Could not save the reminder rules.");
    setNotice("Reminder rules saved.");
    await load();
  };

  const run = async () => {
    setError(null);
    setNotice(null);
    const r = await adminFetch<{ result: { sent: number; failed: number; alreadySent: number; skipped?: string } }>("/api/admin/billing/reminders", { method: "POST" });
    setConfirmRun(false);
    if (!r.ok) return setError(r.data.message ?? "Could not run the reminders.");
    const x = r.data.result;
    setNotice(
      x.skipped === "all_off"
        ? "Every reminder is switched off."
        : x.skipped === "mail_not_configured"
          ? "Email is not set up (RESEND_API_KEY), so nothing was sent."
          : `Sent ${x.sent}, failed ${x.failed}, already sent before ${x.alreadySent}.`,
    );
    await load();
  };

  const rows: { key: "failed" | "abandoned" | "renewal"; title: string; help: string }[] = [
    { key: "failed", title: "Failed payment", help: "days after a plan payment failed" },
    { key: "abandoned", title: "Abandoned checkout", help: "days after a checkout was left unfinished" },
    { key: "renewal", title: "Renewal coming due", help: "days before a paid plan runs out (plans do not renew by themselves)" },
  ];
  const preview = d?.preview.preview ?? [];

  return (
    <Panel>
      <h2 className="text-sm font-semibold text-white">Reminder emails</h2>
      <p className="mt-0.5 text-xs text-zinc-400">
        Sent once a day at 09:00 UTC by a scheduled job. Each reminder goes to a person once: a rerun, or two runs at once, cannot send it again. If several steps are due together, only the latest is sent. Nothing goes to someone who has paid since.
      </p>
      {d && !d.mailConfigured && <p className="mt-2 text-xs text-amber-200">Email is not set up (RESEND_API_KEY is missing): nothing will be sent until it is.</p>}
      <div className="mt-2">
        {notice && (
          <Notice kind="ok" onClose={() => setNotice(null)}>
            {notice}
          </Notice>
        )}
        {error && (
          <Notice kind="err" onClose={() => setError(null)}>
            {error}
          </Notice>
        )}
        {loadError && (
          <Notice kind="err" onRetry={load}>
            {loadError}
          </Notice>
        )}
      </div>
      {!form ? (
        !loadError && <Loading />
      ) : (
        <>
          <div className="mt-3 space-y-2">
            {rows.map((row) => (
              <div key={row.key} className="grid gap-2 sm:grid-cols-[14rem_10rem_1fr] sm:items-center">
                <label className="flex items-center gap-2 text-sm text-zinc-200">
                  <input type="checkbox" disabled={!editable} checked={form[row.key][0]} onChange={(e) => setForm({ ...form, [row.key]: [e.target.checked, form[row.key][1]] })} />
                  {row.title}
                </label>
                <input aria-label={`${row.title}: days`} value={form[row.key][1]} disabled={!editable} onChange={(e) => setForm({ ...form, [row.key]: [form[row.key][0], e.target.value] })} className={field} />
                <span className="text-xs text-zinc-400">{row.help}, e.g. “1, 3”</span>
              </div>
            ))}
          </div>
          {editable && (
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={btn.ghost}
                onClick={() => {
                  setNotice(null);
                  setConfirmRun(true);
                }}
              >
                Run now
              </button>
              <button
                type="button"
                className={btn.primary}
                onClick={() => {
                  setNotice(null);
                  setConfirmSave(true);
                }}
              >
                Save reminder rules
              </button>
            </div>
          )}

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-zinc-400">Next run would send</h3>
          {d?.preview.skipped === "all_off" ? (
            <EmptyLine>Nothing: every reminder is switched off.</EmptyLine>
          ) : preview.length === 0 ? (
            <EmptyLine>Nothing is due.{d?.preview.alreadySent ? ` ${fmtNumber(d.preview.alreadySent)} due reminder(s) were already sent.` : ""}</EmptyLine>
          ) : (
            <ul className="mt-1 divide-y divide-white/5 text-sm">
              {preview.map((p, i) => (
                <li key={i} className="flex flex-wrap gap-2 py-1.5">
                  <Badge>{p.kind}</Badge>
                  <span className="break-all text-zinc-200">{p.email ?? "no email on the account"}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-400">{p.subjectLine}</span>
                  {p.amount != null && <span className="text-xs text-zinc-400">{fmtMoney(p.amount, p.currency)}</span>}
                </li>
              ))}
            </ul>
          )}

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-zinc-400">Log</h3>
          {!d?.log.length ? (
            <Empty>No reminders sent yet.</Empty>
          ) : (
            <>
              <ul className="mt-1 divide-y divide-white/5 text-sm">
                {log.visible.map((l, i) => (
                  <li key={`${l.at}-${i}`} className="flex flex-wrap items-center gap-2 py-1.5">
                    <Time ts={l.at} className="w-44 text-xs text-zinc-400" />
                    <Badge tone={l.outcome === "sent" ? "green" : l.outcome === "failed" ? "red" : "zinc"}>{l.outcome}</Badge>
                    <span className="text-zinc-300">{l.kind}</span>
                    <span className="break-all text-zinc-200">{l.email ?? "—"}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">
                      {l.detail} · {l.by === "cron" ? "scheduled" : `run by ${l.by}`}
                    </span>
                  </li>
                ))}
              </ul>
              {log.total > log.pageSize && <Pager page={log.page} pageSize={log.pageSize} total={log.total} onPage={log.setPage} noun="reminder" />}
            </>
          )}
          {d?.rules.updatedAt && (
            <p className="mt-2 text-xs text-zinc-400">
              Rules last changed <Time ts={d.rules.updatedAt} /> by {d.rules.updatedBy}.
            </p>
          )}
        </>
      )}
      {confirmRun && (
        <Confirm
          title="Send due reminders now?"
          body="Sends what the list above shows, the same as the daily job. Anyone already reminded is skipped."
          confirmLabel="Send now"
          onConfirm={run}
          onCancel={() => setConfirmRun(false)}
        />
      )}
      {confirmSave && form && (
        <Confirm
          title="Save the reminder rules?"
          body={
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {rows.map((row) => (
                <li key={row.key}>
                  {row.title}: {form[row.key][0] ? `on, ${form[row.key][1] || "no days set"} (${row.help})` : "off"}
                </li>
              ))}
              <li>The next daily run (09:00 UTC) sends by these rules.</li>
            </ul>
          }
          confirmLabel="Save rules"
          onConfirm={save}
          onCancel={() => setConfirmSave(false)}
        />
      )}
    </Panel>
  );
}
