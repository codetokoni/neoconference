"use client";

// Communication tabs besides composing: email delivery, usage reminders and
// one person's notification preferences.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Empty, Loading, Notice, Panel, btn, field } from "../ui";

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

const BAD = new Set(["bounced", "complained", "failed"]);

export function DeliveryTab() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<{ log: LogEntry[]; events: DeliveryEvent[]; mail: boolean; webhook: boolean; webhookUrl: string } | null>(null);
  const [q, setQ] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setData(null);
    const u = new URLSearchParams();
    if (q.trim()) u.set("q", q.trim());
    if (onlyFailed) u.set("status", "failed");
    const r = await adminFetch<{ log: LogEntry[]; events: DeliveryEvent[]; mail: boolean; webhook: boolean; webhookUrl: string }>(`/api/admin/comms/delivery?${u}`);
    if (!r.ok) return setError(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch, q, onlyFailed]);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyFailed]);

  const events = (data?.events ?? []).filter((e) => !onlyFailed || BAD.has(e.type));
  return (
    <div className="space-y-4">
      {error && <Notice kind="err">{error}</Notice>}
      {data && !data.mail && <Notice kind="err">Email is not set up: RESEND_API_KEY is missing, so no email is sent at all.</Notice>}
      {data && !data.webhook && (
        <Panel className="border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-amber-200">
            Delivery reports are off. RESEND_WEBHOOK_SECRET is not set, so this page shows only what failed at the moment of sending — not bounces,
            complaints or delays.
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            To turn them on: in Resend → Webhooks add <code className="rounded bg-black/40 px-1">{data.webhookUrl}</code> for the email.delivered,
            email.delivery_delayed, email.bounced, email.complained and email.failed events, then put its signing secret (whsec_…) in the Vercel variable
            RESEND_WEBHOOK_SECRET and redeploy.
          </p>
        </Panel>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search address, subject or template" aria-label="Search email" className={`${field} min-w-0 flex-1`} />
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={onlyFailed} onChange={() => setOnlyFailed(!onlyFailed)} />
          Failures only
        </label>
        <button type="submit" className={btn.primary}>
          Search
        </button>
      </form>
      {!data ? (
        <Loading />
      ) : (
        <>
          {data.webhook && (
            <Panel>
              <h3 className="text-sm font-semibold text-white">Delivery reports</h3>
              {events.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">None yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-white/5 text-sm">
                  {events.map((e, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2 py-1.5">
                      <Badge tone={BAD.has(e.type) ? "red" : e.type === "delivered" ? "green" : "zinc"}>{e.type}</Badge>
                      <span className="text-zinc-200">{e.to}</span>
                      <span className="truncate text-xs text-zinc-500">{e.subject}</span>
                      {e.reason && <span className="text-xs text-red-300">{e.reason}</span>}
                      {e.template && <span className="text-xs text-zinc-500">{e.template}</span>}
                      {e.sendId && <span className="text-xs text-zinc-500">announcement</span>}
                      <span className="ml-auto text-xs text-zinc-500">{fmtTime(e.ts)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
          <Panel>
            <h3 className="text-sm font-semibold text-white">Transactional email sent</h3>
            <p className="mt-0.5 text-xs text-zinc-500">Announcements are listed per recipient on their own page under History.</p>
            {data.log.length === 0 ? (
              <Empty>No email logged yet.</Empty>
            ) : (
              <ul className="mt-2 divide-y divide-white/5 text-sm">
                {data.log.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2 py-1.5">
                    <Badge tone={e.status === "sent" ? "green" : e.status === "failed" ? "red" : "amber"}>{e.status}</Badge>
                    <span className="text-zinc-200">{e.to}</span>
                    <span className="truncate text-xs text-zinc-400">{e.subject}</span>
                    <span className="text-xs text-zinc-500">
                      {e.source === "test" ? "test · " : ""}
                      {e.template} v{e.templateVersion < 0 ? "unsaved" : e.templateVersion}
                    </span>
                    {e.error && <span className="text-xs text-red-300">{e.error}</span>}
                    <span className="ml-auto text-xs text-zinc-500">{fmtTime(e.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Reminders                                                                  */
/* -------------------------------------------------------------------------- */

type Rule = { enabled: boolean; thresholds: number[]; channels: { email: boolean; inApp: boolean } };
type ReminderConfig = { meetings: Rule; recording: Rule; updatedAt: number | null; updatedBy: string | null };

export function RemindersTab() {
  const { adminFetch } = useAdmin();
  const [cfg, setCfg] = useState<ReminderConfig | null>(null);
  const [text, setText] = useState({ meetings: "", recording: "" });
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = (c: ReminderConfig) => {
    setCfg(c);
    setText({ meetings: c.meetings.thresholds.join(", "), recording: c.recording.thresholds.join(", ") });
  };
  useEffect(() => {
    adminFetch<{ config: ReminderConfig }>("/api/admin/comms/reminders").then((r) => (r.ok ? apply(r.data.config) : setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` })));
  }, [adminFetch]);
  if (!cfg) return msg ? <Notice kind="err">{msg.text}</Notice> : <Loading />;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const nums = (s: string) => s.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
    const r = await adminFetch<{ config: ReminderConfig }>("/api/admin/comms/reminders", {
      method: "PUT",
      json: { meetings: { ...cfg.meetings, thresholds: nums(text.meetings) }, recording: { ...cfg.recording, thresholds: nums(text.recording) } },
    });
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    apply(r.data.config);
    setMsg({ kind: "ok", text: "Saved." });
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
            <input value={text[key]} onChange={(e) => setText({ ...text, [key]: e.target.value })} className={`${field} mt-1 w-40`} aria-label={`${title} thresholds`} />
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" checked={r.channels.email} onChange={() => set({ ...r, channels: { ...r.channels, email: !r.channels.email } })} />
            Email
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" checked={r.channels.inApp} onChange={() => set({ ...r, channels: { ...r.channels, inApp: !r.channels.inApp } })} />
            In-app
          </label>
        </div>
      </Panel>
    );
  };

  return (
    <div className="space-y-4">
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      {rule("meetings", "Meetings running out", "Plans with a lifetime meeting cap (Free: 5). Each threshold is sent once per account. Wording: the “Free meetings running out” email template.")}
      {rule("recording", "Recording hours running out", "Monthly recording hours (Pro 10, Business and Enterprise 50). Each threshold is sent once a month. Wording: the “Recording hours running out” template.")}
      <p className="text-xs text-zinc-500">
        People who turned off “Usage reminders” in their settings are skipped on that channel. Renewal and failed-payment reminders are part of billing and are set up there.
        {cfg.updatedAt && <> Last changed by {cfg.updatedBy} {fmtTime(cfg.updatedAt)}.</>}
      </p>
      <button type="button" className={btn.primary} disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save reminders"}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  A person's preferences                                                     */
/* -------------------------------------------------------------------------- */

type Prefs = { categories: Record<string, { email: boolean; inApp: boolean; push: boolean }>; updatedAt: number | null; updatedVia: string | null };

export function PrefsTab() {
  const { adminFetch, can } = useAdmin();
  const [who, setWho] = useState("");
  const [res, setRes] = useState<{ user: { id: string; name: string; email: string }; prefs: Prefs } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!can("users:read")) return <Empty>Looking up a person needs the users:read permission.</Empty>;
  const look = async () => {
    setError(null);
    setRes(null);
    const r = await adminFetch<{ user: { id: string; name: string; email: string }; prefs: Prefs }>(`/api/admin/comms/prefs?user=${encodeURIComponent(who.trim())}`);
    if (!r.ok) return setError(r.data.message ?? `HTTP ${r.status}`);
    setRes(r.data);
  };
  const LABELS: Record<string, string> = { announcements: "Announcements", product: "Product updates", reminders: "Usage reminders" };
  return (
    <div className="space-y-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (who.trim()) look();
        }}
      >
        <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="User id or email" aria-label="User id or email" className={field} />
        <button type="submit" className={btn.primary}>
          Look up
        </button>
      </form>
      {error && <Notice kind="err">{error}</Notice>}
      {res && (
        <Panel>
          <p className="text-sm text-zinc-100">
            {res.user.name || res.user.email} <span className="text-xs text-zinc-500">{res.user.email} · {res.user.id}</span>
          </p>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
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
                  <td className="py-1 text-zinc-300">{LABELS[k] ?? k}</td>
                  {(["email", "inApp", "push"] as const).map((c) => (
                    <td key={c} className="py-1">
                      <Badge tone={v[c] ? "green" : "red"}>{v[c] ? "on" : "off"}</Badge>
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-white/5">
                <td className="py-1 text-zinc-300">Transactional, security and service notices</td>
                <td className="py-1 text-xs text-zinc-500" colSpan={3}>
                  Always on — cannot be turned off
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-500">
            {res.prefs.updatedAt ? `Last changed ${fmtTime(res.prefs.updatedAt)} via ${res.prefs.updatedVia?.replace(/_/g, " ")}.` : "Never changed: everything is on."}
          </p>
        </Panel>
      )}
    </div>
  );
}
