'use client';

// src/app/dashboard/RecurringRolesCard.tsx
//
// "Recurring hosts & moderators" section on the dashboard. Manages the
// caller's per-owner recurring roles list — every new event they create
// gets these roles pre-applied so they don't have to promote Sarah in
// meeting after meeting after meeting.
//
// Existing events are NOT retro-applied — that would silently escalate
// people the owner may not have intended for older meetings. Only new
// events created from now on inherit the list.

import { useEffect, useState } from 'react';

type RoleValue = 'host' | 'cohost' | 'moderator' | 'speaker';

interface RoleItem {
  identifier: string;
  isEmail: boolean;
  role: RoleValue;
  addedAt: number;
  addedBy: string | null;
}

const ROLE_LABEL: Record<RoleValue, string> = {
  host: 'Host',
  cohost: 'Cohost',
  moderator: 'Moderator',
  speaker: 'Speaker',
};

export default function RecurringRolesCard() {
  const [items, setItems] = useState<RoleItem[] | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<RoleValue>('moderator');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch('/api/user/recurring-roles', { cache: 'no-store' });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        items?: RoleItem[];
      };
      if (r.ok && j.ok) setItems(j.items || []);
      else setItems([]);
    } catch {
      setItems([]);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    const value = identifier.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/user/recurring-roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: value, role }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setError(j.error || 'add_failed');
      } else {
        setIdentifier('');
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await fetch('/api/user/recurring-roles', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: id }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'remove_failed');
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.22em] text-white/50">
            Recurring hosts & moderators
          </div>
          <h3 className="mt-1 text-base sm:text-lg font-semibold text-white truncate">
            People with a permanent role in your meetings
          </h3>
          <p className="mt-1 text-[11px] text-white/45">
            Applied automatically to every new event you create. Existing events
            are not changed — add to those manually.
          </p>
        </div>
      </div>

      {/* Add row — stacks on mobile, side-by-side on sm+ */}
      <div className="mt-4 flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="email@example.com or user_XXXXX"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white/85 focus:border-cyan-400/60 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as RoleValue)}
          className="rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-white/85 focus:border-cyan-400/60 focus:outline-none sm:w-40"
        >
          {(Object.keys(ROLE_LABEL) as RoleValue[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={add}
          disabled={busy || !identifier.trim()}
          className="rounded-xl bg-cyan-400 text-slate-950 text-sm font-semibold px-4 py-2.5 hover:bg-cyan-300 transition disabled:opacity-50 disabled:cursor-not-allowed sm:w-28"
        >
          {busy ? '…' : 'Add'}
        </button>
      </div>

      {error ? (
        <div className="mt-2 text-xs text-rose-300">{error}</div>
      ) : null}

      {/* List */}
      <div className="mt-4">
        {items === null ? (
          <div className="h-8 w-40 rounded bg-white/5 animate-pulse" />
        ) : items.length === 0 ? (
          <div className="text-xs text-white/45 italic">
            No recurring roles yet.
          </div>
        ) : (
          <ul className="divide-y divide-white/5 rounded-xl border border-white/10 overflow-hidden">
            {items.map((it) => (
              <li
                key={it.identifier}
                className="flex items-center gap-2 px-3 py-2.5 text-sm bg-white/[0.02]"
              >
                <span className="min-w-0 flex-1 truncate text-white/85 font-mono text-xs">
                  {it.identifier}
                </span>
                <span className="shrink-0 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-cyan-100">
                  {ROLE_LABEL[it.role as RoleValue] || it.role}
                </span>
                <button
                  type="button"
                  onClick={() => remove(it.identifier)}
                  className="shrink-0 text-[11px] text-rose-300/80 hover:text-rose-200 transition px-2"
                  aria-label={'Remove ' + it.identifier}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
