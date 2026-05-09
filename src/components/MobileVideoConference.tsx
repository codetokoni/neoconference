'use client';

import { useEffect, useState } from 'react';
import {
  ParticipantTile,
  RoomAudioRenderer,
  ControlBar,
  useTracks,
  VideoConference,
  TrackLoop,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';

/**
 * MobileVideoConference
 *
 * Renders a custom 2x2 grid (4 tiles per page) at phone widths (<= 640px).
 * On larger screens, renders the stock <VideoConference /> unchanged.
 *
 * Why: LiveKit's default GridLayout picks 1x2 (2 tiles per page) on portrait
 * phones. Users want to see 4 at once.
 */
export default function MobileVideoConference() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  if (!isMobile) {
    return <VideoConference />;
  }

  return <MobileGridImpl />;
}

const PAGE_SIZE = 4;

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

  return (
    <div
      className="lk-video-conference nc-mobile-vc"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
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
          paddingRight: 62, // reserve gutter for reactions/raise-hand bar
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

      <ControlBar
        controls={{ microphone: true, camera: true, screenShare: false, chat: true, leave: true }}
      />
      <RoomAudioRenderer />
    </div>
  );
}
