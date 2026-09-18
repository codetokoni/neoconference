'use client';

// src/app/dashboard/e/[slug]/InviteByKingsChat.tsx
//
// Per-event "invite by KingsChat handle" card. Sits alongside
// InviteSpeakers on /dashboard/e/<slug>. Assigns the role in the
// event's meeting-roles hash under `kc:<handle>` (see
// /api/events/[id]/invite-kc) and, when the recipient has already
// signed in via KingsChat, pushes an invite message straight to their
// KC via the server-side sender.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

// Wire values match MeetingRole ('host' | 'moderator'). Display labels
// come from LEGACY_ROLE_MAP in permissions.ts, where 'moderator' is
// what a co-host does today. Anything else ('speaker', 'cohost') gets
// normalized down to those two or to 'participant' — no point offering
// them here.
type Role = 'host' | 'moderator';

const ROLE_LABEL: Record<Role, string> = {
  host: 'Host',
  moderator: 'Cohost',
};

type Outcome = {
  handle: string;
  status: 'assigned+sent' | 'assigned' | 'assigned+not_linked' | 'error';
  reason?: string;
};

export default function InviteByKingsChat({
  eventId,
  eventSlug,
}: {
  eventId: string;
  eventSlug: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [handle, setHandle] = useState('');
  const [role, setRole] = useState<Role>('moderator');
  const [sendMessage, setSendMessage] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<Outcome[]>([]);

  async function send() {
    const raw = handle.trim();
    if (!raw) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/events/' + eventId + '/invite-kc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: raw, role, sendMessage }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        assigned?: boolean;
        sent?: boolean;
        sendReason?: string;
        error?: string;
      };
      if (!res.ok || !j.ok) {
        setErr(j.error || 'invite_failed');
      } else {
        const status: Outcome['status'] = j.sent
          ? 'assigned+sent'
          : j.sendReason === 'not_linked'
            ? 'assigned+not_linked'
            : sendMessage
              ? 'error'
              : 'assigned';
        setResults((prev) => [
          {
            handle: raw.replace(/^@/, '').replace(/^kc:/i, ''),
            status,
            reason: j.sendReason,
          },
          ...prev,
        ]);
        setHandle('');
        startTransition(() => router.refresh());
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'invite_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-slate-200">
          Invite by KingsChat
        </h3>
        <span className="text-[10px] uppercase tracking-wider text-cyan-200/70">
          Handle → this event
        </span>
      </div>

      <p className="text-[11px] text-slate-400">
        Assigns the role under their KingsChat handle. Applies the moment
        they sign in via KingsChat. If they've signed in with KC before,
        we can also push an invite message directly to their chat.
      </p>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="@pastorchris"
          className="min-w-0 flex-1 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/60 focus:outline-none font-mono"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/60 focus:outline-none sm:w-36"
        >
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={send}
          disabled={busy || isPending || !handle.trim()}
          className="px-4 py-2 rounded-full bg-cyan-500 text-slate-950 font-medium hover:bg-cyan-400 transition text-sm disabled:opacity-50 disabled:cursor-not-allowed sm:w-32"
        >
          {busy ? 'Sending…' : sendMessage ? 'Invite' : 'Assign'}
        </button>
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          checked={sendMessage}
          onChange={(e) => setSendMessage(e.target.checked)}
          className="accent-cyan-400"
        />
        Push an invite message via KingsChat (falls back to role-only when they
        haven&apos;t linked yet)
      </label>

      {err ? <p className="text-xs text-rose-300">{err}</p> : null}

      {results.length > 0 ? (
        <ul className="text-xs space-y-1 pt-2 border-t border-slate-800">
          {results.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span className="text-slate-300 font-mono truncate">
                @{r.handle}
              </span>
              <StatusPill status={r.status} reason={r.reason} />
            </li>
          ))}
        </ul>
      ) : null}

      {/* Constant reference so the operator can copy the event URL if the
          KC push failed and they need to paste it into KingsChat manually. */}
      <div className="pt-2 border-t border-slate-800 text-[10px] text-slate-500 font-mono truncate">
        Event URL: {typeof window !== 'undefined' ? window.location.origin : 'https://www.neoconference.app'}
        /{eventSlug}
      </div>
    </div>
  );
}

function StatusPill({
  status,
  reason,
}: {
  status: Outcome['status'];
  reason?: string;
}) {
  const cfg: Record<Outcome['status'], { label: string; cls: string }> = {
    'assigned+sent': {
      label: 'Sent ✓',
      cls: 'bg-emerald-500/15 text-emerald-200 border border-emerald-400/40',
    },
    assigned: {
      label: 'Assigned',
      cls: 'bg-cyan-500/15 text-cyan-200 border border-cyan-400/40',
    },
    'assigned+not_linked': {
      label: 'Assigned · not linked',
      cls: 'bg-amber-500/15 text-amber-200 border border-amber-400/40',
    },
    error: {
      label: reason || 'Error',
      cls: 'bg-rose-500/15 text-rose-200 border border-rose-400/40',
    },
  };
  const c = cfg[status];
  return (
    <span
      className={
        'px-2 py-0.5 rounded-full uppercase tracking-wider text-[10px] ' +
        c.cls
      }
      title={reason}
    >
      {c.label}
    </span>
  );
}
