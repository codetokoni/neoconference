"use client";

// Communication: write an announcement or service notice, see exactly what
// each channel will show and who it reaches, confirm, and follow it out.
// Also: the history of every send, email delivery, usage reminders and a
// person's notification preferences (comms-extra.tsx).

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";
import { formatMessage } from "@/lib/comms/format";
import { DeliveryTab, PrefsTab, RemindersTab } from "./comms-extra";

type Channel = "email" | "inApp" | "push";
type PerChannel = Record<Channel, number>;
type Send = {
  id: string;
  kind: "announcement" | "product" | "service";
  message: { title: string; body: string; severity: "info" | "warning" | "critical"; url: string };
  channels: Record<Channel, boolean>;
  audienceLabel: string;
  startsAt: number | null;
  endsAt: number | null;
  status: "draft" | "queued" | "sending" | "paused" | "cancelled" | "done";
  createdAt: number;
  createdByEmail: string;
  confirmedAt?: number;
  confirmedByEmail?: string;
  finishedAt?: number;
  stoppedReason?: string;
  preview: { count: number; exact: boolean; withEmail: number };
  resolve: { done: boolean; scanned: number };
  chunks: number;
  nextChunk: number;
  counts: { recipients: number; sent: PerChannel; failed: PerChannel; skipped: PerChannel; unknown: PerChannel };
  lastError?: string;
};
type ChannelPreview = {
  email: { subject: string; html: string; text: string; from: string; unsubscribe: string | null } | null;
  inApp: { title: string; body: string; url: string } | null;
  push: { title: string; body: string; url: string } | null;
};
type Preview = {
  count: number;
  exact: boolean;
  withEmail: number;
  sample: Array<{ uid: string; email: string; name: string; plan: string; status: string }>;
  unmatched: string[];
  groups: Array<{ id: string; name?: string; missing?: true }>;
};
type Config = { mail: boolean; push: boolean; fcm: boolean; webhook: boolean; stepUpAbove: number };

const CH_LABEL: Record<Channel, string> = { email: "Email", inApp: "In-app (bell)", push: "Push" };
const KIND_LABEL = { announcement: "Announcement", product: "Product update", service: "Service notice" };
const STATUS_TONE = { draft: "zinc", queued: "cyan", sending: "cyan", paused: "amber", cancelled: "red", done: "green" } as const;

