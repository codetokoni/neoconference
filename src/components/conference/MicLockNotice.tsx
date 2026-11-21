'use client';

// Tells the person when their microphone is locked, when they try to unmute
// while it is ("Your microphone is locked. …"), and when they may unmute
// again ("You can now turn your microphone and camera on."). Rendered once inside the meeting, on top of
// everything (a portal on <body>: a transformed toolbar would trap it).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MIC_ALLOWED_MESSAGE, MIC_LOCKED_EVENT, MIC_LOCKED_MESSAGE, useMicLocked } from './micLockClient';

const SHOW_MS = 6000;

export default function MicLockNotice() {
  const locked = useMicLocked();
  const prev = useRef<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const was = prev.current;
    prev.current = locked;
    if (locked && was !== true) setMessage(MIC_LOCKED_MESSAGE);
    else if (!locked && was === true) setMessage(MIC_ALLOWED_MESSAGE);
  }, [locked]);

  useEffect(() => {
    const onAttempt = () => setMessage(MIC_LOCKED_MESSAGE);
    window.addEventListener(MIC_LOCKED_EVENT, onAttempt);
    return () => window.removeEventListener(MIC_LOCKED_EVENT, onAttempt);
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [message]);

  if (!mounted) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-mic-lock-notice=""
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)',
        transform: 'translateX(-50%)',
        zIndex: 2147483000,
        maxWidth: 'min(92vw, 420px)',
        pointerEvents: message ? 'auto' : 'none',
      }}
    >
      {message ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            borderRadius: 12,
            background: 'rgba(15,23,42,0.96)',
            border: '1px solid ' + (message === MIC_ALLOWED_MESSAGE ? 'rgba(52,211,153,0.5)' : 'rgba(251,191,36,0.5)'),
            color: '#f1f5f9',
            fontSize: 13,
            lineHeight: 1.4,
            boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
          }}
        >
          <span aria-hidden style={{ fontSize: 16 }}>{message === MIC_ALLOWED_MESSAGE ? '🎙️' : '🔒'}</span>
          <span>{message}</span>
          <button
            type="button"
            onClick={() => setMessage(null)}
            aria-label="Dismiss"
            style={{ marginLeft: 4, background: 'transparent', border: 'none', color: '#94a3b8', fontSize: 16, cursor: 'pointer', padding: 2 }}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
