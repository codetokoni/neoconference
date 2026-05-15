'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { VideoConference, useRoomContext } from '@livekit/components-react';
import MobileParticipantGrid from './conference/MobileParticipantGrid';
import MobileControlBar from './conference/MobileControlBar';
import RoomHeaderPill from './conference/RoomHeaderPill';
import ReactionsRail from './conference/ReactionsRail';

/**
 * MobileVideoConference
 *
 * Phone (<= 640px): 3-column participant grid with header pill,
 * reactions rail, and glass control bar.
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

  return <MobileLayout />;
}

/* ------------------------------------------------------------------ */
/*  Mobile layout (rendered only on phones)                            */
/* ------------------------------------------------------------------ */

function MobileLayout() {
  const room = useRoomContext();
  const params = useParams();
  const searchParams = useSearchParams();
  const roomName = decodeURIComponent(params.name as string);
  const slug = searchParams?.get('event') || roomName;

  const handleLeave = useCallback(() => {
    try { room?.disconnect(); } catch {}
    if (typeof window !== 'undefined') window.location.href = '/';
  }, [room]);

  return (
    <div className="lk-video-conference nc-mobile-vc flex flex-col h-full">
      <RoomHeaderPill roomName={slug} />
      <div className="flex-1 relative overflow-hidden">
        <MobileParticipantGrid slug={slug} />
        <ReactionsRail />
      </div>
      <MobileControlBar onLeave={handleLeave} />
    </div>
  );
}
