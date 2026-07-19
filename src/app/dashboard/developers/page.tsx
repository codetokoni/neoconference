'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface KeyMeta {
  id: string;
  name: string;
  plan: string;
  createdAt: number;
  lastUsedAt: number | null;
  maskedKey: string;
}

/**
 * Dashboard -> Developers: create, view and revoke API keys.
 * The raw key is shown exactly once, immediately after creation.
 * Styled to match the NeoConference neon-cyan on near-black brand palette.
 */
export default function DevelopersPage() {
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/developers/keys');
      const json = await res.json();
      setKeys(json.data || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createKey() {
    setError(null);
    const res = await fetch('/api/developers/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || 'Failed to create key');
      return;
    }
    setNewKey(json.data.key);
    setName('');
    load();
  }

  async function revokeKey(id: string) {
    await fetch(`/api/developers/keys?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    load();
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#03050a] text-cyan-50">
      {/* Animated background orbs */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-32 h-[30rem] w-[30rem] rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-[26rem] w-[26rem] rounded-full bg-sky-400/10 blur-3xl" />
      </div>

      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight neo-gradient-text neo-text-glow">
          API keys
        </h1>
        <p className="mt-3 text-sm text-cyan-100/70">
          Use these keys to authenticate with the{' '}
          <Link href="/docs" className="text-cyan-300 hover:text-cyan-200 transition-colors">
            NeoConference API
          </Link>
          . Treat them like passwords — anyone with a key can act on your account.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name (e.g. Production)"
            className="flex-1 rounded-xl border border-cyan-400/20 bg-[rgba(4,8,16,0.6)] px-4 py-2.5 text-sm text-cyan-50 placeholder-cyan-100/30 outline-none transition-colors focus:border-cyan-400/60"
          />
          <button
            onClick={createKey}
            className="rounded-xl bg-cyan-400 px-5 py-2.5 text-sm font-semibold text-[#03050a] transition-colors hover:bg-cyan-300"
          >
            Create key
          </button>
        </div>

        {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}

        {newKey && (
          <div className="mt-6 rounded-xl border border-cyan-400/30 bg-cyan-400/5 p-4">
            <strong className="block text-sm text-cyan-200">
              Copy your new key now — it won&apos;t be shown again:
            </strong>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-[rgba(4,8,16,0.7)] p-3 text-xs text-cyan-100 select-all">{newKey}</pre>
          </div>
        )}

        {loading ? (
          <p className="mt-10 text-sm text-cyan-100/50">Loading…</p>
        ) : (
          <div className="mt-10 overflow-hidden rounded-2xl border border-cyan-400/15 neo-glass">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-cyan-400/15 text-left text-xs uppercase tracking-wider text-cyan-100/50">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Key</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b border-cyan-400/10 last:border-0">
                    <td className="px-4 py-3 text-cyan-50">{k.name}</td>
                    <td className="px-4 py-3"><code className="text-cyan-300">{k.maskedKey}</code></td>
                    <td className="px-4 py-3 text-cyan-100/70">{k.plan}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => revokeKey(k.id)}
                        className="rounded-lg border border-rose-400/30 px-3 py-1.5 text-xs text-rose-300 transition-colors hover:bg-rose-400/10"
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
                {keys.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-cyan-100/40">
                      No keys yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
