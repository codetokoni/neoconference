'use client';

import { useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

/**
 * TranscriptNoticeBanner
 *
 * FRS §8.6: "Participants should be informed when a transcript is being
 * generated." The caption worker on this platform doubles as the live
 * transcription pipeline — enabling captions starts producing a text stream
 * that gets saved as the meeting transcript.
 *
 * Listens for the room-wide "captions" data-channel state message that
 * CaptionsToggle already broadcasts. On the off->on edge (or on join if a
 * caption stream is already running when the client connects), a glass
 * banner fades in for eight seconds so every attendee — hosts included —
 * has a moment where the transcription state is stated in plain text, not
 * inferred from a caption line appearing later.
 *
 * Ambient — no user interaction, no permissions. Mount inside <LiveKitRoom>.
 */
export default function TranscriptNoticeBanner() {
  const room = useRoomContext();
  const [visible, setVisible] = useState(false);
  const wasEnabledRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!room) return;
    const show = () => {
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setVisible(false), 8000);
    };
    const onData = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as {
          type?: string;
          enabled?: boolean;
        };
        if (msg?.type !== 'captions' || typeof msg.enabled !== 'boolean') return;
        if (msg.enabled && !wasEnabledRef.current) {
          show();
        }
        wasEnabledRef.current = msg.enabled;
      } catch {
        // ignore non-JSON
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    };
  }, [room]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-room-chrome="true"
      style={{
        position: 'fixed',
        top: 68,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        padding: '8px 16px',
        borderRadius: 999,
        background: 'rgba(17,17,24,0.9)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(34,211,238,0.4)',
        color: '#e5f8ff',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.2,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4), 0 0 30px -12px rgba(34,211,238,0.6)',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: '#22d3ee',
          boxShadow: '0 0 8px rgba(34,211,238,0.9)',
        }}
      />
      This meeting is being transcribed
    </div>
  );
}
