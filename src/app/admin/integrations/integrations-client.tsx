"use client";

// Integrations, platform webhooks and developer API keys. No secret value
// ever reaches this page except a new one, once, right after it is made.

import { useCallback, useEffect, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";
import type { IntegrationStatus } from "@/lib/platform/integrations";
import type { Delivery, PublicEndpoint } from "@/lib/platform/webhooks";

type Msg = { kind: "ok" | "err"; text: string } | null;
type Tab = "integrations" | "webhooks" | "keys";

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
      <div role="tablist" className="mb-4 flex gap-1 border-b border-white/10">
        {(
          [
            ["integrations", "Services"],
            ["webhooks", "Webhooks"],
            ["keys", "API keys"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? "border-cyan-400 text-cyan-100" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "integrations" ? <Services /> : tab === "webhooks" ? <Webhooks setMsg={setMsg} showSecret={setSecret} /> : <Keys setMsg={setMsg} showSecret={setSecret} />}
      {secret && <SecretOnce {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function SecretOnce({ title, value, note, onClose }: { title: string; value: string; note: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="secret-title" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0B1220] p-5">
        <h2 id="secret-title" className="text-base font-semibold text-white">
          {title}
        </h2>
        <p className="mt-1 text-sm text-amber-200">Shown this once. Copy it now — it cannot be shown again.</p>
        <code data-secret-once className="mt-3 block break-all rounded-lg bg-black/50 p-3 font-mono text-sm text-cyan-100">
          {value}
        </code>
        <p className="mt-2 text-xs text-zinc-400">{note}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className={btn.ghost}
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
      </div>
    </div>
  );
}

/* --------------------------------- services -------------------------------- */

function Services() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<{ integrations: IntegrationStatus[]; rotation: { steps: string[]; docs: string }; environment: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    adminFetch<NonNullable<typeof data>>("/api/admin/integrations").then((r) => (r.ok ? setData(r.data) : setErr(r.data.message ?? "Could not load.")));
  }, [adminFetch]);
  if (err) return <Notice kind="err">{err}</Notice>;
  if (!data) return <Loading />;
  const tone = { configured: "green", partial: "amber", not_configured: "zinc" } as const;
  const label = { configured: "Configured", partial: "Partly configured", not_configured: "Not configured" };
  return (
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Panel>
        <p className="mb-3 text-xs text-zinc-500">
          From this deployment&apos;s environment ({data.environment}). Each value is shown only as a fingerprint — the first 8 characters of its SHA-256 — which changes when the secret is rotated and reveals nothing about it.
        </p>
        <ul className="divide-y divide-white/5">
          {data.integrations.map((i) => (
            <li key={i.id} className="py-3" data-integration={i.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-zinc-100">{i.name}</span>
                <Badge tone={tone[i.state]}>{label[i.state]}</Badge>
                <span className="text-xs text-zinc-500">{i.purpose}</span>
              </div>
              {i.implicit && <p className="mt-1 text-xs text-zinc-500">{i.implicit}</p>}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {i.vars.map((v) => (
                  <span key={v.name} className="font-mono text-[11px]">
                    <span className={v.set ? "text-zinc-300" : "text-zinc-600"}>{v.name}</span>{" "}
                    {v.set ? <span className="text-emerald-300">fp:{v.fingerprint}</span> : <span className="text-zinc-600">{v.required ? "missing" : "not set"}</span>}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">Keys are made at: {i.console}</p>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel>
        <h2 className="text-base font-semibold text-white">Rotating a provider secret</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Secrets such as LiveKit&apos;s or Clerk&apos;s live in Vercel environment variables. They cannot be changed from here: rotate them at the provider, then in Vercel.
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-zinc-300">
          {data.rotation.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <a className="mt-3 inline-block text-sm text-cyan-300 underline" href={data.rotation.docs} target="_blank" rel="noopener noreferrer">
          Vercel: managing environment variables
        </a>
      </Panel>
    </div>
  );
}

/* --------------------------------- webhooks -------------------------------- */

type WebhookData = { events: { key: string; label: string }[]; endpoints: PublicEndpoint[]; deliveries: Delivery[] };

function Webhooks({ setMsg, showSecret }: { setMsg: (m: Msg) => void; showSecret: (s: { title: string; value: string; note: string }) => void }) {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<WebhookData | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>(["webhook.test"]);
  const [rotate, setRotate] = useState<PublicEndpoint | null>(null);
  const [grace, setGrace] = useState("24");
  const [remove, setRemove] = useState<PublicEndpoint | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<WebhookData>("/api/admin/webhooks");
    if (r.ok) setData(r.data);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load." });
  }, [adminFetch, setMsg]);
  useEffect(() => {
    load();
  }, [load]);

  const fail = (r: { data: { error?: string; message?: string } }) => r.data.error !== "cancelled" && setMsg({ kind: "err", text: r.data.message ?? "Not done." });

  const create = async () => {
    const r = await adminFetch<{ secret: string }>("/api/admin/webhooks", { method: "POST", json: { url, description, events } });
    if (!r.ok) return fail(r);
    setUrl("");
    setDescription("");
    showSecret({ title: "Signing secret", value: r.data.secret, note: "Verify each delivery's x-neo-signature header with it: HMAC-SHA256 of \"<t>.<body>\"." });
    load();
  };
  const doRotate = async () => {
    if (!rotate) return;
    const r = await adminFetch<{ secret: string; graceHours: number }>(`/api/admin/webhooks/${rotate.id}/rotate`, { method: "POST", json: { graceHours: Number(grace) } });
    setRotate(null);
    if (!r.ok) return fail(r);
    showSecret({
      title: "New signing secret",
      value: r.data.secret,
      note: r.data.graceHours > 0 ? `The old secret also signs every delivery for ${r.data.graceHours} more hours, then stops.` : "The old secret has stopped signing.",
    });
    load();
  };
  const test = async (e: PublicEndpoint) => {
    const r = await adminFetch<{ delivery?: Delivery }>(`/api/admin/webhooks/${e.id}/test`, { method: "POST" });
    if (!r.ok) return fail(r);
    const d = r.data.delivery;
    setMsg(d?.ok ? { kind: "ok", text: `Test delivered (HTTP ${d.status}, ${d.durationMs} ms).` } : { kind: "err", text: `Test failed: ${d?.error ?? `HTTP ${d?.status}`}` });
    load();
  };
  const toggle = async (e: PublicEndpoint) => {
    const r = await adminFetch(`/api/admin/webhooks/${e.id}`, { method: "PATCH", json: { enabled: !e.enabled } });
    if (!r.ok) return fail(r);
    load();
  };
  const doRemove = async () => {
    if (!remove) return;
    const r = await adminFetch(`/api/admin/webhooks/${remove.id}`, { method: "DELETE" });
    setRemove(null);
    if (!r.ok) return fail(r);
    load();
  };

  if (!data) return <Loading />;
  return (
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
          <input className={field} aria-label="Endpoint address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/neo" />
          <input className={field} aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What receives it (optional)" />
          <fieldset className="md:col-span-2">
            <legend className="text-sm text-zinc-300">Events</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {data.events.map((ev) => (
                <label key={ev.key} className="flex items-center gap-1.5 text-sm text-zinc-200">
                  <input type="checkbox" checked={events.includes(ev.key)} onChange={(e) => setEvents(e.target.checked ? [...events, ev.key] : events.filter((x) => x !== ev.key))} />
                  <span className="font-mono text-xs">{ev.key}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <button type="submit" className={btn.primary} disabled={!url.trim() || !events.length}>
              Add endpoint
            </button>
          </div>
        </form>
      </Panel>

      <Panel>
        <h2 className="mb-3 text-base font-semibold text-white">Endpoints</h2>
        {!data.endpoints.length ? (
          <Empty>No webhook endpoints yet.</Empty>
        ) : (
          <ul className="divide-y divide-white/5">
            {data.endpoints.map((e) => (
              <li key={e.id} className="py-3" data-webhook={e.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-sm text-zinc-100">{e.url}</span>
                  {e.enabled ? <Badge tone="green">Enabled</Badge> : <Badge>Paused</Badge>}
                </div>
                {e.description && <p className="text-xs text-zinc-400">{e.description}</p>}
                <p className="mt-1 text-xs text-zinc-500">Events: {e.events.join(", ")}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  Secrets:{" "}
                  {e.secrets.map((s) => (
                    <span key={s.fingerprint} className="mr-3 font-mono">
                      fp:{s.fingerprint} {s.current ? "(current)" : `(old, signs until ${fmtTime(s.expiresAt)})`}
                    </span>
                  ))}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={btn.ghost} onClick={() => test(e)}>
                    Send test
                  </button>
                  <button type="button" className={btn.ghost} onClick={() => setRotate(e)}>
                    Rotate secret
                  </button>
                  <button type="button" className={btn.ghost} onClick={() => toggle(e)}>
                    {e.enabled ? "Pause" : "Enable"}
                  </button>
                  <button type="button" className={btn.danger} onClick={() => setRemove(e)}>
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
        {!data.deliveries.length ? (
          <Empty>Nothing sent yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1.5 pr-3 font-medium">When</th>
                  <th className="py-1.5 pr-3 font-medium">Event</th>
                  <th className="py-1.5 pr-3 font-medium">Endpoint</th>
                  <th className="py-1.5 pr-3 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d) => (
                  <tr key={d.id} className="border-t border-white/5">
                    <td className="py-1.5 pr-3 text-zinc-400">{fmtTime(d.ts)}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs text-zinc-300">{d.event}</td>
                    <td className="py-1.5 pr-3 break-all font-mono text-xs text-zinc-400">{d.url}</td>
                    <td className="py-1.5 pr-3">
                      {d.ok ? <Badge tone="green">{d.status}</Badge> : <Badge tone="red">{d.status ?? "failed"}</Badge>} <span className="text-xs text-zinc-500">{d.error ?? `${d.durationMs} ms`}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {rotate && (
        <Confirm
          title="Rotate the signing secret?"
          body={
            <div>
              <p>A new secret is made and shown once. The current one keeps signing deliveries for the grace period, so the receiver can switch without missing any.</p>
              <label className="mt-3 block text-sm text-zinc-300">
                Grace period (hours, 0–168)
                <input className={`${field} mt-1 w-24`} value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" />
              </label>
            </div>
          }
          confirmLabel="Rotate"
          onConfirm={doRotate}
          onCancel={() => setRotate(null)}
        />
      )}
      {remove && <Confirm title="Delete this endpoint?" body={remove.url} confirmLabel="Delete" danger onConfirm={doRemove} onCancel={() => setRemove(null)} />}
    </div>
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
  const [showRevoked, setShowRevoked] = useState(false);
  const [act, setAct] = useState<{ key: KeyRow; kind: "revoke" | "rotate" } | null>(null);
  const load = useCallback(async () => {
    const r = await adminFetch<{ keys: KeyRow[] }>("/api/admin/api-keys");
    if (r.ok) setKeys(r.data.keys);
    else setMsg({ kind: "err", text: r.data.message ?? "Could not load." });
  }, [adminFetch, setMsg]);
  useEffect(() => {
    load();
  }, [load]);
  const go = async () => {
    if (!act) return;
    const { key, kind } = act;
    setAct(null);
    const r =
      kind === "revoke"
        ? await adminFetch(`/api/admin/api-keys/${key.id}`, { method: "DELETE" })
        : await adminFetch<{ secret: string }>(`/api/admin/api-keys/${key.id}/rotate`, { method: "POST" });
    if (!r.ok) {
      if (r.data.error !== "cancelled") setMsg({ kind: "err", text: r.data.message ?? "Not done." });
      return;
    }
    if (kind === "rotate") {
      showSecret({
        title: `New API key for ${key.ownerEmail ?? key.ownerUserId}`,
        value: (r.data as { secret: string }).secret,
        note: "The old key stopped working. Give this one to the account's owner over a safe channel; they see it (masked) in their developer dashboard.",
      });
    } else setMsg({ kind: "ok", text: `${key.maskedKey} revoked.` });
    load();
  };
  if (!keys) return <Loading />;
  const shown = keys.filter((k) => showRevoked || !k.revoked);
  return (
    <Panel>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Developer API keys ({keys.filter((k) => !k.revoked).length} active)</h2>
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} /> Show revoked
        </label>
      </div>
      {!shown.length ? (
        <Empty>No API keys.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1.5 pr-3 font-medium">Key</th>
                <th className="py-1.5 pr-3 font-medium">Account</th>
                <th className="py-1.5 pr-3 font-medium">Created</th>
                <th className="py-1.5 pr-3 font-medium">Last used</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => (
                <tr key={k.id} className="border-t border-white/5" data-api-key={k.id}>
                  <td className="py-1.5 pr-3">
                    <span className="font-mono text-xs text-zinc-200">{k.maskedKey}</span> <span className="text-xs text-zinc-500">{k.name}</span> {k.revoked && <Badge tone="red">revoked</Badge>}
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-zinc-300">
                    {k.ownerEmail ?? k.ownerUserId ?? "—"} <Badge>{k.plan}</Badge>
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-zinc-400">{fmtTime(k.createdAt)}</td>
                  <td className="py-1.5 pr-3 text-xs text-zinc-400">{fmtTime(k.lastUsedAt)}</td>
                  <td className="py-1.5 text-right">
                    {!k.revoked && (
                      <span className="inline-flex gap-2">
                        <button type="button" className={btn.ghost} onClick={() => setAct({ key: k, kind: "rotate" })}>
                          Rotate
                        </button>
                        <button type="button" className={btn.danger} onClick={() => setAct({ key: k, kind: "revoke" })}>
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
          onConfirm={go}
          onCancel={() => setAct(null)}
        />
      )}
    </Panel>
  );
}
