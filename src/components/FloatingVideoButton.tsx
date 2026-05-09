'use client';

// src/components/FloatingVideoButton.tsx
// Picture-in-Picture toggle so the call keeps showing in a small floating
// window when the user switches tabs or minimizes the browser.
//
// Uses the standard HTMLVideoElement.requestPictureInPicture() API, which is
// supported on Chromium desktop, Edge, Safari (incl. iOS 14+), and Firefox.
// On unsupported browsers (mostly older mobile Safari) we show a friendly
// notice instead of failing silently.

import { useCallback, useEffect, useState } from 'react';

function pickBestVideoElement(): HTMLVideoElement | null {
  if (typeof document === 'undefined') return null;
  const vids = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
  if (vids.length === 0) return null;
  // Prefer a video that is playing, has dimensions, and is not muted-camera-off.
  const ranked = vids
    .map((v) => {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const playing = !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0;
      const inView = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      return { v, area, playing, inView };
    })
    .filter((x) => x.v.videoWidth > 0)
    .sort((a, b) => {
      if (a.playing !== b.playing) return a.playing ? -1 : 1;
      if (a.inView !== b.inView) return a.inView ? -1 : 1;
      return b.area - a.area;
    });
  return ranked[0]?.v ?? null;
}

export default function FloatingVideoButton() {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(true);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const ok = 'pictureInPictureEnabled' in document && (document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled !== false;
    setSupported(!!ok);
  }, []);

  useEffect(() => {
    const onEnter = () => setActive(true);
    const onLeave = () => setActive(false);
    document.addEventListener('enterpictureinpicture', onEnter, true);
    document.addEventListener('leavepictureinpicture', onLeave, true);
    return () => {
      document.removeEventListener('enterpictureinpicture', onEnter, true);
      document.removeEventListener('leavepictureinpicture', onLeave, true);
    };
  }, []);

  const toggle = useCallback(async () => {
    setHint(null);
    try {
      const d = document as Document & { pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
      if (d.pictureInPictureElement && d.exitPictureInPicture) {
        await d.exitPictureInPicture();
        setActive(false);
        return;
      }
      const v = pickBestVideoElement();
      if (!v) {
        setHint('No live video to float yet.');
        return;
      }
      const anyV = v as HTMLVideoElement & { disablePictureInPicture?: boolean; requestPictureInPicture?: () => Promise<PictureInPictureWindow> };
      if (anyV.disablePictureInPicture) anyV.disablePictureInPicture = false;
      if (typeof anyV.requestPictureInPicture !== 'function') {
        setHint('Floating video is not supported in this browser.');
        return;
      }
      // Some browsers require the video to actually be playing before PiP.
      if (v.paused) {
        try { await v.play(); } catch {}
      }
      await anyV.requestPictureInPicture();
      setActive(true);
    } catch (err) {
      setHint('Could not start floating video.');
      // eslint-disable-next-line no-console
      console.warn('[FloatingVideoButton] PiP failed', err);
    }
  }, []);

  // Auto-clear the hint after 3s
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
