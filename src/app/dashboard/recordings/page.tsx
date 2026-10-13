'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

type PersistedTranscript = {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  provider: string;
  text?: string;
  summary?: string;
  error?: string;
  updatedAt?: string;
};

type AudioSidecar = {
  key: string;
  size: number;
  downloadUrl: string;
};

type Recording = {
  key: string;
  size: number;
  lastModified?: string;
  downloadUrl: string;
  audio?: AudioSidecar | null;
  transcript?: PersistedTranscript | null;
  /** In the admin "All recordings" view: the room, who recorded it, and whether it is yours. */
  room?: string | null;
  owner?: { userId: string; label: string } | null;
  mine?: boolean;
};

type Resp = {
  ok: boolean;
  configured?: boolean;
  recordings?: Recording[];
  truncated?: boolean;
  error?: string;
  message?: string;
  hint?: string;
};

type Scope = 'mine' | 'all';

type TranscribeJob = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  text?: string;
  summary?: string;
  error?: string;
  provider?: string;
};

type TranscribeState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'queued'; jobId: string; provider: string }
  | { status: 'running'; jobId: string; provider: string }
  | { status: 'done'; jobId: string; provider: string; text: string; summary?: string }
  | { status: 'error'; error: string };

function basenameNoExt(key: string): string {
  const last = key.split('/').pop() || key;
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

type DownloadMenuProps = {
  recordingKey: string;
  videoUrl: string;
  audioUrl?: string;
  transcriptReady: boolean;
};

function DownloadMenu({ recordingKey, videoUrl, audioUrl, transcriptReady }: DownloadMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const baseName = basenameNoExt(recordingKey);
  const transcriptHref = `/api/recordings/transcript?key=${encodeURIComponent(recordingKey)}`;

  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-100 px-3 py-1.5 text-xs hover:bg-cyan-400/20 transition"
      >
        Download
        <span className="text-[10px] opacity-70">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-white/10 bg-black/85 backdrop-blur-xl shadow-[0_8px_24px_rgba(0,0,0,0.5)] overflow-hidden"
          style={{ borderWidth: '0.5px' }}
        >
          <a
            href={videoUrl}
            download={`${baseName}.mp4`}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center justify-between px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-400/15 transition"
          >
            <span>Download video</span>
            <span className="text-[10px] text-white/40">.mp4</span>
          </a>
          {audioUrl ? (
            <a
              href={audioUrl}
              download={`${baseName}.m4a`}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-400/15 transition border-t border-white/5"
            >
              <span>Download audio</span>
              <span className="text-[10px] text-white/40">.m4a</span>
            </a>
          ) : (
            <div
              role="menuitem"
              aria-disabled="true"
              title="Audio not available — this recording was made before audio sidecar was enabled."
              className="flex items-center justify-between px-3 py-2 text-xs text-white/35 border-t border-white/5 cursor-not-allowed"
            >
              <span>Download audio</span>
              <span className="text-[10px] opacity-60">unavailable</span>
            </div>
          )}
          {transcriptReady ? (
            <a
              href={transcriptHref}
              download={`${baseName}.txt`}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-400/15 transition border-t border-white/5"
            >
              <span>Download transcript</span>
              <span className="text-[10px] text-white/40">.txt</span>
            </a>
          ) : (
            <div
              role="menuitem"
              aria-disabled="true"
              title="Transcript not yet generated. Click the Transcribe button on this row to create one."
              className="flex items-center justify-between px-3 py-2 text-xs text-white/35 border-t border-white/5 cursor-not-allowed"
            >
              <span>Download transcript</span>
              <span className="text-[10px] opacity-60">unavailable</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtBytes(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function fmtDate(iso?: string) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function RecordingsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [tx, setTx] = useState<Record<string, TranscribeState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // "Copy link": per row, what happened ("copying" | the link copied | an error).
  const [links, setLinks] = useState<Record<string, { state: 'copying' | 'copied' | 'error'; text: string }>>({});
  // An administrator who can see files (content:read) also gets "All recordings".
  const [canSeeAll, setCanSeeAll] = useState(false);
  const [scope, setScope] = useState<Scope>('mine');

  useEffect(() => {
    let alive = true;
    fetch('/api/admin/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { admin?: { permissions?: string[] } } | null) => {
        if (alive && j?.admin?.permissions?.includes('content:read')) setCanSeeAll(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function load(which: Scope = scope) {
    setLoading(true);
    try {
      const res = await fetch(which === 'all' ? '/api/recordings?scope=all' : '/api/recordings', { cache: 'no-store' });
      const j: Resp = await res.json();
      if (!res.ok && !j.error) j.error = 'Could not load recordings.';
      if (j.error === 'mfa_required' || j.error === 'mfa_enrollment_required') {
        j.error = 'Open the admin area and enter your authenticator code first, then come back to see all recordings.';
      } else if (j.error === 'forbidden' || j.error === 'not_admin') {
        j.error = j.message || 'Your admin role cannot see other people’s recordings.';
      }
      setData(j);

      // Hydrate the transcribe-state map from any transcripts the API already
      // returned (these come from the KV-backed transcribeStore and survive
      // page reloads / lambda cold starts).
      const hydrated: Record<string, TranscribeState> = {};
      for (const rec of j.recordings || []) {
        const t = rec.transcript;
        if (!t) continue;
        if (t.status === 'done' && t.text) {
          hydrated[rec.key] = {
            status: 'done',
            jobId: t.jobId,
            provider: t.provider,
            text: t.text,
            summary: t.summary,
          };
        } else if (t.status === 'error') {
          hydrated[rec.key] = { status: 'error', error: t.error || 'Transcription failed.' };
        } else if (t.status === 'running') {
          hydrated[rec.key] = { status: 'running', jobId: t.jobId, provider: t.provider };
        } else if (t.status === 'queued') {
          hydrated[rec.key] = { status: 'queued', jobId: t.jobId, provider: t.provider };
        }
      }
      if (Object.keys(hydrated).length > 0) {
        // Merge so any in-flight client states aren't clobbered.
        setTx((prev) => ({ ...hydrated, ...prev }));
      }
    } catch (e: unknown) {
      setData({ ok: false, error: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(scope); }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  async function transcribe(key: string) {
    setTx((s) => ({ ...s, [key]: { status: 'submitting' } }));
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordingKey: key }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string; message?: string; provider?: string; job?: TranscribeJob };
      if (!j.ok || !j.job) {
        throw new Error(j.message || j.error || 'Could not queue transcription.');
      }
      const job = j.job;
      const provider = j.provider || 'stub';
      if (job.status === 'done' && job.text) {
        setTx((s) => ({
          ...s,
          [key]: { status: 'done', jobId: job.id, provider, text: job.text!, summary: job.summary },
        }));
        setExpanded((s) => ({ ...s, [key]: true }));
      } else if (job.status === 'error') {
        setTx((s) => ({
          ...s,
          [key]: { status: 'error', error: job.error || 'Transcription failed.' },
        }));
      } else if (job.status === 'running') {
        setTx((s) => ({ ...s, [key]: { status: 'running', jobId: job.id, provider } }));
      } else {
        setTx((s) => ({ ...s, [key]: { status: 'queued', jobId: job.id, provider } }));
      }
    } catch (e: unknown) {
      setTx((s) => ({
        ...s,
        [key]: { status: 'error', error: e instanceof Error ? e.message : 'transcribe failed' },
      }));
    }
  }

  /**
   * A link to the recording anyone can open (/share/<token>), copied. The
   * row's own download link is signed for an hour, so it is no use to send
   * to someone; this one works for 30 days.
   */
  async function copyLink(key: string) {
    setLinks((s) => ({ ...s, [key]: { state: 'copying', text: 'Making a link…' } }));
    try {
      const res = await fetch('/api/recordings/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, label: key.split('/').pop() || key, ttlSeconds: 30 * 24 * 3600 }),
      });
      const j = (await res.json().catch(() => ({}))) as { share?: { token: string }; message?: string; error?: string };
      if (!res.ok || !j.share?.token) throw new Error(j.message || j.error || 'Could not make a link.');
      const url = `${window.location.origin}/share/${j.share.token}`;
      let copied = true;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        copied = false;
      }
      setLinks((s) => ({ ...s, [key]: { state: 'copied', text: url + (copied ? '' : ' (copy it from here)') } }));
    } catch (e: unknown) {
      setLinks((s) => ({ ...s, [key]: { state: 'error', text: e instanceof Error ? e.message : 'Could not make a link.' } }));
    }
  }

  async function copyTranscript(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  const needle = filter.toLowerCase();
  const recordings = (data?.recordings || []).filter((r) =>
    (/\.mp4$/i.test(r.key)) &&
    (!filter ||
      r.key.toLowerCase().includes(needle) ||
      (r.owner?.label || '').toLowerCase().includes(needle) ||
      (r.room || '').toLowerCase().includes(needle))
  );
  // In "All recordings", only your own can be transcribed or deleted from here.
  const ownsRow = (r: Recording) => scope === 'mine' || r.mine === true;

  return (
    <main className="min-h-screen bg-[#05070d] text-white relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-50">
        <div className="absolute -top-40 -left-40 h-[480px] w-[480px] rounded-full bg-cyan-500/15 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[420px] w-[420px] rounded-full bg-indigo-500/15 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 py-10 md:py-16">
        <div className="mb-6 sm:mb-8 flex items-center justify-between gap-4">
          <Link href="/" className="text-sm text-white/60 hover:text-white transition">← Back to NeoConference</Link>
          <span className="text-[10px] sm:text-xs uppercase tracking-[0.3em] text-cyan-300/70">Recordings</span>
        </div>

        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 md:gap-6">
          <div>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight">
              {scope === 'all' ? 'All' : 'Your'}{' '}
              <span className="bg-gradient-to-r from-cyan-300 to-indigo-300 bg-clip-text text-transparent">recordings</span>
            </h1>
            <p className="mt-2 text-white/60 text-xs sm:text-sm">
              {scope === 'all'
                ? 'Every recording on NeoConference, newest first. Only the person who recorded one can delete it.'
                : 'Stored on Cloudflare R2. Download links expire after 1 hour — refresh this page for new ones.'}
            </p>
            {canSeeAll && (
              <div role="tablist" aria-label="Whose recordings" className="mt-4 inline-flex rounded-xl border border-white/10 bg-black/30 p-1 text-sm">
                {(['mine', 'all'] as const).map((s) => (
                  <button
                    key={s}
                    role="tab"
                    aria-selected={scope === s}
                    onClick={() => setScope(s)}
                    className={`rounded-lg px-3 py-1.5 transition ${scope === s ? 'bg-cyan-400/20 text-cyan-100' : 'text-white/60 hover:text-white'}`}
                  >
                    {s === 'mine' ? 'Mine' : 'All recordings (admin)'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={scope === 'all' ? 'Filter by room, person or filename' : 'Filter by room or filename'}
              className="flex-1 md:w-72 md:flex-initial rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 transition"
            />
            <button
              onClick={() => load()}
              className="shrink-0 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm hover:bg-white/10 transition"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {data && data.configured === false && (
          <div className="mt-8 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-5 text-sm text-amber-100">
            <div className="font-medium mb-1">Recording storage isn&apos;t configured.</div>
            <div className="text-amber-100/80 text-xs">{data.hint}</div>
          </div>
        )}

        {data && !data.ok && data.error && (
          <div className="mt-8 rounded-2xl border border-red-400/30 bg-red-500/10 p-5 text-sm text-red-200">
            {data.error}
          </div>
        )}

        <div className="mt-6 sm:mt-8 rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl overflow-hidden">
          {loading && !data && (
            <div className="p-10 text-center text-white/50 text-sm">Loading recordings…</div>
          )}

          {data && data.ok && recordings.length === 0 && (
            <div className="p-12 text-center">
              <div className="text-5xl mb-3 opacity-40">⊘</div>
              <div className="text-white/70">No recordings yet.</div>
              <div className="text-white/40 text-xs mt-1">Start a meeting and hit Record — your files will appear here.</div>
            </div>
          )}

          {recordings.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[680px]">
                <thead className="bg-white/[0.02] border-b border-white/10">
                  <tr className="text-left text-[11px] uppercase tracking-[0.2em] text-white/45">
                    <th className="px-4 sm:px-5 py-3 font-normal">File</th>
                    <th className="px-4 sm:px-5 py-3 font-normal w-24 sm:w-32">Size</th>
                    <th className="px-4 sm:px-5 py-3 font-normal w-56 hidden md:table-cell">Recorded</th>
                    <th className="px-4 sm:px-5 py-3 font-normal w-44 sm:w-48 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {recordings.map((r) => {
                    const state = tx[r.key] || { status: 'idle' };
                    const isExpanded = expanded[r.key];
                    return (
                      <tr key={r.key} className="border-b border-white/5 hover:bg-white/[0.02] transition align-top">
                        <td className="px-4 sm:px-5 py-3.5">
                          <div className="font-mono text-white/90 truncate max-w-[200px] sm:max-w-[420px]" title={r.key}>{r.key}</div>
                          {scope === 'all' && (
                            <div className="mt-0.5 text-[11px] text-white/55 truncate max-w-[200px] sm:max-w-[420px]">
                              {r.room ? <>Room <span className="text-cyan-200/80">{r.room}</span></> : 'Room unknown'}
                              {' · '}
                              {r.mine ? 'You' : r.owner ? r.owner.label : 'Recorded by the room (no account)'}
                            </div>
                          )}
                          <div className="md:hidden text-[10px] text-white/40 mt-0.5">{fmtDate(r.lastModified)}</div>
                          {state.status === 'submitting' && (
                            <div className="mt-1 inline-flex items-center gap-1.5 text-[10px] text-fuchsia-200/80">
                              <span className="h-1 w-1 rounded-full bg-fuchsia-300 animate-pulse" />
                              Transcribing… this can take up to 30s for an hour of audio.
                            </div>
                          )}
                          {state.status === 'queued' && (
                            <div className="mt-1 inline-flex items-center gap-1.5 text-[10px] text-amber-200/80">
                              <span className="h-1 w-1 rounded-full bg-amber-300 animate-pulse" />
                              Queued · {state.provider}
                            </div>
                          )}
                          {state.status === 'running' && (
                            <div className="mt-1 inline-flex items-center gap-1.5 text-[10px] text-cyan-200/80">
                              <span className="h-1 w-1 rounded-full bg-cyan-300 animate-pulse" />
                              Processing on {state.provider}… reload later to check.
                            </div>
                          )}
                          {state.status === 'done' && (
                            <button
                              onClick={() => setExpanded((s) => ({ ...s, [r.key]: !s[r.key] }))}
                              className="mt-1 inline-flex items-center gap-1.5 text-[10px] text-emerald-200/90 hover:text-emerald-100 transition"
                            >
                              <span className="h-1 w-1 rounded-full bg-emerald-300" />
                              Transcript ready · {state.provider} {isExpanded ? '▲ hide' : '▼ show'}
                            </button>
                          )}
                          {state.status === 'error' && (
                            <div className="mt-1 text-[10px] text-red-300 max-w-[420px] break-words">{state.error}</div>
                          )}
                          {links[r.key] && (
                            <div
                              role="status"
                              className={`mt-1 text-[11px] max-w-[420px] break-all ${links[r.key].state === 'error' ? 'text-red-300' : 'text-emerald-200/90'}`}
                            >
                              {links[r.key].state === 'copied' ? (
                                <>
                                  Link copied · works for 30 days ·{' '}
                                  <a href={links[r.key].text.split(' ')[0]} target="_blank" rel="noreferrer" className="underline hover:text-emerald-100">
                                    {links[r.key].text}
                                  </a>
                                </>
                              ) : (
                                links[r.key].text
                              )}
                            </div>
                          )}
                          {state.status === 'done' && isExpanded && (
                            <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-3 sm:p-4 text-xs sm:text-sm text-white/85 space-y-3 max-w-[640px]">
                              {state.summary && (
                                <div>
                                  <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80 mb-1">AI Summary</div>
                                  <div className="text-white/90 leading-relaxed">{state.summary}</div>
                                </div>
                              )}
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/80">Transcript</div>
                                  <button
                                    onClick={() => copyTranscript(state.text)}
                                    className="text-[10px] text-cyan-200/80 hover:text-cyan-100 transition"
                                  >
                                    Copy
                                  </button>
                                </div>
                                <div className="text-white/80 leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto">
                                  {state.text}
                                </div>
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-4 sm:px-5 py-3.5 text-white/65 text-xs sm:text-sm">{fmtBytes(r.size)}</td>
                        <td className="px-4 sm:px-5 py-3.5 text-white/55 hidden md:table-cell">{fmtDate(r.lastModified)}</td>
                        <td className="px-4 sm:px-5 py-3.5 text-right">
                          <div className="inline-flex items-center gap-2 justify-end">
                            {ownsRow(r) && (
                            <button
                              onClick={() => transcribe(r.key)}
                              disabled={state.status === 'submitting' || state.status === 'queued' || state.status === 'running'}
                              title="Submit for AI transcription"
                              className="inline-flex items-center gap-1 rounded-lg border border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-100 px-2.5 py-1.5 text-[11px] hover:bg-fuchsia-400/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {state.status === 'submitting' ? '…' : state.status === 'queued' ? '✓ Queued' : state.status === 'running' ? '… Running' : state.status === 'done' ? '↻ Re-run' : 'Transcribe'}
                            </button>
                            )}
                            <button
                              onClick={() => copyLink(r.key)}
                              disabled={links[r.key]?.state === 'copying'}
                              title="Copy a link anyone can open to watch or download this recording (30 days)"
                              className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/30 bg-emerald-400/10 text-emerald-100 px-2.5 py-1.5 text-[11px] hover:bg-emerald-400/20 transition disabled:opacity-50"
                            >
                              {links[r.key]?.state === 'copied' ? '✓ Copied' : 'Copy link'}
                            </button>
                            <DownloadMenu
                              recordingKey={r.key}
                              videoUrl={r.downloadUrl}
                              audioUrl={r.audio?.downloadUrl}
                              transcriptReady={
                                !!(r.transcript && r.transcript.status === 'done' && r.transcript.text)
                              }
                            />
                            {ownsRow(r) && (
                            <button
                              onClick={async () => {
                                if (!confirm('Delete this recording permanently? This cannot be undone.')) return;
                                const res2 = await fetch('/api/recordings?key=' + encodeURIComponent(r.key), { method: 'DELETE' });
                                const j2 = await res2.json();
                                if (j2.ok) load();
                                else alert(j2.error || 'Delete failed');
                              }}
                              className="inline-flex items-center gap-1 rounded-lg border border-red-400/30 bg-red-400/10 text-red-200 px-2.5 py-1.5 text-[11px] hover:bg-red-400/20 transition"
                            >Delete</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {recordings.length > 0 && (
          <p className="mt-4 text-[11px] text-white/40 text-right">
            {recordings.length} recording{recordings.length === 1 ? '' : 's'} · links valid for 1h
          </p>
        )}
      </div>
    </main>
  );
}
