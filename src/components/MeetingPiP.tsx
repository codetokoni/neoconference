'use client';

// src/components/MeetingPiP.tsx
//
// FRS §11 Picture-in-Picture: floating meeting window with full controls.
// Replaces the video-only FloatingVideoButton.
//
// Two rendering paths, chosen by capability:
//
//  1. **Document Picture-in-Picture** (Chromium 116+, Edge 116+): opens an
//     always-on-top window that receives a React portal of our own UI —
//     active speaker's camera track, mic mute, camera toggle, return-to-
//     meeting, leave-meeting, and (when running) the meeting timer. This is
//     the target user experience the FRS describes.
//
//  2. **Video-element Picture-in-Picture** (Safari, Firefox, older Chrome,
//     iOS Safari 14+): the browser draws its own tiny video window. No
//     custom controls beyond the native mute button, but uninterrupted
//     background audio is guaranteed by LiveKit's audio path regardless.
//
// Auto-enter on `visibilitychange`: when the tab is hidden we try Document
// PiP first, then video-element PiP. On return we exit the auto-entered
// PiP. A user's manual toggle takes precedence — we don't tear that down.
//
// The Document PiP window shares this React tree via createPortal, so
// LiveKit context (useRoomContext, useTracks, useLocalParticipant) resolves
// inside the PiP UI without any extra plumbing.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
} from '@livekit/components-react';
import {
  RoomEvent,
  Track,
  type LocalParticipant,
  type Participant,
  type TrackPublication,
} from 'livekit-client';
import {
  ArrowUpRight,
  Mic,
  MicOff,
  PhoneOff,
  Pin,
  Video,
  VideoOff,
} from 'lucide-react';
import { computeRemaining, IDLE_TIMER, type TimerState } from '@/lib/timer';

/* ------------------------------------------------------------------ */
/*  Document PiP API type shims                                        */
/* ------------------------------------------------------------------ */

interface DocumentPiPRequestOptions {
  width?: number;
  height?: number;
}
interface DocumentPictureInPictureAPI {
  requestWindow(opts?: DocumentPiPRequestOptions): Promise<Window>;
  window: Window | null;
  addEventListener(type: 'enter', listener: (e: Event) => void): void;
  removeEventListener(type: 'enter', listener: (e: Event) => void): void;
}
declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureAPI;
  }
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const PIP_WIDTH = 380;
const PIP_HEIGHT = 300;
const TIMER_MSG_TYPE = 'timer';

/* ------------------------------------------------------------------ */
/*  Capability probes                                                  */
/* ------------------------------------------------------------------ */

