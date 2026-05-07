'use client';

// src/app/dashboard/e/[slug]/DomainPanel.tsx
//
// Owner-side controls for /api/events/[id]/domain. Binds a custom hostname
// to the event so visitors hitting <host>/ land on /e/<slug>. Surfaces the
// CNAME instructions inline once a domain is set so the host can finish DNS.

import { useState } from 'react';

type Props = {
  eventId: string;
  slug: string;
  initial?: string | null;
};

export default function DomainPanel({ eventId, slug, initial }: Props) {
  const [domain, setDomain] = useState(initial || '');
  const [draft, setDraft] = useState(initial || '');
  const [busy, setBusy] = useState<null | 'save' | 'remove'>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(Boolean(initial));

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const res = await fetch('/api/events/' + eventId + '/domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: draft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message || data?.error || ('HTTP ' + res.status));
      } else {
        setDomain(data.domain || draft.trim());
        setShowInstructions(true);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setError(null);
    try {
      const res = await fetch('/api/events/' + eventId + '/domain', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.message || data?.error || ('HTTP ' + res.status));
      } else {
        setDomain('');
        setDraft('');
        setShowInstructions(false);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-fuchsia-400/20 bg-gradient-to-br from-fuchsia-500/[0.05] via-white/[0.02] to-transparent p-5 sm:p-6">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex h-1.5 w-1.5 rounded-full bg-fuchsia-300 shadow-[0_0_8px_2px_rgba(232,121,249,0.7)]" />
        <h3 className="text-base font-semibold">Custom domain</h3>
        {domain ? (
          <span className="text-[10px] uppercase tracking-[0.22em] text-fuchsia-200/80">Bound · {domain}</span>
        ) : (
          <span className="text-[10px] uppercase tracking-[0.22em] text-white/40">Not bound</span>
        )}
      </div>
      <p className="mt-1 text-white/55 text-xs">Point your own hostname (e.g. live.acme.com) at this event. Visitors landing on the host get the public event page.</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="live.acme.com"
          className="flex-1 min-w-[200px] bg-black/30 px-3 py-2 rounded-md text-sm text-white/90 border border-white/10 focus:outline-none focus:border-fuchsia-300/60"
        />
        <button
          type="button"
          onClick={save}
          disabled={!draft.trim() || busy !== null}
          className="text-xs px-3 py-2 rounded-md bg-fuchsia-400/20 hover:bg-fuchsia-400/30 border border-fuchsia-300/40 text-fuchsia-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === 'save' ? 'Binding…' : domain ? 'Update' : 'Bind domain'}
        </button>
        {domain && (
          <button
            type="button"
            onClick={remove}
            disabled={busy !== null}
            className="text-xs px-3 py-2 rounded-md text-rose-300/80 hover:bg-rose-500/10 border border-rose-300/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy === 'remove' ? 'Unbinding…' : 'Unbind'}
          </button>
        )}
      </div>

      {error && (
        <p className="mt-3 text-xs text-rose-300">{error}</p>
      )}

      {showInstructions && domain && (
        <div className="mt-4 rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-white/75 space-y-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-300" />
            <span className="font-medium text-white/90">Almost there — finish DNS in 2 steps:</span>
          </div>
          <ol className="list-decimal pl-5 space-y-1.5">
            <li>
              In <span className="text-cyan-200">Vercel project settings → Domains</span>, add <code className="bg-white/10 px-1 rounded">{domain}</code>.
            </li>
            <li>
              On your DNS provider, add a CNAME record:
              <pre className="mt-1 bg-black/60 rounded px-2 py-1.5 text-cyan-200 font-mono whitespace-pre overflow-x-auto">{domain + '  CNAME  cname.vercel-dns.com'}</pre>
            </li>
          </ol>
          <p className="text-white/45">
            Once propagated, visiting <span className="text-fuchsia-200">{'https://' + domain}</span> will land directly on this event ({slug}).
          </p>
        </div>
      )}
    </div>
  );
}
