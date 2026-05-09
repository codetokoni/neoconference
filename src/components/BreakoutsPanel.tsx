"use client";

// src/components/BreakoutsPanel.tsx
//
// VISUAL breakout groups for a LiveKit room.
//
// HONEST LIMITATION: This is a *visual* split, not true audio isolation.
// Everyone in the room can still hear everyone. The host broadcasts a
// group assignment via the LiveKit data channel and each client filters
// their own video grid to show only tiles for participants in the same
// group. Use separate rooms if you need real audio breakouts.
//
// Wire-protocol (sent reliably over the data channel):
//   { type: "breakout", payload: BreakoutState }
// where BreakoutState =
//   { active: boolean; groups: {id,name}[]; assignments: {[identity]: groupId}; ts: number }
//
// Anyone who joins later will see whatever the host last broadcast,
// because the host re-sends on RoomEvent.ParticipantConnected.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRoomContext,
  useParticipants,
  useLocalParticipant,
} from "@livekit/components-react";
import { RoomEvent, type Participant } from "livekit-client";

export interface BreakoutGroup {
  id: string;
  name: string;
}

export interface BreakoutState {
  active: boolean;
  groups: BreakoutGroup[];
  /** identity -> groupId */
  assignments: Record<string, string>;
  /** Identity of the host who broadcast this state. Used so guests keep the host's tile visible regardless of group assignment. */
  host?: string;
  ts: number;
}

const EMPTY_STATE: BreakoutState = {
  active: false,
  groups: [],
  assignments: {},
  ts: 0,
};

function newId() {
  return "g_" + Math.random().toString(36).slice(2, 8);
}

