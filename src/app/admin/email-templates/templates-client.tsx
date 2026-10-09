"use client";

// Email templates: the wording of every transactional email. Edit the
// subject and bodies with {{variables}}, see it filled with sample data, send
// a test to yourself, and go back to any earlier version or the default.

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, Empty, Loading, Notice, PageHeader, Panel, btn, field } from "../ui";
import { renderTemplate } from "@/lib/comms/format";
import type { TemplateDef, TemplateParts } from "@/lib/comms/templateDefaults";

type Item = { id: string; name: string; group: string; description: string; audience: string; edited: boolean; version: number; savedAt: number | null; savedByEmail: string | null };
type Version = TemplateParts & { version: number; savedAt: number; savedByEmail: string; note?: string; revertedFrom?: number };
type Detail = { def: TemplateDef; current: Version | null; active: TemplateParts & { version: number }; history: Version[] };

export default function TemplatesClient() {
  const { adminFetch } = useAdmin();
  const [items, setItems] = useState<Item[] | null>(null);
  const [me, setMe] = useState("");
  const [mail, setMail] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await adminFetch<{ items: Item[]; mail: boolean; me: string }>("/api/admin/comms/templates");
    if (!r.ok) {
      setError(r.data.message ?? `HTTP ${r.status}`);
      return setItems([]);
    }
    setItems(r.data.items);
    setMe(r.data.me);
    setMail(r.data.mail);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  if (open) return <Editor id={open} me={me} mail={mail} onBack={() => (setOpen(null), load())} />;
  const groups = [...new Set((items ?? []).map((i) => i.group))];
  return (
    <div>
      <PageHeader title="Email templates" sub="The wording of every email the platform sends about someone's account or meetings. Until a template is edited, the original wording goes out." />
      {error && <Notice kind="err">{error}</Notice>}
      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty>No templates.</Empty>
      ) : (
        groups.map((g) => (
          <div key={g} className="mb-4">
            <p className="mb-1 px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">{g}</p>
            <Panel className="p-0">
              <ul className="divide-y divide-white/5">
                {items
                  .filter((i) => i.group === g)
                  .map((i) => (
                    <li key={i.id}>
                      <button type="button" onClick={() => setOpen(i.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left hover:bg-white/[0.03]">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-zinc-100">{i.name}</span>
                          <span className="block text-xs text-zinc-500">{i.description}</span>
                        </span>
                        {i.edited ? <Badge tone="cyan">edited · v{i.version}</Badge> : <Badge>default</Badge>}
                      </button>
                    </li>
                  ))}
              </ul>
            </Panel>
          </div>
        ))
      )}
    </div>
  );
}

