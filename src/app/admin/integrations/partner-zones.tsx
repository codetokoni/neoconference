"use client";

// Admin > Integrations > Partner zones: websites that embed one meeting per
// zone of their own (src/lib/partners). A secret key is shown once, right
// after it is made; afterwards only its masked form.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin, type ApiResult } from "../AdminApi";
import { Badge, Confirm, Dialog, Empty, Labeled, LoadState, Panel, btn, field } from "../ui";
import type { AuditEvent, PartnerIntegration, PartnerKeyMeta, ZoneMapping } from "@/lib/partners/store";

type Msg = { kind: "ok" | "err"; text: string } | null;
type ShowSecret = (s: { title: string; value: string; note: string }) => void;
type Row = PartnerIntegration & { activeKeys: number; zones: number };
type Detail = {
  integration: PartnerIntegration;
  keys: PartnerKeyMeta[];
  zones: ZoneMapping[];
  audit: AuditEvent[];
  orgAdmins: string[];
  leaders: Record<string, string[]>;
};

const PUBLIC_STAT_LABELS: Record<string, string> = {
  sessions: "Prayer sessions",
  uniqueParticipants: "Unique participants",
  connectedNow: "Connected now",
  totalPrayerSeconds: "Total prayer time",
  averagePrayerSeconds: "Average prayer time",
};

const KEY_NOTE =
  "Give it to the partner's developers over a safe channel. It goes in their server's environment, never in a web page: their backend sends it as \"Authorization: Bearer <key>\" to POST /api/partner/v1/join-sessions.";

function errText(r: ApiResult<unknown>): string | null {
  if (r.data.error === "cancelled") return null;
  return r.data.message ?? r.data.error ?? `HTTP ${r.status}`;
}

