"use client";

// Account settings → Notifications: which optional messages to get, per
// channel. Transactional and security email is listed as always on.

import { useEffect, useState } from "react";

type Channel = "email" | "inApp" | "push";
type Category = { key: string; label: string; description: string };
type Prefs = { categories: Record<string, Record<Channel, boolean>> };

const CHANNELS: Array<[Channel, string]> = [
  ["email", "Email"],
  ["inApp", "In the app"],
  ["push", "Push"],
];

export default function NotificationPrefs() {
  const [cats, setCats] = useState<Category[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me/comms-prefs", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { categories: Category[]; prefs: Prefs }) => {
        setCats(d.categories);
        setPrefs(d.prefs);
      })
      .catch(() => setError("Could not load your notification choices."));
  }, []);

  const flip = async (cat: string, ch: Channel) => {
    if (!prefs) return;
    const value = !prefs.categories[cat][ch];
    const key = `${cat}.${ch}`;
    setSaving(key);
    setError(null);
    // Shown at once; put back if the server says no.
    setPrefs({ categories: { ...prefs.categories, [cat]: { ...prefs.categories[cat], [ch]: value } } });
    try {
      const r = await fetch("/api/me/comms-prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [cat]: { [ch]: value } }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setPrefs((await r.json()).prefs);
    } catch {
      setPrefs(prefs);
      setError("That change was not saved. Try again.");
    } finally {
      setSaving(null);
    }
  };

  if (error && !prefs) return <p className="text-sm text-red-400">{error}</p>;
  if (!cats || !prefs) return <p className="text-sm text-zinc-500">Loading…</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead className="bg-white/[0.03] text-xs text-zinc-400">
          <tr>
            <th className="px-3 py-2 font-medium">What</th>
            {CHANNELS.map(([, l]) => (
              <th key={l} className="px-3 py-2 font-medium">
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cats.map((c) => (
            <tr key={c.key} className="border-t border-white/5">
              <td className="px-3 py-2">
                <span className="text-zinc-100">{c.label}</span>
                <span className="block text-xs text-zinc-500">{c.description}</span>
              </td>
              {CHANNELS.map(([ch, l]) => (
                <td key={ch} className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`${c.label} — ${l}`}
                    checked={prefs.categories[c.key]?.[ch] ?? true}
                    disabled={saving === `${c.key}.${ch}`}
                    onChange={() => flip(c.key, ch)}
                    className="h-4 w-4 accent-cyan-400"
                  />
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-white/5">
            <td className="px-3 py-2">
              <span className="text-zinc-100">Your account and meetings</span>
              <span className="block text-xs text-zinc-500">Invitations, changes and cancellations, sign-in and security notices, receipts, service notices.</span>
            </td>
            <td colSpan={3} className="px-3 py-2 text-xs text-zinc-400">
              Always on
            </td>
          </tr>
        </tbody>
      </table>
      {error && <p className="px-3 py-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
