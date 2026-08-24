'use client';

// src/components/BackgroundContinuity.tsx
//
// FRS §11 background continuity — the two platform APIs that let a mobile
// meeting keep going when the user switches apps or does other things.
// Neither is a control the user turns on; both are quietly registered as
// soon as the room mounts.
//
//   1. **Screen Wake Lock** — asks the OS to keep the phone screen from
//      auto-locking while the user is in the meeting. Only takes effect
//      while the tab is foreground; the browser releases it automatically
//      when the tab becomes hidden, and we re-acquire it on visibility
//      restore. Web has no equivalent for "keep going with the screen
//      off" — that's an OS-level constraint on any browser tab.
//
//   2. **Media Session** — publishes meeting metadata to the OS's media
//      controls (Now Playing bar / lockscreen notification / hardware
//      buttons). This is the signal mobile browsers look at to decide
//      whether to keep the tab's audio alive while it's backgrounded.
//      Without it, Android Chrome and iOS Safari suspend the audio when
//      the tab is hidden; with it, the audio streams through the same
//      way a music app would.
//
// This component renders nothing. It just wires these two APIs and cleans
// them up on unmount / room disconnect.
//
// FRS §11 explicitly notes the parts "subject to device restrictions" —
// screen lock and background camera. Those are not addressable from web
// code and are documented in-runbook, not in this component.

import { useEffect, useRef } from 'react';
import { useRoomContext } from '@livekit/components-react';

interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}
interface WakeLockAPI {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}
declare global {
  interface Navigator {
    wakeLock?: WakeLockAPI;
  }
}

export default function BackgroundContinuity({
  eventName,
  eventSlug,
}: {
  eventName?: string;
  eventSlug: string;
}) {
  const room = useRoomContext();
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const releasedByBrowserRef = useRef(false);

  /* ---------------- Screen Wake Lock ---------------- */
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;

    let cancelled = false;

    const acquire = async () => {
      if (cancelled) return;
      if (sentinelRef.current && !sentinelRef.current.released) return;
      try {
        const s = await navigator.wakeLock!.request('screen');
        if (cancelled) {
          s.release().catch(() => {});
          return;
        }
        sentinelRef.current = s;
        releasedByBrowserRef.current = false;
        // The browser fires 'release' whenever it drops the lock — most
        // commonly on tab visibility change. Note this so the visibility
        // handler knows it needs to re-acquire on return.
        s.addEventListener('release', () => {
          releasedByBrowserRef.current = true;
        });
      } catch {
        // NotAllowedError on iOS < 16.4 (unsupported), or if the tab
        // isn't fully active. Silent — the meeting continues fine.
      }
    };

    const onVisibility = () => {
      if (!document.hidden && releasedByBrowserRef.current) {
        acquire();
      }
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const s = sentinelRef.current;
      sentinelRef.current = null;
      if (s && !s.released) {
        s.release().catch(() => {});
      }
    };
  }, []);

  /* ---------------- Media Session metadata ---------------- */
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const title = eventName?.trim() || 'NEO Conference';
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: 'Live meeting',
        album: eventSlug,
      });
    } catch {
      // Some browsers throw on MediaMetadata construction if fields are odd —
      // fall back to leaving the previous (or empty) metadata in place.
    }

    // playbackState "playing" is what mobile OSes look at when deciding
    // to keep audio alive in the background. LiveKit's own audio element
    // gates this on the actual audio track being playing, but the state
    // signal has to come from us.
    try {
      navigator.mediaSession.playbackState = 'playing';
    } catch {
      // Older browsers may not support the setter.
    }

    // We expose only the actions that make sense for a meeting — no
    // seek/track-forward, because there's no timeline. Mute / unmute
    // are surfaced via play/pause because that's what OS media widgets
    // render, and it's a familiar shape for anyone who has paused a
    // podcast from a lockscreen.
    const setHandler = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Some actions may throw NotSupportedError — safe to ignore.
      }
    };

    const togglePlay = () => {
      const lp = room?.localParticipant;
      if (!lp) return;
      lp.setMicrophoneEnabled(true).catch(() => {});
    };
    const togglePause = () => {
      const lp = room?.localParticipant;
      if (!lp) return;
      lp.setMicrophoneEnabled(false).catch(() => {});
    };
    const stop = () => {
      try {
        room?.disconnect();
      } catch {
        // ignore
      }
    };

    setHandler('play', togglePlay);
    setHandler('pause', togglePause);
    setHandler('stop', stop);

    return () => {
      setHandler('play', null);
      setHandler('pause', null);
      setHandler('stop', null);
      try {
        navigator.mediaSession.playbackState = 'none';
      } catch {
        // ignore
      }
    };
  }, [eventName, eventSlug, room]);

  return null;
}
