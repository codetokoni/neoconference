'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useRoomContext } from '@livekit/components-react';
import NeoVideoConference from './conference/NeoVideoConference';
import MobileParticipantGrid from './conference/MobileParticipantGrid';
import MobileControlBar from './conference/MobileControlBar';
import RoomHeaderPill from './conference/RoomHeaderPill';
import ReactionsRail from './conference/ReactionsRail';
import { PHONE_STATUS_SLOT_ID } from './conference/phoneStatusSlot';
import { leaveMeeting } from './conference/leaveMeeting';

/**
 * MobileVideoConference
 *
 * Phone (<= 640px): 3-column participant grid with header pill,
 * reactions rail, and glass control bar.
 * Desktop: LiveKit's <VideoConference /> layout, as NeoVideoConference
 * (tiles that say whose they are, and a way back from an enlarged tile).
 */
export default function MobileVideoConference({
  hideSelf = false,
  ownerUserId = null,
}: {
  hideSelf?: boolean;
  /** The meeting's owner (a Clerk user id), for the pinned row's Owner. */
  ownerUserId?: string | null;
}) {
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
    return <NeoVideoConference hideSelf={hideSelf} ownerUserId={ownerUserId} />;
  }

  return <MobileLayout ownerUserId={ownerUserId} />;
}

/* ------------------------------------------------------------------ */
/*  Mobile layout (rendered only on phones)                            */
/* ------------------------------------------------------------------ */

function MobileLayout({ ownerUserId }: { ownerUserId: string | null }) {
  const room = useRoomContext();
  const params = useParams();
  const searchParams = useSearchParams();
  const roomName = decodeURIComponent(params.name as string);
  const slug = searchParams?.get('event') || roomName;

  // To "How was the meeting?", as the room's own onLeave does: this full
  // page load used to go to "/" and won over it (leaveMeeting.ts).
  const handleLeave = useCallback(() => leaveMeeting(room, slug), [room, slug]);

  return (
    <div className="lk-video-conference nc-mobile-vc flex flex-col h-full">
      <RoomHeaderPill roomName={slug} />
      {/* The status strip: the timer, CC, the transcript notice and the
          spotlight put themselves here on a phone (phoneStatusSlot.ts),
          in the layout instead of over the tiles. Empty, it takes no room. */}
      <div
        id={PHONE_STATUS_SLOT_ID}
        className="flex flex-wrap items-center justify-center gap-2 px-3 empty:hidden"
        style={{ paddingBottom: 6 }}
      />
      <div className="flex-1 relative overflow-hidden">
        <MobileParticipantGrid slug={slug} ownerUserId={ownerUserId} />
        <ReactionsRail />
      </div>
      <MobileControlBar onLeave={handleLeave} />
    </div>
  );
}