function supportsDocumentPiP(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

function supportsVideoElementPiP(): boolean {
  if (typeof document === 'undefined') return false;
  const d = document as Document & { pictureInPictureEnabled?: boolean };
  const ok = 'pictureInPictureEnabled' in document && d.pictureInPictureEnabled !== false;
  const iosOk =
    typeof (
      HTMLVideoElement.prototype as unknown as {
        webkitSupportsPresentationMode?: unknown;
      }
    ).webkitSupportsPresentationMode === 'function';
  return !!ok || !!iosOk;
}

/* ------------------------------------------------------------------ */
/*  Stylesheet cloning                                                  */
/* ------------------------------------------------------------------ */

/**
 * Copy every stylesheet in the parent document into the PiP document so
 * Tailwind classes and inlined critical CSS render identically. Runs once
 * when the PiP window opens; there's no HMR concern because rendered
 * artefacts are static after Next.js's initial paint.
 */
function cloneStylesheetsInto(target: Document, source: Document) {
  // Baseline body styles — the PiP window's default is white with default
  // fonts; we want a full-bleed dark canvas that matches the app.
  const baseline = target.createElement('style');
  baseline.textContent = `
    :root, body, html { margin: 0; padding: 0; background: #000; color: #fff; }
    body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
           overflow: hidden; height: 100vh; }
    * { box-sizing: border-box; }
    button { font: inherit; color: inherit; }
  `;
  target.head.appendChild(baseline);

  Array.from(source.styleSheets).forEach((sheet) => {
    try {
      const owner = sheet.ownerNode as (Element & { cloneNode: (deep: boolean) => Node }) | null;
      if (owner && owner.tagName) {
        target.head.appendChild(owner.cloneNode(true));
      } else if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    } catch {
      // Cross-origin stylesheets can throw on access; skip them.
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Video-element PiP fallback                                          */
/* ------------------------------------------------------------------ */

function isLikelyLocalVideo(v: HTMLVideoElement): boolean {
  let n: HTMLElement | null = v;
  for (let i = 0; n && i < 6; i++, n = n.parentElement) {
    const cls = (n.className || '').toString().toLowerCase();
    if (
      cls.includes('local-participant') ||
      cls.includes('lk-participant--local') ||
      cls.includes('self')
    ) {
      return true;
    }
  }
  return v.muted;
}

function pickBestPlainVideo(): HTMLVideoElement | null {
  const vids = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  const ranked = vids
    .map((v) => {
      const rect = v.getBoundingClientRect();
      const playing = !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0;
      const remote = !isLikelyLocalVideo(v);
      return { v, playing, remote, area: rect.width * rect.height };
    })
    .filter((x) => x.playing)
    .sort((a, b) => {
      if (a.remote !== b.remote) return a.remote ? -1 : 1;
      return b.area - a.area;
    });
  return ranked[0]?.v ?? null;
}

async function enterVideoElementPiP(v: HTMLVideoElement): Promise<boolean> {
  try {
    const anyV = v as HTMLVideoElement & {
      disablePictureInPicture?: boolean;
      requestPictureInPicture?: () => Promise<PictureInPictureWindow>;
      webkitSetPresentationMode?: (mode: string) => void;
      webkitSupportsPresentationMode?: (mode: string) => boolean;
    };
    if (anyV.disablePictureInPicture) anyV.disablePictureInPicture = false;
    v.setAttribute('playsinline', 'true');
    v.setAttribute('autoplay', 'true');
    if (v.paused) {
      try {
        await v.play();
      } catch {
        // Autoplay policies — the video is still attached; PiP request often
        // succeeds even without a resumed play state.
      }
    }
    if (typeof anyV.requestPictureInPicture === 'function') {
      await anyV.requestPictureInPicture();
      return true;
    }
    if (
      typeof anyV.webkitSetPresentationMode === 'function' &&
      anyV.webkitSupportsPresentationMode &&
      anyV.webkitSupportsPresentationMode('picture-in-picture')
    ) {
      anyV.webkitSetPresentationMode('picture-in-picture');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function exitAnyVideoElementPiP(): Promise<void> {
  try {
    const d = document as Document & {
      pictureInPictureElement?: Element | null;
      exitPictureInPicture?: () => Promise<void>;
    };
    if (d.pictureInPictureElement && d.exitPictureInPicture) {
      await d.exitPictureInPicture();
      return;
    }
    const v = d.pictureInPictureElement as HTMLVideoElement | null;
    const anyV = v as
      | (HTMLVideoElement & { webkitSetPresentationMode?: (m: string) => void })
      | null;
    if (anyV && typeof anyV.webkitSetPresentationMode === 'function') {
      anyV.webkitSetPresentationMode('inline');
    }
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ */
/*  PiP contents                                                        */
/* ------------------------------------------------------------------ */

/** Choose the best camera track to display in PiP. Prefers a speaking
 *  remote participant, then any playing remote camera, then the local
 *  camera as a last resort so the window is never blank when something
 *  is available. */
function usePiPFeaturedTrack() {
  const participants = useParticipants();
  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: false }],
    { onlySubscribed: false },
  );

  const speakingIdentity = useMemo(() => {
    const speaker = participants.find(
      (p) => p.isSpeaking && !(p as Participant & { isLocal?: boolean }).isLocal,
    );
    return speaker?.identity ?? null;
  }, [participants]);

  return useMemo(() => {
    if (!cameraTracks.length) return null;
    if (speakingIdentity) {
      const t = cameraTracks.find((tr) => tr.participant.identity === speakingIdentity);
      if (t) return t;
    }
    const remote = cameraTracks.find(
      (t) =>
        !(t.participant as Participant & { isLocal?: boolean }).isLocal &&
        t.publication?.track,
    );
    if (remote) return remote;
    return cameraTracks[0];
  }, [cameraTracks, speakingIdentity]);
}

/** Compact timer badge — subscribes to the same {type:"timer", state} data-
 *  channel packets MeetingTimer sends. No controls, no sound, just a
 *  running countdown while a timer is active. Silent otherwise. */
function PiPTimerBadge({ slug }: { slug: string }) {
  const room = useRoomContext();
  const [state, setState] = useState<TimerState>(IDLE_TIMER);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/events/${encodeURIComponent(slug)}/timer`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json || typeof json !== 'object') return;
        if ((json as { state?: TimerState }).state) {
          setState((json as { state: TimerState }).state);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!room) return;
    const decoder = new TextDecoder();
    const onData = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(decoder.decode(payload)) as {
          type?: string;
          state?: TimerState;
        };
        if (msg?.type === TIMER_MSG_TYPE && msg.state) setState(msg.state);
      } catch {
        // not our packet
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  useEffect(() => {
    const tick = () => setRemaining(computeRemaining(state));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [state]);

  if (state.status === 'idle') return null;
  const total = Math.max(0, Math.ceil(remaining / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const text = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  const paused = state.status === 'paused';

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        padding: '4px 10px',
        borderRadius: 999,
        background: paused ? 'rgba(234,179,8,0.9)' : 'rgba(34,211,238,0.9)',
        color: '#0b1020',
        fontSize: 12,
        fontWeight: 700,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        letterSpacing: 0.5,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}
    >
      {paused ? '⏸ ' : ''}
      {text}
    </div>
  );
}

/** The full PiP UI — video + controls + timer. Rendered via createPortal
 *  into the PiP window body. */
function PiPContent({
  slug,
  onReturn,
  onLeave,
}: {
  slug: string;
  onReturn: () => void;
  onLeave: () => void;
}) {
  const { localParticipant } = useLocalParticipant();
  const featured = usePiPFeaturedTrack();
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const lp = localParticipant as LocalParticipant | undefined;
    if (!lp) return;
    const sync = () => {
      setMicOn(lp.isMicrophoneEnabled);
      setCamOn(lp.isCameraEnabled);
    };
    sync();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyLP = lp as any;
    anyLP.on?.(RoomEvent.TrackMuted, sync);
    anyLP.on?.(RoomEvent.TrackUnmuted, sync);
    anyLP.on?.(RoomEvent.TrackPublished, sync);
    anyLP.on?.(RoomEvent.TrackUnpublished, sync);
    return () => {
      anyLP.off?.(RoomEvent.TrackMuted, sync);
      anyLP.off?.(RoomEvent.TrackUnmuted, sync);
      anyLP.off?.(RoomEvent.TrackPublished, sync);
      anyLP.off?.(RoomEvent.TrackUnpublished, sync);
    };
  }, [localParticipant]);

  const toggleMic = useCallback(async () => {
    if (!localParticipant || busy) return;
    setBusy(true);
    try {
      await localParticipant.setMicrophoneEnabled(!localParticipant.isMicrophoneEnabled);
    } catch {
      // Device may be blocked — leave the current state.
    } finally {
      setBusy(false);
    }
  }, [localParticipant, busy]);

  const toggleCam = useCallback(async () => {
    if (!localParticipant || busy) return;
    setBusy(true);
    try {
      await localParticipant.setCameraEnabled(!localParticipant.isCameraEnabled);
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }, [localParticipant, busy]);

  const attachedTrack: TrackPublication | undefined = featured?.publication ?? undefined;
  const isTrackReady = !!(attachedTrack && attachedTrack.track);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#000',
        color: '#fff',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          background:
            'radial-gradient(ellipse at top, #0a1a24 0%, #000 60%)',
        }}
      >
        {featured && isTrackReady ? (
          <VideoTrack
            trackRef={featured}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              background: '#000',
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(255,255,255,0.6)',
              fontSize: 13,
            }}
          >
            {featured
              ? 'Waiting for speaker…'
              : 'Audio-only session'}
          </div>
        )}
        <PiPTimerBadge slug={slug} />
        {featured && (
          <div
            style={{
              position: 'absolute',
              left: 8,
              bottom: 8,
              padding: '3px 8px',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.6)',
              fontSize: 11,
              maxWidth: '70%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {featured.participant.name || featured.participant.identity}
          </div>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 10,
          background: 'rgba(11,16,32,0.95)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <PiPControl
          onClick={toggleMic}
          active={micOn}
          activeIcon={<Mic size={18} />}
          inactiveIcon={<MicOff size={18} />}
          ariaLabel={micOn ? 'Mute microphone' : 'Unmute microphone'}
          danger={!micOn}
        />
        <PiPControl
          onClick={toggleCam}
          active={camOn}
          activeIcon={<Video size={18} />}
          inactiveIcon={<VideoOff size={18} />}
          ariaLabel={camOn ? 'Turn camera off' : 'Turn camera on'}
          danger={!camOn}
        />
        <div style={{ flex: 1 }} />
        <PiPControl
          onClick={onReturn}
          activeIcon={<ArrowUpRight size={18} />}
          inactiveIcon={<ArrowUpRight size={18} />}
          active
          ariaLabel="Return to meeting tab"
          tone="brand"
        />
        <PiPControl
          onClick={onLeave}
          activeIcon={<PhoneOff size={18} />}
          inactiveIcon={<PhoneOff size={18} />}
          active
          ariaLabel="Leave meeting"
          tone="danger"
        />
      </div>
    </div>
  );
}

function PiPControl({
  onClick,
  active,
  activeIcon,
  inactiveIcon,
  ariaLabel,
  tone,
  danger,
}: {
  onClick: () => void;
  active: boolean;
  activeIcon: ReactNode;
  inactiveIcon: ReactNode;
  ariaLabel: string;
  tone?: 'brand' | 'danger';
  danger?: boolean;
}) {
  const bg =
    tone === 'danger'
      ? '#dc2626'
      : tone === 'brand'
      ? 'rgba(34,211,238,0.9)'
      : danger
      ? '#dc2626'
      : 'rgba(255,255,255,0.12)';
  const color = tone === 'brand' ? '#0b1020' : '#fff';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 40,
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.08)',
        background: bg,
        color,
        cursor: 'pointer',
        transition: 'transform 120ms ease, background 120ms ease',
      }}
    >
      {active ? activeIcon : inactiveIcon}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Root component                                                      */
/* ------------------------------------------------------------------ */

export default function MeetingPiP({ slug }: { slug?: string }) {
  const room = useRoomContext();
  const [docSupported, setDocSupported] = useState(false);
  const [videoSupported, setVideoSupported] = useState(false);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [videoPiPActive, setVideoPiPActive] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const autoEnteredRef = useRef<'doc' | 'video' | null>(null);

  useEffect(() => {
    setDocSupported(supportsDocumentPiP());
    setVideoSupported(supportsVideoElementPiP());
  }, []);

  // Track native video-element PiP state for the fallback path.
  useEffect(() => {
    const onEnter = () => setVideoPiPActive(true);
    const onLeave = () => setVideoPiPActive(false);
    document.addEventListener('enterpictureinpicture', onEnter, true);
    document.addEventListener('leavepictureinpicture', onLeave, true);
    return () => {
      document.removeEventListener('enterpictureinpicture', onEnter, true);
      document.removeEventListener('leavepictureinpicture', onLeave, true);
    };
  }, []);

  const closeDocPiP = useCallback(() => {
    if (pipWindow && !pipWindow.closed) {
      try {
        pipWindow.close();
      } catch {
        // ignore
      }
    }
    setPipWindow(null);
  }, [pipWindow]);

  const openDocPiP = useCallback(async (): Promise<boolean> => {
    if (!docSupported || !window.documentPictureInPicture) return false;
    try {
      const w = await window.documentPictureInPicture.requestWindow({
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
      });
      cloneStylesheetsInto(w.document, document);
      w.document.title = 'NEO Conference';
      w.addEventListener('pagehide', () => setPipWindow(null));
      setPipWindow(w);
      return true;
    } catch {
      return false;
    }
  }, [docSupported]);

  const openVideoPiP = useCallback(async (): Promise<boolean> => {
    if (!videoSupported) return false;
    const v = pickBestPlainVideo();
    if (!v) return false;
    return await enterVideoElementPiP(v);
  }, [videoSupported]);

  /** User-initiated open. Prefers Document PiP for the richer UX. */
  const openFromUser = useCallback(async () => {
    setHint(null);
    if (pipWindow || videoPiPActive) return;
    if (await openDocPiP()) return;
    if (await openVideoPiP()) return;
    setHint('Floating video is not supported in this browser.');
  }, [pipWindow, videoPiPActive, openDocPiP, openVideoPiP]);

  const closeAll = useCallback(async () => {
    if (pipWindow) closeDocPiP();
    if (videoPiPActive) await exitAnyVideoElementPiP();
    autoEnteredRef.current = null;
  }, [pipWindow, videoPiPActive, closeDocPiP]);

  const toggle = useCallback(async () => {
    if (pipWindow || videoPiPActive) {
      await closeAll();
    } else {
      await openFromUser();
    }
  }, [pipWindow, videoPiPActive, closeAll, openFromUser]);

  /** Auto-enter on visibility hidden. Uses whichever path is supported. */
  useEffect(() => {
    if (!docSupported && !videoSupported) return;
    const onVis = async () => {
      if (document.hidden) {
        if (pipWindow || videoPiPActive) return;
        if (docSupported) {
          const ok = await openDocPiP();
          if (ok) {
            autoEnteredRef.current = 'doc';
            return;
          }
        }
        if (videoSupported) {
          const ok = await openVideoPiP();
          if (ok) autoEnteredRef.current = 'video';
        }
      } else {
        if (autoEnteredRef.current === 'doc' && pipWindow) closeDocPiP();
        if (autoEnteredRef.current === 'video' && videoPiPActive) {
          await exitAnyVideoElementPiP();
        }
        if (autoEnteredRef.current) autoEnteredRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [
    docSupported,
    videoSupported,
    pipWindow,
    videoPiPActive,
    openDocPiP,
    openVideoPiP,
    closeDocPiP,
  ]);

  /** Fade hint messages. */
  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(null), 3000);
    return () => clearTimeout(id);
  }, [hint]);

  /** Cleanup on unmount: close any window we opened. */
  useEffect(() => {
    return () => {
      if (pipWindow && !pipWindow.closed) {
        try {
          pipWindow.close();
        } catch {
          // ignore
        }
      }
    };
  }, [pipWindow]);

  const returnToMeeting = useCallback(() => {
    try {
      window.focus();
    } catch {
      // ignore
    }
    closeDocPiP();
  }, [closeDocPiP]);

  const leaveMeeting = useCallback(async () => {
    try {
      await room?.disconnect();
    } catch {
      // ignore
    }
    closeDocPiP();
  }, [room, closeDocPiP]);

  if (!docSupported && !videoSupported) return null;

  const active = !!pipWindow || videoPiPActive;
  const buttonTitle = active
    ? 'Exit floating video'
    : 'Float video so it stays visible while you do other things';

  return (
    <>
      <button
        type="button"
        data-toolbar-item="true"
        data-room-chrome="true"
        onClick={toggle}
        aria-pressed={active}
        title={buttonTitle}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-transparent px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] transition"
      >
        <Pin size={16} aria-hidden />
        {active ? 'Unfloat' : 'Float'}
      </button>
      {hint ? (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 96,
            transform: 'translateX(-50%)',
            background: 'rgba(15,23,42,0.96)',
            color: '#fbbf24',
            border: '1px solid rgba(251,191,36,0.4)',
            borderRadius: 8,
            padding: '8px 14px',
            fontSize: 12,
            zIndex: 200,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          {hint}
        </div>
      ) : null}
      {pipWindow && slug
        ? createPortal(
            <PiPContent slug={slug} onReturn={returnToMeeting} onLeave={leaveMeeting} />,
            pipWindow.document.body,
          )
        : null}
    </>
  );
}
