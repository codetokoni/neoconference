"use client";

// Platform settings: branding and contacts, the site-wide notice, regional
// settings and the registration rules. Each section saves on its own and is
// live within seconds.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { adminClock, fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";
import {
  DATE_STYLES,
  dateTimeFormat,
  noticeActive,
  type Contacts,
  type PlatformSettings,
} from "@/lib/platform/model";

type Tab = "branding" | "notice" | "regional" | "registration";
const TABS: { id: Tab; label: string }[] = [
  { id: "branding", label: "Branding & contacts" },
  { id: "notice", label: "Notice banner" },
  { id: "regional", label: "Regional" },
  { id: "registration", label: "Registration" },
];

type Msg = { kind: "ok" | "err"; text: string } | null;

/** ms -> the value a datetime-local input wants, in the browser's zone. */
function toLocalInput(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : null;
}
const lines = (v: string) => v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

export default function SettingsClient() {
  const { adminFetch } = useAdmin();
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [tab, setTab] = useState<Tab>("branding");
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<{ settings: PlatformSettings }>("/api/admin/settings");
    if (r.ok) setSettings(r.data.settings);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load the settings." });
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (section: Tab | "contacts", value: unknown, done = "Saved. Live within a few seconds.") => {
      const r = await adminFetch<{ settings: PlatformSettings }>("/api/admin/settings", { method: "PATCH", json: { section, value } });
      if (r.ok) {
        setSettings(r.data.settings);
        setMsg({ kind: "ok", text: done });
        return true;
      }
      setMsg({ kind: "err", text: r.data.message ?? "Not saved." });
      return false;
    },
    [adminFetch],
  );

  return (
    <div>
      <PageHeader title="Platform settings" sub="Name, logo, contacts, the site-wide notice, regional formats and who may sign up. Changes are live within seconds, with no redeploy." />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <div role="tablist" aria-label="Settings sections" className="mb-4 flex flex-wrap gap-1 border-b border-white/10">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.id ? "border-cyan-400 text-cyan-100" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {!settings ? (
        <Loading />
      ) : tab === "branding" ? (
        <BrandingTab settings={settings} save={save} setSettings={setSettings} setMsg={setMsg} />
      ) : tab === "notice" ? (
        <NoticeTab settings={settings} save={save} />
      ) : tab === "regional" ? (
        <RegionalTab settings={settings} save={save} />
      ) : (
        <RegistrationTab settings={settings} save={save} setMsg={setMsg} />
      )}
    </div>
  );
}

type SaveFn = (section: Tab | "contacts", value: unknown, done?: string) => Promise<boolean>;

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm text-zinc-300">
      {label}
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </label>
  );
}

/* --------------------------------- branding -------------------------------- */

