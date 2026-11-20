"use client";

import { useEffect, useRef } from "react";
import { useLocalParticipant, useRoomContext, type LocalUserChoices } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";

/**
 * Applies prejoin mute choices once the local participant is connected.
 *
 * The room now publishes only what was chosen on the join screen
 * (joinMedia, src/components/conference/roomOptions.ts): a camera or
 * microphone switched off there is never published, and the in-room
 * buttons start it when wanted. This stays as a safety net: if a track is
 * published anyway (an embed that publishes both), the choice still wins,
 * retried on RoomEvent.Connected and on track publication.
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
