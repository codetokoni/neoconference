'use client';
import { zIndex } from "@/lib/zIndex";

import { useEffect, useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

/**
 * MediaRequestPrompt
 *
 * Listens for data-channel messages of type 'media_request' targeted at the
 * local participant. When received, shows an Allow / Deny modal so the user
 * can decide whether to enable their microphone or camera. We never enable
 * media without explicit user consent.
 */
type Pending = {
  kind: 'audio' | 'video';
  fromName: string;
};

export default function MediaRequestPrompt() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg?.type !== 'media_request') return;
        const myIdentity = (room as any).localParticipant?.identity;
        if (msg.to && myIdentity && msg.to !== myIdentity) return;
        if (msg.kind !== 'audio' && msg.kind !== 'video') return;
        setPending({ kind: msg.kind, fromName: String(msg.fromName || 'Host') });
      } catch {
        // ignore malformed messages
      }
    };
    (room as any).on(RoomEvent.DataReceived, onData);
    return () => { (room as any).off(RoomEvent.DataReceived, onData); };
  }, [room]);

  if (!pending) return null;

  const allow = async () => {
    try {
      if (!localParticipant) return;
      if (pending.kind === 'audio') await localParticipant.setMicrophoneEnabled(true);
      else await localParticipant.setCameraEnabled(true);
    } catch {
      // ignore
    } finally {
      setPending(null);
    }
  };
  const deny = () => setPending(null);

  const label = pending.kind === 'audio' ? 'unmute your microphone' : 'turn on your camera';

  return (
    <div
      role='dialog'
      aria-modal='true'
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: zIndex.mediaPrompt,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 360,
          background: '#111',
          color: '#fff',
          borderRadius: 14,
          padding: 16,
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
          {pending.fromName} is asking you to {label}
        </div>
        <div style={{ fontSize: 13, color: '#bbb', marginBottom: 16 }}>
          You can allow this once, or deny it. We will only enable your media if you allow.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type='button'
            onClick={deny}
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'transparent',
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Deny
          </button>
          <button
            type='button'
            onClick={allow}
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              border: 'none',
              background: '#22c55e',
              color: '#0a0a0a',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
