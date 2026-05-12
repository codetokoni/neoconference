"use client";

// src/components/WaitingRoomPanel.tsx
//
// Host-side panel for approving / denying attendees who are knocking on
// an event-bound room. Polls /api/waiting-room?slug=<slug> every 4s.
// Only renders when the caller is host or cohost AND the room is bound to
// an event slug. The parent decides when to mount this; this component
// just guards on its own props for safety.

import { useEffect, useState } from "react";
import { zIndex } from "@/lib/zIndex";

interface WaitingEntry {
  id: string;
  name: string;
  email?: string;
  requestedAt: number;
  status: "pending" | "admitted" | "denied";
}

export default function WaitingRoomPanel({
  open,
  onClose,
  eventSlug,
  isHost,
}: {
  open: boolean;
  onClose: () => void;
  eventSlug?: string;
  isHost: boolean;
}) {
  const [entries, setEntries] = useState<WaitingEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deniedIds, setDeniedIds] = useState<Set<string>>(new Set());
  const [admitAllBusy, setAdmitAllBusy] = useState(false);
  // Hydrate denied set from sessionStorage (per-room key) so denied attendees
  // stay suppressed for the rest of this tab session.
  useEffect(() => {
    if (typeof window === "undefined" || !eventSlug) return;
    try {
      const raw = sessionStorage.getItem(`nc:waiting:denied:${eventSlug}`);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) setDeniedIds(new Set(arr));
      }
    } catch {}
  }, [eventSlug]);
  // Persist whenever it changes.
  useEffect(() => {
    if (typeof window === "undefined" || !eventSlug) return;
    try {
      sessionStorage.setItem(
        `nc:waiting:denied:${eventSlug}`,
        JSON.stringify(Array.from(deniedIds))
      );
    } catch {}
  }, [deniedIds, eventSlug]);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Poll the queue while open.
  useEffect(() => {
    if (!open || !isHost || !eventSlug) return;
    let cancelled = false;
    let timer: any = null;

    const fetchQueue = async () => {
      try {
        const res = await fetch(
          `/api/waiting-room?slug=${encodeURIComponent(eventSlug)}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setEntries(Array.isArray(data.entries) ? data.entries : []);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load queue");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    fetchQueue();
    timer = setInterval(fetchQueue, 4000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [open, isHost, eventSlug]);

  const decide = async (entryId: string, decision: "admit" | "deny") => {
    if (!eventSlug || busyId) return;
    setBusyId(entryId);
    try {
      const res = await fetch("/api/waiting-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "decide",
          slug: eventSlug,
          entryId,
          decision,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      if (decision === "deny") {
        setDeniedIds((prev) => {
          const next = new Set(prev);
          next.add(entryId);
          return next;
        });
      }
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entryId
            ? { ...e, status: decision === "admit" ? "admitted" : "denied" }
            : e
        )
      );
    } catch (e: any) {
      setError(e?.message || "Decision failed");
    } finally {
      setBusyId(null);
    }
  };


  const admitAll = async () => {
    if (!eventSlug || admitAllBusy) return;
    const queue = entries.filter(
      (e) => e.status === "pending" && !deniedIds.has(e.id)
    );
    if (queue.length === 0) return;
    setAdmitAllBusy(true);
    try {
      for (const e of queue) {
        try {
          const res = await fetch("/api/waiting-room", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              op: "decide",
              slug: eventSlug,
              entryId: e.id,
              decision: "admit",
            }),
          });
          if (res.ok) {
            setEntries((prev) =>
              prev.map((x) =>
                x.id === e.id ? { ...x, status: "admitted" } : x
              )
            );
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      setAdmitAllBusy(false);
    }
  };
  if (!open) return null;
  if (!isHost) return null;
  if (!eventSlug) return null;

  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        zIndex: zIndex.panelModal,
        background: "rgba(17, 17, 24, 0.98)",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        paddingBottom: "calc(80px + env(safe-area-inset-bottom, 0px))",
        boxSizing: "border-box",
      }
    : {
        position: "absolute",
        top: 48,
        left: 8,
        bottom: 8,
        width: 320,
        zIndex: 13,
        background: "rgba(17, 17, 24, 0.96)",
        color: "#fff",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.08)",
      };

  const pending = entries.filter(
    (e) => e.status === "pending" && !deniedIds.has(e.id)
  );
  const decided = entries.filter((e) => e.status !== "pending").slice(-10);

  return (
    <aside
      data-room-chrome="true"
      style={panelStyle}
    >
      <div
        style={{
          padding: "10px 14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #2a2a33",
          fontSize: 13,
        }}
      >
        <strong>Waiting room ({pending.length})</strong>

        {pending.length >= 2 ? (
          <button
            disabled={admitAllBusy}
            onClick={admitAll}
            style={{
              background: "rgba(34, 197, 94, 0.18)",
              color: "#86efac",
              border: "1px solid rgba(34, 197, 94, 0.5)",
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 600,
              cursor: admitAllBusy ? "wait" : "pointer",
              marginLeft: 8,
            }}
          >
            {admitAllBusy ? "Admitting…" : `Admit all (${pending.length})`}
          </button>
        ) : null}        <button
          onClick={onClose}
          style={{
            background: "transparent",
            color: "#fff",
            border: "none",
            opacity: 0.7,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>

      {error ? (
        <div
          style={{
            padding: "8px 14px",
            background: "rgba(220, 38, 38, 0.18)",
            color: "#fca5a5",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      ) : null}

      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          overflowY: "auto",
          flex: 1,
        }}
      >
        {loading && pending.length === 0 ? (
          <li
            style={{
              padding: "16px 14px",
              fontSize: 12,
              opacity: 0.6,
            }}
          >
            Loading queue…
          </li>
        ) : null}

        {!loading && pending.length === 0 ? (
          <li
            style={{
              padding: "16px 14px",
              fontSize: 12,
              opacity: 0.6,
            }}
          >
            No one waiting.
          </li>
        ) : null}

        {pending.map((e) => (
          <li
            key={e.id}
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid #1d1d25",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600 }}>{e.name}</span>
              <span
                style={{
                  fontSize: 10,
                  opacity: 0.55,
                  whiteSpace: "nowrap",
                }}
              >
                {timeAgo(e.requestedAt)}
              </span>
            </div>
            {e.email ? (
              <div style={{ fontSize: 11, opacity: 0.6 }}>{e.email}</div>
            ) : null}
            <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
              <button
                disabled={busyId === e.id}
                onClick={() => decide(e.id, "admit")}
                style={{
                  flex: 1,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid rgba(34, 197, 94, 0.5)",
                  background: "rgba(34, 197, 94, 0.18)",
                  color: "#86efac",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: busyId === e.id ? "wait" : "pointer",
                }}
              >
                Admit
              </button>
              <button
                disabled={busyId === e.id}
                onClick={() => decide(e.id, "deny")}
                style={{
                  flex: 1,
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: "1px solid rgba(220, 38, 38, 0.5)",
                  background: "rgba(220, 38, 38, 0.18)",
                  color: "#fca5a5",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: busyId === e.id ? "wait" : "pointer",
                }}
              >
                Deny
              </button>
            </div>
          </li>
        ))}

        {decided.length > 0 ? (
          <li
            style={{
              padding: "8px 14px",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              opacity: 0.4,
              borderTop: "1px solid #1d1d25",
            }}
          >
            Recently decided
          </li>
        ) : null}

        {decided.map((e) => (
          <li
            key={e.id}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              opacity: 0.6,
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span>{e.name}</span>
            <span
              style={{
                color: e.status === "admitted" ? "#86efac" : "#fca5a5",
                fontWeight: 600,
              }}
            >
              {e.status}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function timeAgo(ts: number): string {
  const sec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return sec + "s ago";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  return hr + "h ago";
}
