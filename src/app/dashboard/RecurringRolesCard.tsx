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

// Only 'host' and 'moderator' are real grantable MeetingRole values
// (see permissions.ts). 'cohost' is a display alias that normalizes to
// 'moderator'; 'speaker' collapses to 'participant' and doesn't make
// sense as a "permanent" role.
type RoleValue = 'host' | 'moderator';

interface RoleItem {
  identifier: string;
  isEmail: boolean;
  isKcHandle: boolean;
  role: RoleValue;
  addedAt: number;
  addedBy: string | null;
}

const ROLE_LABEL: Record<RoleValue, string> = {
  host: 'Host',
  moderator: 'Cohost',
};

/** Human-readable label for a stored identifier. `kc:pastorchris` renders
 *  as `@pastorchris` — the shape the operator typed in. */
function displayIdentifier(item: RoleItem): string {
  if (item.isKcHandle) return '@' + item.identifier.slice(3);
  return item.identifier;
}

/** Copy-to-clipboard invite message. Keeps the phrasing generic so the
 *  operator can paste it into KingsChat, WhatsApp, email, or wherever. */
function inviteText(item: RoleItem, siteUrl: string): string {
  const who = displayIdentifier(item);
  const role = ROLE_LABEL[item.role as RoleValue] || item.role;
  return (
    'Hi ' + who + ' — you\'ve been added as a permanent ' + role +
    ' on NeoConference. Sign in at ' + siteUrl +
    ' (KingsChat, Neomail, or email) and you\'ll automatically be a ' +
    role + ' in every meeting I run.'
  );
}

export default function RecurringRolesCard() {
  const [items, setItems] = useState<RoleItem[] | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<RoleValue>('moderator'); // default = Cohost
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
          placeholder="email@example.com, @kcHandle, or user_XXXXX"
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
              <RoleRow key={it.identifier} item={it} onRemove={() => remove(it.identifier)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RoleRow({
  item,
  onRemove,
}: {
  item: RoleItem;
  onRemove: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<null | 'sent' | 'not_linked' | 'sender_not_linked' | 'error'>(null);

  const siteUrl =
    typeof window !== 'undefined' ? window.location.origin : 'https://www.neoconference.app';

  async function copyInvite() {
    const message = inviteText(item, siteUrl);
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore — the user can retry
    }
  }

  async function sendViaKc() {
    if (!item.isKcHandle || sending) return;
    setSending(true);
    setSendStatus(null);
    try {
      const r = await fetch('/api/kc/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: item.identifier.slice(3), // drop "kc:" prefix
          message: inviteText(item, siteUrl),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (r.ok && j.ok) setSendStatus('sent');
      // The recipient has never signed in here, so we don't know their
      // KingsChat id — versus you (the sender) needing to sign in with
      // KingsChat so the message can come from your account.
      else if (j.error === 'recipient_not_found') setSendStatus('not_linked');
      else if (j.error === 'sender_not_linked') setSendStatus('sender_not_linked');
      else setSendStatus('error');
      setTimeout(() => setSendStatus(null), 4000);
    } catch {
      setSendStatus('error');
      setTimeout(() => setSendStatus(null), 4000);
    } finally {
      setSending(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm bg-white/[0.02]">
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs"
        title={item.identifier}
      >
        {item.isKcHandle ? (
          <span className="text-cyan-100">{displayIdentifier(item)}</span>
        ) : (
          <span className="text-white/85">{item.identifier}</span>
        )}
        {item.isKcHandle ? (
          <span className="ml-1.5 text-[10px] uppercase tracking-[0.2em] text-cyan-200/60">
            KingsChat
          </span>
        ) : null}
      </span>
      <span className="shrink-0 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-cyan-100">
        {ROLE_LABEL[item.role as RoleValue] || item.role}
      </span>
      {item.isKcHandle ? (
        <button
          type="button"
          onClick={sendViaKc}
          disabled={sending}
          className="shrink-0 text-[11px] text-cyan-200/80 hover:text-cyan-100 transition px-2 disabled:opacity-50"
          title={
            sendStatus === 'not_linked'
              ? "This person hasn't signed in via KingsChat yet — copy the invite and send it manually."
              : sendStatus === 'sender_not_linked'
                ? 'Messages go out from your own KingsChat account. Sign in with KingsChat once, then send again.'
                : 'Push an invite message directly to their KingsChat'
          }
        >
          {sending
            ? 'Sending…'
            : sendStatus === 'sent'
              ? 'Sent ✓'
              : sendStatus === 'not_linked'
                ? 'Not linked'
                : sendStatus === 'sender_not_linked'
                  ? 'Sign in with KC first'
                  : sendStatus === 'error'
                  ? 'Retry'
                  : 'Send via KC'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={copyInvite}
        className="shrink-0 text-[11px] text-cyan-200/80 hover:text-cyan-100 transition px-2"
        title="Copy an invite message you can paste into KingsChat / WhatsApp / email"
      >
        {copied ? 'Copied' : 'Copy invite'}
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 text-[11px] text-rose-300/80 hover:text-rose-200 transition px-2"
        aria-label={'Remove ' + item.identifier}
      >
        Remove
      </button>
    </li>
  );
}
