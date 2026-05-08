'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Recording = {
  key: string;
  size: number;
  lastModified?: string;
  downloadUrl: string;
};

type Resp = {
  ok: boolean;
  configured?: boolean;
  recordings?: Recording[];
  error?: string;
  hint?: string;
};

type TranscribeState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'queued'; jobId: string; provider: string }
  | { status: 'error'; error: string };

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

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/recordings', { cache: 'no-store' });
      const j: Resp = await res.json();
      setData(j);
    } catch (e: unknown) {
      setData({ ok: false, error: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function transcribe(key: string) {
    setTx((s) => ({ ...s, [key]: { status: 'submitting' } }));
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recordingKey: key }),
      });
      const j = await res.json();
      if (!j.ok || !j.job) {
        throw new Error(j.error || 'Could not queue transcription.');
      }
      setTx((s) => ({
        ...s,
        [key]: { status: 'queued', jobId: j.job.id, provider: j.provider || 'stub' },
      }));
    } catch (e: unknown) {
      setTx((s) => ({
        ...s,
        [key]: { status: 'error', error: e instanceof Error ? e.message : 'transcribe failed' },
      }));
    }
  }

  const recordings = (data?.recordings || []).filter((r) =>
    (/\.mp4$/i.test(r.key)) && (!filter || r.key.toLowerCase().includes(filter.toLowerCase()))
  );

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
              Your <span className="bg-gradient-to-r from-cyan-300 to-indigo-300 bg-clip-text text-transparent">recordings</span>
            </h1>
            <p className="mt-2 text-white/60 text-xs sm:text-sm">
              Stored on Cloudflare R2. Download links expire after 1 hour — refresh this page for new ones.
            </p>
          </div>
          <div className="flex items-center gap-2 w-full md:w-auto">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by room or filename"
              className="flex-1 md:w-72 md:flex-initial rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 transition"
            />
            <button
              onClick={load}
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
                    return (
                      <tr key={r.key} className="border-b border-white/5 hover:bg-white/[0.02] transition">
                        <td className="px-4 sm:px-5 py-3.5">
                          <div className="font-mono text-white/90 truncate max-w-[200px] sm:max-w-[420px]" title={r.key}>{r.key}</div>
                          <div className="md:hidden text-[10px] text-white/40 mt-0.5">{fmtDate(r.lastModified)}</div>
                          {state.status === 'queued' && (
                            <div className="mt-1 inline-flex items-center gap-1.5 text-[10px] text-cyan-200/80">
                              <span className="h-1 w-1 rounded-full bg-cyan-300 animate-pulse" />
                              Transcript queued · {state.provider}
                            </div>
                          )}
                          {state.status === 'error' && (
                            <div className="mt-1 text-[10px] text-red-300">{state.error}</div>
                          )}
                        </td>
                        <td className="px-4 sm:px-5 py-3.5 text-white/65 text-xs sm:text-sm">{fmtBytes(r.size)}</td>
                        <td className="px-4 sm:px-5 py-3.5 text-white/55 hidden md:table-cell">{fmtDate(r.lastModified)}</td>
                        <td className="px-4 sm:px-5 py-3.5 text-right">
                          <div className="inline-flex items-center gap-2 justify-end">
                            <button
                              onClick={() => transcribe(r.key)}
                              disabled={state.status === 'submitting' || state.status === 'queued'}
                              title="Submit for AI transcription"
                              className="inline-flex items-center gap-1 rounded-lg border border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-100 px-2.5 py-1.5 text-[11px] hover:bg-fuchsia-400/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {state.status === 'submitting' ? '…' : state.status === 'queued' ? '✓ Queued' : 'Transcribe'}
                            </button>
                            <a
                              href={r.downloadUrl}
                              download
                              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-100 px-3 py-1.5 text-xs hover:bg-cyan-400/20 transition"
                            >Download</a>
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
