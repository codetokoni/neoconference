"use client";

// Email templates: the wording of every transactional email. Edit the
// subject and bodies with {{variables}}, see it filled with sample data, send
// a test to yourself, and go back to any earlier version or the default.
// The open template is in the address bar (?template=<id>) so it can be linked.

import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText, fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, LoadState, Notice, PageHeader, Pager, Panel, btn, field, useClientTable, useUrlFilters } from "../ui";
import { renderTemplate } from "@/lib/comms/format";
import type { TemplateDef, TemplateParts } from "@/lib/comms/templateDefaults";

type Item = { id: string; name: string; group: string; description: string; audience: string; edited: boolean; version: number; savedAt: number | null; savedByEmail: string | null };
type Version = TemplateParts & { version: number; savedAt: number; savedByEmail: string; note?: string; revertedFrom?: number };
type Detail = { def: TemplateDef; current: Version | null; active: TemplateParts & { version: number }; history: Version[] };
type Msg = { kind: "ok" | "err"; text: string };

const URL_DEFAULTS = { template: "" };

export default function TemplatesClient() {
  const { adminFetch } = useAdmin();
  const f = useUrlFilters(URL_DEFAULTS);
  const open = f.value.template || null;
  const [items, setItems] = useState<Item[] | null>(null);
  const [me, setMe] = useState("");
  const [mail, setMail] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const r = await adminFetch<{ items: Item[]; mail: boolean; me: string }>("/api/admin/comms/templates");
    if (!r.ok) return setError(errorText(r));
    setItems(r.data.items);
    setMe(r.data.me);
    setMail(r.data.mail);
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  if (open)
    return (
      <Editor
        id={open}
        me={me}
        mail={mail}
        onBack={() => {
          f.set({ template: "" });
          load();
        }}
      />
    );
  return (
    <div>
      <PageHeader title="Email templates" sub="The wording of every email the platform sends about someone's account or meetings. Until a template is edited, the original wording goes out." />
      <LoadState data={items} error={error} onRetry={load} empty="No templates.">
        {(list) =>
          [...new Set(list.map((i) => i.group))].map((g) => (
            <div key={g} className="mb-4">
              <h2 className="mb-1 px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-400">{g}</h2>
              <Panel className="p-0">
                <ul className="divide-y divide-white/5">
                  {list
                    .filter((i) => i.group === g)
                    .map((i) => (
                      <li key={i.id}>
                        <button
                          type="button"
                          onClick={() => f.set({ template: i.id })}
                          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-zinc-100">{i.name}</span>
                            <span className="block text-xs text-zinc-400">{i.description}</span>
                          </span>
                          {i.edited ? <Badge tone="cyan">edited · v{i.version}</Badge> : <Badge>default</Badge>}
                        </button>
                      </li>
                    ))}
                </ul>
              </Panel>
            </div>
          ))
        }
      </LoadState>
    </div>
  );
}

function partsOf(d: Detail): TemplateParts {
  return {
    subject: d.active.subject,
    html: d.active.html,
    text: d.active.text,
    ...(d.active.short !== undefined || d.def.defaults.short !== undefined ? { short: d.active.short ?? "" } : {}),
  };
}

