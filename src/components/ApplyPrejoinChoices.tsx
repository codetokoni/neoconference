"use client";

import { useEffect, useRef } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import type { LocalUserChoices } from "@livekit/components-react";

/**
 * Applies prejoin mute choices once the local participant is connected.
 *
 * We pass audio={true} video={true} to LiveKitRoom so tracks are created
 * at connect time (permissions captured, publishers wired up). Then we
 * apply the user's prejoin choice here, retrying on RoomEvent.Connected
 * and on track publication so we win any race against LiveKit's own
 * auto-publish lifecycle.
 *
 * Fixes: muting on prejoin meant tracks never existed, so the in-room
 * toolbar buttons couldn't toggle them.
 */
export default function ApplyPrejoinChoices({
  choices,
}: {
  choices: LocalUserChoices | null;
}) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const appliedRef = useRef(false);

  // Apply once when connected (or whenever choices/localParticipant change)
  useEffect(() => {
    if (!choices || !localParticipant) return;
    const apply = async () => {
      try {
        if (choices.audioEnabled === false) {
          await localParticipant.setMicrophoneEnabled(false);
        }
        if (choices.videoEnabled === false) {
          await localParticipant.setCameraEnabled(false);
        }
        appliedRef.current = true;
      } catch {
        // ignore
      }
    };
    if (room.state === "connected") {
      apply();
    }
    // Also retry on Connected and TrackPublished — LiveKit may auto-publish
    // tracks slightly after the connected event fires.
    const onConnected = () => apply();
    const onTrackPublished = () => {
      if (!appliedRef.current) apply();
    };
    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.LocalTrackPublished, onTrackPublished);
    return () => {
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.LocalTrackPublished, onTrackPublished);
    };
  }, [choices, localParticipant, room]);

  return null;
}
