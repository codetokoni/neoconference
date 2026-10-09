"use client";

// Content > Limits: the largest file and the file types each upload point
// accepts. Enforced by the server at every upload route, with a message
// that says what is allowed; changing them takes content:moderate and a
// fresh code. Storage quotas are per plan (Plans), retention is a
// data-governance setting — both are linked, not repeated, here.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatBytes, type KnownMime, type UploadKind, type UploadRule } from "@/lib/content/model";
import { fmtTime, useAdmin } from "../../AdminApi";
import { Loading, Notice, PageHeader, Panel, btn, field } from "../../ui";
import { ContentTabs } from "../content-ui";

type Resp = {
  rules: Record<UploadKind, UploadRule>;
  defaults: Record<UploadKind, UploadRule>;
  kinds: { id: UploadKind; label: string; route: string }[];
  fileTypes: { mime: KnownMime; exts: string[]; label: string }[];
  ceiling: number;
  updatedAt: number | null;
  updatedByEmail: string | null;
};

const MB = 1024 * 1024;

export default function LimitsClient() {
  const { can, adminFetch } = useAdmin();
  const [data, setData] = useState<Resp | null>(null);
  const [draft, setDraft] = useState<Record<string, { mb: string; mimes: KnownMime[] }>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await adminFetch<Resp>("/api/admin/content/limits");
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setData(r.data);
    setDraft(Object.fromEntries(r.data.kinds.map((k) => [k.id, { mb: String(+(r.data.rules[k.id].maxBytes / MB).toFixed(2)), mimes: r.data.rules[k.id].mimes }])));
  }, [adminFetch]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!data) return;
    setBusy(true);
    setMsg(null);
    const rules = Object.fromEntries(data.kinds.map((k) => [k.id, { maxBytes: Math.round(Number(draft[k.id].mb) * MB), mimes: draft[k.id].mimes }]));
    const r = await adminFetch("/api/admin/content/limits", { method: "PUT", json: { rules } });
    setBusy(false);
    if (!r.ok) return setMsg({ kind: "err", text: r.data.message ?? `HTTP ${r.status}` });
    setMsg({ kind: "ok", text: "Saved. The next upload at each point is checked against these." });
    load();
  };

  const editable = can("content:moderate");
  return (
    <div>
      <PageHeader
        title="Content"
        sub="What each upload point accepts. The server checks every upload against this, whatever the app or browser allows."
        actions={
          editable && data ? (
            <button type="button" className={btn.primary} disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save limits"}
            </button>
          ) : null
        }
      />
      <ContentTabs />
      {msg && (
        <Notice kind={msg.kind} onClose={() => setMsg(null)}>
          {msg.text}
        </Notice>
      )}
      <p className="mb-3 text-xs text-zinc-500">
        Storage quotas are part of each plan (<Link href="/admin/plans" className="underline">Plans</Link>, &quot;Storage&quot;): uploads to meeting and group chat are
        refused once the account&apos;s files reach it. How long files are kept is a data-governance retention setting.
        {data?.updatedAt ? ` Last changed ${fmtTime(data.updatedAt)} by ${data.updatedByEmail}.` : " Not changed yet: these are the defaults."}
      </p>
      {!data ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {data.kinds.map((k) => {
            const d = draft[k.id];
            if (!d) return null;
            const isDefault = data.rules[k.id].maxBytes === data.defaults[k.id].maxBytes && data.rules[k.id].mimes.join() === data.defaults[k.id].mimes.join();
            return (
              <Panel key={k.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold text-white">{k.label}</h2>
                  <code className="text-xs text-zinc-500">{k.route}</code>
                </div>
                <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-zinc-300">
                  Largest file
                  <input
                    value={d.mb}
                    disabled={!editable}
                    onChange={(e) => setDraft((x) => ({ ...x, [k.id]: { ...d, mb: e.target.value } }))}
                    inputMode="decimal"
                    className={`${field} w-28`}
                    aria-label={`${k.label}: largest file in MB`}
                  />
                  MB <span className="text-xs text-zinc-500">(up to {formatBytes(data.ceiling)}; default {formatBytes(data.defaults[k.id].maxBytes)})</span>
                </label>
                <fieldset className="mt-3">
                  <legend className="text-xs text-zinc-400">Allowed file types {isDefault ? "(defaults)" : ""}</legend>
                  <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {data.fileTypes.map((t) => (
                      <label key={t.mime} className="flex items-center gap-2 text-sm text-zinc-300">
                        <input
                          type="checkbox"
                          disabled={!editable}
                          checked={d.mimes.includes(t.mime)}
                          onChange={(e) =>
                            setDraft((x) => ({
                              ...x,
                              [k.id]: { ...d, mimes: e.target.checked ? [...d.mimes, t.mime] : d.mimes.filter((m) => m !== t.mime) },
                            }))
                          }
                        />
                        {t.label} <span className="text-xs text-zinc-500">.{t.exts.join(", .")}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
