'use client';

// Big-meeting receiving in the room (src/lib/bigMeeting.ts): rendered inside
// LiveKitRoom when the token route said "selective", and the room connected
// with autoSubscribe off. Also says once, when someone came in muted because
// the meeting is big, how to speak.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRoomContext } from '@livekit/components-react';
import { startReceiving } from './bigMeetingSubscriptions';

export const JOINED_MUTED_MESSAGE = 'You joined muted because this is a big meeting. Unmute your microphone to speak.';
const SHOW_MS = 8000;

export default function BigMeetingReceiver({ joinedMuted }: { joinedMuted: boolean }) {
  const room = useRoomContext();
  useEffect(() => startReceiving(room), [room]);

  const [show, setShow] = useState(joinedMuted);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setShow(false), SHOW_MS);
    return () => clearTimeout(t);
  }, [show]);

  if (!mounted || !show) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-joined-muted-notice=""
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)',
        transform: 'translateX(-50%)',
        zIndex: 2147483000,
        maxWidth: 'min(92vw, 420px)',
        padding: '10px 14px',
        borderRadius: 12,
        background: 'rgba(24,24,27,0.95)',
        color: '#fff',
        fontSize: 14,
        lineHeight: 1.4,
        boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      }}
    >
      {JOINED_MUTED_MESSAGE}
    </div>,
    document.body,
  );
}
