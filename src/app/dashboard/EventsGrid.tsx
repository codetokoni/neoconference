'use client';

// src/app/dashboard/EventsGrid.tsx
//
// Client wrapper around the per-event cards that adds a "Select" mode.
// In select mode each card gets a checkbox in its top-left corner and
// a sticky action bar at the bottom offers Delete for the current
// selection. Outside select mode the cards behave exactly as before.
//
// Everything is state-inline — no context, no global stores — because
// dashboard is a single tree and the selection is genuinely local.

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { NeoEvent } from '@/types/event';

export interface EventCardData {
  id: string;
  slug: string;
  name: string;
  state: NeoEvent['state'];
  updatedAt?: string;
  livekitRoom: string;
  recordingsCount: number;
  transcriptCount: number;
}

export default function EventsGrid({ events }: { events: EventCardData[] }) {
  const router = useRouter();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedList = useMemo(
    () => events.filter((e) => selected.has(e.slug)),
    [events, selected],
  );

  function enterSelectMode() {
    setSelectMode(true);
  }
  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }
  function toggleOne(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(events.map((e) => e.slug)));
  }

  async function performDelete() {
    if (confirmText.trim().toUpperCase() !== 'DELETE') return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/events/bulk-delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slugs: selectedList.map((e) => e.slug),
          confirm: 'DELETE',
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        deleted?: string[];
        failed?: { slug: string; reason: string }[];
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setError(j.error || 'bulk_delete_failed');
        setBusy(false);
        return;
      }
      setConfirmOpen(false);
      setConfirmText('');
      exitSelectMode();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'bulk_delete_failed');
      setBusy(false);
    }
  }

  return (
    <>
      {/* Toolbar row — sits above the grid so the layout doesn't jump when
          Select mode enters. Toolbar is always rendered; buttons swap. */}
      <div className="mb-3 flex items-center justify-end gap-2 text-xs">
        {selectMode ? (
          <>
            <span className="mr-auto text-white/60">
              {selected.size} selected of {events.length}
            </span>
            <button
              type="button"
              onClick={selectAll}
              className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-white/80 hover:bg-white/[0.08]"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={exitSelectMode}
              className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-white/80 hover:bg-white/[0.08]"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={enterSelectMode}
            className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-white/80 hover:bg-white/[0.08]"
          >
            Select…
          </button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {events.map((ev) => (
          <EventCard
            key={ev.id}
            ev={ev}
            selectMode={selectMode}
            selected={selected.has(ev.slug)}
            onToggle={() => toggleOne(ev.slug)}
          />
        ))}
      </div>

      {/* Sticky action bar when there's a selection. */}
      {selectMode && selected.size > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-rose-400/40 bg-[#0a0b12]/95 px-5 py-3 shadow-2xl backdrop-blur-xl">
            <span className="text-sm text-white/85">
              {selected.size} event{selected.size === 1 ? '' : 's'} selected
            </span>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="rounded-full bg-rose-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-rose-400 transition"
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}

      {/* Confirm modal. Owner types "DELETE" as sentinel to unlock. */}
      {confirmOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => (busy ? null : setConfirmOpen(false))}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-[#0a0b12] shadow-2xl overflow-hidden"
          >
            <div className="px-6 py-5 border-b border-rose-500/20 bg-rose-500/5">
              <h2 className="text-lg font-semibold text-rose-100">
                Delete {selected.size} event{selected.size === 1 ? '' : 's'}
              </h2>
              <p className="text-xs text-rose-200/70 mt-1">
                This action cannot be undone.
              </p>
            </div>

            <div className="px-6 py-5 space-y-4 text-sm text-slate-200">
              <ul className="max-h-40 overflow-auto text-xs text-slate-400 space-y-1 border border-slate-800 rounded-lg p-3 bg-slate-900/40">
                {selectedList.map((ev) => (
                  <li key={ev.id} className="flex justify-between gap-2">
                    <span className="truncate text-white/80">{ev.name}</span>
                    <span className="font-mono text-white/40">/{ev.slug}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-400">
                Event records + all slug aliases will be removed. Share links stop
                resolving. Recording files in R2 are NOT touched.
              </p>
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">
                  Type{' '}
                  <code className="font-mono text-rose-200 bg-rose-500/10 px-1.5 py-0.5 rounded">
                    DELETE
                  </code>{' '}
                  to confirm:
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 focus:border-rose-400 focus:outline-none text-sm font-mono"
                  placeholder="DELETE"
                />
              </div>
              {error ? (
                <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                  {error}
                </div>
              ) : null}
            </div>

            <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40">
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={busy}
                className="px-4 py-2 rounded-full border border-slate-700 text-slate-300 hover:border-slate-500 transition text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={performDelete}
                disabled={busy || confirmText.trim().toUpperCase() !== 'DELETE'}
                className="px-4 py-2 rounded-full bg-rose-500 text-slate-950 font-medium hover:bg-rose-400 transition text-sm disabled:bg-rose-500/40 disabled:text-rose-100/60 disabled:cursor-not-allowed"
              >
                {busy ? 'Deleting…' : `Delete ${selected.size}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function EventCard({
  ev,
  selectMode,
  selected,
  onToggle,
}: {
  ev: EventCardData;
  selectMode: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const updated = ev.updatedAt ? new Date(ev.updatedAt).toLocaleDateString() : '';

  // Deterministic gradient seed from slug for thumbnail variety.
  const seed = ev.slug.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 4;
  const gradients = [
    'from-cyan-500/30 via-sky-500/15 to-indigo-500/20',
    'from-fuchsia-500/25 via-pink-500/15 to-rose-500/20',
    'from-emerald-500/25 via-teal-500/15 to-cyan-500/20',
    'from-amber-500/20 via-orange-500/15 to-rose-500/20',
  ];
  const gradient = gradients[seed];

  const wrapperClass =
    'group relative rounded-2xl border bg-white/[0.03] backdrop-blur-xl overflow-hidden transition ' +
    (selected
      ? 'border-cyan-300/60 shadow-[0_0_0_1px_rgba(103,232,249,0.35)]'
      : 'border-white/10 hover:border-cyan-300/30');

  return (
    <div className={wrapperClass}>
      {/* Thumbnail */}
      <div
        className={
          'relative h-28 sm:h-32 bg-gradient-to-br ' + gradient + ' overflow-hidden ' +
          (selectMode ? 'cursor-pointer' : '')
        }
        onClick={selectMode ? onToggle : undefined}
        role={selectMode ? 'button' : undefined}
        aria-pressed={selectMode ? selected : undefined}
      >
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(255,255,255,0.08),transparent_60%)]" />
        <StateBadge state={ev.state} shifted={selectMode} />
        {ev.recordingsCount > 0 && (
          <span className="absolute bottom-2.5 right-2.5 rounded-full bg-black/55 backdrop-blur px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-white/85">
            {ev.recordingsCount} clip{ev.recordingsCount === 1 ? '' : 's'}
          </span>
        )}
        {selectMode ? (
          <label
            className="absolute top-2.5 left-2.5 flex h-6 w-6 items-center justify-center rounded-md border border-white/25 bg-black/55 backdrop-blur cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              className="h-4 w-4 accent-cyan-400 cursor-pointer"
              aria-label={'Select ' + ev.name}
            />
          </label>
        ) : null}
      </div>

      <div className="p-4 sm:p-5">
        <h3 className="text-base font-semibold text-white truncate" title={ev.name}>
          {ev.name}
        </h3>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-white/45 uppercase tracking-[0.18em]">
          <span className="truncate">/{ev.slug}</span>
          {updated && (
            <>
              <span>·</span>
              <span>{updated}</span>
            </>
          )}
        </div>

        {ev.transcriptCount > 0 && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-fuchsia-500/10 border border-fuchsia-300/20 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.2em] text-fuchsia-200">
            <span className="h-1 w-1 rounded-full bg-fuchsia-300" /> {ev.transcriptCount}{' '}
            transcript{ev.transcriptCount === 1 ? '' : 's'}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2 text-xs">
          {/* In select mode the action buttons stay clickable but visually
              muted, so an accidental click on the card body doesn't open
              /manage while the operator is trying to check a box. */}
          <Link
            href={'/dashboard/e/' + ev.slug}
            className={
              'flex-1 text-center rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 hover:bg-white/[0.08] transition ' +
              (selectMode ? 'opacity-60' : '')
            }
          >
            Manage
          </Link>
          <Link
            href={'/e/' + ev.slug + '/replay'}
            className={
              'flex-1 text-center rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 hover:bg-white/[0.08] transition ' +
              (selectMode ? 'opacity-60' : '')
            }
          >
            Replay
          </Link>
          <Link
            href={'/' + ev.slug}
            className={
              'flex-1 text-center rounded-lg border border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-100 px-3 py-2 hover:bg-cyan-300/[0.14] transition ' +
              (selectMode ? 'opacity-60' : '')
            }
          >
            Open room →
          </Link>
        </div>
      </div>
    </div>
  );
}

function StateBadge({
  state,
  shifted,
}: {
  state: NeoEvent['state'];
  shifted?: boolean;
}) {
  const cfg: Record<NeoEvent['state'], { label: string; cls: string }> = {
    scheduled: { label: 'Scheduled', cls: 'bg-white/10 text-white/85' },
    waiting: {
      label: 'Waiting',
      cls: 'bg-amber-500/20 text-amber-100 border border-amber-300/25',
    },
    live: {
      label: 'Live',
      cls: 'bg-rose-500/20 text-rose-100 border border-rose-300/30 animate-pulse',
    },
    ended: { label: 'Ended', cls: 'bg-white/10 text-white/65' },
    replay: {
      label: 'Replay',
      cls: 'bg-cyan-500/15 text-cyan-100 border border-cyan-300/25',
    },
    archived: { label: 'Archived', cls: 'bg-white/5 text-white/40' },
  };
  const c = cfg[state] || cfg.scheduled;
  const positionCls = shifted ? 'top-2.5 left-11' : 'top-2.5 left-2.5';
  return (
    <span
      className={
        'absolute ' + positionCls + ' rounded-full backdrop-blur px-2.5 py-0.5 text-[10px] uppercase tracking-[0.2em] ' +
        c.cls
      }
    >
      {c.label}
    </span>
  );
}
