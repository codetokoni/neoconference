"use client";

// Communication: write an announcement or service notice, see exactly what
// each channel will show and who it reaches, confirm, and follow it out.
// Also: the history of every send, email delivery, usage reminders and a
// person's notification preferences (comms-extra.tsx). The tab, the opened
// send and the history filters live in the address bar so a view can be linked.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Time, errorText, fmtNumber, fmtTime, fromZonedInput, useAdmin, zoneLabel } from "../AdminApi";
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
const STATUS_LABEL: Record<Send["status"], string> = { draft: "Draft", queued: "Queued", sending: "Sending", paused: "Paused", cancelled: "Cancelled", done: "Finished" };
const SEVERITY_LABEL = { info: "Information", warning: "Warning", critical: "Critical" };

/** The history list API returns at most this many sends, newest first. */
const HISTORY_CAP = 100;

const TABS = [
  { id: "compose", label: "New message" },
  { id: "history", label: "History" },
  { id: "delivery", label: "Email delivery" },
  { id: "reminders", label: "Reminders" },
  { id: "prefs", label: "Preferences" },
] as const;
type Tab = (typeof TABS)[number]["id"];
const URL_DEFAULTS = { tab: "compose", send: "", q: "", status: "", failed: "" };

export default function CommsClient() {
  const { can } = useAdmin();
  const f = useUrlFilters(URL_DEFAULTS);
  const tab: Tab = TABS.some((t) => t.id === f.value.tab) ? (f.value.tab as Tab) : "compose";
  const openId = f.value.send || null;
  return (
    <div>
      <PageHeader
        title="Communication"
        sub={
          <>
            Announcements and service notices to the bell, push and email; what was sent and what became of it. A site-wide banner is set in{" "}
            {can("settings:write") ? (
              <Link href="/admin/settings" className="text-cyan-300 hover:text-cyan-200">
                Settings → Notice banner tab
              </Link>
            ) : (
              "Settings → Notice banner (needs the settings:write permission)"
            )}
            .
          </>
        }
      />
      {/* Changing tab starts that tab clean: no send open, no filters carried over. */}
      <Tabs label="Communication" tabs={TABS} value={tab} idBase="comms" onChange={(k) => f.set({ tab: k, send: "", q: "", status: "", failed: "" })} />
      <TabPanel idBase="comms" value={tab}>
        {openId ? (
          <SendDetail id={openId} onBack={() => f.set({ send: "" })} />
        ) : tab === "compose" ? (
          <Compose onSent={(id) => f.set({ tab: "history", send: id })} />
        ) : tab === "history" ? (
          <History q={f.value.q} status={f.value.status} onFilter={(p) => f.set(p)} onOpen={(id) => f.set({ send: id })} />
        ) : tab === "delivery" ? (
          <DeliveryTab q={f.value.q} failed={f.value.failed === "1"} onFilter={(p) => f.set(p)} />
        ) : tab === "reminders" ? (
          <RemindersTab />
        ) : (
          <PrefsTab />
        )}
      </TabPanel>
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

function people(n: number, exact = true): string {
  return `${exact ? "" : "at least "}${fmtNumber(n)} ${n === 1 ? "person" : "people"}`;
}

function Compose({ onSent }: { onSent: (id: string) => void }) {
  const { adminFetch } = useAdmin();
  const [config, setConfig] = useState<Config | null>(null);
  const [configErr, setConfigErr] = useState<string | null>(null);
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
  const [goingBack, setGoingBack] = useState(false);

  // Which channels are set up — a failure here is shown, not taken as "all set up".
  const loadConfig = useCallback(async () => {
    setConfigErr(null);
    const r = await adminFetch<{ config: Config }>("/api/admin/comms/sends?status=none");
    if (r.ok) setConfig(r.data.config);
    else setConfigErr(errorText(r));
  }, [adminFetch]);
  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const live = useMemo(() => formatMessage(body), [body]);
  const zone = zoneLabel();

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
        // Read on the admin clock, the zone named beside the inputs.
        startsAt: fromZonedInput(startsAt),
        endsAt: fromZonedInput(endsAt),
      },
    });
    setBusy(false);
    if (!r.ok) return setError(errorText(r));
    setDraft(r.data);
  };

  // Going back discards the server-side draft; the form keeps what was typed.
  const discard = async () => {
    setError(null);
    const r = draft ? await adminFetch(`/api/admin/comms/sends/${draft.send.id}`, { method: "DELETE" }) : null;
    setGoingBack(false);
    if (r && !r.ok) setError(`The draft could not be discarded (${errorText(r)}). It stays in History as a draft.`);
    setDraft(null);
  };

  const confirm = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const r = await adminFetch<{ send: Send }>(`/api/admin/comms/sends/${draft.send.id}/confirm`, { method: "POST", json: { count: draft.preview.count } });
    setBusy(false);
    setConfirming(false);
    if (!r.ok) return setError(errorText(r));
    onSent(draft.send.id);
  };

  if (draft) {
    const p = draft.preview;
    const n = p.count;
    return (
      <div className="space-y-4">
        {error && (
          <Notice kind="err" onClose={() => setError(null)}>
            {error}
          </Notice>
        )}
        <Panel>
          <h2 className="text-base font-semibold text-white">Check before sending</h2>
          <p className="mt-1 text-sm text-zinc-300">
            <b className="text-white" data-testid="recipient-count">
              {p.exact ? fmtNumber(n) : `At least ${fmtNumber(n)}`}
            </b>{" "}
            {n === 1 ? "person" : "people"} · {draft.send.audienceLabel}
            {draft.send.channels.email && <> · {fmtNumber(p.withEmail)} with an email address</>}
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
                    <span className="min-w-0 break-all text-xs text-zinc-400">{r.email || "no email"}</span>
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
          <button type="button" className={btn.ghost} onClick={() => setGoingBack(true)} disabled={busy}>
            Back and edit
          </button>
          <button type="button" className={btn.primary} disabled={busy || n === 0} onClick={() => setConfirming(true)}>
            {busy ? "Sending…" : `Send to ${people(n, p.exact)}`}
          </button>
          {n === 0 && <span className="text-xs text-zinc-400">Nobody matches this audience, so there is nothing to send.</span>}
          {draft.needsStepUp && <span className="text-xs text-amber-300">A send this large asks for a fresh authenticator code.</span>}
        </div>
        {confirming && (
          <Confirm
            title={`Send “${draft.send.message.title}”?`}
            body={
              <>
                {KIND_LABEL[draft.send.kind]} to {people(n, p.exact)} by{" "}
                {(Object.keys(CH_LABEL) as Channel[]).filter((c) => draft.send.channels[c]).map((c) => CH_LABEL[c].toLowerCase()).join(", ")}. It cannot be unsent; you can pause or cancel what has not gone yet.
              </>
            }
            confirmLabel="Send now"
            typeToConfirm={draft.needsStepUp ? "SEND" : undefined}
            onConfirm={confirm}
            onCancel={() => setConfirming(false)}
          />
        )}
        {goingBack && (
          <Confirm
            title="Back to editing?"
            body="This preview is discarded (the draft is deleted). What you typed stays in the form, and you preview again before sending."
            confirmLabel="Back and edit"
            onConfirm={discard}
            onCancel={() => setGoingBack(false)}
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
      {error && (
        <Notice kind="err" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
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
                    <span className="block text-xs text-zinc-400">
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
        <p className="mt-1 text-xs text-zinc-400">
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
          {configErr && (
            <div className="mt-2">
              <Notice kind="err" onRetry={loadConfig}>
                Could not check which channels are set up: {configErr}
              </Notice>
            </div>
          )}
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
                ["everyone", "Everyone (not suspended)"],
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
              {/* Whole days in UTC: the server reads from 00:00 to 23:59:59 UTC. */}
              <div className="grid grid-cols-2 gap-2">
                <label className="min-w-0 text-xs text-zinc-400">
                  Signed up from (UTC)
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${field} mt-1`} />
                </label>
                <label className="min-w-0 text-xs text-zinc-400">
                  to (UTC)
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
            <span className="block text-xs text-zinc-400">{zone}</span>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={`${field} mt-1`} />
          </label>
          <label className="block text-sm text-zinc-300">
            End (optional — nothing more is delivered after it)
            <span className="block text-xs text-zinc-400">{zone}</span>
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

type GroupHit = { id: string; name: string; ownerName: string | null; memberCount: number };

function GroupPicker({ onPick }: { onPick: (id: string) => void }) {
  const { adminFetch } = useAdmin();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<GroupHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    setBusy(true);
    setError(null);
    const r = await adminFetch<{ items: GroupHit[] }>(`/api/admin/comms/groups?q=${encodeURIComponent(q.trim())}`);
    setBusy(false);
    if (!r.ok) {
      setItems(null);
      return setError(errorText(r));
    }
    setItems(r.data.items);
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
          className={`${field} min-w-0`}
        />
        <button type="button" className={btn.ghost} onClick={search} disabled={busy}>
          {busy ? "Finding…" : "Find"}
        </button>
      </div>
      {error && (
        <div className="mt-2">
          <Notice kind="err" onRetry={search}>
            {error}
          </Notice>
        </div>
      )}
      {items && (
        <ul className="mt-2 max-h-48 divide-y divide-white/5 overflow-y-auto rounded-lg border border-white/10 text-sm">
          {items.length === 0 && <li className="px-3 py-2 text-zinc-400">No group matches.</li>}
          {items.map((g) => (
            <li key={g.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-zinc-100">{g.name}</span>
              <span className="text-xs text-zinc-400">
                {fmtNumber(g.memberCount)} member{g.memberCount === 1 ? "" : "s"}
                {g.ownerName ? ` · ${g.ownerName}` : ""}
              </span>
              <button type="button" className={`${btn.ghost} px-2 py-0.5 text-xs`} onClick={() => onPick(g.id)} aria-label={`Add ${g.name}`}>
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
        <Panel className="min-w-0 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Email</h3>
            <button type="button" className={`${btn.ghost} px-2 py-1 text-xs`} onClick={() => setShowText(!showText)}>
              {showText ? "Show HTML" : "Show plain text"}
            </button>
          </div>
          <p className="mt-1 break-words text-xs text-zinc-400">
            From {channels.email.from} · Subject: <span className="text-zinc-100">{channels.email.subject}</span>
          </p>
          {showText ? (
            <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-xs text-zinc-200">{channels.email.text}</pre>
          ) : (
            <iframe title="Email preview" sandbox="" srcDoc={channels.email.html} className="mt-2 h-80 w-full rounded-lg bg-white" />
          )}
          {channels.email.unsubscribe && <p className="mt-1 text-xs text-zinc-400">Each recipient gets their own unsubscribe link (this one is the first sample recipient&apos;s).</p>}
        </Panel>
      )}
      {channels.inApp && (
        <Panel className="min-w-0">
          <h3 className="text-sm font-semibold text-white">In-app (the bell)</h3>
          <div className="mt-2 rounded-lg border border-white/10 bg-[#0B1220] p-3">
            <p className="text-sm font-medium text-zinc-100">{channels.inApp.title}</p>
            <p className="mt-0.5 text-sm text-zinc-400">{channels.inApp.body}</p>
            <p className="mt-1 break-all text-[11px] text-zinc-400">Opens {channels.inApp.url}</p>
          </div>
        </Panel>
      )}
      {channels.push && (
        <Panel className="min-w-0">
          <h3 className="text-sm font-semibold text-white">Push (browsers and the Android app)</h3>
          <div className="mt-2 rounded-xl bg-zinc-100 p-3 text-zinc-900 shadow">
            <p className="text-xs text-zinc-600">NeoConference</p>
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

function recipientsOf(s: Send): number {
  return s.status === "draft" ? s.preview.count : s.counts.recipients;
}

function History({
  q,
  status,
  onFilter,
  onOpen,
}: {
  q: string;
  status: string;
  onFilter: (p: { q?: string; status?: string }) => void;
  onOpen: (id: string) => void;
}) {
  const { adminFetch } = useAdmin();
  const [items, setItems] = useState<Send[] | null>(null);
  const [search, setSearch] = useState(q);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSearch(q), [q]);
  const load = useCallback(async () => {
    setItems(null);
    setError(null);
    const u = new URLSearchParams();
    if (q.trim()) u.set("q", q.trim());
    if (status) u.set("status", status);
    const r = await adminFetch<{ items: Send[] }>(`/api/admin/comms/sends?${u}`);
    if (!r.ok) return setError(errorText(r));
    setItems(r.data.items);
  }, [adminFetch, q, status]);
  useEffect(() => {
    load();
  }, [load]);
  const table = useClientTable(
    items,
    (s, k) => (k === "title" ? s.message.title : k === "status" ? STATUS_LABEL[s.status] : k === "recipients" ? recipientsOf(s) : s.confirmedAt ?? s.createdAt),
    { key: "when", dir: "desc" },
  );
  const filtered = !!(q || status);
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onFilter({ q: search.trim() });
        }}
      >
        <FilterBar active={filtered} onClear={() => onFilter({ q: "", status: "" })}>
          <Labeled label="Search" className="min-w-[12rem] flex-1">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title, message, sender or audience" className={field} />
          </Labeled>
          <Labeled label="Status">
            <select value={status} onChange={(e) => onFilter({ status: e.target.value })} className={`${field} w-auto`}>
              <option value="">Any status</option>
              {(Object.keys(STATUS_LABEL) as Send["status"][]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </Labeled>
          <button type="submit" className={btn.primary}>
            Search
          </button>
        </FilterBar>
      </form>
      <LoadState data={items} error={error} onRetry={load} empty={filtered ? "No sends match." : "Nothing sent yet."}>
        {(list) => (
          <>
            {list.length >= HISTORY_CAP && (
              <Notice kind="info">Showing the newest {fmtNumber(HISTORY_CAP)} sends that match. Search or filter by status to find older ones.</Notice>
            )}
            <TableWrap minWidth={640}>
              <thead className="border-b border-white/10 text-xs text-zinc-400">
                <tr>
                  <SortTh label="Message" k="title" sort={table.sort} onSort={table.onSort} />
                  <SortTh label="Status" k="status" sort={table.sort} onSort={table.onSort} />
                  <SortTh label="Recipients" k="recipients" sort={table.sort} onSort={table.onSort} className="text-right" />
                  <SortTh label="Sent (or drafted)" k="when" sort={table.sort} onSort={table.onSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {table.visible.map((s) => (
                  <tr key={s.id} className="hover:bg-white/[0.03]">
                    <td className="max-w-[22rem] px-3 py-2">
                      <button type="button" onClick={() => onOpen(s.id)} className="block max-w-full truncate text-left font-medium text-zinc-100 hover:text-cyan-200">
                        {s.message.title}
                      </button>
                      <span className="block truncate text-xs text-zinc-400">
                        {KIND_LABEL[s.kind]} · {s.audienceLabel} · {s.createdByEmail}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtNumber(recipientsOf(s))}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                      <Time ts={s.confirmedAt ?? s.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pager page={table.page} pageSize={table.pageSize} total={table.total} onPage={table.setPage} onPageSize={table.setPageSize} noun="send" />
          </>
        )}
      </LoadState>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  One send                                                                   */
/* -------------------------------------------------------------------------- */

type RecipientRow = { uid: string; name: string; email: string; ch: Partial<Record<Channel, { s: string; r?: string; t: number }>> };
type Failure = { uid: string; email: string; channel: Channel; reason: string; ts: number };
type Control = "pause" | "resume" | "cancel";

function SendDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<{ send: Send; reports: Record<string, number>; failures: Failure[]; channels: ChannelPreview } | null>(null);
  const [rows, setRows] = useState<{ chunk: number; chunks: number; items: RecipientRow[] } | null>(null);
  const [rowsErr, setRowsErr] = useState<string | null>(null);
  const [chunk, setChunk] = useState(0);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [webhook, setWebhook] = useState<boolean | null>(null);
  const [webhookErr, setWebhookErr] = useState<string | null>(null);
  const [asking, setAsking] = useState<Control | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ send: Send; reports: Record<string, number>; failures: Failure[]; channels: ChannelPreview }>(`/api/admin/comms/sends/${id}`);
    if (!r.ok) return setLoadErr(errorText(r));
    setLoadErr(null);
    setData(r.data);
  }, [adminFetch, id]);
  const loadRows = useCallback(async () => {
    const r = await adminFetch<{ chunk: number; chunks: number; items: RecipientRow[] }>(`/api/admin/comms/sends/${id}/recipients?chunk=${chunk}`);
    if (!r.ok) return setRowsErr(errorText(r));
    setRowsErr(null);
    setRows(r.data);
  }, [adminFetch, id, chunk]);
  const loadWebhook = useCallback(async () => {
    const r = await adminFetch<{ config: Config }>("/api/admin/comms/sends?status=none");
    if (!r.ok) return setWebhookErr(errorText(r));
    setWebhookErr(null);
    setWebhook(r.data.config.webhook);
  }, [adminFetch]);

  useEffect(() => {
    load();
    loadWebhook();
  }, [load, loadWebhook]);
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

  const control = async (action: Control) => {
    setError(null);
    setOk(null);
    const r = await adminFetch(`/api/admin/comms/sends/${id}/control`, { method: "POST", json: { action } });
    setAsking(null);
    if (!r.ok) setError(errorText(r));
    else setOk(action === "pause" ? "Paused. Nothing more goes out until you resume it." : action === "resume" ? "Resumed. Delivery carries on." : "Cancelled. Nobody else will get it.");
    await load();
  };

  const back = (
    <button type="button" onClick={onBack} className="text-sm text-cyan-300 hover:text-cyan-200">
      ← All sends
    </button>
  );
  if (!data)
    return (
      <div className="space-y-4">
        {back}
        <LoadState data={null} error={loadErr} onRetry={load}>
          {() => null}
        </LoadState>
      </div>
    );
  const s = data.send;
  const total = s.resolve.done ? s.chunks : Math.max(s.chunks, 1);
  const pct = s.status === "done" ? 100 : Math.round((s.nextChunk / Math.max(total, 1)) * (s.resolve.done ? 100 : 90));
  const active = (Object.keys(CH_LABEL) as Channel[]).filter((c) => s.channels[c]);
  const first = chunk * 100 + 1;
  return (
    <div className="space-y-4">
      {back}
      {loadErr && (
        <Notice kind="err" onRetry={load}>
          Could not refresh this send: {loadErr}
        </Notice>
      )}
      {error && (
        <Notice kind="err" onClose={() => setError(null)}>
          {error}
        </Notice>
      )}
      {ok && (
        <Notice kind="ok" onClose={() => setOk(null)}>
          {ok}
        </Notice>
      )}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-lg font-semibold text-white">{s.message.title}</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              {KIND_LABEL[s.kind]} · {SEVERITY_LABEL[s.message.severity] ?? s.message.severity} · {s.audienceLabel}
            </p>
            <p className="mt-0.5 text-xs text-zinc-400">
              Drafted by {s.createdByEmail} {fmtTime(s.createdAt)}
              {s.confirmedAt && <> · sent by {s.confirmedByEmail} {fmtTime(s.confirmedAt)}</>}
              {s.finishedAt && <> · finished {fmtTime(s.finishedAt)}</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
            {(s.status === "queued" || s.status === "sending") && (
              <button type="button" className={btn.warn} onClick={() => setAsking("pause")}>
                Pause
              </button>
            )}
            {s.status === "paused" && (
              <button type="button" className={btn.primary} onClick={() => setAsking("resume")}>
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
          {fmtNumber(s.counts.recipients)} recipients so far{s.resolve.done ? "" : " (still listing)"} · block {Math.min(s.nextChunk, s.chunks)} of {s.chunks}
          {s.status === "draft" && " · not confirmed"}
          {s.stoppedReason === "ended" && " · stopped at its end time"}
          {s.startsAt && s.startsAt > Date.now() && ` · starts ${fmtTime(s.startsAt)}`}
        </p>
        {s.lastError && <p className="mt-1 text-xs text-red-300">Last error: {s.lastError}</p>}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-left text-sm">
            <thead className="text-xs text-zinc-400">
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
                  <td className="py-1 tabular-nums text-emerald-300">{fmtNumber(s.counts.sent[c])}</td>
                  <td className="py-1 tabular-nums text-red-300">{fmtNumber(s.counts.failed[c])}</td>
                  <td className="py-1 tabular-nums text-zinc-400">{fmtNumber(s.counts.skipped[c])}</td>
                  <td className="py-1 tabular-nums text-zinc-400">{fmtNumber(s.counts.unknown[c])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {s.channels.email &&
          (webhook === false ? (
            <p className="mt-2 text-xs text-amber-300">
              Delivery reports are off (RESEND_WEBHOOK_SECRET is not set): only failures at send time are shown, not bounces or complaints.
            </p>
          ) : (
            <p className="mt-2 text-xs text-zinc-400">
              Email reports: {fmtNumber(data.reports.delivered ?? 0)} delivered · {fmtNumber(data.reports.bounced ?? 0)} bounced · {fmtNumber(data.reports.complained ?? 0)} complaints ·{" "}
              {fmtNumber(data.reports.delayed ?? 0)} delayed · {fmtNumber(data.reports.failed ?? 0)} failed
              {webhookErr && <span className="text-amber-300"> (could not check whether delivery reports are on: {webhookErr})</span>}
            </p>
          ))}
      </Panel>

      {data.failures.length > 0 && <Failures failures={data.failures} />}

      {rowsErr && (
        <Notice kind="err" onRetry={loadRows}>
          Could not read the recipients: {rowsErr}
        </Notice>
      )}
      {rows && rows.chunks > 0 && (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Recipients</h3>
            <nav aria-label="Recipient blocks" className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <button type="button" className={`${btn.ghost} px-2 py-1 text-xs`} disabled={chunk === 0} onClick={() => setChunk(chunk - 1)} aria-label="Previous 100 recipients">
                Previous
              </button>
              <span>
                {fmtNumber(first)}–{fmtNumber(first + rows.items.length - 1)} · block {chunk + 1} of {rows.chunks}
              </span>
              <button type="button" className={`${btn.ghost} px-2 py-1 text-xs`} disabled={chunk + 1 >= rows.chunks} onClick={() => setChunk(chunk + 1)} aria-label="Next 100 recipients">
                Next
              </button>
            </nav>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="text-xs text-zinc-400">
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
                      <span className="text-zinc-200">{r.name}</span> <span className="text-xs text-zinc-400">{r.email}</span>
                    </td>
                    {active.map((c) => {
                      const st = r.ch[c];
                      const tone = !st ? "zinc" : st.s === "sent" || st.s === "delivered" ? "green" : st.s === "failed" || st.s === "bounced" || st.s === "complained" ? "red" : st.s === "unknown" ? "amber" : "zinc";
                      return (
                        <td key={c} className="py-1" title={st?.r}>
                          <Badge tone={tone}>{st ? st.s : "waiting"}</Badge>
                          {st?.r && <span className="ml-1 text-[11px] text-zinc-400">{st.r}</span>}
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

      {asking === "pause" && (
        <Confirm
          title="Pause this send?"
          body="Nothing more goes out until you resume it. Those it already reached keep it."
          confirmLabel="Pause"
          onConfirm={() => control("pause")}
          onCancel={() => setAsking(null)}
        />
      )}
      {asking === "resume" && (
        <Confirm
          title="Resume this send?"
          body="Delivery carries on to everyone it has not reached yet."
          confirmLabel="Resume"
          onConfirm={() => control("resume")}
          onCancel={() => setAsking(null)}
        />
      )}
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

/** Failed deliveries (the server keeps the newest 200), a page at a time. */
function Failures({ failures }: { failures: Failure[] }) {
  const table = useClientTable(failures, (f, k) => (k === "who" ? f.email || f.uid : k === "channel" ? f.channel : f.ts), { key: "ts", dir: "desc" });
  return (
    <Panel>
      <h3 className="text-sm font-semibold text-white">Failed deliveries</h3>
      {failures.length >= 200 && <p className="mt-1 text-xs text-zinc-400">The newest 200 are listed.</p>}
      <ul className="mt-2 divide-y divide-white/5 text-sm">
        {table.visible.map((f, i) => (
          <li key={`${f.uid}-${f.channel}-${f.ts}-${i}`} className="flex flex-wrap gap-2 py-1.5">
            <span className="min-w-0 break-all text-zinc-200">{f.email || f.uid}</span>
            <Badge tone="red">{CH_LABEL[f.channel]}</Badge>
            <span className="text-xs text-zinc-400">{f.reason}</span>
            <span className="ml-auto text-xs text-zinc-400">{fmtTime(f.ts)}</span>
          </li>
        ))}
      </ul>
      <Pager page={table.page} pageSize={table.pageSize} total={table.total} onPage={table.setPage} noun="failure" />
    </Panel>
  );
}
