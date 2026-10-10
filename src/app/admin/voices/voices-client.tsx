"use client";

// Cloned speaker voices: in a meeting, a listener who picked a language
// under "Hear this meeting in" hears this speaker's sentences in the
// speaker's own voice (Cartesia). Made only with the speaker's recorded
// consent; switched off or deleted here at any time.

import { useCallback, useEffect, useState } from "react";
import { fmtNumber, fmtTime, useAdmin } from "../AdminApi";
import { Badge, Confirm, LoadState, Notice, PageHeader, Panel, btn, field } from "../ui";

type Voice = {
  userId: string;
  name: string;
  voiceId: string;
  sampleLanguage: string;
  enabled: boolean;
  consent: { by: string; at: number; statement: string };
  createdAt: number;
  createdBy: string;
};
type Data = {
  configured: boolean;
  voices: Voice[];
  usage: { month: string; characters: number; dailyCapPerMeeting: number };
  languages: string[];
};
type Found = { id: string; name: string; email: string };
type Msg = { kind: "ok" | "err"; text: string } | null;

const CONSENT_TEXT =
  "I agree that NeoConference may create a copy of my voice from my recording and use it only to speak translations of what I say in NeoConference meetings. I can ask for it to be switched off or deleted at any time.";

export default function VoicesClient() {
  const { adminFetch } = useAdmin();
  const [data, setData] = useState<Data | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [removing, setRemoving] = useState<Voice | null>(null);

  // New voice form.
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [who, setWho] = useState<Found | null>(null);
  const [name, setName] = useState("");
  const [sampleLanguage, setSampleLanguage] = useState("en");
  const [consentBy, setConsentBy] = useState("");
  const [consentAt, setConsentAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [statement, setStatement] = useState(CONSENT_TEXT);
  const [agreed, setAgreed] = useState(false);
  const [clip, setClip] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadErr(null);
    const r = await adminFetch<Data>("/api/admin/voices");
    if (r.ok) setData(r.data);
    else setLoadErr(r.data.message ?? "Could not load.");
  }, [adminFetch]);
  useEffect(() => {
    void load();
  }, [load]);

  const search = async () => {
    if (!q.trim()) return;
    const r = await adminFetch<{ items: Found[] }>(`/api/admin/users?q=${encodeURIComponent(q.trim())}&pageSize=8`);
    setFound(r.ok ? (r.data.items ?? []).map((u) => ({ id: u.id, name: u.name, email: u.email })) : []);
    if (!r.ok) setMsg({ kind: "err", text: r.data.message ?? "Could not search." });
  };

  const create = async () => {
    if (!who || !clip || !agreed) return;
    setBusy(true);
    setMsg(null);
    const form = new FormData();
    form.append("userId", who.id);
    form.append("name", name.trim() || who.name);
    form.append("sampleLanguage", sampleLanguage);
    form.append("consentBy", consentBy.trim());
    form.append("consentAt", consentAt);
    form.append("consentStatement", statement.trim());
    form.append("clip", clip, clip.name);
    const r = await adminFetch<{ voice: Voice }>("/api/admin/voices", { method: "POST", body: form });
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: "ok", text: `Voice made for ${r.data.voice.name}. Their meeting sentences now play in their own voice.` });
      setWho(null);
      setFound([]);
      setQ("");
      setName("");
      setConsentBy("");
      setAgreed(false);
      setClip(null);
      void load();
    } else {
      setMsg({ kind: "err", text: r.data.message ?? "Could not make the voice." });
    }
  };

  const toggle = async (v: Voice) => {
    const r = await adminFetch("/api/admin/voices", { method: "PATCH", json: { userId: v.userId, enabled: !v.enabled } });
    setMsg(r.ok ? { kind: "ok", text: `${v.name}'s voice is ${v.enabled ? "off" : "on"}.` } : { kind: "err", text: r.data.message ?? "Could not change it." });
    void load();
  };

  return (
    <div>
      <PageHeader
        title="Speaker voices"
        sub="In a meeting, listeners who chose a language under “Hear this meeting in” hear these speakers in their own voice instead of the computer voice. Made with Cartesia, only with the speaker's consent."
      />
      {msg && (
        <div className="mb-3">
          <Notice kind={msg.kind} onClose={() => setMsg(null)}>
            {msg.text}
          </Notice>
        </div>
      )}

      <LoadState data={data} error={loadErr} onRetry={load}>
        {(d) => (
          <div className="flex flex-col gap-4">
            {!d.configured && (
              <Notice kind="err">
                Cartesia is not connected yet: add <code>CARTESIA_API_KEY</code> in Vercel (Production), then redeploy.
              </Notice>
            )}
            <Panel>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-zinc-300">
                <span>
                  This month: <b className="text-zinc-100">{fmtNumber(d.usage.characters)}</b> characters spoken
                </span>
                <span>
                  Cap per meeting per day: <b className="text-zinc-100">{fmtNumber(d.usage.dailyCapPerMeeting)}</b>
                </span>
                <span className="text-zinc-500">Swahili is not offered by Cartesia; it stays on the computer voice.</span>
              </div>
            </Panel>

            <Panel>
              <h2 className="mb-3 text-sm font-semibold text-zinc-100">Voices</h2>
              {d.voices.length === 0 ? (
                <p className="text-sm text-zinc-400">No voices yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-white/5">
                  {d.voices.map((v) => (
                    <li key={v.userId} className="flex flex-wrap items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-100">{v.name}</span>
                          <Badge tone={v.enabled ? "green" : "zinc"}>{v.enabled ? "On" : "Off"}</Badge>
                        </div>
                        <p className="text-xs text-zinc-400">
                          Consent from {v.consent.by} on {fmtTime(v.consent.at)} · made {fmtTime(v.createdAt)} by {v.createdBy}
                        </p>
                      </div>
                      <button type="button" className={btn.ghost} onClick={() => void toggle(v)}>
                        {v.enabled ? "Switch off" : "Switch on"}
                      </button>
                      <button type="button" className={btn.danger} onClick={() => setRemoving(v)}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel>
              <h2 className="mb-1 text-sm font-semibold text-zinc-100">Make a voice</h2>
              <p className="mb-3 text-xs text-zinc-400">
                1–3 minutes of the speaker talking naturally, one voice only, no music or echo (wav or mp3, under 16 MB).
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-zinc-400">The speaker&apos;s NeoConference account</span>
                  {who ? (
                    <div className="flex items-center gap-2 text-sm text-zinc-100">
                      {who.name} <span className="text-zinc-500">{who.email}</span>
                      <button type="button" className={btn.ghost} onClick={() => setWho(null)}>
                        Change
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex gap-2">
                        <input className={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or username" onKeyDown={(e) => e.key === "Enter" && void search()} />
                        <button type="button" className={btn.ghost} onClick={() => void search()}>
                          Find
                        </button>
                      </div>
                      {found.map((u) => (
                        <button
                          key={u.id}
                          type="button"
                          className="rounded-md px-2 py-1 text-left text-sm text-zinc-200 hover:bg-white/5"
                          onClick={() => {
                            setWho(u);
                            setName(u.name);
                          }}
                        >
                          {u.name} <span className="text-zinc-500">{u.email}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-zinc-400">Name to show</span>
                  <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pastor Chris" />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-zinc-400">The recording</span>
                  <input
                    className={field}
                    type="file"
                    accept="audio/*,.wav,.mp3,.ogg,.webm,.flac"
                    onChange={(e) => setClip(e.target.files?.[0] ?? null)}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-zinc-400">Language spoken in the recording</span>
                  <select className={field} value={sampleLanguage} onChange={(e) => setSampleLanguage(e.target.value)}>
                    {d.languages.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-zinc-400">Consent given by (their name)</span>
                  <input className={field} value={consentBy} onChange={(e) => setConsentBy(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-zinc-400">Date consent was given</span>
                  <input className={field} type="date" value={consentAt} onChange={(e) => setConsentAt(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1.5 md:col-span-2">
                  <span className="text-xs text-zinc-400">What they agreed to</span>
                  <textarea className={field} rows={3} value={statement} onChange={(e) => setStatement(e.target.value)} />
                </label>
                <label className="flex items-start gap-2 text-sm text-zinc-200 md:col-span-2">
                  <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  The speaker gave this consent, and the recording is of their own voice.
                </label>
              </div>
              <div className="mt-3">
                <button
                  type="button"
                  className={btn.primary}
                  disabled={busy || !d.configured || !who || !clip || !agreed || !consentBy.trim() || !statement.trim()}
                  onClick={() => void create()}
                >
                  {busy ? "Making the voice…" : "Make voice"}
                </button>
              </div>
            </Panel>
          </div>
        )}
      </LoadState>

      {removing && (
        <Confirm
          title={`Delete ${removing.name}'s voice?`}
          body="It is removed here and at Cartesia. Their meeting sentences go back to the computer voice."
          confirmLabel="Delete voice"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const r = await adminFetch(`/api/admin/voices?userId=${encodeURIComponent(removing.userId)}`, { method: "DELETE" });
            setRemoving(null);
            setMsg(r.ok ? { kind: "ok", text: "Voice deleted." } : { kind: "err", text: r.data.message ?? "Could not delete." });
            void load();
          }}
        />
      )}
    </div>
  );
}
