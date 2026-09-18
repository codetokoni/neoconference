'use client';

// src/app/dashboard/PersonalRoomCard.tsx
//
// "Your permanent room" section on the dashboard. Fetches (or creates
// on first call) the caller's isPermanent event from
// /api/user/personal-room and renders the always-live short URL with a
// copy button and an Open room CTA. Mobile-first — inputs stack cleanly
// on narrow screens, action buttons wrap.

import { useEffect, useState } from 'react';

interface PersonalRoomResponse {
  ok?: boolean;
  slug?: string;
  url?: string;
  error?: string;
}

export default function PersonalRoomCard() {
  const [data, setData] = useState<PersonalRoomResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/user/personal-room', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch(() => {
        if (!cancelled) setData({ error: 'lookup_failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function copyLink() {
    if (!data?.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for clipboard-blocked contexts — select the text so
      // the user can still copy manually.
      const el = document.getElementById('personal-room-url') as HTMLInputElement | null;
      if (el) {
        el.select();
      }
    }
  }

  if (!data) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-xl p-4 sm:p-5">
        <div className="h-4 w-40 rounded bg-white/10 animate-pulse" />
        <div className="mt-3 h-10 w-full rounded bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (!data.ok || !data.url || !data.slug) {
    return null; // Fail-silent — the dashboard still works without this card.
  }

  return (
    <div className="rounded-2xl border border-cyan-300/25 bg-gradient-to-br from-cyan-500/[0.06] to-indigo-500/[0.04] backdrop-blur-xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.22em] text-cyan-200/70">
            Your permanent room
          </div>
          <h3 className="mt-1 text-base sm:text-lg font-semibold text-white truncate">
            Always available — share this link
          </h3>
        </div>
        <span className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.2em] text-cyan-100">
          Live
        </span>
      </div>

      {/* URL row — stacks label above input; input row is a flex with a
          min-w-0 so the URL truncates and the action buttons stay visible. */}
      <div className="mt-4">
        <label
          htmlFor="personal-room-url"
          className="block text-[11px] uppercase tracking-[0.22em] text-white/50 mb-1.5"
        >
          Room link
        </label>
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2.5">
          <input
            id="personal-room-url"
            readOnly
            value={data.url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 bg-transparent border-none outline-none text-xs sm:text-sm text-white/85 font-mono"
            aria-label="Your permanent room link"
          />
          <button
            type="button"
            onClick={copyLink}
            className="shrink-0 rounded-lg border border-cyan-300/40 bg-cyan-400/10 text-cyan-100 text-[11px] px-2.5 py-1 hover:bg-cyan-400/20 transition"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <a
          href={'/' + data.slug}
          className="text-center rounded-xl bg-cyan-400 text-slate-950 font-semibold text-sm px-4 py-2.5 hover:bg-cyan-300 transition"
        >
          Open room →
        </a>
        <a
          href={'/dashboard/e/' + data.slug}
          className="text-center rounded-xl border border-white/15 bg-white/[0.04] text-white/85 text-sm px-4 py-2.5 hover:bg-white/[0.08] transition"
        >
          Manage
        </a>
      </div>

      <p className="mt-3 text-[11px] text-white/50">
        This link is yours forever. It always opens the room — no scheduling, no expiry.
      </p>
    </div>
  );
}
