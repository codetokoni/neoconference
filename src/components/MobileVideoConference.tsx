'use client';
import { zIndex } from "@/lib/zIndex";

import { useEffect, useRef, useState } from 'react';
import {
  ParticipantTile,
  useTracks,
  VideoConference,
  TrackLoop,
  useLocalParticipant,
  useRoomContext,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';

/**
 * MobileVideoConference
 *
 * Phone (<= 640px): custom 2x2 grid (4 tiles per page) with horizontal swipe to
 * paginate, plus a fixed bottom control bar (mic / camera / more / leave).
 * Desktop: stock <VideoConference /> unchanged.
 */
export default function MobileVideoConference() {
  const [isMobile, setIsMobile] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  if (!mounted || !isMobile) {
    return <VideoConference />;
  }

  return <MobileGridImpl />;
}

const PAGE_SIZE = 4;
const SWIPE_THRESHOLD = 50; // px
const BAR_HEIGHT = 64; // px reserved for bottom control bar

function MobileGridImpl() {
  const tracks: TrackReferenceOrPlaceholder[] = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const pageTracks = tracks.slice(start, start + PAGE_SIZE);

  // Touch swipe handlers
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStartX.current = t.clientX;
    touchStartY.current = t.clientY;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null || touchStartY.current == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX.current;
    const dy = t.clientY - touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0 && safePage < totalPages - 1) setPage(safePage + 1);
    else if (dx > 0 && safePage > 0) setPage(safePage - 1);
  };

  return (
    <div
      className='lk-video-conference nc-mobile-vc'
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        position: 'absolute',
        inset: 0,
        touchAction: 'pan-y',
      }}
    >
      <div
        className='nc-mobile-grid'
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          gap: 6,
          padding: 6,
          paddingRight: 62,
          paddingBottom: BAR_HEIGHT + 6,
          boxSizing: 'border-box',
          width: '100%',
        }}
      >
        <TrackLoop tracks={pageTracks}>
          <ParticipantTile
            style={{
              width: '100%',
              height: '100%',
              borderRadius: 12,
              overflow: 'hidden',
              minHeight: 0,
            }}
          />
        </TrackLoop>
      </div>

      {totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            justifyContent: 'center',
            padding: '6px 0',
            position: 'absolute',
            bottom: BAR_HEIGHT,
            left: 0,
            right: 0,
          }}
        >
          {Array.from({ length: totalPages }).map((_, i) => (
            <button
              key={i}
              onClick={() => setPage(i)}
              aria-label={`Go to page ${i + 1}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                border: 'none',
                padding: 0,
                background: i === safePage ? '#fff' : 'rgba(255,255,255,0.35)',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      )}

      <MobileControlBar />
    </div>
  );
}

// ---------- Bottom control bar ----------

type ToolbarItem = { label: string; el: HTMLButtonElement };

function MobileControlBar() {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const [moreOpen, setMoreOpen] = useState(false);
  const [items, setItems] = useState<ToolbarItem[]>([]);

  // Scan the existing top room toolbar buttons (People / Whiteboard / etc) when the
  // sheet opens, so the More menu mirrors whatever is currently available.
  const refreshItems = () => {
    const list: ToolbarItem[] = [];
    const btns = document.querySelectorAll<HTMLButtonElement>('.room-toolbar > button');
    btns.forEach((b) => {
      const label = (b.textContent || '').trim();
      if (!label) return;
      list.push({ label, el: b });
    });
    // De-dupe by label
    const seen = new Set<string>();
    setItems(list.filter((it) => {
      const k = it.label.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }));
  };

  const toggleMic = () => {
    if (!localParticipant) return;
    localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {});
  };
  const toggleCam = () => {
    if (!localParticipant) return;
    localParticipant.setCameraEnabled(!isCameraEnabled).catch(() => {});
  };
  const leave = () => {
    try { room?.disconnect(); } catch {}
    if (typeof window !== 'undefined') window.location.href = '/';
  };
  const openMore = () => { refreshItems(); setMoreOpen(true); };
  const closeMore = () => setMoreOpen(false);
    const fire = (it: ToolbarItem) => {
      try {
        const lbl = (it.label || "").toLowerCase();
        // Recording button is rendered inside .room-toolbar but the toolbar has
        // pointer-events: none on phones, and proxying a programmatic .click()
        // through React onClick can be unreliable in this stack. RecordingControls
        // exposes window.__ncRecordToggle so we trigger it directly.
        const isRec = lbl.includes("record") || lbl.includes("waiting for host");
        const toggle = (window as any).__ncRecordToggle;
        if (isRec && typeof toggle === "function") {
          toggle();
        } else {
          it.el.click();
        }
      } catch {}
      closeMore();
    };

  const btnStyle: React.CSSProperties = {
    flex: 1,
    height: 48,
    border: 'none',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.08)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  };
  const dangerStyle: React.CSSProperties = { ...btnStyle, background: '#dc2626' };
  const offStyle: React.CSSProperties = { ...btnStyle, background: '#dc2626' };

  return (
    <>
      <div
        data-nc-mobile-bar='true'
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: BAR_HEIGHT,
          padding: '8px 8px calc(env(safe-area-inset-bottom, 0px) + 8px)',
          display: 'flex',
          gap: 8,
          alignItems: 'stretch',
          background: 'linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0.55))',
          zIndex: zIndex.videoChrome,
          boxSizing: 'border-box',
        }}
      >
        <button type='button' onClick={toggleMic} aria-label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'} style={isMicrophoneEnabled ? btnStyle : offStyle}>
          <span aria-hidden='true' style={{ fontSize: 18 }}>{isMicrophoneEnabled ? 'Mic' : 'Mic⊘'}</span>
        </button>
        <button type='button' onClick={toggleCam} aria-label={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'} style={isCameraEnabled ? btnStyle : offStyle}>
          <span aria-hidden='true' style={{ fontSize: 18 }}>{isCameraEnabled ? 'Cam' : 'Cam⊘'}</span>
        </button>
        <button type='button' onClick={openMore} aria-label='More' style={btnStyle}>
          <span aria-hidden='true' style={{ fontSize: 18 }}>More</span>
        </button>
        <button type='button' onClick={leave} aria-label='Leave room' style={dangerStyle}>
          <span aria-hidden='true' style={{ fontSize: 18 }}>Leave</span>
        </button>
      </div>

      {moreOpen && (
        <div
          onClick={closeMore}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: zIndex.videoChromeRaised,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 480,
              background: '#111',
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              padding: 12,
              paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
              maxHeight: '60vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px 10px' }}>
              <div style={{ color: '#fff', fontSize: 14, fontWeight: 600 }}>More</div>
              <button type='button' onClick={closeMore} style={{ color: '#bbb', background: 'transparent', border: 'none', fontSize: 18, cursor: 'pointer' }}>
                Close
              </button>
            </div>
            {items.length === 0 && (
              <div style={{ color: '#888', fontSize: 13, padding: 12, textAlign: 'center' }}>
                No extra actions available right now.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {items.map((it, i) => (
                <button
                  key={i}
                  type='button'
                  onClick={() => fire(it)}
                  style={{
                    height: 48,
                    borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: '#1c1c1e',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    padding: '0 10px',
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