export default function CommsClient() {
  const [tab, setTab] = useState<"compose" | "history" | "delivery" | "reminders" | "prefs">("compose");
  const [openId, setOpenId] = useState<string | null>(null);
  const tabs = [
    ["compose", "New message"],
    ["history", "History"],
    ["delivery", "Email delivery"],
    ["reminders", "Reminders"],
    ["prefs", "Preferences"],
  ] as const;
  return (
    <div>
      <PageHeader
        title="Communication"
        sub="Announcements and service notices to the bell, push and email; what was sent and what became of it. A site-wide banner is set in Settings."
      />
      <div role="tablist" aria-label="Communication" className="mb-4 flex gap-1 overflow-x-auto border-b border-white/10">
        {tabs.map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k && !openId}
            onClick={() => {
              setOpenId(null);
              setTab(k);
            }}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === k && !openId ? "border-cyan-400 text-cyan-200" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
          >
            {l}
          </button>
        ))}
      </div>
      {openId ? (
        <SendDetail id={openId} onBack={() => setOpenId(null)} />
      ) : tab === "compose" ? (
        <Compose onSent={(id) => setOpenId(id)} />
      ) : tab === "history" ? (
        <History onOpen={setOpenId} />
      ) : tab === "delivery" ? (
        <DeliveryTab />
      ) : tab === "reminders" ? (
        <RemindersTab />
      ) : (
        <PrefsTab />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Compose                                                                    */
/* -------------------------------------------------------------------------- */

const PLANS = ["free", "starter", "pro", "business", "enterprise"];
const STATUSES = ["active", "suspended", "locked"];

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function Compose({ onSent }: { onSent: (id: string) => void }) {
  const { adminFetch } = useAdmin();
  const [config, setConfig] = useState<Config | null>(null);
  const [kind, setKind] = useState<Send["kind"]>("announcement");
  const [severity, setSeverity] = useState<Send["message"]["severity"]>("info");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [channels, setChannels] = useState<Record<Channel, boolean>>({ email: false, inApp: true, push: false });
  const [aKind, setAKind] = useState<"everyone" | "filter" | "groups" | "users">("filter");
  const [plans, setPlans] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>(["active"]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [groupIds, setGroupIds] = useState("");
  const [users, setUsers] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ send: Send; preview: Preview; channels: ChannelPreview; needsStepUp: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    adminFetch<{ config: Config }>("/api/admin/comms/sends?status=none").then((r) => r.ok && setConfig(r.data.config));
  }, [adminFetch]);

  const live = useMemo(() => formatMessage(body), [body]);

  const makeDraft = async () => {
    setBusy(true);
    setError(null);
    const list = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const audience =
      aKind === "everyone"
        ? { kind: "everyone" }
        : {
            kind: aKind,
            plans,
            statuses,
            signedUpFrom: from ? Date.parse(from + "T00:00:00Z") : undefined,
            signedUpTo: to ? Date.parse(to + "T23:59:59Z") : undefined,
            groupIds: aKind === "groups" ? list(groupIds) : undefined,
            users: aKind === "users" ? list(users) : undefined,
          };
    const r = await adminFetch<{ send: Send; preview: Preview; channels: ChannelPreview; needsStepUp: boolean }>("/api/admin/comms/sends", {
      method: "POST",
      json: {
        kind,
        severity,
        title,
        body,
        url,
        channels,
        audience,
        startsAt: startsAt ? new Date(startsAt).getTime() : null,
        endsAt: endsAt ? new Date(endsAt).getTime() : null,
      },
    });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? `HTTP ${r.status}`);
    setDraft(r.data);
  };

  const discard = async () => {
    if (draft) await adminFetch(`/api/admin/comms/sends/${draft.send.id}`, { method: "DELETE" });
    setDraft(null);
  };

  const confirm = async () => {
    if (!draft) return;
    setConfirming(false);
    setBusy(true);
    setError(null);
    const r = await adminFetch<{ send: Send }>(`/api/admin/comms/sends/${draft.send.id}/confirm`, { method: "POST", json: { count: draft.preview.count } });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? `HTTP ${r.status}`);
    onSent(draft.send.id);
  };

  if (draft) {
    const p = draft.preview;
    const n = p.count;
    return (
      <div className="space-y-4">
        {error && <Notice kind="err" onClose={() => setError(null)}>{error}</Notice>}
        <Panel>
          <h2 className="text-base font-semibold text-white">Check before sending</h2>
          <p className="mt-1 text-sm text-zinc-300">
            <b className="text-white" data-testid="recipient-count">
              {p.exact ? n.toLocaleString() : `At least ${n.toLocaleString()}`}
            </b>{" "}
            {n === 1 ? "person" : "people"} · {draft.send.audienceLabel}
            {draft.send.channels.email && <> · {p.withEmail.toLocaleString()} with an email address</>}
          </p>
          {!p.exact && <p className="mt-1 text-xs text-amber-300">This audience is large; the preview stopped counting. The job counts everyone as it sends.</p>}
          {p.unmatched.length > 0 && <p className="mt-1 text-xs text-amber-300">Matched nobody: {p.unmatched.join(", ")}</p>}
          {p.groups.length > 0 && (
            <p className="mt-1 text-xs text-zinc-400">Groups: {p.groups.map((g) => (g.missing ? `${g.id} (not found)` : g.name)).join(", ")}</p>
          )}
          {draft.send.startsAt && <p className="mt-1 text-xs text-zinc-400">Starts {fmtTime(draft.send.startsAt)}</p>}
          {draft.send.endsAt && <p className="mt-1 text-xs text-zinc-400">Stops delivering {fmtTime(draft.send.endsAt)}</p>}
          {p.sample.length > 0 && (
            <details className="mt-3" open>
              <summary className="cursor-pointer text-xs text-zinc-400">Sample of recipients</summary>
              <ul className="mt-2 divide-y divide-white/5 rounded-lg border border-white/10 text-sm">
                {p.sample.map((r) => (
                  <li key={r.uid} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                    <span className="text-zinc-100">{r.name}</span>
                    <span className="text-xs text-zinc-500">{r.email || "no email"}</span>
                    <Badge>{r.plan}</Badge>
                    {r.status !== "active" && <Badge tone="amber">{r.status}</Badge>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Panel>
        <ChannelPreviews channels={draft.channels} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btn.ghost} onClick={discard} disabled={busy}>
            Back and edit
          </button>
          <button type="button" className={btn.primary} disabled={busy || n === 0} onClick={() => setConfirming(true)}>
            {busy ? "Sending…" : `Send to ${p.exact ? "" : "at least "}${n.toLocaleString()} ${n === 1 ? "person" : "people"}`}
          </button>
          {draft.needsStepUp && <span className="text-xs text-amber-300">A send this large asks for a fresh authenticator code.</span>}
        </div>
        {confirming && (
          <Confirm
            title={`Send “${draft.send.message.title}”?`}
            body={
              <>
                {KIND_LABEL[draft.send.kind]} to {p.exact ? "" : "at least "}
                {n.toLocaleString()} {n === 1 ? "person" : "people"} by{" "}
                {(Object.keys(CH_LABEL) as Channel[]).filter((c) => draft.send.channels[c]).map((c) => CH_LABEL[c].toLowerCase()).join(", ")}. It cannot be unsent; you can pause or cancel what has not gone yet.
              </>
            }
            confirmLabel="Send now"
            typeToConfirm={draft.needsStepUp ? "SEND" : undefined}
            onConfirm={confirm}
            onCancel={() => setConfirming(false)}
          />
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        makeDraft();
      }}
    >
      {error && <Notice kind="err" onClose={() => setError(null)}>{error}</Notice>}
      <Panel>
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset>
            <legend className="text-sm text-zinc-300">Kind</legend>
            <div className="mt-1 space-y-1">
              {(Object.keys(KIND_LABEL) as Send["kind"][]).map((k) => (
                <label key={k} className="flex items-start gap-2 text-sm text-zinc-200">
                  <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} className="mt-1" />
                  <span>
                    {KIND_LABEL[k]}
                    <span className="block text-xs text-zinc-500">
                      {k === "service"
                        ? "Outages, maintenance, security. Reaches everyone in the audience, whatever their preferences."
                        : k === "product"
                          ? "New features and tips. People who turned product updates off are skipped."
                          : "News for users. People who turned announcements off are skipped."}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm text-zinc-300">
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value as Send["message"]["severity"])} className={`${field} mt-1`}>
              <option value="info">Information</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical (high-priority push)</option>
            </select>
          </label>
        </div>
        <label className="mt-3 block text-sm text-zinc-300">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} required className={`${field} mt-1`} placeholder="Scheduled maintenance on Saturday" />
        </label>
        <label className="mt-3 block text-sm text-zinc-300">
          Message
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} required rows={6} className={`${field} mt-1 font-mono`} />
        </label>
        <p className="mt-1 text-xs text-zinc-500">
          Formatting: a blank line starts a paragraph, **bold**, *italic*, [link text](https://…), lines starting with “- ” make a list. HTML is shown as text.
        </p>
        {body.trim() && (
          <div className="mt-2 rounded-lg border border-white/10 bg-white p-3" aria-label="Formatted message">
            <div dangerouslySetInnerHTML={{ __html: live.html }} />
          </div>
        )}
        <label className="mt-3 block text-sm text-zinc-300">
          Opens (optional page on this site)
          <input value={url} onChange={(e) => setUrl(e.target.value)} className={`${field} mt-1`} placeholder="/pricing" />
        </label>
      </Panel>

      <Panel>
        <fieldset>
          <legend className="text-sm text-zinc-300">Channels</legend>
          <div className="mt-1 flex flex-wrap gap-4">
            {(Object.keys(CH_LABEL) as Channel[]).map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm text-zinc-200">
                <input type="checkbox" checked={channels[c]} onChange={() => setChannels({ ...channels, [c]: !channels[c] })} />
                {CH_LABEL[c]}
              </label>
            ))}
          </div>
          {config && channels.email && !config.mail && <p className="mt-1 text-xs text-amber-300">Email is not set up (RESEND_API_KEY): email recipients will be skipped.</p>}
          {config && channels.push && !config.push && !config.fcm && <p className="mt-1 text-xs text-amber-300">Push is not set up (VAPID keys / FCM): push recipients will be skipped.</p>}
        </fieldset>
      </Panel>

      <Panel>
        <fieldset>
          <legend className="text-sm text-zinc-300">Who gets it</legend>
          <div className="mt-1 flex flex-wrap gap-4">
            {(
              [
                ["filter", "By plan, status or sign-up date"],
                ["groups", "Members of groups"],
                ["users", "Specific people"],
                ["everyone", "Everyone"],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-sm text-zinc-200">
                <input type="radio" name="audience" checked={aKind === k} onChange={() => setAKind(k)} />
                {l}
              </label>
            ))}
          </div>
          {aKind === "groups" && (
            <>
              <GroupPicker onPick={(id) => setGroupIds((cur) => (cur.split(/[\s,;]+/).includes(id) ? cur : `${cur.trim()} ${id}`.trim()))} />
              <label className="mt-3 block text-sm text-zinc-300">
                Group ids, separated by spaces or commas
                <textarea value={groupIds} onChange={(e) => setGroupIds(e.target.value)} rows={2} className={`${field} mt-1 font-mono`} />
              </label>
            </>
          )}
          {aKind === "users" && (
            <label className="mt-3 block text-sm text-zinc-300">
              User ids or email addresses, separated by spaces, commas or new lines
              <textarea value={users} onChange={(e) => setUsers(e.target.value)} rows={3} className={`${field} mt-1 font-mono`} />
            </label>
          )}
          {aKind !== "everyone" && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs text-zinc-400">Plan {aKind !== "filter" && "(optional)"}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {PLANS.map((p) => (
                    <label key={p} className="flex items-center gap-1.5 text-sm text-zinc-200">
                      <input type="checkbox" checked={plans.includes(p)} onChange={() => setPlans(toggle(plans, p))} />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-zinc-400">Account status</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {STATUSES.map((s) => (
                    <label key={s} className="flex items-center gap-1.5 text-sm text-zinc-200">
                      <input type="checkbox" checked={statuses.includes(s)} onChange={() => setStatuses(toggle(statuses, s))} />
                      {s}
                    </label>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-zinc-400">
                  Signed up from
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${field} mt-1`} />
                </label>
                <label className="text-xs text-zinc-400">
                  to
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${field} mt-1`} />
                </label>
              </div>
            </div>
          )}
        </fieldset>
      </Panel>

      <Panel>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-zinc-300">
            Start (optional — empty sends at once)
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={`${field} mt-1`} />
          </label>
          <label className="block text-sm text-zinc-300">
            End (optional — nothing more is delivered after it)
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={`${field} mt-1`} />
          </label>
        </div>
      </Panel>

      <button type="submit" className={btn.primary} disabled={busy}>
        {busy ? "Counting recipients…" : "Preview"}
      </button>
    </form>
  );
}

