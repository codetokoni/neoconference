'use client';

// src/app/dashboard/e/[slug]/ChaptersPanel.tsx
//
// Owner-side controls for /api/events/[id]/chapters. Lets the host:
//   - run AI derivation (gpt-4o-mini) when configured
//   - run heuristic derivation (always works)
//   - inline-edit existing chapter labels / start times
//   - delete or reorder rows, then PUT the result as 'manual' source

import { useState } from 'react';
import type { Chapter } from '@/types/event';

type Props = {
  eventId: string;
  initial: Chapter[];
  hasTranscript: boolean;
};

function fmt(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
  return h > 0 ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

function parseTs(input: string): number {
  const parts = input.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export default function ChaptersPanel({ eventId, initial, hasTranscript }: Props) {
  const [chapters, setChapters] = useState<Chapter[]>(initial);
  const [busy, setBusy] = useState<null | 'ai' | 'heuristic' | 'save'>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  async function derive(mode: 'ai' | 'heuristic') {
    setBusy(mode);
    setError(null);
    try {
      const res = await fetch('/api/events/' + eventId + '/chapters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message || data?.error || ('HTTP ' + res.status));
      } else {
        setChapters(data.chapters || []);
        setDirty(false);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const res = await fetch('/api/events/' + eventId + '/chapters', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapters }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message || data?.error || ('HTTP ' + res.status));
      } else {
        setChapters(data.chapters || []);
        setDirty(false);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  function update(idx: number, patch: Partial<Chapter>) {
    setChapters((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
    setDirty(true);
  }
  function remove(idx: number) {
    setChapters((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }
  function add() {
    const last = chapters[chapters.length - 1];
    const startSec = last ? (last.startSec || 0) + 60 : 0;
    setChapters((prev) => [...prev, { id: 'manual-' + Date.now(), startSec, label: 'New chapter', source: 'manual' as const }]);
    setDirty(true);
  }

  return (
    <div className="rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/[0.06] via-white/[0.02] to-transparent p-5 sm:p-6">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-300 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)]" />
        <h3 className="text-base font-semibold">Chapters</h3>
        <span className="text-[10px] uppercase tracking-[0.22em] text-white/40">{chapters.length} markers</span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            disabled={!hasTranscript || busy !== null}
            onClick={() => derive('ai')}
            className="text-xs px-3 py-1.5 rounded-md bg-cyan-400/10 hover:bg-cyan-400/20 border border-cyan-300/30 text-cyan-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === 'ai' ? 'Thinking…' : 'Auto · AI'}
          </button>
          <button
            type="button"
            disabled={!hasTranscript || busy !== null}
            onClick={() => derive('heuristic')}
            className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === 'heuristic' ? 'Working…' : 'Auto · Fast'}
          </button>
        </div>
      </div>
      {!hasTranscript && (
        <p className="mt-3 text-xs text-amber-200/80">Run a transcript first (Recordings → Transcribe) to enable auto-derivation.</p>
      )}
      {error && (
        <p className="mt-3 text-xs text-rose-300">{error}</p>
      )}
      <ul className="mt-4 space-y-2">
        {chapters.map((c, i) => (
          <li key={c.id || ('row-' + i)} className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/30 px-2 py-1.5">
            <input
              value={fmt(c.startSec)}
              onChange={(e) => update(i, { startSec: parseTs(e.target.value) })}
              className="w-20 bg-transparent text-cyan-200 font-mono text-xs tabular-nums px-2 py-1 rounded border border-cyan-300/20 focus:outline-none focus:border-cyan-300/60"
            />
            <input
              value={c.label}
              onChange={(e) => update(i, { label: e.target.value })}
              className="flex-1 min-w-0 bg-transparent text-sm text-white/90 px-2 py-1 rounded border border-white/10 focus:outline-none focus:border-cyan-300/60"
            />
            <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-white/40">{c.source}</span>
            <button
              type="button"
              onClick={() => remove(i)}
              className="shrink-0 text-xs px-2 py-1 rounded text-rose-300/80 hover:bg-rose-500/10"
              aria-label="Remove chapter"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={add}
          className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-white/80"
        >
          + Add chapter
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || busy !== null}
          className="ml-auto text-xs px-3 py-1.5 rounded-md bg-cyan-400/20 hover:bg-cyan-400/30 border border-cyan-300/40 text-cyan-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === 'save' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
      </div>
    </div>
  );
}

