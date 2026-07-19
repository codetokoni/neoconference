'use client';

import { useEffect, useState } from 'react';

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
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <h1>API keys</h1>
      <p>
        Use these keys to authenticate with the{' '}
        <a href="/docs">NeoConference API</a>. Treat them like passwords.
      </p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. Production)"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={createKey}>Create key</button>
      </div>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {newKey && (
        <div style={{ padding: 12, border: '1px solid #0af', borderRadius: 8, margin: '12px 0' }}>
          <strong>Copy your new key now — it won&apos;t be shown again:</strong>
          <pre style={{ userSelect: 'all', overflowX: 'auto' }}>{newKey}</pre>
        </div>
      )}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Key</th>
              <th align="left">Plan</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td><code>{k.maskedKey}</code></td>
                <td>{k.plan}</td>
                <td align="right">
                  <button onClick={() => revokeKey(k.id)}>Revoke</button>
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={4}>No keys yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}
