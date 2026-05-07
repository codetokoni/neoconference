"use client";

import { useState } from "react";
import type { TicketTier } from "@/types/event";

type Props = {
  eventId: string;
  tickets: TicketTier[];
};

function fmtPrice(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2) + " " + currency.toUpperCase();
  }
}

export default function TicketsList({ eventId, tickets }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!tickets || tickets.length === 0) return null;

  async function buy(tierId: string) {
    setBusyId(tierId);
    setErr(null);
    try {
      const res = await fetch(`/api/events/${eventId}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tierId }),
      });
      const json = await res.json();
      if (!res.ok || !json?.url) throw new Error(json?.error || "Checkout failed");
      window.location.href = json.url;
    } catch (e: any) {
      setErr(e?.message || "Checkout failed");
      setBusyId(null);
    }
  }

  return (
    <section className="neo-event-section">
      <h2 style={{ marginBottom: 12 }}>Tickets</h2>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {tickets.map((t) => {
          const soldOut = typeof t.capacity === "number" && (t.sold ?? 0) >= t.capacity;
          return (
            <div
              key={t.id}
              style={{
                border: "1px solid rgba(110, 231, 183, 0.25)",
                background: "rgba(16, 185, 129, 0.08)",
                borderRadius: 14,
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 16 }}>{t.label}</div>
              <div style={{ fontSize: 22, color: "#6ee7b7" }}>{fmtPrice(t.priceCents, t.currency)}</div>
              {t.description ? (
                <div style={{ fontSize: 13, opacity: 0.7 }}>{t.description}</div>
              ) : null}
              <button
                type="button"
                disabled={busyId === t.id || soldOut}
                onClick={() => buy(t.id)}
                style={{
                  marginTop: 6,
                  padding: "8px 14px",
                  borderRadius: 10,
                  border: "none",
                  background: soldOut ? "#475569" : "#34d399",
                  color: "#022c22",
                  fontWeight: 600,
                  cursor: soldOut ? "not-allowed" : "pointer",
                }}
              >
                {soldOut ? "Sold out" : busyId === t.id ? "Redirecting…" : "Buy ticket"}
              </button>
            </div>
          );
        })}
      </div>
      {err ? (
        <p style={{ marginTop: 10, color: "#fda4af", fontSize: 13 }}>{err}</p>
      ) : null}
    </section>
  );
}

