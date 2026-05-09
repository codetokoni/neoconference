'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ParticipantTile,
  useTracks,
  VideoConference,
  TrackLoop,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';

/**
 * MobileVideoConference
 *
 * Phone (<= 640px): custom 2x2 grid (4 tiles per page) with horizontal swipe to
 * paginate. Desktop: stock <VideoConference /> unchanged.
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
    // Ignore mostly-vertical drags so we don't hijack scrolls
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0 && safePage < totalPages - 1) setPage(safePage + 1);
    else if (dx > 0 && safePage > 0) setPage(safePage - 1);
  };

  return (
    <div
      className="lk-video-conference nc-mobile-vc"
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
        className="nc-mobile-grid"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          gap: 6,
          padding: 6,
          paddingRight: 62,
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
    </div>
  );
}
