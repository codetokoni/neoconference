'use client';

// src/components/ChatPanel.tsx
// Sidebar chat for the live LiveKit room. Hybrid model:
//   - REST GET /api/events/[id]/chat on mount to hydrate history.
//   - LiveKit DataChannel (topic neo-chat) for realtime fan-out.
//   - REST POST /api/events/[id]/chat for durable persistence.
//
// Place inside <LiveKitRoom> tree. Hidden by default; toggle via prop.

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
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
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function initials(name: string): string {
  const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function ChatPanel({ eventId, open, onClose }: Props) {
  const room = useRoomContext();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    fetch(`/api/events/${eventId}/chat`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((j) => { if (!cancelled && Array.isArray(j?.messages)) setMessages(j.messages); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [eventId]);

  useEffect(() => {
    if (!room) return;
    const dec = new TextDecoder();
    const handler = (payload: Uint8Array, _p: any, _k: any, topic?: string) => {
      if (topic && topic !== TOPIC) return;
      try {
        const obj = JSON.parse(dec.decode(payload));
        if (obj && typeof obj.text === 'string' && typeof obj.id === 'string') {
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

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = dist < 80;
    if (stickToBottomRef.current) setUnread(0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setUnread(0);
    } else {
      setUnread((n) => Math.min(n + 1, 99));
    }
  }, [messages, open]);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [open]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true); setErr(null);
    try {
      const res = await fetch(`/api/events/${eventId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      const saved: ChatMessage = json.message;
      setMessages((arr) => (arr.some((m) => m.id === saved.id) ? arr : [...arr, saved]));
      setDraft('');
      stickToBottomRef.current = true;
      setUnread(0);
      try {
        const enc = new TextEncoder();
        await room?.localParticipant?.publishData(enc.encode(JSON.stringify(saved)), { reliable: true, topic: TOPIC });
      } catch {}
    } catch (e: any) {
      setErr(e?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  }, [draft, sending, eventId, room]);

  const jumpToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setUnread(0);
  }, []);

  const grouped = useMemo(() => {
    return messages.map((m, i) => {
      const prev = i > 0 ? messages[i - 1] : null;
      const sameSender = prev && prev.name === m.name;
      const dt = prev ? new Date(m.ts).getTime() - new Date(prev.ts).getTime() : Infinity;
      const grp = sameSender && dt < 120000;
      return { m, grouped: grp };
    });
  }, [messages]);

  if (!open) return null;

  const panelStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed', inset: 0, zIndex: 80,
        background: 'rgba(8,11,20,0.96)',
        backdropFilter: 'blur(16px)',
        display: 'flex', flexDirection: 'column', color: '#e2e8f0',
      }
    : {
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 'min(380px, 92vw)', zIndex: 80,
        background: 'rgba(8,11,20,0.86)',
        backdropFilter: 'blur(16px)',
        borderLeft: '1px solid rgba(34,211,238,0.25)',
        display: 'flex', flexDirection: 'column', color: '#e2e8f0',
      };

  return (
    <aside style={panelStyle} aria-label='Chat'>
      <header
        style={{
          padding: isMobile ? '14px 16px' : '12px 16px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottom: '1px solid rgba(34,211,238,0.18)',
          minHeight: isMobile ? 56 : 48,
        }}
      >
        <strong style={{ fontSize: isMobile ? 16 : 14, letterSpacing: 0.4, color: '#67e8f9' }}>Chat</strong>
        <button
          type='button'
          onClick={onClose}
          aria-label='Close chat'
          style={{
            background: 'transparent', border: 'none', color: '#94a3b8',
            cursor: 'pointer', padding: isMobile ? 8 : 4,
            minWidth: isMobile ? 44 : 28, minHeight: isMobile ? 44 : 28,
            fontSize: 20, lineHeight: 1,
          }}
        >
          ✕
        </button>
      </header>
      <div
        ref={listRef}
        onScroll={onListScroll}
        style={{
          flex: 1, overflowY: 'auto', padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}
      >
        {messages.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: 13 }}>No messages yet. Say hi.</p>
        ) : grouped.map(({ m, grouped: g }) => (
          <div key={m.id} style={{ fontSize: 13, lineHeight: 1.4, display: 'flex', gap: 10, marginTop: g ? 0 : 8 }}>
            <div style={{ width: 32, flexShrink: 0 }}>
              {!g && (
                <div
                  aria-hidden
                  style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: avatarColor(m.name),
                    color: '#fff', fontSize: 12, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {initials(m.name)}
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {!g && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ color: '#67e8f9', fontWeight: 600 }}>{m.name}</span>
                  <span style={{ color: '#64748b', fontSize: 11 }}>{fmtTime(m.ts)}</span>
                </div>
              )}
              <div style={{ color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
            </div>
          </div>
        ))}
      </div>
      {unread > 0 && (
        <button
          type='button'
          onClick={jumpToBottom}
          style={{
            position: 'absolute', bottom: isMobile ? 110 : 92, left: '50%', transform: 'translateX(-50%)',
            background: '#0ea5e9', color: '#001018', border: 'none', borderRadius: 999,
            padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            boxShadow: '0 6px 20px rgba(14,165,233,0.5)',
          }}
        >
          {unread} new ↓
        </button>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        style={{
          padding: 12,
          paddingBottom: isMobile ? 'calc(12px + env(safe-area-inset-bottom))' : 12,
          borderTop: '1px solid rgba(34,211,238,0.18)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder='Send a message'
          rows={2}
          maxLength={1000}
          style={{
            resize: 'none',
            background: 'rgba(15,23,42,0.7)', color: '#e2e8f0',
            border: '1px solid rgba(34,211,238,0.25)',
            borderRadius: 8, padding: isMobile ? 12 : 8,
            fontSize: isMobile ? 15 : 13, lineHeight: 1.4,
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#475569' }}>
            {isMobile ? 'Tap send' : 'Enter to send · Shift+Enter for newline'}
          </span>
          <button
            type='submit'
            disabled={sending || !draft.trim()}
            style={{
              padding: isMobile ? '10px 18px' : '6px 14px',
              borderRadius: 8, border: '1px solid rgba(34,211,238,0.4)',
              background: 'linear-gradient(135deg,#22d3ee,#0ea5e9)', color: '#001018',
              fontSize: isMobile ? 14 : 12, fontWeight: 700,
              cursor: sending || !draft.trim() ? 'not-allowed' : 'pointer',
              opacity: sending || !draft.trim() ? 0.5 : 1,
              minWidth: isMobile ? 80 : 60, minHeight: isMobile ? 40 : 28,
            }}
          >
            {sending ? '…' : 'Send'}
          </button>
        </div>
        {err ? <p style={{ color: '#fda4af', fontSize: 11, margin: 0 }}>{err}</p> : null}
      </form>
    </aside>
  );
}
