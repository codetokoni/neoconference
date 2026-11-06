'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  CarouselLayout,
  Chat,
  ConnectionStateToast,
  ControlBar,
  FocusLayout,
  FocusLayoutContainer,
  GridLayout,
  LayoutContextProvider,
  ParticipantTile,
  RoomAudioRenderer,
  isTrackReference,
  useCreateLayoutContext,
  useParticipants,
  usePinnedTracks,
  useTrackRefContext,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { RoomEvent, Track } from 'livekit-client';
import { useHiddenVideos } from '@/components/HiddenVideosProvider';
import { enlargedTileGone } from './roomLayout';

/**
 * The meeting's video layout on a computer or tablet: LiveKit's own
 * <VideoConference> (components-react 2.9.20, prefabs.mjs), the same grid,
 * focus view, control bar and chat, with three things it could not do.
 *
 * - Every tile carries who it is (`data-neo-identity`, `data-neo-source`).
 *   LiveKit's tiles say only the display name, so the tile menu was put on
 *   the first tile with that name: two people of one name (or one person
 *   on two devices, or a person and their own screen share) got one menu
 *   between them, sometimes for the other one.
 * - A clear way back. Enlarging a tile (LiveKit's focus toggle, or a
 *   screen share, which enlarges itself) left only that tile's small
 *   shrink button, which the tile menu sat on top of: the way back to the
 *   gallery was a refresh. Now a "Back to gallery" bar says what is
 *   enlarged and undoes it, and Esc does too.
 * - The enlarged tile never goes stale: when that person leaves, or their
 *   video is hidden (on this screen or for everyone), or it is you and
 *   "Hide me" is on, the gallery comes back instead of an empty stage.
 *
 * Nothing here touches the call: tracks, publications and the connection
 * are LiveKit's, and moving between the grid and the focus view only moves
 * tiles.
 */
export default function NeoVideoConference({ hideSelf = false }: { hideSelf?: boolean }) {
  const [widget, setWidget] = useState<{ showChat: boolean; unreadMessages: number; showSettings?: boolean }>({ showChat: false, unreadMessages: 0 });
  const lastAutoFocusedScreenShareTrack = useRef<TrackReferenceOrPlaceholder | null>(null);

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );
  const layoutContext = useCreateLayoutContext();
  const screenShareTracks = tracks.filter(isTrackReference).filter((t) => t.publication.source === Track.Source.ScreenShare);
  const focusTrack = usePinnedTracks(layoutContext)?.[0];
  const carouselTracks = tracks.filter((t) => !sameTrack(t, focusTrack));

  const participants = useParticipants();
  const hidden = useHiddenVideos();
  const clearPin = () => layoutContext.pin.dispatch?.({ msg: 'clear_pin' });

  // LiveKit's own focus rules, unchanged: a new screen share is enlarged,
  // and the gallery comes back when that share ends.
  useEffect(() => {
    if (screenShareTracks.some((t) => t.publication.isSubscribed) && lastAutoFocusedScreenShareTrack.current === null) {
      layoutContext.pin.dispatch?.({ msg: 'set_pin', trackReference: screenShareTracks[0] });
      lastAutoFocusedScreenShareTrack.current = screenShareTracks[0];
    } else if (
      lastAutoFocusedScreenShareTrack.current &&
      !screenShareTracks.some(
        (t) => t.publication.trackSid === lastAutoFocusedScreenShareTrack.current?.publication?.trackSid,
      )
    ) {
      clearPin();
      lastAutoFocusedScreenShareTrack.current = null;
    }
    if (focusTrack && !isTrackReference(focusTrack)) {
      const updated = tracks.find(
        (t) => t.participant.identity === focusTrack.participant.identity && t.source === focusTrack.source,
      );
      if (updated !== focusTrack && isTrackReference(updated)) {
        layoutContext.pin.dispatch?.({ msg: 'set_pin', trackReference: updated });
      }
    }
    // Same dependencies as LiveKit's prefab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    screenShareTracks.map((t) => `${t.publication.trackSid}_${t.publication.isSubscribed}`).join(),
    focusTrack?.publication?.trackSid,
    tracks,
  ]);

  // The enlarged tile must be someone still here and still shown.
  const focusIdentity = focusTrack?.participant.identity;
  const focusIsLocal = focusTrack?.participant.isLocal ?? false;
  const focusGone = enlargedTileGone({
    focusIdentity,
    focusIsLocal,
    present: participants.map((p) => p.identity),
    isHidden: hidden.isHidden,
    hideSelf,
  });
  useEffect(() => {
    if (focusGone) clearPin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusGone]);

  // Esc goes back to the gallery, unless it is closing something else
  // (a menu, a dialog) or the browser's own fullscreen.
  useEffect(() => {
    if (!focusTrack) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.fullscreenElement) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]')) return;
      clearPin();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!focusTrack]);

  const focusName = focusTrack
    ? focusTrack.participant.isLocal
      ? focusTrack.source === Track.Source.ScreenShare
        ? 'Your screen'
        : 'You'
      : `${focusTrack.participant.name || focusTrack.participant.identity}${
          focusTrack.source === Track.Source.ScreenShare ? "'s screen" : ''
        }`
    : '';

  return (
    <div className="lk-video-conference">
      <LayoutContextProvider value={layoutContext} onWidgetChange={setWidget}>
        <div className="lk-video-conference-inner">
          {focusTrack && !focusGone ? (
            <div className="lk-focus-layout-wrapper neo-focus-wrapper">
              <div className="neo-focus-bar" data-neo-focus-bar="true">
                <span className="neo-focus-bar-label">
                  Enlarged on your screen: <strong>{focusName}</strong>
                </span>
                <button type="button" className="neo-focus-bar-back" onClick={clearPin}>
                  Back to gallery
                </button>
              </div>
              <FocusLayoutContainer>
                <CarouselLayout tracks={carouselTracks}>
                  <NeoTile />
                </CarouselLayout>
                <FocusLayout trackRef={focusTrack} data-neo-identity={focusTrack.participant.identity} data-neo-source={focusTrack.source} />
              </FocusLayoutContainer>
            </div>
          ) : (
            <div className="lk-grid-layout-wrapper">
              <GridLayout tracks={tracks}>
                <NeoTile />
              </GridLayout>
            </div>
          )}
          <ControlBar controls={{ chat: true, settings: false }} />
        </div>
        <Chat style={{ display: widget.showChat ? 'grid' : 'none' } as CSSProperties} />
      </LayoutContextProvider>
      <RoomAudioRenderer />
      <ConnectionStateToast />
    </div>
  );
}

/** A LiveKit tile that says whose it is. */
function NeoTile() {
  const trackRef = useTrackRefContext();
  return (
    <ParticipantTile
      data-neo-identity={trackRef.participant.identity}
      data-neo-source={trackRef.source}
    />
  );
}

function sameTrack(a?: TrackReferenceOrPlaceholder, b?: TrackReferenceOrPlaceholder): boolean {
  if (!a || !b) return false;
  if (a.participant.identity !== b.participant.identity || a.source !== b.source) return false;
  const sa = a.publication?.trackSid;
  const sb = b.publication?.trackSid;
  return sa === sb;
}
