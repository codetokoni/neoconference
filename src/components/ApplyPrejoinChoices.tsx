"use client";

import { useEffect, useRef } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import type { LocalUserChoices } from "@livekit/components-react";

/**
 * Applies prejoin mute choices once the local participant is connected.
 *
 * We always pass audio={true} video={true} to LiveKitRoom so tracks are
 * created at connect time (permissions captured, publishers wired up).
 * Then we immediately disable them here if the user prejoin'd as muted.
 *
 * This fixes the bug where muting on prejoin meant tracks never existed,
 * so the in-room toolbar buttons couldn't toggle them.
 */
export default function ApplyPrejoinChoices({
  choices,
}: {
  choices: LocalUserChoices | null;
}) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const appliedRef = useRef(false);

  useEffect(() => {
    if (!choices || !localParticipant || appliedRef.current) return;
    if (room.state !== "connected") return;
    appliedRef.current = true;
    (async () => {
      try {
        if (choices.audioEnabled === false) {
          await localParticipant.setMicrophoneEnabled(false);
        }
        if (choices.videoEnabled === false) {
          await localParticipant.setCameraEnabled(false);
        }
      } catch {
        // ignore
      }
    })();
  }, [choices, localParticipant, room.state]);

  return null;
}
