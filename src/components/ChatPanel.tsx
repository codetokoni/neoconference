'use client';

// src/components/ChatPanel.tsx
// Sidebar chat for the live LiveKit room. Hybrid model:
//   - REST GET /api/events/[id]/chat on mount to hydrate history.
//   - LiveKit DataChannel (topic neo-chat) for realtime fan-out.
//   - REST POST /api/events/[id]/chat for durable persistence.
//
// Place inside <LiveKitRoom> tree. Hidden by default; toggle via prop.

import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useRoomContext, useParticipants, useLocalParticipant } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import type { ChatMessage } from '@/types/event';

const TOPIC = 'neo-chat';
const TYPING_TOPIC = 'neo-typing';
const MENTION_EVERYONE = 'everyone';
const MOD_TOPIC = 'neo-mod';

type Props = {
  eventId: string;
  open: boolean;
  onClose: () => void;
  isHost?: boolean;
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

function renderMessageText(text: string, knownNames: Map<string,string>, meIdentity: string, meName: string): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  const re = /@([\w.\-]+)/g;
  let match: RegExpExecArray | null;
  const meNameLow = (meName||'').toLowerCase();
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > lastIdx) out.push(text.slice(lastIdx, start));
    const tag = match[1];
    const tagLow = tag.toLowerCase();
    const isEveryone = tagLow === 'everyone';
    const isKnown = isEveryone || knownNames.has(tagLow);
    const isMe = isEveryone || tagLow === meNameLow || tagLow === (meIdentity||'').toLowerCase();
    if (isKnown) {
      out.push(
        <span key={'m'+(key++)} style={{ color: isMe ? '#fbbf24' : '#22d3ee', fontWeight: 600, background: isMe ? 'rgba(251,191,36,0.12)' : 'rgba(34,211,238,0.10)', padding: '0 3px', borderRadius: 3 }}>@{tag}</span>
      );
    } else {
      out.push(match[0]);
    }
    lastIdx = end;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

