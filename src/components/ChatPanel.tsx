'use client';

// src/components/ChatPanel.tsx
//
// Sidebar chat for the live LiveKit room. Hybrid model:
//   - REST GET /api/events/[id]/chat on mount to hydrate history.
//   - LiveKit DataChannel (topic neo-chat) for realtime fan-out.
//   - REST POST /api/events/[id]/chat for durable persistence.
//
// Place inside <LiveKitRoom> tree. Hidden by default; toggle via prop.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import type { ChatMessage } from '@/types/event';

const TOPIC = 'neo-chat';

type Props = {
  eventId: string;
  open: boolean;
  onClose: () => void;
};

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

export default function ChatPanel({ eventId, open, onClose }: Props) {
  const room = useRoomContext();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Hydrate from REST
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    fetch(`/api/events/${eventId}/chat`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((j) => { if (!cancelled && Array.isArray(j?.messages)) setMessages(j.messages); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [eventId]);

  // Subscribe to DataChannel realtime
  useEffect(() => {
    if (!room) return;
    const dec = new TextDecoder();
    const handler = (payload: Uint8Array, _p: any, _k: any, topic?: string) => {
      if (topic && topic !== TOPIC) return;
      try {
        const obj = JSON.parse(dec.decode(payload));
        if (obj && typeof obj.text === "string" && typeof obj.id === "string") {
          setMessages((arr) => {
            if (arr.some((m) => m.id === obj.id)) return arr;
            return [...arr, obj as ChatMessage].slice(-500);
          });
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler as any);
    return () => { room.off(RoomEvent.DataReceived, handler as any); };
  }, [room]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true); setErr(null);
    try {
      const res = await fetch(`/api/events/${eventId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      const saved: ChatMessage = json.message;
      setMessages((arr) => (arr.some((m) => m.id === saved.id) ? arr : [...arr, saved]));
      setDraft("");
      // Fan out via DataChannel
      try {
        const enc = new TextEncoder();
        await room?.localParticipant?.publishData(enc.encode(JSON.stringify(saved)), { reliable: true, topic: TOPIC });
      } catch {}
    } catch (e: any) {
      setErr(e?.message || "Send failed");
    } finally {
      setSending(false);
    }
  }, [draft, sending, eventId, room]);

  if (!open) return null;

  return (
    <aside
      style={{
        position: "fixed",
        top: 0, right: 0, bottom: 0,
        width: "min(380px, 92vw)",
        zIndex: 80,
        background: "rgba(8,11,20,0.86)",
        backdropFilter: "blur(16px)",
        borderLeft: "1px solid rgba(34,211,238,0.25)",
        display: "flex",
        flexDirection: "column",
        color: "#e2e8f0",
      }}
    >
      <header style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(34,211,238,0.18)" }}>
        <strong style={{ fontSize: 14, letterSpacing: 0.4, color: "#67e8f9" }}>Chat</strong>
        <button type="button" onClick={onClose} aria-label="Close chat" style={{ background: "transparent", border: "none", color: "#cbd5e1", fontSize: 20, cursor: "pointer" }}>×</button>
      </header>
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 ? (
          <p style={{ color: "#64748b", fontSize: 13 }}>No messages yet. Say hi.</p>
        ) : messages.map((m) => (
          <div key={m.id} style={{ fontSize: 13, lineHeight: 1.4 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "#67e8f9", fontWeight: 600 }}>{m.name}</span>
              <span style={{ color: "#64748b", fontSize: 11 }}>{fmtTime(m.ts)}</span>
            </div>
            <div style={{ color: "#e2e8f0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text}</div>
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        style={{ padding: 12, borderTop: "1px solid rgba(34,211,238,0.18)", display: "flex", flexDirection: "column", gap: 6 }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Send a message"
          rows={2}
          maxLength={1000}
          style={{ resize: "none", background: "rgba(15,23,42,0.7)", color: "#e2e8f0", border: "1px solid rgba(34,211,238,0.25)", borderRadius: 10, padding: "8px 10px", fontSize: 13, outline: "none" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#475569" }}>Enter to send, Shift+Enter for newline</span>
          <button type="submit" disabled={sending || !draft.trim()} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "#22d3ee", color: "#0e1530", fontSize: 12, fontWeight: 600, cursor: sending ? "wait" : "pointer", opacity: !draft.trim() ? 0.4 : 1 }}>{sending ? "..." : "Send"}</button>
        </div>
        {err ? <p style={{ color: "#fda4af", fontSize: 11, margin: 0 }}>{err}</p> : null}
      </form>
    </aside>
  );
}

