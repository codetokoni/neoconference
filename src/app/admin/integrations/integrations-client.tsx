"use client";

// Integrations, platform webhooks and developer API keys. No secret value
// ever reaches this page except a new one, once, right after it is made.

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import {
  Badge,
  Confirm,
  Dialog,
  Empty,
  FilterBar,
  LoadState,
  Labeled,
  Notice,
  PageHeader,
  Pager,
  Panel,
  SortTh,
  TabPanel,
  Tabs,
  btn,
  field,
  useClientTable,
} from "../ui";
import type { IntegrationStatus } from "@/lib/platform/integrations";
import type { Delivery, PublicEndpoint } from "@/lib/platform/webhooks";

type Msg = { kind: "ok" | "err"; text: string } | null;
type Tab = "integrations" | "webhooks" | "keys";
const TABS: { id: Tab; label: string }[] = [
  { id: "integrations", label: "Services" },
  { id: "webhooks", label: "Webhooks" },
  { id: "keys", label: "API keys" },
];

export default function IntegrationsClient() {
  const [tab, setTab] = useState<Tab>("integrations");
  const [msg, setMsg] = useState<Msg>(null);
  const [secret, setSecret] = useState<{ title: string; value: string; note: string } | null>(null);
  return (
    <div>
      <PageHeader title="Integrations" sub="What this deployment is connected to, the platform's own webhooks, and every developer API key." />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <Tabs
        label="Integrations sections"
        tabs={TABS}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setMsg(null);
        }}
        idBase="integrations"
      />
      <TabPanel idBase="integrations" value={tab}>
        {tab === "integrations" ? <Services /> : tab === "webhooks" ? <Webhooks setMsg={setMsg} showSecret={setSecret} /> : <Keys setMsg={setMsg} showSecret={setSecret} />}
      </TabPanel>
      {secret && <SecretOnce {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function SecretOnce({ title, value, note, onClose }: { title: string; value: string; note: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    // Escape does not close it: the secret is gone once it does, so only "I have stored it" closes it.
    <Dialog title={title} onClose={() => undefined}>
      <p className="mt-1 text-sm text-amber-200">Shown this once. Copy it now — it cannot be shown again.</p>
      <code data-secret-once className="mt-3 block break-all rounded-lg bg-black/50 p-3 font-mono text-sm text-cyan-100">
        {value}
      </code>
      <p className="mt-2 text-xs text-zinc-400">{note}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={btn.ghost}
          data-autofocus
          onClick={() => {
            navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className={btn.primary} onClick={onClose}>
          I have stored it
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied to the clipboard." : ""}
      </p>
    </Dialog>
  );
}

/* --------------------------------- services -------------------------------- */

type ServicesData = { integrations: IntegrationStatus[]; rotation: { steps: string[]; docs: string }; environment: string };

function Services() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<ServicesData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setErr(null);
    const r = await adminFetch<ServicesData>("/api/admin/integrations");
    if (r.ok) setData(r.data);
    else setErr(r.data.message ?? "Could not load.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);
  const tone = { configured: "green", partial: "amber", not_configured: "zinc" } as const;
  const label = { configured: "Configured", partial: "Partly configured", not_configured: "Not configured" };
  return (
    <LoadState data={data} error={err} onRetry={load}>
      {(d) => (
        <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <Panel className="min-w-0">
            <p className="mb-3 text-xs text-zinc-400">
              From this deployment&apos;s environment ({d.environment}). Each value is shown only as a fingerprint — the first 8 characters of its SHA-256 — which changes when the secret is rotated and reveals nothing about it.
            </p>
            <ul className="divide-y divide-white/5">
              {d.integrations.map((i) => (
                <li key={i.id} className="py-3" data-integration={i.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-zinc-100">{i.name}</span>
                    <Badge tone={tone[i.state]}>{label[i.state]}</Badge>
                    <span className="text-xs text-zinc-400">{i.purpose}</span>
                  </div>
                  {i.implicit && <p className="mt-1 text-xs text-zinc-400">{i.implicit}</p>}
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {i.vars.map((v) => (
                      <span key={v.name} className="break-all font-mono text-[11px]">
                        <span className={v.set ? "text-zinc-300" : "text-zinc-400"}>{v.name}</span>{" "}
                        {v.set ? <span className="text-emerald-300">fp:{v.fingerprint}</span> : <span className="text-zinc-400">{v.required ? "missing" : "not set"}</span>}
                      </span>
                    ))}
                  </div>
                  <p className="mt-1 break-words text-[11px] text-zinc-400">Keys are made at: {i.console}</p>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel className="min-w-0">
            <h2 className="text-base font-semibold text-white">Rotating a provider secret</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Secrets such as LiveKit&apos;s or Clerk&apos;s live in Vercel environment variables. They cannot be changed from here: rotate them at the provider, then in Vercel.
            </p>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-zinc-300">
              {d.rotation.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <a className="mt-3 inline-block text-sm text-cyan-300 underline" href={d.rotation.docs} target="_blank" rel="noopener noreferrer">
              Vercel: managing environment variables
            </a>
          </Panel>
        </div>
      )}
    </LoadState>
  );
}

/* --------------------------------- webhooks -------------------------------- */

type WebhookData = { events: { key: string; label: string }[]; endpoints: PublicEndpoint[]; deliveries: Delivery[] };

function Webhooks({ setMsg, showSecret }: { setMsg: (m: Msg) => void; showSecret: (s: { title: string; value: string; note: string }) => void }) {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<WebhookData | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["webhook.test"]);
  const [rotate, setRotate] = useState<PublicEndpoint | null>(null);
  const [grace, setGrace] = useState("24");
  const [remove, setRemove] = useState<PublicEndpoint | null>(null);
  const [pause, setPause] = useState<PublicEndpoint | null>(null);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<WebhookData>("/api/admin/webhooks");
    if (r.ok) setData(r.data);
    else setLoadErr(r.data.message ?? "Could not load.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const deliveries = useClientTable(data?.deliveries, (d, k) => (k === "ts" ? d.ts : k === "event" ? d.event : k === "url" ? d.url : d.ok ? 1 : 0), { key: "ts", dir: "desc" });

  const fail = (r: { data: { error?: string; message?: string } }) => r.data.error !== "cancelled" && setMsg({ kind: "err", text: r.data.message ?? "Not done." });

  const create = async () => {
    setMsg(null);
    setCreating(true);
    const r = await adminFetch<{ secret: string }>("/api/admin/webhooks", { method: "POST", json: { url, description, events } });
    setCreating(false);
    if (!r.ok) return fail(r);
    setUrl("");
    setDescription("");
    setMsg({ kind: "ok", text: "Endpoint added." });
    showSecret({ title: "Signing secret", value: r.data.secret, note: "Verify each delivery's x-neo-signature header with it: HMAC-SHA256 of \"<t>.<body>\"." });
    load();
  };
  const doRotate = async () => {
    if (!rotate) return;
    setMsg(null);
    const r = await adminFetch<{ secret: string; graceHours: number }>(`/api/admin/webhooks/${rotate.id}/rotate`, { method: "POST", json: { graceHours: Number(grace) } });
    if (!r.ok) return fail(r);
    showSecret({
      title: "New signing secret",
      value: r.data.secret,
      note: r.data.graceHours > 0 ? `The old secret also signs every delivery for ${r.data.graceHours} more hours, then stops.` : "The old secret has stopped signing.",
    });
    load();
  };
  const test = async (e: PublicEndpoint) => {
    setMsg(null);
    setTesting(e.id);
    const r = await adminFetch<{ delivery?: Delivery }>(`/api/admin/webhooks/${e.id}/test`, { method: "POST" });
    setTesting(null);
    if (!r.ok) return fail(r);
    const d = r.data.delivery;
    setMsg(d?.ok ? { kind: "ok", text: `Test delivered (HTTP ${d.status}, ${d.durationMs} ms).` } : { kind: "err", text: `Test failed: ${d?.error ?? `HTTP ${d?.status}`}` });
    load();
  };
  const toggle = async (e: PublicEndpoint) => {
    setMsg(null);
    const r = await adminFetch(`/api/admin/webhooks/${e.id}`, { method: "PATCH", json: { enabled: !e.enabled } });
    if (!r.ok) return fail(r);
    setMsg({ kind: "ok", text: e.enabled ? `${e.url} is paused.` : `${e.url} is receiving events again.` });
    load();
  };
  const doRemove = async () => {
    if (!remove) return;
    setMsg(null);
    const r = await adminFetch(`/api/admin/webhooks/${remove.id}`, { method: "DELETE" });
    if (!r.ok) return fail(r);
    setMsg({ kind: "ok", text: `${remove.url} deleted.` });
    load();
  };

  return (
    <LoadState data={data} error={loadErr} onRetry={load}>
      {(d) => (
        <div className="space-y-4">
          <Panel>
            <h2 className="mb-3 text-base font-semibold text-white">Add an endpoint</h2>
            <form
              className="grid gap-3 md:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <Labeled label="Endpoint address">
                <input className={field} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/neo" />
              </Labeled>
              <Labeled label="Description">
                <input className={field} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What receives it (optional)" />
              </Labeled>
              <fieldset className="md:col-span-2">
                <legend className="text-sm text-zinc-300">Events</legend>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {d.events.map((ev) => (
                    <label key={ev.key} className="flex items-center gap-1.5 text-sm text-zinc-200" title={ev.label}>
                      <input type="checkbox" checked={events.includes(ev.key)} onChange={(e) => setEvents(e.target.checked ? [...events, ev.key] : events.filter((x) => x !== ev.key))} />
                      <span className="font-mono text-xs">{ev.key}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="md:col-span-2">
                <button type="submit" className={btn.primary} disabled={creating || !url.trim() || !events.length}>
                  {creating ? "Adding…" : "Add endpoint"}
                </button>
                {!events.length && <span className="ml-2 text-xs text-zinc-400">Pick at least one event.</span>}
              </div>
            </form>
          </Panel>

          <Panel>
            <h2 className="mb-3 text-base font-semibold text-white">Endpoints ({d.endpoints.length})</h2>
            {!d.endpoints.length ? (
              <Empty>No webhook endpoints yet.</Empty>
            ) : (
              <ul className="divide-y divide-white/5">
                {d.endpoints.map((e) => (
                  <li key={e.id} className="py-3" data-webhook={e.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-sm text-zinc-100">{e.url}</span>
                      {e.enabled ? <Badge tone="green">Enabled</Badge> : <Badge>Paused</Badge>}
                    </div>
                    {e.description && <p className="text-xs text-zinc-400">{e.description}</p>}
                    <p className="mt-1 break-words text-xs text-zinc-400">Events: {e.events.join(", ")}</p>
                    <p className="mt-1 text-xs text-zinc-400">
                      Secrets:{" "}
                      {e.secrets.map((s) => (
                        <span key={s.fingerprint} className="mr-3 inline-block font-mono">
                          fp:{s.fingerprint} {s.current ? "(current)" : `(old, signs until ${fmtTime(s.expiresAt)})`}
                        </span>
                      ))}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className={btn.ghost} disabled={testing === e.id} onClick={() => test(e)} aria-label={`Send a test to ${e.url}`}>
                        {testing === e.id ? "Sending…" : "Send test"}
                      </button>
                      <button type="button" className={btn.ghost} onClick={() => setRotate(e)} aria-label={`Rotate the secret of ${e.url}`}>
                        Rotate secret
                      </button>
                      <button type="button" className={btn.ghost} onClick={() => setPause(e)} aria-label={`${e.enabled ? "Pause" : "Enable"} ${e.url}`}>
                        {e.enabled ? "Pause" : "Enable"}
                      </button>
                      <button type="button" className={btn.danger} onClick={() => setRemove(e)} aria-label={`Delete ${e.url}`}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <h2 className="mb-3 text-base font-semibold text-white">Recent deliveries</h2>
            {!d.deliveries.length ? (
              <Empty>Nothing sent yet.</Empty>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead>
                      <tr className="text-xs text-zinc-400">
                        <SortTh label="When" k="ts" sort={deliveries.sort} onSort={deliveries.onSort} className="pl-0" />
                        <SortTh label="Event" k="event" sort={deliveries.sort} onSort={deliveries.onSort} />
                        <SortTh label="Endpoint" k="url" sort={deliveries.sort} onSort={deliveries.onSort} />
                        <SortTh label="Result" k="ok" sort={deliveries.sort} onSort={deliveries.onSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.visible.map((x) => (
                        <tr key={x.id} className="border-t border-white/5">
                          <td className="py-1.5 pr-3 text-zinc-400">{fmtTime(x.ts)}</td>
                          <td className="px-3 py-1.5 font-mono text-xs text-zinc-300">{x.event}</td>
                          <td className="break-all px-3 py-1.5 font-mono text-xs text-zinc-400">{x.url}</td>
                          <td className="px-3 py-1.5">
                            {x.ok ? <Badge tone="green">{x.status}</Badge> : <Badge tone="red">{x.status ?? "failed"}</Badge>} <span className="text-xs text-zinc-400">{x.error ?? `${x.durationMs} ms`}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={deliveries.page} pageSize={deliveries.pageSize} total={deliveries.total} onPage={deliveries.setPage} onPageSize={deliveries.setPageSize} noun="record" />
                <p className="mt-1 text-xs text-zinc-400">The most recent deliveries the platform kept; older ones are not listed.</p>
              </>
            )}
          </Panel>

          {rotate && (
            <Confirm
              title="Rotate the signing secret?"
              body={
                <div>
                  <p className="break-all">{rotate.url}</p>
                  <p className="mt-2">A new secret is made and shown once. The current one keeps signing deliveries for the grace period, so the receiver can switch without missing any.</p>
                  <label className="mt-3 block text-sm text-zinc-300">
                    Grace period (hours, 0–168)
                    <input className={`${field} mt-1 w-24`} value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" />
                  </label>
                </div>
              }
              confirmLabel="Rotate"
              onConfirm={async () => {
                await doRotate();
                setRotate(null);
              }}
              onCancel={() => setRotate(null)}
            />
          )}
          {pause && (
            <Confirm
              title={pause.enabled ? "Pause this endpoint?" : "Enable this endpoint?"}
              body={
                <>
                  <span className="block break-all">{pause.url}</span>
                  <span className="mt-2 block">
                    {pause.enabled ? "No events are sent to it until it is enabled again. Events that happen meanwhile are not sent later." : "It receives its events again from now on."}
                  </span>
                </>
              }
              confirmLabel={pause.enabled ? "Pause" : "Enable"}
              onConfirm={async () => {
                await toggle(pause);
                setPause(null);
              }}
              onCancel={() => setPause(null)}
            />
          )}
          {remove && (
            <Confirm
              title="Delete this endpoint?"
              body={<span className="break-all">{remove.url} stops receiving events and its signing secrets are discarded. This cannot be undone.</span>}
              confirmLabel="Delete"
              danger
              typeToConfirm="delete"
              onConfirm={async () => {
                await doRemove();
                setRemove(null);
              }}
              onCancel={() => setRemove(null)}
            />
          )}
        </div>
      )}
    </LoadState>
  );
}

/* ---------------------------------- API keys -------------------------------- */

type KeyRow = {
  id: string;
  name: string;
  maskedKey: string;
  plan: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
  revokedAt: number | null;
  rotatedFrom: string | null;
  ownerUserId: string | null;
  ownerEmail: string | null;
};

function Keys({ setMsg, showSecret }: { setMsg: (m: Msg) => void; showSecret: (s: { title: string; value: string; note: string }) => void }) {
  const { adminFetch } = useAdmin();
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [q, setQ] = useState("");
  const [act, setAct] = useState<{ key: KeyRow; kind: "revoke" | "rotate" } | null>(null);
  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<{ keys: KeyRow[] }>("/api/admin/api-keys");
    if (r.ok) setKeys(r.data.keys);
    else setLoadErr(r.data.message ?? "Could not load.");
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);
  const go = async () => {
    if (!act) return;
    const { key, kind } = act;
    setMsg(null);
    const r =
      kind === "revoke"
        ? await adminFetch(`/api/admin/api-keys/${key.id}`, { method: "DELETE" })
        : await adminFetch<{ secret: string }>(`/api/admin/api-keys/${key.id}/rotate`, { method: "POST" });
    if (!r.ok) {
      if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? "Not done." });
      return;
    }
    if (kind === "rotate") {
      setMsg({ kind: "ok", text: `${key.maskedKey} rotated; the old key stopped working.` });
      showSecret({
        title: `New API key for ${key.ownerEmail ?? key.ownerUserId}`,
        value: (r.data as { secret: string }).secret,
        note: "The old key stopped working. Give this one to the account's owner over a safe channel; they see it (masked) in their developer dashboard.",
      });
    } else setMsg({ kind: "ok", text: `${key.maskedKey} revoked.` });
    load();
  };
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (keys ?? []).filter(
      (k) => (showRevoked || !k.revoked) && (!needle || [k.maskedKey, k.name, k.ownerEmail, k.ownerUserId, k.plan].some((v) => (v ?? "").toLowerCase().includes(needle))),
    );
  }, [keys, q, showRevoked]);
  const t = useClientTable(
    shown,
    (k, key) => (key === "key" ? k.name || k.maskedKey : key === "account" ? k.ownerEmail ?? k.ownerUserId : key === "created" ? k.createdAt : k.lastUsedAt),
    { key: "created", dir: "desc" },
  );
  return (
    <LoadState data={keys} error={loadErr} onRetry={load}>
      {(all) => (
        <Panel>
          <h2 className="mb-3 text-base font-semibold text-white">Developer API keys ({all.filter((k) => !k.revoked).length} active)</h2>
          <FilterBar
            active={!!q || showRevoked}
            onClear={() => {
              setQ("");
              setShowRevoked(false);
            }}
          >
            <Labeled label="Search" className="w-full sm:w-72">
              <input
                className={field}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  t.setPage(1);
                }}
                placeholder="Key, name, account or plan"
              />
            </Labeled>
            <label className="flex items-center gap-1.5 pb-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={showRevoked}
                onChange={(e) => {
                  setShowRevoked(e.target.checked);
                  t.setPage(1);
                }}
              />{" "}
              Show revoked
            </label>
          </FilterBar>
          {!t.total ? (
            <Empty>{all.length ? "No API key matches." : "No API keys."}</Empty>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead>
                    <tr className="text-xs text-zinc-400">
                      <SortTh label="Key" k="key" sort={t.sort} onSort={t.onSort} className="pl-0" />
                      <SortTh label="Account" k="account" sort={t.sort} onSort={t.onSort} />
                      <SortTh label="Created" k="created" sort={t.sort} onSort={t.onSort} />
                      <SortTh label="Last used" k="lastUsed" sort={t.sort} onSort={t.onSort} />
                      <th className="py-1.5 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.visible.map((k) => (
                      <tr key={k.id} className="border-t border-white/5" data-api-key={k.id}>
                        <td className="py-1.5 pr-3">
                          <span className="font-mono text-xs text-zinc-200">{k.maskedKey}</span> <span className="text-xs text-zinc-400">{k.name}</span> {k.revoked && <Badge tone="red">revoked</Badge>}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-zinc-300">
                          {k.ownerEmail ?? k.ownerUserId ?? "—"} <Badge>{k.plan}</Badge>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-zinc-400">{fmtTime(k.createdAt)}</td>
                        <td className="px-3 py-1.5 text-xs text-zinc-400">{k.lastUsedAt ? fmtTime(k.lastUsedAt) : "never"}</td>
                        <td className="py-1.5 text-right">
                          {k.revoked ? (
                            <span className="text-xs text-zinc-400">{k.revokedAt ? `revoked ${fmtTime(k.revokedAt)}` : ""}</span>
                          ) : (
                            <span className="inline-flex gap-2">
                              <button type="button" className={btn.ghost} onClick={() => setAct({ key: k, kind: "rotate" })} aria-label={`Rotate ${k.maskedKey}`}>
                                Rotate
                              </button>
                              <button type="button" className={btn.danger} onClick={() => setAct({ key: k, kind: "revoke" })} aria-label={`Revoke ${k.maskedKey}`}>
                                Revoke
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={t.page} pageSize={t.pageSize} total={t.total} onPage={t.setPage} onPageSize={t.setPageSize} noun="key" />
            </>
          )}
          {act && (
            <Confirm
              title={act.kind === "revoke" ? `Revoke ${act.key.maskedKey}?` : `Rotate ${act.key.maskedKey}?`}
              body={
                act.kind === "revoke"
                  ? "Every API call with this key fails from now on. The account can make a new key."
                  : "This key stops working now and a new one is made for the same account, shown to you once to pass on."
              }
              confirmLabel={act.kind === "revoke" ? "Revoke" : "Rotate"}
              danger
              typeToConfirm={act.kind === "revoke" ? "revoke" : undefined}
              onConfirm={async () => {
                await go();
                setAct(null);
              }}
              onCancel={() => setAct(null)}
            />
          )}
        </Panel>
      )}
    </LoadState>
  );
}
