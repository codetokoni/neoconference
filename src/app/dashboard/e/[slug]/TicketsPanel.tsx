"use client";

import { useState } from "react";
import type { TicketTier } from "@/types/event";

type Props = {
  eventId: string;
  initial?: TicketTier[];
};

const CURRENCIES = ["espees"];

function emptyTier(): TicketTier {
  return {
    id: "tier-" + Math.random().toString(36).slice(2, 8),
    label: "General Admission",
    priceCents: 0,
    currency: "espees",
    capacity: undefined,
    sold: 0,
    description: "",
    active: true,
  };
}

export default function TicketsPanel({ eventId, initial }: Props) {
  const [tiers, setTiers] = useState<TicketTier[]>(initial ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  function update(idx: number, patch: Partial<TicketTier>) {
    setTiers((t) => t.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
    setOk(false);
  }

  async function save() {
    setSaving(true);
    setErr(null);
    setOk(false);
    try {
      const res = await fetch(`/api/events/${eventId}/tickets`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tickets: tiers }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      if (json?.event?.tickets) setTiers(json.event.tickets);
      setOk(true);
    } catch (e: any) {
      setErr(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-5 backdrop-blur">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-emerald-200">Tickets &amp; pricing</h3>
          <p className="text-xs text-emerald-200/60">Sell paid access via Stripe Checkout. Buyers skip the waiting room automatically.</p>
        </div>
        <button
          type="button"
          onClick={() => setTiers((t) => [...t, emptyTier()])}
          className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-100 hover:bg-emerald-400/20"
        >
          + Add tier
        </button>
      </header>

      {tiers.length === 0 ? (
        <p className="text-sm text-emerald-200/50">No tiers yet. Add one to start selling.</p>
      ) : (
        <div className="space-y-3">
          {tiers.map((t, i) => (
            <div key={t.id} className="grid grid-cols-1 gap-2 rounded-xl border border-emerald-400/20 bg-black/20 p-3 md:grid-cols-12">
              <input
                value={t.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Tier name"
                className="md:col-span-3 rounded bg-black/40 px-2 py-1 text-sm text-white outline-none ring-1 ring-emerald-400/20 focus:ring-emerald-400/60"
              />
              <input
                type="number"
                min={0}
                step={1}
                value={t.priceCents}
                onChange={(e) => update(i, { priceCents: Math.max(0, parseInt(e.target.value || "0", 10)) })}
                placeholder="Price (cents)"
                className="md:col-span-2 rounded bg-black/40 px-2 py-1 text-sm text-white outline-none ring-1 ring-emerald-400/20 focus:ring-emerald-400/60"
              />
              <select
                value={t.currency}
                onChange={(e) => update(i, { currency: e.target.value })}
                className="md:col-span-1 rounded bg-black/40 px-2 py-1 text-sm uppercase text-white outline-none ring-1 ring-emerald-400/20 focus:ring-emerald-400/60"
              >
                {CURRENCIES.map((c) => (<option key={c} value={c}>{c.toUpperCase()}</option>))}
              </select>
              <input
                type="number"
                min={0}
                value={t.capacity ?? ""}
                onChange={(e) => update(i, { capacity: e.target.value ? parseInt(e.target.value, 10) : undefined })}
                placeholder="Cap"
                className="md:col-span-1 rounded bg-black/40 px-2 py-1 text-sm text-white outline-none ring-1 ring-emerald-400/20 focus:ring-emerald-400/60"
              />
              <input
                value={t.description ?? ""}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="Description (optional)"
                className="md:col-span-3 rounded bg-black/40 px-2 py-1 text-sm text-white outline-none ring-1 ring-emerald-400/20 focus:ring-emerald-400/60"
              />
              <label className="md:col-span-1 flex items-center gap-1 text-xs text-emerald-200/80">
                <input type="checkbox" checked={t.active !== false} onChange={(e) => update(i, { active: e.target.checked })} />
                Live
              </label>
              <button
                type="button"
                onClick={() => setTiers((arr) => arr.filter((_, k) => k !== i))}
                className="md:col-span-1 rounded border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20"
              >
                Remove
              </button>
              {typeof t.sold === "number" && t.sold > 0 ? (
                <div className="md:col-span-12 text-[11px] text-emerald-200/60">Sold so far: {t.sold}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-emerald-400 px-4 py-1.5 text-xs font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save tiers"}
        </button>
        {ok ? <span className="text-xs text-emerald-300">Saved.</span> : null}
        {err ? <span className="text-xs text-rose-300">{err}</span> : null}
      </div>
    </section>
  );
}

