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

  const recordings = (data?.recordings || []).filter((r) =>
    !filter ? true : r.key.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <main className="min-h-screen bg-[#05070d] text-white relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-50">
        <div className="absolute -top-40 -left-40 h-[480px] w-[480px] rounded-full bg-cyan-500/15 blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[420px] w-[420px] rounded-full bg-indigo-500/15 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-12 md:py-16">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link href="/" className="text-sm text-white/60 hover:text-white transition">← Back to NeoConference</Link>
          <span className="text-xs uppercase tracking-[0.3em] text-cyan-300/70">Recordings</span>
        </div>

        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight">
              Your <span className="bg-gradient-to-r from-cyan-300 to-indigo-300 bg-clip-text text-transparent">recordings</span>
            </h1>
            <p className="mt-2 text-white/60 text-sm">
              Stored on Cloudflare R2. Download links expire after 1 hour — refresh this page for new ones.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by room or filename"
              className="rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm w-72 outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20 transition"
            />
            <button
              onClick={load}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm hover:bg-white/10 transition"
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

        <div className="mt-8 rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-xl overflow-hidden">
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
            <table className="w-full text-sm">
              <thead className="bg-white/[0.02] border-b border-white/10">
                <tr className="text-left text-[11px] uppercase tracking-[0.2em] text-white/45">
                  <th className="px-5 py-3 font-normal">File</th>
                  <th className="px-5 py-3 font-normal w-32">Size</th>
                  <th className="px-5 py-3 font-normal w-56">Recorded</th>
                  <th className="px-5 py-3 font-normal w-32 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {recordings.map((r) => (
                  <tr key={r.key} className="border-b border-white/5 hover:bg-white/[0.02] transition">
                    <td className="px-5 py-3.5">
                      <div className="font-mono text-white/90 truncate max-w-[420px]" title={r.key}>{r.key}</div>
                    </td>
                    <td className="px-5 py-3.5 text-white/65">{fmtBytes(r.size)}</td>
                    <td className="px-5 py-3.5 text-white/55">{fmtDate(r.lastModified)}</td>
                    <td className="px-5 py-3.5 text-right">
                      <a
                        href={r.downloadUrl}
                        download
                        className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 text-cyan-100 px-3 py-1.5 text-xs hover:bg-cyan-400/20 transition"
                      >Download</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