function Editor({ id, me, mail, onBack }: { id: string; me: string; mail: boolean; onBack: () => void }) {
  const { adminFetch } = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [parts, setParts] = useState<TemplateParts | null>(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "revert" | null>(null);
  const [view, setView] = useState<"html" | "text">("html");
  const [revertTo, setRevertTo] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<Detail>(`/api/admin/comms/templates/${encodeURIComponent(id)}`);
    if (!r.ok) return setLoadErr(errorText(r));
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
  const dirty = !!(d && parts) && (parts.subject !== d.active.subject || parts.html !== d.active.html || parts.text !== d.active.text || (parts.short ?? "") !== (d.active.short ?? ""));
  const versions = useClientTable(d?.history, (v) => v.version, { key: "version", dir: "desc", pageSize: 10 });

  // Unsaved wording is not lost to a closed tab or a reload without asking.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const backLink = (
    <button type="button" onClick={() => (dirty ? setLeaving(true) : onBack())} className="text-sm text-cyan-300 hover:text-cyan-200">
      ← All templates
    </button>
  );
  if (!d || !parts || !preview)
    return (
      <div className="space-y-4">
        {backLink}
        <LoadState data={null} error={loadErr} onRetry={load}>
          {() => null}
        </LoadState>
      </div>
    );

  const save = async () => {
    setBusy("save");
    setMsg(null);
    const r = await adminFetch(`/api/admin/comms/templates/${encodeURIComponent(id)}`, { method: "PUT", json: { ...parts, note } });
    setBusy(null);
    setSaving(false);
    if (!r.ok) return setMsg({ kind: "err", text: errorText(r) });
    setNote("");
    setMsg({ kind: "ok", text: "Saved. Emails sent from now on use this version." });
    load();
  };
  const test = async () => {
    setBusy("test");
    setMsg(null);
    const r = await adminFetch<{ to: string }>(`/api/admin/comms/templates/${encodeURIComponent(id)}/test`, { method: "POST", json: parts });
    setBusy(null);
    setMsg(r.ok ? { kind: "ok", text: `Test sent to ${r.data.to}.` } : { kind: "err", text: errorText(r) });
  };
  const revert = async (version: number) => {
    setBusy("revert");
    setMsg(null);
    const r = await adminFetch(`/api/admin/comms/templates/${encodeURIComponent(id)}/revert`, { method: "POST", json: { version } });
    setBusy(null);
    setRevertTo(null);
    if (!r.ok) return setMsg({ kind: "err", text: errorText(r) });
    setMsg({ kind: "ok", text: version === 0 ? "Back to the original wording." : `Version ${version} restored.` });
    load();
  };

  const set = (k: keyof TemplateParts, v: string) => setParts({ ...parts, [k]: v });
  return (
    <div className="space-y-4">
      {backLink}
      <PageHeader
        title={d.def.name}
        sub={
          <>
            {d.def.description} Goes to: {d.def.audience}. {d.current ? `Edited version ${d.current.version}, ${fmtTime(d.current.savedAt)} by ${d.current.savedByEmail}.` : "The original wording is in use."}
          </>
        }
      />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel className="min-w-0">
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
            HTML body {d.def.defaults.html === "" && <span className="text-xs text-zinc-400">(this email is plain text; leave empty to keep it so)</span>}
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
                  <span className="text-zinc-400">e.g. {String(v.sample)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-zinc-400">
              {"{{#name}}…{{/name}}"} shows its text when the value is set, {"{{^name}}…{{/name}}"} when it is not. Values are escaped in HTML; scripts are refused.
            </p>
          </details>
          <label className="mt-3 block text-sm text-zinc-300">
            Note for the history (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={`${field} mt-1`} />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={btn.primary}
              disabled={!!busy || !dirty}
              onClick={() => {
                setMsg(null);
                setSaving(true);
              }}
            >
              {busy === "save" ? "Saving…" : "Save new version"}
            </button>
            <button type="button" className={btn.ghost} disabled={!!busy || !mail} onClick={test}>
              {busy === "test" ? "Sending…" : `Send a test to ${me || "me"}`}
            </button>
            {dirty && (
              <button type="button" className={btn.ghost} disabled={!!busy} onClick={() => setParts(partsOf(d))}>
                Discard changes
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            {dirty ? "Unsaved changes." : "No changes to save yet."}
            {!mail && " A test cannot be sent: email is not set up (RESEND_API_KEY)."}
          </p>
        </Panel>
        <Panel className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Preview with sample data</h3>
            <div className="flex gap-1" role="group" aria-label="Preview format">
              {(["html", "text"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={`${btn.ghost} px-2 py-1 text-xs ${view === v ? "border-cyan-400/60 text-cyan-200" : ""}`}
                >
                  {v === "html" ? "HTML" : "Plain text"}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 break-words text-xs text-zinc-400">
            Subject: <span className="text-zinc-100" data-testid="preview-subject">{preview.subject}</span>
          </p>
          {preview.short && (
            <p className="mt-1 break-words text-xs text-zinc-400">
              Bell / push: <span className="text-zinc-100">{preview.short}</span>
            </p>
          )}
          {view === "html" && preview.html ? (
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="mt-2 h-96 w-full rounded-lg bg-white" />
          ) : (
            <>
              {view === "html" && <p className="mt-2 text-xs text-zinc-400">This email has no HTML body; it goes out as the plain text below.</p>}
              <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/40 p-3 text-xs text-zinc-200">{preview.text}</pre>
            </>
          )}
        </Panel>
      </div>
      <Panel>
        <h3 className="text-sm font-semibold text-white">Versions</h3>
        <ul className="mt-2 divide-y divide-white/5 text-sm">
          {versions.visible.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="text-zinc-100">v{v.version}</span>
              {d.current?.version === v.version && <Badge tone="cyan">in use</Badge>}
              {v.revertedFrom !== undefined && <span className="text-xs text-zinc-400">restored v{v.revertedFrom}</span>}
              <span className="text-xs text-zinc-400">
                {fmtTime(v.savedAt)} · {v.savedByEmail}
              </span>
              {v.note && <span className="text-xs text-zinc-400">“{v.note}”</span>}
              {d.current?.version !== v.version && (
                <button type="button" className={`${btn.ghost} ml-auto px-2 py-1 text-xs`} disabled={!!busy} onClick={() => setRevertTo(v.version)} aria-label={`Restore version ${v.version}`}>
                  Restore
                </button>
              )}
            </li>
          ))}
          {versions.page === Math.max(1, Math.ceil(versions.total / versions.pageSize)) && (
            <li className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="text-zinc-100">Original</span>
              {!d.current && <Badge tone="cyan">in use</Badge>}
              <span className="text-xs text-zinc-400">the wording before templates could be edited</span>
              {d.current && (
                <button type="button" className={`${btn.ghost} ml-auto px-2 py-1 text-xs`} disabled={!!busy} onClick={() => setRevertTo(0)} aria-label="Restore the original wording">
                  Restore
                </button>
              )}
            </li>
          )}
        </ul>
        {versions.total > versions.pageSize && <Pager page={versions.page} pageSize={versions.pageSize} total={versions.total} onPage={versions.setPage} noun="saved version" />}
      </Panel>
      {saving && (
        <Confirm
          title="Save this wording?"
          body={`Every “${d.def.name}” email sent from now on uses it (goes to: ${d.def.audience}). The version in use now stays in the history.`}
          confirmLabel="Save new version"
          onConfirm={save}
          onCancel={() => setSaving(false)}
        />
      )}
      {revertTo !== null && (
        <Confirm
          title={revertTo === 0 ? "Go back to the original wording?" : `Restore version ${revertTo}?`}
          body={`Emails sent from now on use it. The version in use now stays in the history.${dirty ? " Your unsaved changes here are discarded." : ""}`}
          confirmLabel="Restore"
          onConfirm={() => revert(revertTo)}
          onCancel={() => setRevertTo(null)}
        />
      )}
      {leaving && (
        <Confirm
          title="Leave without saving?"
          body="Your changes to this template are not saved and will be lost."
          confirmLabel="Leave"
          danger
          onConfirm={() => {
            setLeaving(false);
            onBack();
          }}
          onCancel={() => setLeaving(false)}
        />
      )}
    </div>
  );
}