export default function ChatPanel({ eventId, open, onClose, isHost = false }: Props) {
  const room = useRoomContext();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [mutedUserIds, setMutedUserIds] = useState<Set<string>>(() => new Set());
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [typers, setTypers] = useState<Map<string, { name: string; ts: number }>>(new Map());
  const lastTypingSentRef = useRef(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAt, setMentionAt] = useState<number>(-1);
  const mentionsRef = useRef<Set<string>>(new Set());
  const [dmTo, setDmTo] = useState<{ id: string; name: string } | null>(null);
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();

  const knownNamesByLow = useMemo(() => {
    const m = new Map<string, string>();
    const meId = localParticipant?.identity;
    const meName = (localParticipant?.name || meId || '').trim();
    if (meName) m.set(meName.toLowerCase(), meId || meName);
    if (meId) m.set(meId.toLowerCase(), meId);
    for (const p of participants) {
      if (!p?.identity) continue;
      const nm = (p.name || p.identity).trim();
      if (nm) m.set(nm.toLowerCase(), p.identity);
      m.set(p.identity.toLowerCase(), p.identity);
    }
    return m;
  }, [participants, localParticipant]);

  const mentionCandidates = useMemo(() => {
    const me = localParticipant?.identity;
    const list: { id: string; label: string; sub?: string }[] = [];
    list.push({ id: MENTION_EVERYONE, label: 'everyone', sub: 'Notify all in chat' });
    const seen = new Set<string>();
    for (const p of participants) {
      if (!p?.identity) continue;
      if (p.identity === me) continue;
      if (seen.has(p.identity)) continue;
      seen.add(p.identity);
      const nm = (p.name || p.identity).trim();
      list.push({ id: p.identity, label: nm });
    }
    return list;
  }, [participants, localParticipant]);

  const filteredMentions = useMemo(() => {
    if (mentionQuery == null) return [] as typeof mentionCandidates;
    const q = mentionQuery.toLowerCase();
    if (!q) return mentionCandidates.slice(0, 6);
    return mentionCandidates.filter((c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)).slice(0, 6);
  }, [mentionCandidates, mentionQuery]);

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
      if (topic === MOD_TOPIC) {
        try {
          const obj = JSON.parse(dec.decode(payload));
          if (obj && obj.action === 'delete' && typeof obj.messageId === 'string') {
            setMessages((arr) => arr.filter((mm) => mm.id !== obj.messageId));
          } else if (obj && obj.action === 'mute' && typeof obj.userId === 'string') {
            setMutedUserIds((s) => { const next = new Set(s); next.add(obj.userId); return next; });
          }
        } catch {}
        return;
      }
      if (topic === TYPING_TOPIC) {
        try {
          const obj = JSON.parse(dec.decode(payload));
          if (obj && typeof obj.userId === 'string' && typeof obj.name === 'string') {
            setTypers((m) => {
              const next = new Map(m);
              next.set(obj.userId, { name: obj.name, ts: Date.now() });
              return next;
            });
          }
        } catch {}
        return;
      }
      if (topic && topic !== TOPIC) return;
      try {
        const obj = JSON.parse(dec.decode(payload));
        if (obj && typeof obj.text === 'string' && typeof obj.id === 'string') {
          setMessages((arr) => {
            if (arr.some((m) => m.id === obj.id)) return arr;
            return [...arr, obj as ChatMessage].slice(-500);
          });
          if (typeof obj.userId === 'string') {
            setTypers((m) => {
              if (!m.has(obj.userId)) return m;
              const next = new Map(m); next.delete(obj.userId); return next;
            });
          }
        }
      } catch {}
    };
    room.on(RoomEvent.DataReceived, handler as any);
    return () => { room.off(RoomEvent.DataReceived, handler as any); };
  }, [room]);

  // Typing-indicator sweep: drop typers older than 4s
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      setTypers((m) => {
        const cutoff = Date.now() - 4000;
        let changed = false;
        const next = new Map(m);
        for (const [k, v] of next) { if (v.ts < cutoff) { next.delete(k); changed = true; } }
        return changed ? next : m;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [open]);

  const notifyTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < 1500) return;
    lastTypingSentRef.current = now;
    try {
      const lp = room?.localParticipant;
      if (!lp) return;
      const enc = new TextEncoder();
      const payload = JSON.stringify({ userId: lp.identity, name: lp.name || lp.identity });
      lp.publishData(enc.encode(payload), { reliable: false, topic: TYPING_TOPIC });
    } catch {}
  }, [room]);

  const broadcastMod = useCallback(async (action: 'delete' | 'mute', payload: Record<string, string>) => {
    try {
      const lp = room?.localParticipant;
      if (!lp) return;
      const enc = new TextEncoder();
      const data = enc.encode(JSON.stringify({ action, ...payload }));
      await lp.publishData(data, { reliable: true, topic: MOD_TOPIC });
    } catch {}
  }, [room]);

  const deleteMessage = useCallback((id: string) => {
    setMessages((arr) => arr.filter((mm) => mm.id !== id));
    broadcastMod('delete', { messageId: id });
    setOpenMenuId(null);
  }, [broadcastMod]);

  const muteUser = useCallback((userId: string) => {
    setMutedUserIds((s) => { const next = new Set(s); next.add(userId); return next; });
    broadcastMod('mute', { userId });
    setOpenMenuId(null);
  }, [broadcastMod]);

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
      const lp = room?.localParticipant;
      const senderName = (lp?.name || lp?.identity || 'You').trim();
      const senderId = lp?.identity || 'unknown';
      if (dmTo) {
        const dmMsg: ChatMessage = {
          id: 'dm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          ts: new Date().toISOString(),
          userId: senderId,
          name: senderName,
          text,
          toUserId: dmTo.id,
          ...(replyingTo ? { replyTo: { id: replyingTo.id, name: replyingTo.name, snippet: replyingTo.text.slice(0, 140) } } : {}),
          ...(mentionsRef.current.size > 0 ? { mentions: Array.from(mentionsRef.current) } : {}),
        } as ChatMessage;
        setMessages((arr) => (arr.some((m) => m.id === dmMsg.id) ? arr : [...arr, dmMsg]));
        try {
          const enc = new TextEncoder();
          await lp?.publishData(enc.encode(JSON.stringify(dmMsg)), { reliable: true, topic: TOPIC, destinationIdentities: [dmTo.id] });
        } catch {}
        setDraft('');
        setReplyingTo(null);
        mentionsRef.current = new Set();
        setMentionQuery(null); setMentionAt(-1);
        stickToBottomRef.current = true;
        setUnread(0);
      } else {
        const res = await fetch(`/api/events/${eventId}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, ...(replyingTo ? { replyTo: { id: replyingTo.id, name: replyingTo.name, snippet: replyingTo.text.slice(0, 140) } } : {}), ...(mentionsRef.current.size > 0 ? { mentions: Array.from(mentionsRef.current) } : {}) }),
        });
        if (!res.ok) throw new Error(await res.text());
        const json = await res.json();
        const saved: ChatMessage = json.message;
        setMessages((arr) => (arr.some((m) => m.id === saved.id) ? arr : [...arr, saved]));
        setDraft('');
        setReplyingTo(null);
        mentionsRef.current = new Set();
        setMentionQuery(null); setMentionAt(-1);
        stickToBottomRef.current = true;
        setUnread(0);
        try {
          const enc = new TextEncoder();
          await lp?.publishData(enc.encode(JSON.stringify(saved)), { reliable: true, topic: TOPIC });
        } catch {}
      }
    } catch (e: any) {
      setErr(e?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  }, [draft, sending, eventId, room, replyingTo, dmTo]);

  const jumpToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setUnread(0);
  }, []);

  const grouped = useMemo(() => {
    const visible = messages.filter((mm) => !(mm.userId && mutedUserIds.has(mm.userId)));
    return visible.map((m, i) => {
      const prev = i > 0 ? visible[i - 1] : null;
      const sameSender = prev && prev.name === m.name;
      const dt = prev ? new Date(m.ts).getTime() - new Date(prev.ts).getTime() : Infinity;
      const grp = sameSender && dt < 120000;
      return { m, grouped: grp };
    });
  }, [messages, mutedUserIds]);

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
            background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(34,211,238,0.25)', color: '#e2e8f0', borderRadius: 8,
            cursor: 'pointer', padding: isMobile ? 8 : 6,
            minWidth: isMobile ? 44 : 32, minHeight: isMobile ? 44 : 32,
            fontSize: isMobile ? 20 : 16, lineHeight: 1, fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
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
                  {m.toUserId ? (
                    <span style={{ color: '#a78bfa', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'rgba(168,85,247,0.18)', border: '1px solid rgba(168,85,247,0.4)', letterSpacing: 0.5 }}>
                      {m.userId === (localParticipant?.identity || '') ? `\uD83D\uDD12 DM \u2192 ${(participants.find(p=>p.identity===m.toUserId)?.name) || m.toUserId}` : '\uD83D\uDD12 DM'}
                    </span>
                  ) : null}
                  <span style={{ color: '#64748b', fontSize: 11 }}>{fmtTime(m.ts)}</span>
                </div>
              )}
              {m.replyTo ? (
                <div style={{
                  borderLeft: '3px solid rgba(34,211,238,0.5)', paddingLeft: 8, marginBottom: 4,
                  fontSize: 11, color: '#94a3b8',
                }}>
                  <div style={{ color: '#67e8f9', fontWeight: 600 }}>{m.replyTo.name}</div>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.replyTo.snippet}</div>
                </div>
              ) : null}
              <div style={{ color: '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...(m.toUserId ? { background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: 8, padding: '6px 10px' } : {}) }}>{renderMessageText(m.text, knownNamesByLow, localParticipant?.identity || '', localParticipant?.name || '')}</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 2, position: 'relative' }}>
                <button
                  type='button'
                  onClick={() => setReplyingTo(m)}
                  aria-label='Reply'
                  style={{
                    background: 'transparent', border: 'none', color: '#67e8f9',
                    cursor: 'pointer', fontSize: 11, padding: '2px 0',
                    opacity: 0.7,
                  }}
                >
                  ↩ Reply
                </button>
                {isHost && !m.toUserId ? (
                  <button
                    type='button'
                    onClick={() => setOpenMenuId((v) => v === m.id ? null : m.id)}
                    aria-label='Moderate message'
                    aria-haspopup='menu'
                    aria-expanded={openMenuId === m.id}
                    style={{
                      background: 'transparent', border: 'none', color: '#94a3b8',
                      cursor: 'pointer', fontSize: 14, padding: '0 4px', lineHeight: 1,
                      opacity: 0.7,
                    }}
                  >
                    ⋯
                  </button>
                ) : null}
                {isHost && openMenuId === m.id ? (
                  <div
                    role='menu'
                    aria-label='Moderation actions'
                    style={{
                      position: 'absolute', top: '100%', left: 40, zIndex: 5,
                      background: 'rgba(15,23,42,0.98)',
                      border: '1px solid rgba(239,68,68,0.35)',
                      borderRadius: 8, padding: 4, minWidth: 180,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                    }}
                  >
                    <button
                      type='button'
                      role='menuitem'
                      onClick={() => deleteMessage(m.id)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        background: 'transparent', border: 'none',
                        color: '#fca5a5', cursor: 'pointer',
                        padding: '8px 10px', fontSize: 12, borderRadius: 6,
                      }}
                    >
                      Delete message
                    </button>
                    {m.userId ? (
                      <button
                        type='button'
                        role='menuitem'
                        onClick={() => muteUser(m.userId as string)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          background: 'transparent', border: 'none',
                          color: '#fca5a5', cursor: 'pointer',
                          padding: '8px 10px', fontSize: 12, borderRadius: 6,
                        }}
                      >
                        Mute {m.name} in chat
                      </button>
                    ) : null}
                    <button
                      type='button'
                      role='menuitem'
                      onClick={() => setOpenMenuId(null)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left',
                        background: 'transparent', border: 'none',
                        color: '#94a3b8', cursor: 'pointer',
                        padding: '8px 10px', fontSize: 12, borderRadius: 6,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
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
      {(() => {
        const names = Array.from(typers.values()).map((t) => t.name).filter(Boolean);
        if (names.length === 0) return null;
        const text = names.length === 1 ? `${names[0]} is typing\u2026`
          : names.length === 2 ? `${names[0]} and ${names[1]} are typing\u2026`
          : 'Several people are typing\u2026';
        return (
          <div style={{
            padding: '4px 16px', fontSize: 11, color: '#67e8f9', fontStyle: 'italic',
            opacity: 0.85,
          }}>{text}</div>
        );
      })()}
      <div style={{ padding: '0 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type='button'
          onClick={() => setDmPickerOpen((v) => !v)}
          aria-label='Choose recipient'
          aria-expanded={dmPickerOpen}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: dmTo ? 'rgba(168,85,247,0.18)' : 'rgba(255,255,255,0.04)',
            border: dmTo ? '1px solid rgba(168,85,247,0.45)' : '1px solid rgba(255,255,255,0.12)',
            color: dmTo ? '#e9d5ff' : '#94a3b8',
            borderRadius: 999, padding: '4px 10px', fontSize: 11, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {dmTo ? `\uD83D\uDD12 DM \u00B7 ${dmTo.name}` : 'To: Everyone'}
          <span aria-hidden style={{ opacity: 0.7 }}>\u25BE</span>
        </button>
        {dmTo ? (
          <button
            type='button'
            onClick={() => { setDmTo(null); setDmPickerOpen(false); }}
            aria-label='Clear DM recipient'
            style={{ background: 'transparent', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}
          >\u2715</button>
        ) : null}
      </div>
      {dmPickerOpen ? (
        <div
          role='listbox'
          aria-label='DM recipient picker'
          style={{
            margin: '0 12px',
            background: 'rgba(15,23,42,0.96)',
            border: '1px solid rgba(168,85,247,0.35)',
            borderRadius: 8,
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          <button
            type='button'
            onClick={() => { setDmTo(null); setDmPickerOpen(false); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              width: '100%', textAlign: 'left',
              background: 'transparent', border: 'none', color: '#e2e8f0',
              padding: '10px 12px', cursor: 'pointer',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              fontSize: 13,
            }}
          >
            <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'linear-gradient(135deg,#22d3ee,#0ea5e9)', color: '#001018', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>#</span>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 600 }}>Everyone</span>
              <span style={{ fontSize: 11, color: '#64748b' }}>Public message to the whole room</span>
            </span>
          </button>
          {mentionCandidates.filter((c) => c.id !== MENTION_EVERYONE).map((c) => (
            <button
              key={c.id}
              type='button'
              onClick={() => { setDmTo({ id: c.id, name: c.label }); setDmPickerOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', textAlign: 'left',
                background: dmTo?.id === c.id ? 'rgba(168,85,247,0.10)' : 'transparent',
                border: 'none', color: '#e2e8f0',
                padding: '10px 12px', cursor: 'pointer',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                fontSize: 13,
              }}
            >
              <span style={{ width: 24, height: 24, borderRadius: '50%', background: avatarColor(c.label), color: '#001018', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{initials(c.label)}</span>
              <span style={{ fontWeight: 600 }}>{c.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#a78bfa' }}>\uD83D\uDD12 DM</span>
            </button>
          ))}
        </div>
      ) : null}
      {replyingTo ? (
        <div style={{
          margin: '0 12px 4px', padding: '6px 10px',
          background: 'rgba(34,211,238,0.08)', borderLeft: '3px solid #22d3ee',
          borderRadius: 6, fontSize: 11, color: '#94a3b8',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: '#67e8f9' }}>Replying to {replyingTo.name}</div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyingTo.text}</div>
          </div>
          <button
            type='button'
            onClick={() => setReplyingTo(null)}
            aria-label='Cancel reply'
            style={{
              background: 'transparent', border: 'none', color: '#94a3b8',
              cursor: 'pointer', padding: 4, fontSize: 14, lineHeight: 1,
            }}
          >✕</button>
        </div>
      ) : null}
      {mentionQuery !== null && filteredMentions.length > 0 ? (
        <div
          role='listbox'
          aria-label='Mention suggestions'
          style={{
            margin: '0 12px',
            background: 'rgba(15,23,42,0.96)',
            border: '1px solid rgba(34,211,238,0.3)',
            borderRadius: 8,
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          {filteredMentions.map((c) => (
            <button
              key={c.id}
              type='button'
              onMouseDown={(e) => { e.preventDefault(); }}
              onClick={() => {
                if (mentionAt < 0) return;
                const before = draft.slice(0, mentionAt);
                const afterStart = mentionAt + 1 + (mentionQuery?.length || 0);
                const after = draft.slice(afterStart);
                const insertLabel = c.id === MENTION_EVERYONE ? 'everyone' : c.label.replace(/\s+/g, '');
                const next = before + '@' + insertLabel + ' ' + after;
                mentionsRef.current.add(c.id);
                setDraft(next);
                setMentionQuery(null);
                setMentionAt(-1);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', textAlign: 'left',
                background: 'transparent', border: 'none', color: '#e2e8f0',
                padding: '10px 12px', cursor: 'pointer',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                fontSize: 13,
              }}
            >
              <span
                style={{
                  width: 24, height: 24, borderRadius: '50%',
                  background: c.id === MENTION_EVERYONE ? 'linear-gradient(135deg,#22d3ee,#0ea5e9)' : avatarColor(c.label),
                  color: '#001018', fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {c.id === MENTION_EVERYONE ? '@' : initials(c.label)}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: '#67e8f9' }}>@{c.id === MENTION_EVERYONE ? 'everyone' : c.label}</span>
                {c.sub ? <span style={{ fontSize: 11, color: '#64748b' }}>{c.sub}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
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
          onChange={(e) => {
            const v = e.target.value;
            const ta = e.target as HTMLTextAreaElement;
            const cursor = ta.selectionStart ?? v.length;
            const upto = v.slice(0, cursor);
            const atIdx = upto.lastIndexOf('@');
            const beforeAt = atIdx > 0 ? upto[atIdx - 1] : ' ';
            const okBoundary = atIdx >= 0 && (atIdx === 0 || /\s/.test(beforeAt));
            const tail = atIdx >= 0 ? upto.slice(atIdx + 1) : '';
            const tailOk = okBoundary && !/\s/.test(tail) && tail.length <= 30;
            if (tailOk) { setMentionQuery(tail); setMentionAt(atIdx); }
            else { if (mentionQuery !== null) { setMentionQuery(null); setMentionAt(-1); } }
            setDraft(v); notifyTyping();
          }}
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
