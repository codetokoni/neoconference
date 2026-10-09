"use client";

// Communication tabs besides composing: email delivery, usage reminders and
// one person's notification preferences.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Time, errorText, fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Empty, EmptyLine, FilterBar, Labeled, LoadState, Notice, Pager, Panel, SortTh, TableWrap, btn, field, useClientTable } from "../ui";

type Msg = { kind: "ok" | "err"; text: string };

/* -------------------------------------------------------------------------- */
/*  Email delivery                                                             */
/* -------------------------------------------------------------------------- */

type LogEntry = {
  id: string;
  ts: number;
  source: "template" | "test";
  template: string;
  templateVersion: number;
  to: string;
  recipients: number;
  subject: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
};
type DeliveryEvent = { ts: number; type: string; to: string; subject?: string; reason?: string; template?: string; sendId?: string };
type Delivery = { log: LogEntry[]; events: DeliveryEvent[]; mail: boolean; webhook: boolean; webhookUrl: string };

const BAD = new Set(["bounced", "complained", "failed"]);
/** The delivery API returns at most this many of each list, newest first. */
const DELIVERY_CAP = 200;
const LOG_LABEL: Record<LogEntry["status"], string> = { sent: "Sent", failed: "Failed", skipped: "Skipped" };

export function DeliveryTab({ q, failed, onFilter }: { q: string; failed: boolean; onFilter: (p: { q?: string; failed?: string }) => void }) {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<Delivery | null>(null);
  const [search, setSearch] = useState(q);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSearch(q), [q]);
  const load = useCallback(async () => {
    setData(null);
    setError(null);
    const u = new URLSearchParams();
    if (q.trim()) u.set("q", q.trim());
    if (failed) u.set("status", "failed");
    const r = await adminFetch<Delivery>(`/api/admin/comms/delivery?${u}`);
    if (!r.ok) return setError(errorText(r));
    setData(r.data);
  }, [adminFetch, q, failed]);
  useEffect(() => {
    load();
  }, [load]);

  const events = (data?.events ?? []).filter((e) => !failed || BAD.has(e.type));
  const ev = useClientTable(events, (e, k) => (k === "type" ? e.type : k === "to" ? e.to : e.ts), { key: "ts", dir: "desc" });
  const log = useClientTable(data?.log, (e, k) => (k === "status" ? e.status : k === "to" ? e.to : k === "template" ? e.template : e.ts), { key: "ts", dir: "desc" });
  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onFilter({ q: search.trim() });
        }}
      >
        <FilterBar active={!!q || failed} onClear={() => onFilter({ q: "", failed: "" })}>
          <Labeled label="Search" className="min-w-[12rem] flex-1">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Address, subject or template" className={field} />
          </Labeled>
          <label className="flex items-center gap-2 pb-2 text-sm text-zinc-300">
            <input type="checkbox" checked={failed} onChange={() => onFilter({ failed: failed ? "" : "1" })} />
            Failures only
          </label>
          <button type="submit" className={btn.primary}>
            Search
          </button>
        </FilterBar>
      </form>
      <LoadState data={data} error={error} onRetry={load}>
        {(d) => (
          <>
            {!d.mail && <Notice kind="err">Email is not set up: RESEND_API_KEY is missing, so no email is sent at all.</Notice>}
            {!d.webhook && (
              <Panel className="border-amber-500/30 bg-amber-500/5">
                <p className="text-sm text-amber-200">
                  Delivery reports are off. RESEND_WEBHOOK_SECRET is not set, so this page shows only what failed at the moment of sending — not bounces,
                  complaints or delays.
                </p>
                <p className="mt-1 break-words text-xs text-zinc-400">
                  To turn them on: in Resend → Webhooks add <code className="break-all rounded bg-black/40 px-1">{d.webhookUrl}</code> for the email.delivered,
                  email.delivery_delayed, email.bounced, email.complained and email.failed events, then put its signing secret (whsec_…) in the Vercel variable
                  RESEND_WEBHOOK_SECRET and redeploy.
                </p>
              </Panel>
            )}
            {d.webhook && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-white">Delivery reports</h3>
                {events.length === 0 ? (
                  <EmptyLine>{q || failed ? "No delivery reports match." : "None yet."}</EmptyLine>
                ) : (
                  <>
                    {d.events.length >= DELIVERY_CAP && <p className="mb-2 text-xs text-zinc-400">The newest {DELIVERY_CAP} reports that match are listed; search to find older ones.</p>}
                    <TableWrap minWidth={640}>
                      <thead className="border-b border-white/10 text-xs text-zinc-400">
                        <tr>
                          <SortTh label="Report" k="type" sort={ev.sort} onSort={ev.onSort} />
                          <SortTh label="To" k="to" sort={ev.sort} onSort={ev.onSort} />
                          <th className="px-3 py-2 font-medium">Email</th>
                          <SortTh label="When" k="ts" sort={ev.sort} onSort={ev.onSort} />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {ev.visible.map((e, i) => (
                          <tr key={`${e.ts}-${e.to}-${e.type}-${i}`}>
                            <td className="px-3 py-2">
                              <Badge tone={BAD.has(e.type) ? "red" : e.type === "delivered" ? "green" : "zinc"}>{e.type}</Badge>
                            </td>
                            <td className="break-all px-3 py-2 text-zinc-200">{e.to}</td>
                            <td className="px-3 py-2 text-xs text-zinc-400">
                              {e.subject}
                              {e.reason && <span className="block text-red-300">{e.reason}</span>}
                              {(e.template || e.sendId) && <span className="block text-zinc-400">{e.sendId ? "announcement" : e.template}</span>}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                              <Time ts={e.ts} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </TableWrap>
                    <Pager page={ev.page} pageSize={ev.pageSize} total={ev.total} onPage={ev.setPage} onPageSize={ev.setPageSize} noun="report" />
                  </>
                )}
              </section>
            )}
            <section>
              <h3 className="text-sm font-semibold text-white">Transactional email sent</h3>
              <p className="mb-2 mt-0.5 text-xs text-zinc-400">Announcements are listed per recipient on their own page under History.</p>
              {d.log.length === 0 ? (
                <Empty>{q || failed ? "No email matches." : "No email logged yet."}</Empty>
              ) : (
                <>
                  {d.log.length >= DELIVERY_CAP && <p className="mb-2 text-xs text-zinc-400">The newest {DELIVERY_CAP} emails that match are listed; search to find older ones.</p>}
                  <TableWrap minWidth={680}>
                    <thead className="border-b border-white/10 text-xs text-zinc-400">
                      <tr>
                        <SortTh label="Status" k="status" sort={log.sort} onSort={log.onSort} />
                        <SortTh label="To" k="to" sort={log.sort} onSort={log.onSort} />
                        <th className="px-3 py-2 font-medium">Subject</th>
                        <SortTh label="Template" k="template" sort={log.sort} onSort={log.onSort} />
                        <SortTh label="When" k="ts" sort={log.sort} onSort={log.onSort} />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {log.visible.map((e) => (
                        <tr key={e.id}>
                          <td className="px-3 py-2">
                            <Badge tone={e.status === "sent" ? "green" : e.status === "failed" ? "red" : "amber"}>{LOG_LABEL[e.status] ?? e.status}</Badge>
                          </td>
                          <td className="break-all px-3 py-2 text-zinc-200">{e.to}</td>
                          <td className="px-3 py-2 text-xs text-zinc-400">
                            {e.subject}
                            {e.error && <span className="block text-red-300">{e.error}</span>}
                          </td>
                          <td className="px-3 py-2 text-xs text-zinc-400">
                            {e.source === "test" ? "test · " : ""}
                            {e.template} v{e.templateVersion < 0 ? "unsaved" : e.templateVersion}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                            <Time ts={e.ts} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableWrap>
                  <Pager page={log.page} pageSize={log.pageSize} total={log.total} onPage={log.setPage} onPageSize={log.setPageSize} noun="email" />
                </>
              )}
            </section>
          </>
        )}
      </LoadState>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Reminders                                                                  */
/* -------------------------------------------------------------------------- */

type Rule = { enabled: boolean; thresholds: number[]; channels: { email: boolean; inApp: boolean } };
type ReminderConfig = { meetings: Rule; recording: Rule; updatedAt: number | null; updatedBy: string | null };

export function RemindersTab() {
  const { adminFetch, can } = useAdmin();
  const [cfg, setCfg] = useState<ReminderConfig | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [text, setText] = useState({ meetings: "", recording: "" });
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const apply = (c: ReminderConfig) => {
    setCfg(c);
    setText({ meetings: c.meetings.thresholds.join(", "), recording: c.recording.thresholds.join(", ") });
  };
  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<{ config: ReminderConfig }>("/api/admin/comms/reminders");
    if (r.ok) apply(r.data.config);
    else setLoadErr(errorText(r));
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);
  if (!cfg)
    return (
      <LoadState data={null} error={loadErr} onRetry={load}>
        {() => null}
      </LoadState>
    );

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const nums = (s: string) => s.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    const r = await adminFetch<{ config: ReminderConfig }>("/api/admin/comms/reminders", {
      method: "PUT",
      json: { meetings: { ...cfg.meetings, thresholds: nums(text.meetings) }, recording: { ...cfg.recording, thresholds: nums(text.recording) } },
    });
    setBusy(false);
    setAsking(false);
    if (!r.ok) return setMsg({ kind: "err", text: errorText(r) });
    apply(r.data.config);
    setMsg({ kind: "ok", text: "Saved. Reminders follow these settings from now on." });
  };

  const rule = (key: "meetings" | "recording", title: string, sub: string) => {
    const r = cfg[key];
    const set = (next: Rule) => setCfg({ ...cfg, [key]: next });
    return (
      <Panel>
        <label className="flex items-center gap-2 text-sm font-semibold text-white">
          <input type="checkbox" checked={r.enabled} onChange={() => set({ ...r, enabled: !r.enabled })} />
          {title}
        </label>
        <p className="mt-1 text-xs text-zinc-400">{sub}</p>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <label className="text-sm text-zinc-300">
            At (% of the allowance)
            <input
              value={text[key]}
              onChange={(e) => setText({ ...text, [key]: e.target.value })}
              className={`${field} mt-1 w-40`}
              aria-label={`${title}: at (% of the allowance)`}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" checked={r.channels.email} onChange={() => set({ ...r, channels: { ...r.channels, email: !r.channels.email } })} aria-label={`${title}: email`} />
            Email
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" checked={r.channels.inApp} onChange={() => set({ ...r, channels: { ...r.channels, inApp: !r.channels.inApp } })} aria-label={`${title}: in-app`} />
            In-app
          </label>
        </div>
      </Panel>
    );
  };

  const onOff = (r: Rule) => (r.enabled ? "on" : "off");
  return (
    <div className="space-y-4">
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      {rule("meetings", "Meetings running out", "Plans with a lifetime meeting cap (Free: 5). Each threshold is sent once per account. Wording: the “Free meetings running out” email template.")}
      {rule("recording", "Recording hours running out", "Monthly recording hours (Pro 10, Business and Enterprise 50). Each threshold is sent once a month. Wording: the “Recording hours running out” template.")}
      <p className="text-xs text-zinc-400">
        People who turned off “Usage reminders” in their settings are skipped on that channel. Renewal, failed-payment and abandoned-checkout reminders are part of billing
        {can("billing:read") ? (
          <>
            {" "}
            — see{" "}
            <Link href="/admin/billing/settings" className="text-cyan-300 hover:text-cyan-200">
              Billing settings → Reminder emails
            </Link>
            .
          </>
        ) : (
          " and are set up in Billing settings (needs the billing:read permission)."
        )}
        {cfg.updatedAt && <> Last changed by {cfg.updatedBy} {fmtTime(cfg.updatedAt)}.</>}
      </p>
      <button
        type="button"
        className={btn.primary}
        disabled={busy}
        onClick={() => {
          setMsg(null);
          setAsking(true);
        }}
      >
        {busy ? "Saving…" : "Save reminders"}
      </button>
      {asking && (
        <Confirm
          title="Save the usage reminders?"
          body={
            <>
              Meetings running out: {onOff(cfg.meetings)}
              {cfg.meetings.enabled && <> at {text.meetings || "no thresholds"}%</>}. Recording hours running out: {onOff(cfg.recording)}
              {cfg.recording.enabled && <> at {text.recording || "no thresholds"}%</>}. Users are reminded by these settings from now on.
            </>
          }
          confirmLabel="Save reminders"
          onConfirm={save}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  A person's preferences                                                     */
/* -------------------------------------------------------------------------- */

type Prefs = { categories: Record<string, { email: boolean; inApp: boolean; push: boolean }>; updatedAt: number | null; updatedVia: string | null };

const PREF_LABELS: Record<string, string> = { announcements: "Announcements", product: "Product updates", reminders: "Usage reminders" };

export function PrefsTab() {
  const { adminFetch, can } = useAdmin();
  const [who, setWho] = useState("");
  const [res, setRes] = useState<{ user: { id: string; name: string; email: string }; prefs: Prefs } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can("users:read")) return <Empty>Looking up a person needs the users:read permission.</Empty>;
  const look = async () => {
    setError(null);
    setRes(null);
    setBusy(true);
    const r = await adminFetch<{ user: { id: string; name: string; email: string }; prefs: Prefs }>(`/api/admin/comms/prefs?user=${encodeURIComponent(who.trim())}`);
    setBusy(false);
    if (!r.ok) return setError(errorText(r));
    setRes(r.data);
  };
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (who.trim()) look();
        }}
      >
        <Labeled label="User id or email" className="min-w-[12rem] flex-1">
          <input value={who} onChange={(e) => setWho(e.target.value)} className={field} />
        </Labeled>
        <button type="submit" className={btn.primary} disabled={busy || !who.trim()}>
          {busy ? "Looking up…" : "Look up"}
        </button>
      </form>
      {error && (
        <Notice kind="err" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {res && (
        <Panel>
          <p className="break-words text-sm text-zinc-100">
            {res.user.name || res.user.email}{" "}
            <span className="break-all text-xs text-zinc-400">
              {res.user.email} · {res.user.id}
            </span>
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[22rem] text-left text-sm">
              <thead className="text-xs text-zinc-400">
                <tr>
                  <th className="py-1 font-normal">Category</th>
                  <th className="py-1 font-normal">Email</th>
                  <th className="py-1 font-normal">In-app</th>
                  <th className="py-1 font-normal">Push</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(res.prefs.categories).map(([k, v]) => (
                  <tr key={k} className="border-t border-white/5">
                    <td className="py-1 text-zinc-300">{PREF_LABELS[k] ?? k}</td>
                    {(["email", "inApp", "push"] as const).map((c) => (
                      <td key={c} className="py-1">
                        <Badge tone={v[c] ? "green" : "red"}>{v[c] ? "on" : "off"}</Badge>
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-white/5">
                  <td className="py-1 text-zinc-300">Transactional, security and service notices</td>
                  <td className="py-1 text-xs text-zinc-400" colSpan={3}>
                    Always on — cannot be turned off
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            {res.prefs.updatedAt ? `Last changed ${fmtTime(res.prefs.updatedAt)} via ${res.prefs.updatedVia?.replace(/_/g, " ")}.` : "Never changed: everything is on."}
          </p>
        </Panel>
      )}
    </div>
  );
}
