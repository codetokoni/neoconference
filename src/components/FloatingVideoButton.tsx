'use client';

// src/components/FloatingVideoButton.tsx
// Picture-in-Picture toggle so the call keeps showing in a small floating
// window when the user switches tabs or minimizes the browser.
//
// - Manual toggle: tap Float / Unfloat in the toolbar.
// - Auto: when the document becomes hidden (tab switch / app backgrounded)
//   we try to enter PiP automatically and exit when the document becomes
//   visible again. This makes mobile multitasking just work.
// - Resilience: if the floating video source goes blank we hot-swap to
//   the next-best remote video, so the floating window does not show black.
//
// Standard HTMLVideoElement.requestPictureInPicture() works on Chromium,
// Edge, Firefox, Safari macOS, and iOS Safari 14+. We also fall back to
// webkitSetPresentationMode for older iOS WebKit.

import { useCallback, useEffect, useRef, useState } from 'react';

type RankedVideo = {
  v: HTMLVideoElement;
  remote: boolean;
  area: number;
  playing: boolean;
  inView: boolean;
  hasSource: boolean;
};

function isLikelyLocal(v: HTMLVideoElement): boolean {
  let n: HTMLElement | null = v;
  for (let i = 0; n && i < 6; i++, n = n.parentElement) {
    const cls = (n.className || '').toString().toLowerCase();
    const ds = ((n as HTMLElement).dataset && JSON.stringify((n as HTMLElement).dataset)) || '';
    if (cls.includes('local-participant') || cls.includes('lk-participant--local') || cls.includes('self')) return true;
    if (ds.toLowerCase().includes('local')) return true;
  }
  if (v.muted) return true;
  return false;
}

function rankVideos(): RankedVideo[] {
  if (typeof document === 'undefined') return [];
  const vids = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  return vids
    .map((v): RankedVideo => {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const hasSource = !!v.srcObject || !!v.currentSrc;
      const playing = !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0;
      const inView = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      const remote = !isLikelyLocal(v);
      return { v, remote, area, playing, inView, hasSource };
    })
    .filter((x) => x.hasSource && x.v.videoWidth > 0)
    .sort((a, b) => {
      if (a.remote !== b.remote) return a.remote ? -1 : 1;
      if (a.playing !== b.playing) return a.playing ? -1 : 1;
      if (a.inView !== b.inView) return a.inView ? -1 : 1;
      return b.area - a.area;
    });
}

function pickBest(): HTMLVideoElement | null {
  return rankVideos()[0]?.v ?? null;
}

async function enterPiPForVideo(v: HTMLVideoElement): Promise<boolean> {
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
      try { await v.play(); } catch {}
    }
    if (typeof anyV.requestPictureInPicture === 'function') {
      await anyV.requestPictureInPicture();
      return true;
    }
    if (typeof anyV.webkitSetPresentationMode === 'function' && anyV.webkitSupportsPresentationMode && anyV.webkitSupportsPresentationMode('picture-in-picture')) {
      anyV.webkitSetPresentationMode('picture-in-picture');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function exitPiP(): Promise<void> {
  try {
    const d = document as Document & { pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
    if (d.pictureInPictureElement && d.exitPictureInPicture) {
      await d.exitPictureInPicture();
      return;
    }
    const v = d.pictureInPictureElement as HTMLVideoElement | null;
    const anyV = v as (HTMLVideoElement & { webkitSetPresentationMode?: (mode: string) => void }) | null;
    if (anyV && typeof anyV.webkitSetPresentationMode === 'function') {
      anyV.webkitSetPresentationMode('inline');
    }
  } catch {}
}

export default function FloatingVideoButton() {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const floatingRef = useRef<HTMLVideoElement | null>(null);
  const autoEnteredRef = useRef(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const d = document as Document & { pictureInPictureEnabled?: boolean };
    const ok = 'pictureInPictureEnabled' in document && d.pictureInPictureEnabled !== false;
    const iosOk = typeof (HTMLVideoElement.prototype as unknown as { webkitSupportsPresentationMode?: unknown }).webkitSupportsPresentationMode === 'function';
    setSupported(!!ok || !!iosOk);
  }, []);

  useEffect(() => {
    const onEnter = (e: Event) => {
      const t = e.target as HTMLVideoElement | null;
      if (t) floatingRef.current = t;
      setActive(true);
    };
    const onLeave = () => {
      floatingRef.current = null;
      setActive(false);
    };
    document.addEventListener('enterpictureinpicture', onEnter, true);
    document.addEventListener('leavepictureinpicture', onLeave, true);
    return () => {
      document.removeEventListener('enterpictureinpicture', onEnter, true);
      document.removeEventListener('leavepictureinpicture', onLeave, true);
    };
  }, []);

  const enter = useCallback(async (auto: boolean) => {
    setHint(null);
    const v = pickBest();
    if (!v) {
      if (!auto) setHint('No live video to float yet.');
      return false;
    }
    const ok = await enterPiPForVideo(v);
    if (ok) {
      floatingRef.current = v;
      autoEnteredRef.current = auto;
      setActive(true);
      return true;
    }
    if (!auto) setHint('Floating video is not supported in this browser.');
    return false;
  }, []);

  const toggle = useCallback(async () => {
    setHint(null);
    try {
      const d = document as Document & { pictureInPictureElement?: Element | null };
      if (d.pictureInPictureElement) {
        await exitPiP();
        autoEnteredRef.current = false;
        setActive(false);
        return;
      }
      await enter(false);
    } catch (err) {
      setHint('Could not start floating video.');
      console.warn('[FloatingVideoButton] PiP failed', err);
    }
  }, [enter]);

  useEffect(() => {
    if (!supported) return;
    const onVis = async () => {
      const d = document as Document & { pictureInPictureElement?: Element | null };
      if (document.hidden) {
        if (!d.pictureInPictureElement) {
          await enter(true);
        }
      } else {
        if (d.pictureInPictureElement && autoEnteredRef.current) {
          await exitPiP();
          autoEnteredRef.current = false;
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [supported, enter]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const id = setInterval(async () => {
      if (!alive) return;
      const cur = floatingRef.current;
      if (!cur) return;
      const dead = !cur.srcObject || cur.videoWidth === 0 || cur.readyState < 2 || cur.ended;
      if (!dead) return;
      const ranked = rankVideos();
      const next = ranked.find((r) => r.v !== cur)?.v;
      if (!next) return;
      try {
        await exitPiP();
        const ok = await enterPiPForVideo(next);
        if (ok) floatingRef.current = next;
      } catch {}
    }, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [active]);

  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(null), 3000);
    return () => clearTimeout(id);
  }, [hint]);

  if (!supported) return null;

  return (
    <>
      <button
        type='button'
        data-toolbar-item='true'
        onClick={toggle}
        className='px-3 py-1.5 text-xs rounded bg-black text-white hover:bg-zinc-800 border border-white/30 shadow-sm'
        title={active ? 'Exit floating video' : 'Float video so it stays visible while you do other things'}
        aria-pressed={active}
      >
        {active ? 'Unfloat' : 'Float'}
      </button>
      {hint ? (
        <div
          role='status'
          style={{
            position: 'fixed', left: '50%', bottom: 96, transform: 'translateX(-50%)',
            background: 'rgba(15,23,42,0.96)', color: '#fbbf24',
            border: '1px solid rgba(251,191,36,0.4)', borderRadius: 8,
            padding: '8px 14px', fontSize: 12, zIndex: 200,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >{hint}</div>
      ) : null}
    </>
  );
}