function GroupPicker({ onPick }: { onPick: (id: string) => void }) {
  const { adminFetch } = useAdmin();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Array<{ id: string; name: string; ownerName: string | null; memberCount: number }> | null>(null);
  const search = async () => {
    const r = await adminFetch<{ items: Array<{ id: string; name: string; ownerName: string | null; memberCount: number }> }>(`/api/admin/comms/groups?q=${encodeURIComponent(q.trim())}`);
    setItems(r.ok ? r.data.items : []);
  };
  return (
    <div className="mt-3">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              search();
            }
          }}
          placeholder="Find a group by name"
          aria-label="Find a group"
          className={field}
        />
        <button type="button" className={btn.ghost} onClick={search}>
          Find
        </button>
      </div>
      {items && (
        <ul className="mt-2 max-h-48 divide-y divide-white/5 overflow-y-auto rounded-lg border border-white/10 text-sm">
          {items.length === 0 && <li className="px-3 py-2 text-zinc-500">No group matches.</li>}
          {items.map((g) => (
            <li key={g.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-zinc-100">{g.name}</span>
              <span className="text-xs text-zinc-500">
                {g.memberCount} member{g.memberCount === 1 ? "" : "s"}
                {g.ownerName ? ` · ${g.ownerName}` : ""}
              </span>
              <button type="button" className={`${btn.ghost} px-2 py-0.5 text-xs`} onClick={() => onPick(g.id)}>
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChannelPreviews({ channels }: { channels: ChannelPreview }) {
  const [showText, setShowText] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {channels.email && (
        <Panel className="lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Email</h3>
            <button type="button" className={`${btn.ghost} px-2 py-1 text-xs`} onClick={() => setShowText(!showText)}>
              {showText ? "Show HTML" : "Show plain text"}
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            From {channels.email.from} · Subject: <span className="text-zinc-100">{channels.email.subject}</span>
          </p>
          {showText ? (
            <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-xs text-zinc-200">{channels.email.text}</pre>
          ) : (
            <iframe title="Email preview" sandbox="" srcDoc={channels.email.html} className="mt-2 h-80 w-full rounded-lg bg-white" />
          )}
          {channels.email.unsubscribe && <p className="mt-1 text-xs text-zinc-500">Each recipient gets their own unsubscribe link (this one is the first sample recipient&apos;s).</p>}
        </Panel>
      )}
      {channels.inApp && (
        <Panel>
          <h3 className="text-sm font-semibold text-white">In-app (the bell)</h3>
          <div className="mt-2 rounded-lg border border-white/10 bg-[#0B1220] p-3">
            <p className="text-sm font-medium text-zinc-100">{channels.inApp.title}</p>
            <p className="mt-0.5 text-sm text-zinc-400">{channels.inApp.body}</p>
            <p className="mt-1 text-[11px] text-zinc-500">Opens {channels.inApp.url}</p>
          </div>
        </Panel>
      )}
      {channels.push && (
        <Panel>
          <h3 className="text-sm font-semibold text-white">Push (browsers and the Android app)</h3>
          <div className="mt-2 rounded-xl bg-zinc-100 p-3 text-zinc-900 shadow">
            <p className="text-xs text-zinc-500">NeoConference</p>
            <p className="text-sm font-semibold">{channels.push.title}</p>
            <p className="line-clamp-3 text-sm">{channels.push.body}</p>
          </div>
        </Panel>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  History                                                                    */
/* -------------------------------------------------------------------------- */

function History({ onOpen }: { onOpen: (id: string) => void }) {
  const { adminFetch } = useAdmin();
  const [items, setItems] = useState<Send[] | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setItems(null);
    const u = new URLSearchParams();
    if (q.trim()) u.set("q", q.trim());
    if (status) u.set("status", status);
    const r = await adminFetch<{ items: Send[] }>(`/api/admin/comms/sends?${u}`);
    if (!r.ok) {
      setError(r.data.message ?? `HTTP ${r.status}`);
      return setItems([]);
    }
    setItems(r.data.items);
  }, [adminFetch, q, status]);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  return (
    <div>
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, message, sender or audience" aria-label="Search sends" className={`${field} min-w-0 flex-1`} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className={`${field} w-auto`}>
          <option value="">Any status</option>
          {Object.keys(STATUS_TONE).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" className={btn.primary}>
          Search
        </button>
      </form>
      {error && <Notice kind="err">{error}</Notice>}
      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>Nothing sent yet.</Empty>
      ) : (
        <Panel className="p-0">
          <ul className="divide-y divide-white/5">
            {items.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onOpen(s.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left hover:bg-white/[0.03]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-100">{s.message.title}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {KIND_LABEL[s.kind]} · {s.audienceLabel} · {s.createdByEmail} · {fmtTime(s.confirmedAt ?? s.createdAt)}
                    </span>
                  </span>
                  <span className="text-xs text-zinc-400">{(s.status === "draft" ? s.preview.count : s.counts.recipients).toLocaleString()} recipients</span>
                  <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  One send                                                                   */
/* -------------------------------------------------------------------------- */

type RecipientRow = { uid: string; name: string; email: string; ch: Partial<Record<Channel, { s: string; r?: string; t: number }>> };
type Failure = { uid: string; email: string; channel: Channel; reason: string; ts: number };

function SendDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<{ send: Send; reports: Record<string, number>; failures: Failure[]; channels: ChannelPreview } | null>(null);
  const [rows, setRows] = useState<{ chunk: number; chunks: number; items: RecipientRow[] } | null>(null);
  const [chunk, setChunk] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [webhook, setWebhook] = useState<boolean | null>(null);
  const [asking, setAsking] = useState<"cancel" | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ send: Send; reports: Record<string, number>; failures: Failure[]; channels: ChannelPreview }>(`/api/admin/comms/sends/${id}`);
    if (!r.ok) return setError(r.data.message ?? `HTTP ${r.status}`);
    setData(r.data);
  }, [adminFetch, id]);
  const loadRows = useCallback(async () => {
    const r = await adminFetch<{ chunk: number; chunks: number; items: RecipientRow[] }>(`/api/admin/comms/sends/${id}/recipients?chunk=${chunk}`);
    if (r.ok) setRows(r.data);
  }, [adminFetch, id, chunk]);

  useEffect(() => {
    load();
    adminFetch<{ config: Config }>("/api/admin/comms/sends?status=none").then((r) => r.ok && setWebhook(r.data.config.webhook));
  }, [load, adminFetch]);
  useEffect(() => {
    loadRows();
  }, [loadRows]);

  // While this page is open, it moves the send along itself.
  const running = data?.send.status === "queued" || data?.send.status === "sending";
  useEffect(() => {
    if (!running) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      await adminFetch(`/api/admin/comms/sends/${id}/process`, { method: "POST" });
      if (stop) return;
      await load();
      await loadRows();
      if (!stop) timer = setTimeout(tick, 2500);
    };
    let timer = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [running, id, adminFetch, load, loadRows]);

  const control = async (action: "pause" | "resume" | "cancel") => {
    setAsking(null);
    const r = await adminFetch(`/api/admin/comms/sends/${id}/control`, { method: "POST", json: { action } });
    if (!r.ok) setError(r.data.message ?? `HTTP ${r.status}`);
    await load();
  };

  if (!data) return error ? <Notice kind="err">{error}</Notice> : <Loading />;
  const s = data.send;
  const total = s.resolve.done ? s.chunks : Math.max(s.chunks, 1);
  const pct = s.status === "done" ? 100 : Math.round((s.nextChunk / Math.max(total, 1)) * (s.resolve.done ? 100 : 90));
  const active = (Object.keys(CH_LABEL) as Channel[]).filter((c) => s.channels[c]);
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-cyan-300 hover:text-cyan-200">
        ← All sends
      </button>
      {error && <Notice kind="err" onClose={() => setError(null)}>{error}</Notice>}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white">{s.message.title}</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              {KIND_LABEL[s.kind]} · {s.message.severity} · {s.audienceLabel}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              Drafted by {s.createdByEmail} {fmtTime(s.createdAt)}
              {s.confirmedAt && <> · sent by {s.confirmedByEmail} {fmtTime(s.confirmedAt)}</>}
              {s.finishedAt && <> · finished {fmtTime(s.finishedAt)}</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
            {(s.status === "queued" || s.status === "sending") && (
              <button type="button" className={btn.warn} onClick={() => control("pause")}>
                Pause
              </button>
            )}
            {s.status === "paused" && (
              <button type="button" className={btn.primary} onClick={() => control("resume")}>
                Resume
              </button>
            )}
            {(s.status === "queued" || s.status === "sending" || s.status === "paused") && (
              <button type="button" className={btn.danger} onClick={() => setAsking("cancel")}>
                Cancel
              </button>
            )}
          </div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded bg-white/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
          <div className="h-full bg-cyan-400" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-zinc-400">
          {s.counts.recipients.toLocaleString()} recipients so far{s.resolve.done ? "" : " (still listing)"} · block {Math.min(s.nextChunk, s.chunks)} of {s.chunks}
          {s.status === "draft" && " · not confirmed"}
          {s.stoppedReason === "ended" && " · stopped at its end time"}
          {s.startsAt && s.startsAt > Date.now() && ` · starts ${fmtTime(s.startsAt)}`}
        </p>
        {s.lastError && <p className="mt-1 text-xs text-red-300">Last error: {s.lastError}</p>}
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1 font-normal">Channel</th>
              <th className="py-1 font-normal">Sent</th>
              <th className="py-1 font-normal">Failed</th>
              <th className="py-1 font-normal">Skipped</th>
              <th className="py-1 font-normal">Unknown</th>
            </tr>
          </thead>
          <tbody>
            {active.map((c) => (
              <tr key={c} className="border-t border-white/5">
                <td className="py-1 text-zinc-300">{CH_LABEL[c]}</td>
                <td className="py-1 text-emerald-300">{s.counts.sent[c]}</td>
                <td className="py-1 text-red-300">{s.counts.failed[c]}</td>
                <td className="py-1 text-zinc-400">{s.counts.skipped[c]}</td>
                <td className="py-1 text-zinc-400">{s.counts.unknown[c]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.channels.email &&
          (webhook === false ? (
            <p className="mt-2 text-xs text-amber-300">
              Delivery reports are off (RESEND_WEBHOOK_SECRET is not set): only failures at send time are shown, not bounces or complaints.
            </p>
          ) : (
            <p className="mt-2 text-xs text-zinc-400">
              Email reports: {data.reports.delivered ?? 0} delivered · {data.reports.bounced ?? 0} bounced · {data.reports.complained ?? 0} complaints ·{" "}
              {data.reports.delayed ?? 0} delayed · {data.reports.failed ?? 0} failed
            </p>
          ))}
      </Panel>

      {data.failures.length > 0 && (
        <Panel>
          <h3 className="text-sm font-semibold text-white">Failed deliveries</h3>
          <ul className="mt-2 divide-y divide-white/5 text-sm">
            {data.failures.map((f, i) => (
              <li key={i} className="flex flex-wrap gap-2 py-1.5">
                <span className="text-zinc-200">{f.email || f.uid}</span>
                <Badge tone="red">{CH_LABEL[f.channel]}</Badge>
                <span className="text-xs text-zinc-400">{f.reason}</span>
                <span className="ml-auto text-xs text-zinc-500">{fmtTime(f.ts)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {rows && rows.chunks > 0 && (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Recipients</h3>
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <button type="button" className={`${btn.ghost} px-2 py-1 text-xs`} disabled={chunk === 0} onClick={() => setChunk(chunk - 1)}>
                ←
              </button>
              {chunk * 100 + 1}–{chunk * 100 + rows.items.length}
              <button type="button" className={`${btn.ghost} px-2 py-1 text-xs`} disabled={chunk + 1 >= rows.chunks} onClick={() => setChunk(chunk + 1)}>
                →
              </button>
            </div>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="py-1 font-normal">Person</th>
                  {active.map((c) => (
                    <th key={c} className="py-1 font-normal">
                      {CH_LABEL[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.items.map((r) => (
                  <tr key={r.uid} className="border-t border-white/5">
                    <td className="py-1">
                      <span className="text-zinc-200">{r.name}</span> <span className="text-xs text-zinc-500">{r.email}</span>
                    </td>
                    {active.map((c) => {
                      const st = r.ch[c];
                      const tone = !st ? "zinc" : st.s === "sent" || st.s === "delivered" ? "green" : st.s === "failed" || st.s === "bounced" || st.s === "complained" ? "red" : st.s === "unknown" ? "amber" : "zinc";
                      return (
                        <td key={c} className="py-1" title={st?.r}>
                          <Badge tone={tone}>{st ? st.s : "waiting"}</Badge>
                          {st?.r && <span className="ml-1 text-[11px] text-zinc-500">{st.r}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <details>
        <summary className="cursor-pointer text-sm text-zinc-400">The message as sent</summary>
        <div className="mt-2">
          <ChannelPreviews channels={data.channels} />
        </div>
      </details>

      {asking === "cancel" && (
        <Confirm
          title="Cancel this send?"
          body="Nobody else will get it. Those it already reached keep it."
          confirmLabel="Cancel the send"
          danger
          onConfirm={() => control("cancel")}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}