function Editor({ id, me, mail, onBack }: { id: string; me: string; mail: boolean; onBack: () => void }) {
  const { adminFetch } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [parts, setParts] = useState<TemplateParts | null>(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"html" | "text">("html");
  const [revertTo, setRevertTo] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await adminFetch<Detail>(`/api/admin/comms/templates/${encodeURIComponent(id)}`);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setD(r.data);
    setParts({ subject: r.data.active.subject, html: r.data.active.html, text: r.data.active.text, ...(r.data.def.defaults.short !== undefined ? { short: r.data.active.short ?? "" } : {}) });
  }, [adminFetch, id]);
  useEffect(() => {
    load();
  }, [load]);

  const vars = useMemo(() => Object.fromEntries((d?.def.variables ?? []).map((v) => [v.name, v.sample])), [d]);
  const preview = useMemo(
    () =>
      parts
        ? {
            subject: renderTemplate(parts.subject, vars, "text"),
            html: parts.html ? renderTemplate(parts.html, vars, "html") : "",
            text: renderTemplate(parts.text, vars, "text"),
            short: parts.short ? renderTemplate(parts.short, vars, "text") : "",
          }
        : null,
    [parts, vars],
  );
  if (!d || !parts || !preview) return msg ? <Notice kind="err">{msg.text}</Notice> : <Loading />;

  const dirty = parts.subject !== d.active.subject || parts.html !== d.active.html || parts.text !== d.active.text || (parts.short ?? "") !== (d.active.short ?? "");

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const r = await adminFetch(`/api/admin/comms/templates/${encodeURIComponent(id)}`, { method: "PUT", json: { ...parts, note } });
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setNote("");
    setMsg({ kind: "ok", text: "Saved. Emails sent from now on use this version." });
    load();
  };
  const test = async () => {
    setBusy(true);
    setMsg(null);
    const r = await adminFetch<{ to: string }>(`/api/admin/comms/templates/${encodeURIComponent(id)}/test`, { method: "POST", json: parts });
    setBusy(false);
    setMsg(r.ok ? { kind: "ok", text: `Test sent to ${r.data.to}.` } : { kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
  };
  const revert = async (version: number) => {
    setRevertTo(null);
    setBusy(true);
    const r = await adminFetch(`/api/admin/comms/templates/${encodeURIComponent(id)}/revert`, { method: "POST", json: { version } });
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: version === 0 ? "Back to the original wording." : `Version ${version} restored.` });
    load();
  };

  const set = (k: keyof TemplateParts, v: string) => setParts({ ...parts, [k]: v });
  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-cyan-300 hover:text-cyan-200">
        ← All templates
      </button>
      <PageHeader
        title={d.def.name}
        sub={
          <>
            {d.def.description} Goes to: {d.def.audience}. {d.current ? `Edited version ${d.current.version}, ${fmtTime(d.current.savedAt)} by ${d.current.savedByEmail}.` : "The original wording is in use."}
          </>
        }
      />
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <label className="block text-sm text-zinc-300">
            Subject
            <input value={parts.subject} onChange={(e) => set("subject", e.target.value)} className={`${field} mt-1 font-mono`} />
          </label>
          {parts.short !== undefined && (
            <label className="mt-3 block text-sm text-zinc-300">
              Bell / push line
              <input value={parts.short} onChange={(e) => set("short", e.target.value)} className={`${field} mt-1 font-mono`} />
            </label>
          )}
          <label className="mt-3 block text-sm text-zinc-300">
            HTML body {d.def.defaults.html === "" && <span className="text-xs text-zinc-500">(this email is plain text; leave empty to keep it so)</span>}
            <textarea value={parts.html} onChange={(e) => set("html", e.target.value)} rows={8} className={`${field} mt-1 font-mono text-xs`} />
          </label>
          <label className="mt-3 block text-sm text-zinc-300">
            Plain-text body
            <textarea value={parts.text} onChange={(e) => set("text", e.target.value)} rows={6} className={`${field} mt-1 font-mono text-xs`} />
          </label>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-400">Variables ({d.def.variables.length})</summary>
            <ul className="mt-2 space-y-1 text-xs">
              {d.def.variables.map((v) => (
                <li key={v.name}>
                  <code className="rounded bg-black/40 px-1 text-cyan-200">{`{{${v.name}}}`}</code> <span className="text-zinc-400">{v.description}</span>{" "}
                  <span className="text-zinc-600">e.g. {String(v.sample)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-zinc-500">
              {"{{#name}}…{{/name}}"} shows its text when the value is set, {"{{^name}}…{{/name}}"} when it is not. Values are escaped in HTML; scripts are refused.
            </p>
          </details>
          <label className="mt-3 block text-sm text-zinc-300">
            Note for the history (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={`${field} mt-1`} />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btn.primary} disabled={busy || !dirty} onClick={save}>
              Save new version
            </button>
            <button type="button" className={btn.ghost} disabled={busy || !mail} onClick={test} title={mail ? `Sends to ${me}` : "Email is not set up"}>
              Send a test to {me || "me"}
            </button>
            {dirty && (
              <button type="button" className={btn.ghost} disabled={busy} onClick={() => setParts({ subject: d.active.subject, html: d.active.html, text: d.active.text, ...(d.active.short !== undefined || d.def.defaults.short !== undefined ? { short: d.active.short ?? "" } : {}) })}>
                Discard changes
              </button>
            )}
          </div>
        </Panel>
        <Panel>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Preview with sample data</h3>
            <div className="flex gap-1">
              {(["html", "text"] as const).map((v) => (
                <button key={v} type="button" onClick={() => setView(v)} className={`${btn.ghost} px-2 py-1 text-xs ${view === v ? "border-cyan-400/60 text-cyan-200" : ""}`}>
                  {v === "html" ? "HTML" : "Plain text"}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            Subject: <span className="text-zinc-100" data-testid="preview-subject">{preview.subject}</span>
          </p>
          {preview.short && <p className="mt-1 text-xs text-zinc-400">Bell / push: <span className="text-zinc-100">{preview.short}</span></p>}
          {view === "html" && preview.html ? (
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="mt-2 h-96 w-full rounded-lg bg-white" />
          ) : (
            <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-black/40 p-3 text-xs text-zinc-200">{preview.text}</pre>
          )}
        </Panel>
      </div>
      <Panel>
        <h3 className="text-sm font-semibold text-white">Versions</h3>
        <ul className="mt-2 divide-y divide-white/5 text-sm">
          {d.history.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="text-zinc-100">v{v.version}</span>
              {d.current?.version === v.version && <Badge tone="cyan">in use</Badge>}
              {v.revertedFrom !== undefined && <span className="text-xs text-zinc-500">restored v{v.revertedFrom}</span>}
              <span className="text-xs text-zinc-500">
                {fmtTime(v.savedAt)} · {v.savedByEmail}
              </span>
              {v.note && <span className="text-xs text-zinc-400">“{v.note}”</span>}
              {d.current?.version !== v.version && (
                <button type="button" className={`${btn.ghost} ml-auto px-2 py-1 text-xs`} onClick={() => setRevertTo(v.version)}>
                  Restore
                </button>
              )}
            </li>
          ))}
          <li className="flex flex-wrap items-center gap-2 py-1.5">
            <span className="text-zinc-100">Original</span>
            {!d.current && <Badge tone="cyan">in use</Badge>}
            <span className="text-xs text-zinc-500">the wording before templates could be edited</span>
            {d.current && (
              <button type="button" className={`${btn.ghost} ml-auto px-2 py-1 text-xs`} onClick={() => setRevertTo(0)}>
                Restore
              </button>
            )}
          </li>
        </ul>
      </Panel>
      {revertTo !== null && (
        <Confirm
          title={revertTo === 0 ? "Go back to the original wording?" : `Restore version ${revertTo}?`}
          body="Emails sent from now on use it. The version in use now stays in the history."
          confirmLabel="Restore"
          onConfirm={() => revert(revertTo)}
          onCancel={() => setRevertTo(null)}
        />
      )}
    </div>
  );
}
