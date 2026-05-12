"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { zIndex } from "@/lib/zIndex";
import { useRoomContext, useLocalParticipant } from "@livekit/components-react";
import { RoomEvent, type Participant } from "livekit-client";

/**
 * Live polls panel.
 *
 * Anyone can create a poll (question + 2–6 options). Everyone in the room
 * sees it, votes once, and watches the tallies update in real time. Whoever
 * created the poll can end it; ending freezes the results.
 *
 * State is broadcast over the LiveKit data channel — no server, no DB. Late
 * joiners ask for a snapshot when they open the panel.
 */

type Poll = {
  id: string;
  question: string;
  options: string[];
  /** identity → option index */
  votes: Record<string, number>;
  createdBy: string;
  createdByName: string;
  ended: boolean;
};

type PollMsg =
  | { type: "poll"; op: "new"; poll: Poll }
  | { type: "poll"; op: "vote"; id: string; voter: string; option: number }
  | { type: "poll"; op: "end"; id: string }
  | { type: "poll"; op: "snapshot-request" }
  | { type: "poll"; op: "snapshot"; polls: Poll[] };

export default function PollsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [polls, setPolls] = useState<Poll[]>([]);
  const [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const pollsRef = useRef<Poll[]>([]);
  const [pollNotice, setPollNotice] = useState<{ id: string; question: string; createdByName: string } | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const seenPollIdsRef = useRef<Set<string>>(new Set());

  // Keep ref in sync so the data handler reads the latest list.
  useEffect(() => {
    pollsRef.current = polls;
  }, [polls]);

  const send = useCallback(
    async (msg: PollMsg) => {
      try {
        const payload = new TextEncoder().encode(JSON.stringify(msg));
        await localParticipant.publishData(payload, { reliable: true } as any);
      } catch {
        // ignore
      }
    },
    [localParticipant]
  );

  // Subscribe to poll messages.
  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, _participant?: Participant) => {
      let msg: any;
      try {
        msg = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (!msg || msg.type !== "poll") return;
      if (msg.op === "new") {
        setPolls((prev) => {
          if (prev.find((p) => p.id === msg.poll.id)) return prev;
          return [...prev, msg.poll];
        });
        try {
          const meIdent = localParticipant?.identity;
          const fromSelf = msg.poll.createdBy === meIdent;
          const alreadySeen = seenPollIdsRef.current.has(msg.poll.id);
          if (!fromSelf && !alreadySeen) {
            seenPollIdsRef.current.add(msg.poll.id);
            setPollNotice({
              id: msg.poll.id,
              question: msg.poll.question,
              createdByName: msg.poll.createdByName,
            });
          }
        } catch {}
      } else if (msg.op === "vote") {
        setPolls((prev) =>
          prev.map((p) => {
            if (p.id !== msg.id || p.ended) return p;
            return { ...p, votes: { ...p.votes, [msg.voter]: msg.option } };
          })
        );
      } else if (msg.op === "end") {
        setPolls((prev) =>
          prev.map((p) => (p.id === msg.id ? { ...p, ended: true } : p))
        );
      } else if (msg.op === "snapshot-request") {
        if (pollsRef.current.length > 0) {
          send({ type: "poll", op: "snapshot", polls: pollsRef.current });
        }
      } else if (msg.op === "snapshot") {
        // Merge: keep our items, add anything we don't have.
        setPolls((prev) => {
          const byId = new Map(prev.map((p) => [p.id, p] as const));
          for (const p of msg.polls as Poll[]) {
            if (!byId.has(p.id)) byId.set(p.id, p);
          }
          return Array.from(byId.values());
        });
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, send]);

  // Auto-dismiss the new-poll notification after 10 seconds.
  useEffect(() => {
    if (!pollNotice) return;
    const id = setTimeout(() => setPollNotice(null), 10000);
    return () => clearTimeout(id);
  }, [pollNotice]);

  // On open, ask peers for a snapshot in case we missed a poll while closed.
  useEffect(() => {
    if (!open) return;
    send({ type: "poll", op: "snapshot-request" });
  }, [open, send]);

  const startCreate = () => {
    setCreating(true);
    setQuestion("");
    setOptions(["", ""]);
  };

  const cancelCreate = () => {
    setCreating(false);
  };

  const addOption = () => {
    if (options.length < 6) setOptions((o) => [...o, ""]);
  };

  const removeOption = (idx: number) => {
    if (options.length > 2)
      setOptions((o) => o.filter((_, i) => i !== idx));
  };

  const updateOption = (idx: number, val: string) => {
    setOptions((o) => o.map((s, i) => (i === idx ? val : s)));
  };

  const submitPoll = () => {
    const q = question.trim();
    const opts = options.map((s) => s.trim()).filter(Boolean);
    if (!q || opts.length < 2) {
      alert("Please add a question and at least 2 options.");
      return;
    }
    const me = localParticipant.identity;
    const meName =
      localParticipant.name || localParticipant.identity || "Someone";
    const poll: Poll = {
      id:
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 8),
      question: q,
      options: opts,
      votes: {},
      createdBy: me,
      createdByName: meName,
      ended: false,
    };
    setPolls((prev) => [...prev, poll]);
    send({ type: "poll", op: "new", poll });
    setCreating(false);
  };

  const vote = (pollId: string, optionIdx: number) => {
    const voter = localParticipant.identity;
    setPolls((prev) =>
      prev.map((p) => {
        if (p.id !== pollId || p.ended) return p;
        return { ...p, votes: { ...p.votes, [voter]: optionIdx } };
      })
    );
    send({ type: "poll", op: "vote", id: pollId, voter, option: optionIdx });
  };

  const endPoll = (pollId: string) => {
    if (!confirm("End this poll? Results will be frozen for everyone.")) return;
    setPolls((prev) =>
      prev.map((p) => (p.id === pollId ? { ...p, ended: true } : p))
    );
    send({ type: "poll", op: "end", id: pollId });
  };

  // Floating notification toast (renders even when panel is closed).
  const noticeNode = pollNotice ? (
    <div
      role='status'
      aria-live='polite'
      data-room-chrome="true"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 96,
        transform: 'translateX(-50%)',
        zIndex: zIndex.panelModalRaised,
        background: 'rgba(8,12,24,0.96)',
        border: '1px solid rgba(34,211,238,0.45)',
        borderRadius: 12,
        padding: '10px 14px',
        color: '#e2e8f0',
        fontSize: 12,
        boxShadow: '0 12px 30px rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: '92vw',
      }}
    >
      <span style={{ fontSize: 16 }} aria-hidden>\uD83D\uDCCA</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#67e8f9', fontWeight: 600, fontSize: 11, letterSpacing: 0.3 }}>
          New poll from {pollNotice.createdByName}
        </div>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pollNotice.question}
        </div>
      </div>
      <button
        type='button'
        onClick={() => {
          setPollNotice(null);
          try { window.dispatchEvent(new CustomEvent('neo-open-polls')); } catch {}
        }}
        style={{
          padding: '6px 12px',
          borderRadius: 999,
          border: '1px solid rgba(34,211,238,0.45)',
          background: 'rgba(34,211,238,0.15)',
          color: '#67e8f9',
          fontWeight: 600,
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        View
      </button>
      <button
        type='button'
        onClick={() => setPollNotice(null)}
        aria-label='Dismiss notification'
        style={{
          background: 'transparent',
          border: 'none',
          color: 'rgba(255,255,255,0.5)',
          cursor: 'pointer',
          fontSize: 14,
          padding: '0 4px',
        }}
      >\u2715</button>
    </div>
  ) : null;

  if (!open) return <>{noticeNode}</>;

  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        zIndex: zIndex.panelModal,
        background: "rgba(8, 12, 24, 0.98)",
        backdropFilter: "blur(12px)",
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
        right: 8,
        bottom: 8,
        width: 340,
        zIndex: zIndex.panel,
        background: "rgba(8, 12, 24, 0.96)",
        border: "1px solid rgba(34,211,238,0.25)",
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      };

  const me = localParticipant.identity;

  return (
    <aside
      data-room-chrome="true"
      style={panelStyle}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div>
          <strong style={{ color: "#67e8f9", fontSize: 13 }}>Polls</strong>
          <span
            style={{
              color: "rgba(255,255,255,0.4)",
              fontSize: 11,
              marginLeft: 8,
            }}
          >
            {polls.length} in this room
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            border: "1px solid rgba(255,255,255,0.2)",
            background: "transparent",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "10px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {!creating && (
          <button
            type="button"
            onClick={startCreate}
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              border: "1px solid rgba(34,211,238,0.4)",
              background: "rgba(34,211,238,0.12)",
              color: "#67e8f9",
              cursor: "pointer",
            }}
          >
            + New poll
          </button>
        )}

        {creating && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 12,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <input
              autoFocus
              placeholder="Question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(0,0,0,0.4)",
                color: "#fff",
                fontSize: 13,
              }}
            />
            {options.map((opt, i) => (
              <div key={i} style={{ display: "flex", gap: 6 }}>
                <input
                  placeholder={"Option " + (i + 1)}
                  value={opt}
                  onChange={(e) => updateOption(i, e.target.value)}
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid rgba(255,255,255,0.15)",
                    background: "rgba(0,0,0,0.4)",
                    color: "#fff",
                    fontSize: 13,
                  }}
                />
                {options.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeOption(i)}
                    title="Remove option"
                    style={{
                      width: 28,
                      borderRadius: 6,
                      border: "1px solid rgba(248,113,113,0.4)",
                      background: "transparent",
                      color: "#fca5a5",
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <div style={{ display: "flex", gap: 8 }}>
              {options.length < 6 && (
                <button
                  type="button"
                  onClick={addOption}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    border: "1px solid rgba(255,255,255,0.15)",
                    background: "transparent",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  + Option
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={cancelCreate}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  border: "1px solid rgba(255,255,255,0.15)",
                  background: "transparent",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitPoll}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  border: "1px solid rgba(34,211,238,0.4)",
                  background: "rgba(34,211,238,0.2)",
                  color: "#67e8f9",
                  cursor: "pointer",
                }}
              >
                Launch
              </button>
            </div>
          </div>
        )}

        {polls.length === 0 && !creating && (
          <p
            style={{
              color: "rgba(255,255,255,0.5)",
              fontSize: 12,
              textAlign: "center",
              marginTop: 12,
            }}
          >
            No polls yet. Start one to get the room’s opinion.
          </p>
        )}

        {polls.map((p) => {
          const voteCounts = p.options.map(
            (_, i) => Object.values(p.votes).filter((v) => v === i).length
          );
          const total = voteCounts.reduce((a, b) => a + b, 0);
          const myVote = p.votes[me];
          const canEnd = p.createdBy === me && !p.ended;
          return (
            <div
              key={p.id}
              style={{
                padding: 12,
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.1)",
                background: p.ended
                  ? "rgba(255,255,255,0.02)"
                  : "rgba(34,211,238,0.05)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {p.question}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "rgba(255,255,255,0.4)",
                      marginTop: 2,
                    }}
                  >
                    by {p.createdByName} · {total} vote
                    {total === 1 ? "" : "s"}
                    {p.ended ? " · ended" : ""}
                  </div>
                </div>
                {canEnd && (
                  <button
                    type="button"
                    onClick={() => endPoll(p.id)}
                    style={{
                      padding: "4px 8px",
                      borderRadius: 6,
                      fontSize: 11,
                      border: "1px solid rgba(248,113,113,0.4)",
                      background: "rgba(248,113,113,0.12)",
                      color: "#fca5a5",
                      cursor: "pointer",
                    }}
                  >
                    End
                  </button>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {p.options.map((opt, i) => {
                  const count = voteCounts[i];
                  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                  const picked = myVote === i;
                  const showResults = true;
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={p.ended || myVote !== undefined}
                      onClick={() => vote(p.id, i)}
                      style={{
                        position: "relative",
                        textAlign: "left",
                        padding: "8px 10px",
                        borderRadius: 6,
                        border: picked
                          ? "1px solid #22d3ee"
                          : "1px solid rgba(255,255,255,0.15)",
                        background: "rgba(0,0,0,0.35)",
                        color: "#fff",
                        cursor:
                          p.ended || myVote !== undefined
                            ? "default"
                            : "pointer",
                        overflow: "hidden",
                        fontSize: 12,
                      }}
                    >
                      {showResults && (
                        <span
                          style={{
                            position: "absolute",
                            inset: 0,
                            width: pct + "%",
                            background: picked
                              ? "rgba(34,211,238,0.25)"
                              : "rgba(255,255,255,0.08)",
                            transition: "width 0.3s ease",
                          }}
                        />
                      )}
                      <span
                        style={{
                          position: "relative",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span>{opt}</span>
                        {showResults && (
                          <span
                            style={{
                              fontVariantNumeric: "tabular-nums",
                              fontSize: 11,
                              color: "rgba(255,255,255,0.7)",
                            }}
                          >
                            {pct}% · {count}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