export default function BreakoutsPanel({
  open,
  onClose,
  isHost,
  eventSlug,
}: {
  open: boolean;
  onClose: () => void;
  isHost: boolean;
  /** When provided, breakout state is persisted to /api/breakouts/<slug> */
  eventSlug?: string;
}) {
  const room = useRoomContext();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();

  const [state, setState] = useState<BreakoutState>(EMPTY_STATE);
  const [hostViewAll, setHostViewAll] = useState(false);
  // Track whether we have hydrated from KV. Avoids overwriting a real saved
  // state with our initial empty state on first render.
  const hydratedRef = useRef(false);
  // Debounce timer for host-side PUTs to /api/breakouts/<slug>.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const broadcast = async (next: BreakoutState) => {
    if (!room || !localParticipant) return;
    try {
      const stamped: BreakoutState = {
        ...next,
        host: next.host || localParticipant.identity,
      };
      const payload = new TextEncoder().encode(
        JSON.stringify({ type: "breakout", payload: stamped })
      );
      await localParticipant.publishData(payload, { reliable: true } as any);
    } catch (e) {
      console.error("[breakouts] publishData failed", e);
    }
  };

  // ---- Hydrate from KV on mount (event-bound rooms only) ----
  useEffect(() => {
    if (!eventSlug) {
      hydratedRef.current = true;
      return;
    }
    let cancelled = false;
    fetch("/api/breakouts/" + encodeURIComponent(eventSlug), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        if (j && j.state && typeof j.state === "object") {
          setState(j.state as BreakoutState);
          // If the saved state was active, re-broadcast so existing
          // participants pick it up after a host refresh.
          if (isHost && j.state.active) {
            broadcast(j.state as BreakoutState);
          }
        }
        hydratedRef.current = true;
      })
      .catch(() => {
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventSlug]);

  // ---- Persist to KV on every host-driven change (debounced 500ms) ----
  useEffect(() => {
    if (!isHost || !eventSlug) return;
    if (!hydratedRef.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      fetch("/api/breakouts/" + encodeURIComponent(eventSlug), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      }).catch((e) => console.error("[breakouts] PUT failed", e));
    }, 500);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [state, isHost, eventSlug]);

  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg?.type === "breakout" && msg.payload) {
          const incoming = msg.payload as BreakoutState;
          setState((prev) =>
            !prev.ts || incoming.ts >= prev.ts ? incoming : prev
          );
        }
      } catch {
        // ignore malformed packets
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  useEffect(() => {
    if (!room || !isHost) return;
    const onJoin = () => {
      setTimeout(() => {
        if (state.active) broadcast(state);
      }, 800);
    };
    room.on(RoomEvent.ParticipantConnected, onJoin);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
    };
  }, [room, isHost, state]);

  const myGroupId = useMemo(() => {
    const id = localParticipant?.identity;
    if (!id) return undefined;
    return state.assignments[id];
  }, [localParticipant, state.assignments]);

  useEffect(() => {
    if (!state.active) {
      document
        .querySelectorAll<HTMLElement>(".lk-participant-tile")
        .forEach((t) => {
          t.removeAttribute("data-breakout-group");
        });
      const oldStyle = document.getElementById("nc-breakout-style");
      if (oldStyle) oldStyle.remove();
      return;
    }

    const apply = () => {
      const hostIdentity = state.host;
      const identityToGroup = state.assignments;
      const tiles = document.querySelectorAll<HTMLElement>(
        ".lk-participant-tile"
      );
      tiles.forEach((tile) => {
        const identity =
          tile.getAttribute("data-lk-participant-identity") ||
          tile.querySelector("[data-lk-participant-identity]")?.getAttribute(
            "data-lk-participant-identity"
          );
        if (!identity) return;
        if (hostIdentity && identity === hostIdentity) {
          tile.setAttribute("data-breakout-group", "__host__");
          return;
        }
        const g = identityToGroup[identity];
        if (g) tile.setAttribute("data-breakout-group", g);
        else tile.setAttribute("data-breakout-group", "__none__");
      });
    };

    apply();
    const root = document.querySelector<HTMLElement>("[data-lk-theme]");
    let observer: MutationObserver | null = null;
    if (root) {
      observer = new MutationObserver(apply);
      observer.observe(root, { childList: true, subtree: true });
    }
    const interval = window.setInterval(apply, 1500);

    const showAll = isHost && hostViewAll;
    let style = document.getElementById(
      "nc-breakout-style"
    ) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "nc-breakout-style";
      document.head.appendChild(style);
    }
    if (!myGroupId || showAll) {
      style.textContent = "";
    } else {
      style.textContent = `
        .lk-participant-tile[data-breakout-group]:not([data-breakout-group="${myGroupId}"]):not([data-breakout-group="__host__"]) {
          display: none !important;
        }
      `;
    }

    return () => {
      window.clearInterval(interval);
      observer?.disconnect();
    };
  }, [state, myGroupId, isHost, hostViewAll]);

  const addGroup = () => {
    setState((prev) => ({
      ...prev,
      groups: [
        ...prev.groups,
        { id: newId(), name: "Group " + (prev.groups.length + 1) },
      ],
      ts: Date.now(),
    }));
  };

  const removeGroup = (gid: string) => {
    setState((prev) => {
      const nextAssign: Record<string, string> = {};
      for (const [k, v] of Object.entries(prev.assignments)) {
        if (v !== gid) nextAssign[k] = v;
      }
      return {
        ...prev,
        groups: prev.groups.filter((g) => g.id !== gid),
        assignments: nextAssign,
        ts: Date.now(),
      };
    });
  };

  const assign = (identity: string, groupId: string) => {
    setState((prev) => {
      const nextAssign = { ...prev.assignments };
      if (!groupId) delete nextAssign[identity];
      else nextAssign[identity] = groupId;
      return { ...prev, assignments: nextAssign, ts: Date.now() };
    });
  };

  const openBreakouts = () => {
    const next = { ...state, active: true, ts: Date.now() };
    setState(next);
    broadcast(next);
  };

  const closeBreakouts = () => {
    const next = { ...state, active: false, ts: Date.now() };
    setState(next);
    broadcast(next);
    // Also clear server-side state so a fresh host start gets a clean slate.
    if (isHost && eventSlug) {
      fetch("/api/breakouts/" + encodeURIComponent(eventSlug), {
        method: "DELETE",
      }).catch((e) => console.error("[breakouts] DELETE failed", e));
    }
  };

  const reapply = () => broadcast({ ...state, ts: Date.now() });

  if (!open) return null;

  if (!isHost) {
    if (!state.active) return null;
    const myGroup = state.groups.find((g) => g.id === myGroupId);
    const groupSize = myGroupId
      ? Object.values(state.assignments).filter((g) => g === myGroupId).length
      : 0;
    return (
      <div
        data-room-chrome="true"
        style={{
          position: "absolute",
          top: 48,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 13,
          padding: "6px 14px",
          borderRadius: 999,
          background: "rgba(15,23,42,0.85)",
          color: "#a5f3fc",
          fontSize: 12,
          fontWeight: 600,
          border: "1px solid rgba(34,211,238,0.35)",
          backdropFilter: "blur(6px)",
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
        title="Audio is shared with everyone in the room"
      >
        {myGroup ? (
          <>
            <span>You’re in: <strong>{myGroup.name}</strong></span>
            <span style={{ opacity: 0.6 }}>· {groupSize} here</span>
          </>
        ) : (
          <span>No group assigned</span>
        )}
        <span style={{ opacity: 0.5, fontSize: 10 }}>
          (audio is shared)
        </span>
      </div>
    );
  }

  return (
    <aside
      data-room-chrome="true"
      style={{
        position: "absolute",
        top: 48,
        right: 8,
        bottom: 8,
        width: 320,
        zIndex: 14,
        background: "rgba(17,17,24,0.96)",
        color: "#fff",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
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
        <strong>Breakouts</strong>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "#fff",
            opacity: 0.7,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Close
        </button>
      </div>

      <div
        style={{
          padding: "8px 14px",
          fontSize: 11,
          opacity: 0.65,
          borderBottom: "1px solid #1d1d25",
          lineHeight: 1.45,
        }}
      >
        Visual groups only — audio remains shared across the whole
        room. For real audio isolation, end the meeting and start
        separate rooms.
      </div>

      <div style={{ overflowY: "auto", flex: 1, padding: "10px 14px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            Groups ({state.groups.length})
          </span>
          <button
            onClick={addGroup}
            style={{
              padding: "4px 8px",
              borderRadius: 6,
              background: "rgba(34,211,238,0.18)",
              border: "1px solid rgba(34,211,238,0.4)",
              color: "#a5f3fc",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            + Add group
          </button>
        </div>

        {state.groups.map((g) => {
          const members = participants.filter(
            (p) => state.assignments[p.identity] === g.id
          );
          return (
            <div
              key={g.id}
              style={{
                marginBottom: 10,
                padding: "8px 10px",
                background: "rgba(255,255,255,0.04)",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <span>{g.name} · {members.length}</span>
                <button
                  onClick={() => removeGroup(g.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#fca5a5",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  Remove
                </button>
              </div>
              {members.length > 0 ? (
                <ul style={{ listStyle: "none", margin: "6px 0 0 0", padding: 0 }}>
                  {members.map((p) => (
                    <li
                      key={p.identity}
                      style={{
                        fontSize: 11,
                        opacity: 0.75,
                        padding: "2px 0",
                      }}
                    >
                      {p.name || p.identity}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}

        {state.groups.length === 0 ? (
          <div style={{ fontSize: 11, opacity: 0.5, padding: "6px 0" }}>
            Add at least one group, then assign people below.
          </div>
        ) : null}

        <div
          style={{
            marginTop: 14,
            paddingTop: 10,
            borderTop: "1px solid #1d1d25",
          }}
        >
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            Participants ({participants.length})
          </span>
          <ul style={{ listStyle: "none", margin: "8px 0 0 0", padding: 0 }}>
            {participants.map((p: Participant) => {
              const assigned = state.assignments[p.identity] || "";
              return (
                <li
                  key={p.identity}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "4px 0",
                    fontSize: 12,
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 160,
                    }}
                  >
                    {p.name || p.identity}
                    {p.isLocal ? " (you)" : ""}
                  </span>
                  <select
                    value={assigned}
                    onChange={(e) => assign(p.identity, e.target.value)}
                    style={{
                      background: "#0f172a",
                      color: "#fff",
                      border: "1px solid #334155",
                      borderRadius: 4,
                      fontSize: 11,
                      padding: "2px 4px",
                    }}
                  >
                    <option value="">—</option>
                    {state.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div
        style={{
          padding: "10px 14px",
          borderTop: "1px solid #2a2a33",
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {!state.active ? (
          <button
            onClick={openBreakouts}
            disabled={state.groups.length === 0}
            style={{
              flex: 1,
              padding: "6px 8px",
              borderRadius: 6,
              background: "rgba(34,197,94,0.22)",
              border: "1px solid rgba(34,197,94,0.5)",
              color: "#86efac",
              fontSize: 12,
              fontWeight: 600,
              cursor: state.groups.length === 0 ? "not-allowed" : "pointer",
              opacity: state.groups.length === 0 ? 0.5 : 1,
            }}
          >
            Open breakouts
          </button>
        ) : (
          <>
            <button
              onClick={reapply}
              style={{
                flex: 1,
                padding: "6px 8px",
                borderRadius: 6,
                background: "rgba(34,211,238,0.18)",
                border: "1px solid rgba(34,211,238,0.4)",
                color: "#a5f3fc",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Re-apply
            </button>
            <button
              onClick={closeBreakouts}
              style={{
                flex: 1,
                padding: "6px 8px",
                borderRadius: 6,
                background: "rgba(220,38,38,0.18)",
                border: "1px solid rgba(220,38,38,0.5)",
                color: "#fca5a5",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Close breakouts
            </button>
          </>
        )}
        <label
          style={{
            flexBasis: "100%",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            opacity: 0.7,
            marginTop: 2,
          }}
        >
          <input
            type="checkbox"
            checked={hostViewAll}
            onChange={(e) => setHostViewAll(e.target.checked)}
          />
          View all groups (host only)
        </label>
      </div>
    </aside>
  );
}