export default function PartnerZones({ setMsg, showSecret }: { setMsg: (m: Msg) => void; showSecret: ShowSecret }) {
  const { adminFetch } = useAdmin();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<{ integrations: Row[] }>("/api/admin/partners");
    if (r.ok) setRows(r.data.integrations);
    else setLoadErr(r.data.message ?? "Could not load.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <LoadState data={rows} error={loadErr} onRetry={load}>
      {(all) => (
        <div className="space-y-4">
          <CreatePartner
            onCreated={(name, secret, id) => {
              setMsg({ kind: "ok", text: `${name} added.` });
              showSecret({ title: `Secret key for ${name}`, value: secret, note: KEY_NOTE });
              setOpen(id);
              load();
            }}
            setMsg={setMsg}
          />
          <Panel>
            <h2 className="mb-3 text-base font-semibold text-white">Partners ({all.length})</h2>
            {!all.length ? (
              <Empty>No partner websites yet.</Empty>
            ) : (
              <ul className="divide-y divide-white/5">
                {all.map((p) => (
                  <li key={p.id} className="py-3" data-partner={p.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-zinc-100">{p.name}</span>
                      {p.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Disabled</Badge>}
                      <span className="font-mono text-[11px] text-zinc-400">{p.id}</span>
                      <span className="text-xs text-zinc-400">
                        {p.zones} zone{p.zones === 1 ? "" : "s"} · {p.activeKeys} active key{p.activeKeys === 1 ? "" : "s"} · owner {p.ownerEmail ?? p.ownerUserId}
                      </span>
                      <button type="button" className={`${btn.ghost} ml-auto`} aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
                        {open === p.id ? "Close" : "Manage"}
                      </button>
                    </div>
                    <p className="mt-1 break-all text-xs text-zinc-400">{p.origins.join("  ·  ") || "No approved website yet: nothing can embed it."}</p>
                    {open === p.id && (
                      <div className="mt-3">
                        <PartnerDetail id={p.id} setMsg={setMsg} showSecret={showSecret} onChanged={load} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </LoadState>
  );
}

function CreatePartner({ onCreated, setMsg }: { onCreated: (name: string, secret: string, id: string) => void; setMsg: (m: Msg) => void }) {
  const { adminFetch } = useAdmin();
  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [origins, setOrigins] = useState("");
  const [titleTemplate, setTitleTemplate] = useState("{zone} Meeting");
  const [autoCreateZones, setAuto] = useState(true);
  const [guestAccess, setGuests] = useState(false);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setMsg(null);
    setBusy(true);
    const r = await adminFetch<{ integration: PartnerIntegration; secret: string }>("/api/admin/partners", {
      method: "POST",
      json: { name, ownerEmail, origins, titleTemplate, autoCreateZones, guestAccess },
    });
    setBusy(false);
    if (!r.ok) {
      const t = errText(r);
      if (t) setMsg({ kind: "err", text: t });
      return;
    }
    setName("");
    setOwnerEmail("");
    setOrigins("");
    onCreated(r.data.integration.name, r.data.secret, r.data.integration.id);
  };
  return (
    <Panel>
      <h2 className="mb-1 text-base font-semibold text-white">Add a partner website</h2>
      <p className="mb-3 text-xs text-zinc-400">Each zone on the partner&apos;s site (like /zone/FALF) gets one permanent meeting, owned by the account below; its plan sets the limits.</p>
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Labeled label="Name">
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="PrayerClouds" />
        </Labeled>
        <Labeled label="Owner's email (an existing account)">
          <input className={field} type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="owner@example.com" />
        </Labeled>
        <Labeled label="Websites allowed to embed it, one per line" className="md:col-span-2">
          <textarea className={`${field} min-h-[72px] font-mono`} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://herald.prayerclouds.org" />
        </Labeled>
        <Labeled label="Meeting title ({zone} becomes the zone id)">
          <input className={field} value={titleTemplate} onChange={(e) => setTitleTemplate(e.target.value)} />
        </Labeled>
        <div className="flex flex-col justify-end gap-1 pb-1 text-sm text-zinc-200">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autoCreateZones} onChange={(e) => setAuto(e.target.checked)} /> Make a zone&apos;s meeting on its first visit
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={guestAccess} onChange={(e) => setGuests(e.target.checked)} /> Allow guests (name only, marked as guests)
          </label>
        </div>
        <div className="md:col-span-2">
          <button type="submit" className={btn.primary} disabled={busy || !name.trim() || !ownerEmail.trim()}>
            {busy ? "Adding…" : "Add partner"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

type Pending =
  | { kind: "status" }
  | { kind: "revoke"; key: PartnerKeyMeta }
  | { kind: "zone-status"; zone: ZoneMapping }
  | null;

function PartnerDetail({ id, setMsg, showSecret, onChanged }: { id: string; setMsg: (m: Msg) => void; showSecret: ShowSecret; onChanged: () => void }) {
  const { adminFetch } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [owner, setOwner] = useState<ZoneMapping | null>(null);
  const [leadersOf, setLeadersOf] = useState<ZoneMapping | null>(null);
  const [reportOf, setReportOf] = useState<ZoneMapping | null>(null);
  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<Detail>(`/api/admin/partners/${id}`);
    if (r.ok) setD(r.data);
    else setLoadErr(r.data.message ?? "Could not load.");
  }, [adminFetch, id]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (url: string, init: RequestInit & { json?: unknown }, ok: string): Promise<boolean> => {
    setMsg(null);
    const r = await adminFetch(url, init);
    if (!r.ok) {
      const t = errText(r);
      if (t) setMsg({ kind: "err", text: t });
      return false;
    }
    setMsg({ kind: "ok", text: ok });
    await load();
    onChanged();
    return true;
  };

  const newKey = async () => {
    setMsg(null);
    const r = await adminFetch<{ secret: string; key: PartnerKeyMeta }>(`/api/admin/partners/${id}/keys`, { method: "POST" });
    if (!r.ok) {
      const t = errText(r);
      if (t) setMsg({ kind: "err", text: t });
      return;
    }
    showSecret({
      title: `New secret key (${r.data.key.masked})`,
      value: r.data.secret,
      note: `${KEY_NOTE} The older keys keep working until you revoke them, so the partner can switch first.`,
    });
    await load();
    onChanged();
  };

  return (
    <LoadState data={d} error={loadErr} onRetry={load}>
      {(x) => (
        <div className="space-y-4 rounded-lg border border-white/10 bg-black/20 p-3">
          <Settings integration={x.integration} save={(patch) => run(`/api/admin/partners/${id}`, { method: "PATCH", json: patch }, "Saved.")} />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={x.integration.status === "active" ? btn.danger : btn.ghost} onClick={() => setPending({ kind: "status" })}>
              {x.integration.status === "active" ? "Disable partner" : "Enable partner"}
            </button>
            <span className="text-xs text-zinc-400">Disabled: no new codes, and pages already open cannot join.</span>
          </div>

          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white">Secret keys</h3>
              <button type="button" className={`${btn.ghost} ml-auto`} onClick={newKey}>
                New key
              </button>
            </div>
            {!x.keys.length ? (
              <Empty>No keys: the partner&apos;s server cannot ask for join codes.</Empty>
            ) : (
              <ul className="divide-y divide-white/5 text-xs">
                {x.keys.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center gap-2 py-1.5" data-partner-key={k.id}>
                    <span className="font-mono text-zinc-200">{k.masked}</span>
                    {k.revokedAt ? <Badge tone="red">revoked {fmtTime(k.revokedAt)}</Badge> : <Badge tone="green">active</Badge>}
                    <span className="text-zinc-400">
                      made {fmtTime(k.createdAt)}
                      {k.createdBy ? ` by ${k.createdBy}` : ""} · last used {k.lastUsedAt ? fmtTime(k.lastUsedAt) : "never"}
                    </span>
                    {!k.revokedAt && (
                      <button type="button" className={`${btn.danger} ml-auto`} onClick={() => setPending({ kind: "revoke", key: k })} aria-label={`Revoke ${k.masked}`}>
                        Revoke
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold text-white">Zones ({x.zones.length})</h3>
            {!x.zones.length ? (
              <Empty>No zones yet. {x.integration.autoCreateZones ? "One is made on its first visit." : "Connect one below."}</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead>
                    <tr className="text-zinc-400">
                      <th className="py-1.5 pr-3 font-medium">Zone</th>
                      <th className="px-3 py-1.5 font-medium">Meeting</th>
                      <th className="px-3 py-1.5 font-medium">Owner</th>
                      <th className="px-3 py-1.5 font-medium">Status</th>
                      <th className="py-1.5 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {x.zones.map((z) => (
                      <tr key={z.zoneId} className="border-t border-white/5" data-partner-zone={z.zoneId}>
                        <td className="py-1.5 pr-3 font-mono text-zinc-200">{z.zoneId}</td>
                        <td className="px-3 py-1.5 text-zinc-300">
                          {z.title} <span className="font-mono text-zinc-400">/{z.slug}</span> <span className="text-zinc-500">({z.source === "auto" ? "first visit" : "connected"})</span>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-zinc-400">{z.ownerUserId}</td>
                        <td className="px-3 py-1.5">{z.status === "active" ? <Badge tone="green">active</Badge> : <Badge tone="red">off</Badge>}</td>
                        <td className="py-1.5 text-right">
                          <span className="inline-flex gap-2">
                            <button type="button" className={btn.ghost} onClick={() => setReportOf(z)}>
                              Report
                            </button>
                            <button type="button" className={btn.ghost} onClick={() => setLeadersOf(z)} title="Who reads this zone's prayer reports">
                              Leaders ({(x.leaders[z.zoneId] ?? []).length})
                            </button>
                            <button type="button" className={btn.ghost} onClick={() => setOwner(z)}>
                              Owner
                            </button>
                            <button type="button" className={z.status === "active" ? btn.danger : btn.ghost} onClick={() => setPending({ kind: "zone-status", zone: z })}>
                              {z.status === "active" ? "Switch off" : "Switch on"}
                            </button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <ConnectZone
              connect={(zoneId, meeting) => run(`/api/admin/partners/${id}/zones`, { method: "POST", json: { zoneId, meeting } }, `Zone ${zoneId.toUpperCase()} connected.`)}
            />
          </section>

          <IdList
            title="Report administrators"
            hint="The partner's own user ids. They read every zone's prayer reports and the organisation report; a zone's leaders (Leaders, above) read only theirs. The partner's server can set both lists too."
            ids={x.orgAdmins}
            save={(ids) => run(`/api/admin/partners/${id}/roles`, { method: "PUT", json: { orgAdmins: ids } }, "Report administrators saved.")}
          />

          <section>
            <h3 className="mb-2 text-sm font-semibold text-white">History</h3>
            {!x.audit.length ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
                {x.audit.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="text-zinc-400">
                    <span className="text-zinc-500">{fmtTime(a.at)}</span> <span className="font-mono text-zinc-200">{a.action}</span>
                    {a.actor ? ` · ${a.actor}` : ""}
                    {a.detail ? <span className="break-all"> · {JSON.stringify(a.detail).slice(0, 200)}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {pending?.kind === "status" && (
            <Confirm
              title={x.integration.status === "active" ? `Disable ${x.integration.name}?` : `Enable ${x.integration.name}?`}
              body={
                x.integration.status === "active"
                  ? "Its website stops being able to start meetings, and pages already open cannot join. Meetings and zones are kept."
                  : "Its website can start its zone meetings again."
              }
              confirmLabel={x.integration.status === "active" ? "Disable" : "Enable"}
              danger={x.integration.status === "active"}
              onConfirm={async () => {
                await run(`/api/admin/partners/${id}`, { method: "PATCH", json: { status: x.integration.status === "active" ? "disabled" : "active" } }, x.integration.status === "active" ? "Disabled." : "Enabled.");
                setPending(null);
              }}
              onCancel={() => setPending(null)}
            />
          )}
          {pending?.kind === "revoke" && (
            <Confirm
              title={`Revoke ${pending.key.masked}?`}
              body="The partner's server can no longer ask for join codes with it. Make and hand over a new key first if they are switching."
              confirmLabel="Revoke"
              danger
              typeToConfirm="revoke"
              onConfirm={async () => {
                await run(`/api/admin/partners/${id}/keys/${pending.key.id}`, { method: "DELETE" }, `${pending.key.masked} revoked.`);
                setPending(null);
              }}
              onCancel={() => setPending(null)}
            />
          )}
          {pending?.kind === "zone-status" && (
            <Confirm
              title={pending.zone.status === "active" ? `Switch off zone ${pending.zone.zoneId}?` : `Switch on zone ${pending.zone.zoneId}?`}
              body={
                pending.zone.status === "active"
                  ? "Visitors on that zone's page can no longer join. People already in the meeting stay until they leave."
                  : "Visitors on that zone's page can join its meeting again."
              }
              confirmLabel={pending.zone.status === "active" ? "Switch off" : "Switch on"}
              danger={pending.zone.status === "active"}
              onConfirm={async () => {
                const z = pending.zone;
                await run(
                  `/api/admin/partners/${id}/zones/${encodeURIComponent(z.zoneId)}`,
                  { method: "PATCH", json: { status: z.status === "active" ? "disabled" : "active" } },
                  `Zone ${z.zoneId} switched ${z.status === "active" ? "off" : "on"}.`,
                );
                setPending(null);
              }}
              onCancel={() => setPending(null)}
            />
          )}
          {leadersOf && (
            <Dialog title={`Leaders of zone ${leadersOf.zoneId}`} onClose={() => setLeadersOf(null)}>
              <IdList
                title="Leaders"
                hint="The partner's own user ids. They read this zone's prayer reports and its participant table."
                ids={x.leaders[leadersOf.zoneId] ?? []}
                save={async (ids) => {
                  const done = await run(`/api/admin/partners/${id}/zones/${encodeURIComponent(leadersOf.zoneId)}`, { method: "PATCH", json: { leaders: ids } }, `Leaders of ${leadersOf.zoneId} saved.`);
                  if (done) setLeadersOf(null);
                  return done;
                }}
              />
            </Dialog>
          )}
          {reportOf && <ZoneReport partnerId={id} zone={reportOf} onClose={() => setReportOf(null)} />}
          {owner && (
            <ZoneOwner
              zone={owner}
              onClose={() => setOwner(null)}
              save={async (email) => {
                const done = await run(`/api/admin/partners/${id}/zones/${encodeURIComponent(owner.zoneId)}`, { method: "PATCH", json: { ownerEmail: email } }, `Zone ${owner.zoneId} now belongs to ${email}.`);
                if (done) setOwner(null);
              }}
            />
          )}
        </div>
      )}
    </LoadState>
  );
}

function Settings({ integration, save }: { integration: PartnerIntegration; save: (patch: Record<string, unknown>) => Promise<boolean> }) {
  const [name, setName] = useState(integration.name);
  const [ownerEmail, setOwnerEmail] = useState(integration.ownerEmail ?? "");
  const [origins, setOrigins] = useState(integration.origins.join("\n"));
  const [titleTemplate, setTitleTemplate] = useState(integration.titleTemplate);
  const [autoCreateZones, setAuto] = useState(integration.autoCreateZones);
  const [guestAccess, setGuests] = useState(integration.guestAccess);
  const [timezone, setTimezone] = useState(integration.timezone ?? "UTC");
  const [publicStats, setPublicStats] = useState<string[]>(integration.publicStats ?? []);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const patch: Record<string, unknown> = {};
    if (name !== integration.name) patch.name = name;
    if (ownerEmail.trim().toLowerCase() !== (integration.ownerEmail ?? "")) patch.ownerEmail = ownerEmail;
    if (origins.split(/\s+/).filter(Boolean).join("\n") !== integration.origins.join("\n")) patch.origins = origins;
    if (titleTemplate !== integration.titleTemplate) patch.titleTemplate = titleTemplate;
    if (autoCreateZones !== integration.autoCreateZones) patch.autoCreateZones = autoCreateZones;
    if (guestAccess !== integration.guestAccess) patch.guestAccess = guestAccess;
    if (timezone.trim() !== (integration.timezone ?? "UTC")) patch.timezone = timezone.trim();
    if ([...publicStats].sort().join() !== [...(integration.publicStats ?? [])].sort().join()) patch.publicStats = publicStats;
    if (!Object.keys(patch).length) return;
    setBusy(true);
    await save(patch);
    setBusy(false);
  };
  return (
    <form
      className="grid gap-3 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Labeled label="Name">
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
      </Labeled>
      <Labeled label="Owner of new zone meetings (email)">
        <input className={field} type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
      </Labeled>
      <Labeled label="Websites allowed to embed it, one per line" className="md:col-span-2">
        <textarea className={`${field} min-h-[72px] font-mono`} value={origins} onChange={(e) => setOrigins(e.target.value)} />
      </Labeled>
      <Labeled label="Meeting title for new zones">
        <input className={field} value={titleTemplate} onChange={(e) => setTitleTemplate(e.target.value)} />
      </Labeled>
      <div className="flex flex-col justify-end gap-1 pb-1 text-sm text-zinc-200">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={autoCreateZones} onChange={(e) => setAuto(e.target.checked)} /> Make a zone&apos;s meeting on its first visit
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={guestAccess} onChange={(e) => setGuests(e.target.checked)} /> Allow guests
        </label>
      </div>
      <Labeled label="Report timezone (today, this week, this month)">
        <input className={`${field} font-mono`} value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC, Africa/Lagos, Europe/London" />
      </Labeled>
      <fieldset className="text-sm text-zinc-200">
        <legend className="text-xs text-zinc-400">Figures a zone&apos;s public page may show (never names)</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {Object.entries(PUBLIC_STAT_LABELS).map(([k, label]) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" checked={publicStats.includes(k)} onChange={(e) => setPublicStats(e.target.checked ? [...publicStats, k] : publicStats.filter((x) => x !== k))} /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-zinc-400 md:col-span-2">
        Each zone is one permanent meeting: it reopens for the next visit after it ends. A new owner applies to zones made from now on; give an existing zone to someone with its Owner button.
      </p>
      <div className="md:col-span-2">
        <button type="submit" className={btn.primary} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

function ConnectZone({ connect }: { connect: (zoneId: string, meeting: string) => Promise<boolean> }) {
  const [zoneId, setZoneId] = useState("");
  const [meeting, setMeeting] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-3 grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const done = await connect(zoneId.trim(), meeting.trim());
        setBusy(false);
        if (done) {
          setZoneId("");
          setMeeting("");
        }
      }}
    >
      <Labeled label="Zone id">
        <input className={`${field} font-mono`} value={zoneId} onChange={(e) => setZoneId(e.target.value)} placeholder="FALF" />
      </Labeled>
      <Labeled label="Existing meeting (address or link)">
        <input className={field} value={meeting} onChange={(e) => setMeeting(e.target.value)} placeholder="falf-prayer" />
      </Labeled>
      <button type="submit" className={btn.ghost} disabled={busy || !zoneId.trim() || !meeting.trim()}>
        {busy ? "Connecting…" : "Connect zone"}
      </button>
    </form>
  );
}

function ZoneOwner({ zone, onClose, save }: { zone: ZoneMapping; onClose: () => void; save: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={`Owner of zone ${zone.zoneId}`} onClose={onClose}>
      <p className="mt-1 text-sm text-zinc-300">The meeting /{zone.slug} moves to this account: its plan then sets the meeting&apos;s limits, and it can host.</p>
      <form
        className="mt-3 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await save(email);
          setBusy(false);
        }}
      >
        <Labeled label="Email of an existing account">
          <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus />
        </Labeled>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btn.primary} disabled={busy || !email.trim()}>
            {busy ? "Saving…" : "Give it to them"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A list of the partner's user ids, one per line, saved whole. */
function IdList({ title, hint, ids, save }: { title: string; hint: string; ids: string[]; save: (ids: string[]) => Promise<boolean> }) {
  const [text, setText] = useState(ids.join("\n"));
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(ids.join("\n")), [ids]);
  const list = text.split(/[\s,]+/).filter(Boolean);
  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold text-white">
        {title} ({ids.length})
      </h3>
      <p className="mb-2 text-xs text-zinc-400">{hint}</p>
      <form
        className="flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await save(list);
          setBusy(false);
        }}
      >
        <textarea className={`${field} min-h-[64px] font-mono`} value={text} onChange={(e) => setText(e.target.value)} placeholder="One user id per line" />
        <div>
          <button type="submit" className={btn.ghost} disabled={busy || list.join() === ids.join()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}

type ZoneReportData = {
  zone: { zoneId: string; name: string };
  period: { from: string; to: string; timezone: string; label: string };
  summary: { sessions: number; uniqueParticipants: number; connectedNow: number; totalPrayerSeconds: number; averagePrayerSeconds: number };
  sessions: { id: string; startedAt: number; endedAt: number | null; durationSeconds: number; participants: number; prayerSeconds: number }[];
  participants: { userId: string; guest: boolean; name: string; firstJoined: number | null; lastLeft: number | null; sessionsAttended: number; prayerSeconds: number; connected: boolean }[];
  totalParticipants: number;
  generatedAt: string;
};

function hms(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** The zone's prayer report as its leaders see it, for checking a partner's numbers. */
function ZoneReport({ partnerId, zone, onClose }: { partnerId: string; zone: ZoneMapping; onClose: () => void }) {
  const { adminFetch } = useAdmin();
  const [period, setPeriod] = useState("today");
  const [data, setData] = useState<ZoneReportData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    setData(null);
    const r = await adminFetch<ZoneReportData>(`/api/admin/partners/${partnerId}/zones/${encodeURIComponent(zone.zoneId)}/report?period=${period}`);
    if (r.ok) setData(r.data);
    else setErr(r.data.message ?? "Could not load.");
  }, [adminFetch, partnerId, zone.zoneId, period]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Dialog title={`Prayer report: ${zone.title}`} onClose={onClose} wide>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {["current", "today", "week", "month"].map((p) => (
          <button key={p} type="button" className={p === period ? btn.primary : btn.ghost} aria-pressed={p === period} onClick={() => setPeriod(p)}>
            {p === "current" ? "Current session" : p === "today" ? "Today" : p === "week" ? "This week" : "This month"}
          </button>
        ))}
      </div>
      <LoadState data={data} error={err} onRetry={load}>
        {(r) => (
          <div className="mt-3 space-y-3 text-xs text-zinc-300">
            <p className="text-zinc-400">
              {r.period.label} · {r.period.timezone} · updated {fmtTime(r.generatedAt)}
            </p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ["Sessions", String(r.summary.sessions)],
                ["Unique participants", String(r.summary.uniqueParticipants)],
                ["Connected now", String(r.summary.connectedNow)],
                ["Total prayer time", hms(r.summary.totalPrayerSeconds)],
                ["Average per participant", hms(r.summary.averagePrayerSeconds)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-white/10 p-2">
                  <dt className="text-zinc-400">{k}</dt>
                  <dd className="mt-0.5 font-mono text-sm text-zinc-100">{v}</dd>
                </div>
              ))}
            </dl>
            {r.sessions.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left">
                  <thead>
                    <tr className="text-zinc-400">
                      <th className="py-1 pr-3 font-medium">Session started</th>
                      <th className="px-3 py-1 font-medium">Ended</th>
                      <th className="px-3 py-1 font-medium">Session duration</th>
                      <th className="px-3 py-1 font-medium">Participants</th>
                      <th className="py-1 font-medium">Prayer time (all)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.sessions.map((s) => (
                      <tr key={s.id} className="border-t border-white/5">
                        <td className="py-1 pr-3">{fmtTime(s.startedAt)}</td>
                        <td className="px-3 py-1">{s.endedAt ? fmtTime(s.endedAt) : "running"}</td>
                        <td className="px-3 py-1 font-mono">{hms(s.durationSeconds)}</td>
                        <td className="px-3 py-1">{s.participants}</td>
                        <td className="py-1 font-mono">{hms(s.prayerSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {r.participants.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-left">
                  <thead>
                    <tr className="text-zinc-400">
                      <th className="py-1 pr-3 font-medium">Participant</th>
                      <th className="px-3 py-1 font-medium">First joined</th>
                      <th className="px-3 py-1 font-medium">Last left</th>
                      <th className="px-3 py-1 font-medium">Sessions</th>
                      <th className="py-1 font-medium">Prayer time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.participants.map((p) => (
                      <tr key={`${p.guest}:${p.userId}`} className="border-t border-white/5">
                        <td className="py-1 pr-3">
                          {p.name} <span className="font-mono text-zinc-500">{p.userId}</span>
                        </td>
                        <td className="px-3 py-1">{p.firstJoined ? fmtTime(p.firstJoined) : "—"}</td>
                        <td className="px-3 py-1">{p.connected ? <Badge tone="green">connected</Badge> : p.lastLeft ? fmtTime(p.lastLeft) : "—"}</td>
                        <td className="px-3 py-1">{p.sessionsAttended}</td>
                        <td className="py-1 font-mono">{hms(p.prayerSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r.totalParticipants > r.participants.length && <p className="mt-1 text-zinc-400">First {r.participants.length} of {r.totalParticipants}.</p>}
              </div>
            ) : (
              <Empty>Nobody prayed in this period.</Empty>
            )}
          </div>
        )}
      </LoadState>
    </Dialog>
  );
}