function BrandingTab({
  settings,
  save,
  setSettings,
  setMsg,
}: {
  settings: PlatformSettings;
  save: SaveFn;
  setSettings: (s: PlatformSettings) => void;
  setMsg: (m: Msg) => void;
}) {
  const { adminFetch } = useAdmin();
  const [name, setName] = useState(settings.branding.platformName);
  const [contacts, setContacts] = useState<Contacts>(settings.contacts);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 512 * 1024) return setMsg({ kind: "err", text: `That image is ${Math.ceil(file.size / 1024)} KB; the logo can be at most 512 KB.` });
    setUploading(true);
    const form = new FormData();
    form.append("logo", file);
    const r = await adminFetch<{ settings: PlatformSettings }>("/api/admin/settings/logo", { method: "POST", body: form });
    setUploading(false);
    if (r.ok) {
      setSettings(r.data.settings);
      setMsg({ kind: "ok", text: "Logo uploaded. The header shows it within a few seconds." });
    } else setMsg({ kind: "err", text: r.data.message ?? "Upload failed." });
  };
  const removeLogo = async () => {
    const r = await adminFetch<{ settings: PlatformSettings }>("/api/admin/settings/logo", { method: "DELETE" });
    if (r.ok) {
      setSettings(r.data.settings);
      setMsg({ kind: "ok", text: "Logo removed; the built-in mark is back." });
    } else setMsg({ kind: "err", text: r.data.message ?? "Not removed." });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel>
        <h2 className="mb-3 text-base font-semibold text-white">Branding</h2>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save("branding", { platformName: name });
          }}
        >
          <Field label="Platform name" hint="Shown in the header, the footer, the support page and as the sender name of emails.">
            <input className={field} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button type="submit" className={btn.primary}>
            Save name
          </button>
        </form>
        <div className="mt-5 border-t border-white/10 pt-4">
          <p className="text-sm text-zinc-300">Logo</p>
          <div className="mt-2 flex items-center gap-3">
            {settings.branding.logoKey ? (
              // eslint-disable-next-line @next/next/no-img-element -- our own redirecting route
              <img src={`/api/platform/logo?v=${settings.branding.logoVersion}`} alt="Current logo" className="h-12 w-12 rounded-lg border border-white/10 object-contain" />
            ) : (
              <span className="text-xs text-zinc-500">The built-in mark is used.</span>
            )}
            <label className={`${btn.ghost} cursor-pointer`}>
              {uploading ? "Uploading…" : "Upload image"}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={uploading} onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            {settings.branding.logoKey && (
              <button type="button" className={btn.ghost} onClick={removeLogo}>
                Remove
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">PNG, JPEG or WebP, at most 512 KB. Square images look best.</p>
        </div>
      </Panel>

      <Panel>
        <h2 className="mb-3 text-base font-semibold text-white">Support contacts</h2>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save("contacts", contacts);
          }}
        >
          <Field label="Support email" hint="On the support page and the footer, and the reply-to address of emails.">
            <input className={field} type="email" value={contacts.supportEmail} onChange={(e) => setContacts({ ...contacts, supportEmail: e.target.value })} />
          </Field>
          <Field label="Support phone">
            <input className={field} value={contacts.supportPhone} onChange={(e) => setContacts({ ...contacts, supportPhone: e.target.value })} placeholder="+234 …" />
          </Field>
          <div>
            <p className="text-sm text-zinc-300">Links (help centre, status page, terms…)</p>
            {contacts.links.map((l, i) => (
              <div key={i} className="mt-2 flex gap-2">
                <input aria-label="Link label" className={`${field} w-1/3`} value={l.label} placeholder="Label" onChange={(e) => setContacts({ ...contacts, links: contacts.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <input aria-label="Link address" className={field} value={l.url} placeholder="https://" onChange={(e) => setContacts({ ...contacts, links: contacts.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                <button type="button" aria-label="Remove link" className={btn.ghost} onClick={() => setContacts({ ...contacts, links: contacts.links.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            {contacts.links.length < 8 && (
              <button type="button" className={`${btn.ghost} mt-2`} onClick={() => setContacts({ ...contacts, links: [...contacts.links, { label: "", url: "" }] })}>
                Add link
              </button>
            )}
          </div>
          <button type="submit" className={btn.primary}>
            Save contacts
          </button>
        </form>
      </Panel>
    </div>
  );
}

/* ---------------------------------- notice --------------------------------- */

function NoticeTab({ settings, save }: { settings: PlatformSettings; save: SaveFn }) {
  const n = settings.notice;
  const [form, setForm] = useState({
    enabled: n.enabled,
    level: n.level,
    message: n.message,
    linkUrl: n.linkUrl,
    linkLabel: n.linkLabel,
    startsAt: toLocalInput(n.startsAt),
    endsAt: toLocalInput(n.endsAt),
    dismissible: n.dismissible,
  });
  const live = noticeActive(n);
  const tone = { info: "border-cyan-400/30 bg-cyan-500/15 text-cyan-50", warning: "border-amber-400/40 bg-amber-500/20 text-amber-50", critical: "border-red-500/50 bg-red-600/30 text-red-50" }[form.level];
  return (
    <Panel>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-base font-semibold text-white">Site-wide notice</h2>
        {live ? <Badge tone="green">Showing now</Badge> : n.enabled ? <Badge tone="amber">Scheduled / ended</Badge> : <Badge>Off</Badge>}
      </div>
      <p className="mb-4 text-sm text-zinc-400">A banner at the top of every page. Editing it shows it again to people who dismissed the old one.</p>
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save("notice", { ...form, startsAt: fromLocalInput(form.startsAt), endsAt: fromLocalInput(form.endsAt) });
        }}
      >
        <label className="flex items-center gap-2 text-sm text-zinc-200 md:col-span-2">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Show the notice
        </label>
        <Field label="Level">
          <select className={field} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as typeof form.level, dismissible: e.target.value === "critical" ? false : form.dismissible })}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-zinc-200">
          <input type="checkbox" checked={form.dismissible} onChange={(e) => setForm({ ...form, dismissible: e.target.checked })} /> People can dismiss it
        </label>
        <div className="md:col-span-2">
          <Field label="Message">
            <textarea className={field} rows={2} maxLength={500} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          </Field>
        </div>
        <Field label="Link (optional)">
          <input className={field} value={form.linkUrl} placeholder="https://" onChange={(e) => setForm({ ...form, linkUrl: e.target.value })} />
        </Field>
        <Field label="Link text">
          <input className={field} value={form.linkLabel} placeholder="Learn more" onChange={(e) => setForm({ ...form, linkLabel: e.target.value })} />
        </Field>
        <Field label="Starts (your time)" hint="Empty = now.">
          <input className={field} type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
        </Field>
        <Field label="Ends (your time)" hint="Empty = until turned off.">
          <input className={field} type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
        </Field>
        {form.message && (
          <div className="md:col-span-2">
            <p className="mb-1 text-xs text-zinc-500">Preview</p>
            <div className={`rounded-lg border px-3 py-2 text-sm ${tone}`}>
              {form.message} {form.linkUrl && <u>{form.linkLabel || "Learn more"}</u>} {form.dismissible && <span className="float-right opacity-70">✕</span>}
            </div>
          </div>
        )}
        <div className="md:col-span-2">
          <button type="submit" className={btn.primary}>
            Save notice
          </button>
        </div>
      </form>
    </Panel>
  );
}

/* --------------------------------- regional -------------------------------- */

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

function RegionalTab({ settings, save }: { settings: PlatformSettings; save: SaveFn }) {
  const [r, setR] = useState(settings.regional);
  const allZones = useMemo(zones, []);
  const sample = useMemo(() => {
    try {
      const tz = r.adminTimezone === "local" ? undefined : r.adminTimezone;
      const { locale, options } = dateTimeFormat(r.dateStyle, tz);
      return `${new Intl.DateTimeFormat(locale, options).format(new Date())} · ${new Intl.NumberFormat(r.numberLocale).format(1234567.89)}`;
    } catch {
      return "—";
    }
  }, [r]);
  return (
    <Panel>
      <h2 className="mb-3 text-base font-semibold text-white">Regional</h2>
      <datalist id="tz-list">
        {allZones.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save("regional", r, "Saved. Reload the admin area to see timestamps on the new clock.");
        }}
      >
        <Field label="Default language" hint="The pages' language (code like en, fr, pt-BR).">
          <input className={field} value={r.defaultLanguage} onChange={(e) => setR({ ...r, defaultLanguage: e.target.value })} />
        </Field>
        <Field label="Default time zone" hint="Used when a group meeting or call is created without a zone.">
          <input className={field} list="tz-list" value={r.defaultTimezone} onChange={(e) => setR({ ...r, defaultTimezone: e.target.value })} />
        </Field>
        <Field label="Date format (admin area)">
          <select className={field} value={r.dateStyle} onChange={(e) => setR({ ...r, dateStyle: e.target.value as typeof r.dateStyle })}>
            {DATE_STYLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Number format" hint="A locale, e.g. en-US (1,234.5) or de-DE (1.234,5).">
          <input className={field} value={r.numberLocale} onChange={(e) => setR({ ...r, numberLocale: e.target.value })} />
        </Field>
        <Field label="Admin time zone" hint={'Every timestamp in the admin area is shown in this zone, with the zone named. "local" = each administrator\'s own.'}>
          <input className={field} list="tz-list" value={r.adminTimezone} onChange={(e) => setR({ ...r, adminTimezone: e.target.value })} />
        </Field>
        <div className="self-end pb-2 text-sm text-zinc-400">
          Preview: <span className="text-zinc-200">{sample}</span>
        </div>
        <p className="text-xs text-zinc-500 md:col-span-2">
          The admin area currently shows times in {adminClock().timeZone === "local" ? "each administrator's local zone" : adminClock().timeZone}, e.g. {fmtTime(Date.now())}.
        </p>
        <div className="md:col-span-2">
          <button type="submit" className={btn.primary}>
            Save regional settings
          </button>
        </div>
      </form>
    </Panel>
  );
}

/* ------------------------------- registration ------------------------------ */

type ClerkView = {
  allowlist: { id: string; identifier: string }[];
  blocklist: { id: string; identifier: string }[];
  pushedByApp: string[];
  dashboardOnly: string[];
};

function RegistrationTab({ settings, save, setMsg }: { settings: PlatformSettings; save: SaveFn; setMsg: (m: Msg) => void }) {
  const { adminFetch } = useAdmin();
  const reg = settings.registration;
  const [form, setForm] = useState({
    mode: reg.mode,
    requireVerifiedEmail: reg.requireVerifiedEmail,
    allowDomains: reg.allowDomains.map((d) => d.value).join("\n"),
    blockDomains: reg.blockDomains.map((d) => d.value).join("\n"),
    invited: reg.invited.map((d) => d.value).join("\n"),
    trialsEnabled: reg.trials.enabled,
    trialDays: String(reg.trials.defaultDays),
  });
  const [clerk, setClerk] = useState<ClerkView | null>(null);
  const [clerkErr, setClerkErr] = useState<string | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);

  const loadClerk = useCallback(async () => {
    const r = await adminFetch<ClerkView>("/api/admin/registration/clerk");
    if (r.ok) setClerk(r.data);
    else setClerkErr(r.data.message ?? "Could not read Clerk.");
  }, [adminFetch]);
  useEffect(() => {
    loadClerk();
  }, [loadClerk]);

  const push = async () => {
    setConfirmPush(false);
    const r = await adminFetch<ClerkView & { added: string[]; removed: string[] }>("/api/admin/registration/clerk", { method: "POST" });
    if (r.ok) {
      setClerk(r.data);
      setMsg({ kind: "ok", text: `Clerk's blocklist updated: ${r.data.added.length} added, ${r.data.removed.length} removed.` });
    } else setMsg({ kind: "err", text: r.data.message ?? "Clerk was not updated." });
  };

  const since = (label: string, at: number | null) => (at ? <span className="text-xs text-zinc-500"> — {label} since {fmtTime(at)}</span> : null);

  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <Panel>
        <h2 className="mb-1 text-base font-semibold text-white">Who can sign up</h2>
        <p className="mb-4 text-sm text-zinc-400">
          These rules apply to accounts created after each rule is switched on; existing accounts are never locked out by them. The owner and administrators always pass. A refused new account sees why, with your support contacts.
        </p>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const days = Number(form.trialDays);
            save("registration", {
              mode: form.mode,
              requireVerifiedEmail: form.requireVerifiedEmail,
              allowDomains: lines(form.allowDomains),
              blockDomains: lines(form.blockDomains),
              invited: lines(form.invited),
              trials: { enabled: form.trialsEnabled, defaultDays: Number.isFinite(days) ? days : -1 },
            });
          }}
        >
          <fieldset>
            <legend className="text-sm text-zinc-300">
              Sign-up {since("this mode", reg.modeSince)}
            </legend>
            {(
              [
                ["open", "Open — anyone can sign up"],
                ["invite_only", "Invite-only — only the addresses listed below"],
                ["closed", "Closed — no new accounts"],
              ] as const
            ).map(([v, l]) => (
              <label key={v} className="mt-1 flex items-center gap-2 text-sm text-zinc-200">
                <input type="radio" name="mode" checked={form.mode === v} onChange={() => setForm({ ...form, mode: v })} /> {l}
              </label>
            ))}
          </fieldset>
          {form.mode === "invite_only" && (
            <Field label="Invited addresses (one per line)">
              <textarea className={`${field} font-mono`} rows={4} value={form.invited} onChange={(e) => setForm({ ...form, invited: e.target.value })} />
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" checked={form.requireVerifiedEmail} onChange={(e) => setForm({ ...form, requireVerifiedEmail: e.target.checked })} /> New accounts need a verified email address
            {since("on", reg.verifySince)}
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Allowed email domains" hint="One per line. If any are listed, only these domains (and their subdomains) can sign up.">
              <textarea className={`${field} font-mono`} rows={4} value={form.allowDomains} onChange={(e) => setForm({ ...form, allowDomains: e.target.value })} placeholder="example.org" />
            </Field>
            <Field label="Blocked email domains" hint="One per line. New accounts from these are refused.">
              <textarea className={`${field} font-mono`} rows={4} value={form.blockDomains} onChange={(e) => setForm({ ...form, blockDomains: e.target.value })} placeholder="spam.example" />
            </Field>
          </div>
          <div className="rounded-lg border border-white/10 p-3">
            <p className="text-sm text-zinc-300">Free trials</p>
            <label className="mt-2 flex items-center gap-2 text-sm text-zinc-200">
              <input type="checkbox" checked={form.trialsEnabled} onChange={(e) => setForm({ ...form, trialsEnabled: e.target.checked })} /> New subscriptions may start with a trial
            </label>
            <label className="mt-2 flex items-center gap-2 text-sm text-zinc-300">
              Default length
              <input className={`${field} w-20`} inputMode="numeric" value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} /> days
            </label>
            <p className="mt-1 text-xs text-zinc-500">Used by Plans when a plan does not set its own trial length.</p>
          </div>
          <button type="submit" className={btn.primary}>
            Save registration rules
          </button>
        </form>
      </Panel>

      <Panel>
        <h2 className="mb-1 text-base font-semibold text-white">In Clerk</h2>
        <p className="mb-3 text-sm text-zinc-400">
          The app enforces every rule on its own. Clerk can also refuse blocked domains before an account is made.
        </p>
        {clerkErr && <p className="text-sm text-red-300">{clerkErr}</p>}
        {clerk && (
          <>
            <p className="text-xs uppercase tracking-wide text-zinc-500">Clerk blocklist ({clerk.blocklist.length})</p>
            <ul className="mt-1 max-h-40 overflow-auto font-mono text-xs text-zinc-300">
              {clerk.blocklist.map((b) => (
                <li key={b.id}>
                  {b.identifier} {clerk.pushedByApp.some((d) => b.identifier === `*@${d}`) && <Badge tone="cyan">from here</Badge>}
                </li>
              ))}
              {!clerk.blocklist.length && <li className="text-zinc-500">empty</li>}
            </ul>
            <p className="mt-3 text-xs uppercase tracking-wide text-zinc-500">Clerk allowlist ({clerk.allowlist.length})</p>
            <ul className="mt-1 max-h-24 overflow-auto font-mono text-xs text-zinc-300">
              {clerk.allowlist.map((b) => (
                <li key={b.id}>{b.identifier}</li>
              ))}
              {!clerk.allowlist.length && <li className="text-zinc-500">empty</li>}
            </ul>
            <button type="button" className={`${btn.warn} mt-3`} onClick={() => setConfirmPush(true)}>
              Send blocked domains to Clerk
            </button>
            <p className="mt-4 text-xs font-medium text-zinc-400">Only in the Clerk dashboard:</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-zinc-500">
              {clerk.dashboardOnly.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </>
        )}
      </Panel>
      {confirmPush && (
        <Confirm
          title="Update Clerk's blocklist?"
          body="Each blocked domain is added to Clerk's blocklist as *@domain, and domains you have unblocked here are taken off it. Entries made in the Clerk dashboard are left alone. Refused if a domain would catch the owner or an administrator."
          confirmLabel="Update Clerk"
          onConfirm={push}
          onCancel={() => setConfirmPush(false)}
        />
      )}
    </div>
  );
}
