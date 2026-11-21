'use client';

// The computer layout's control bar: LiveKit's own, plus locked microphone
// and camera buttons while an Owner, Host or Moderator has locked this
// person (micLockClient.ts), and a moderator's "Mute all" and "Lock".
//
// LiveKit's bar leaves the microphone, camera and screen buttons out by
// itself when the server takes publishing away; this puts buttons with a
// lock where the microphone and camera were, which say why instead of
// trying. The wrapper is the bar (lk-control-bar)
// and LiveKit's own is laid out inside it (display: contents), so the
// buttons sit in one row as before.

import { ControlBar } from '@livekit/components-react';
import { Lock } from 'lucide-react';
import { CAM_LOCKED_MESSAGE, MIC_LOCKED_MESSAGE, noteCamLocked, noteMicLocked, useCamLocked, useMicLocked } from './micLockClient';
import { HostMicControlBarButtons } from './MuteEveryone';

export default function NeoControlBar() {
  const locked = useMicLocked();
  // Locked on its own while allowed to talk: the microphone is theirs, the camera not.
  const camLocked = useCamLocked();
  return (
    <div className="lk-control-bar" data-neo-control-bar="">
      {locked ? (
        <button
          type="button"
          className="lk-button"
          aria-label="Microphone locked"
          title={MIC_LOCKED_MESSAGE}
          data-mic-locked="true"
          onClick={noteMicLocked}
        >
          <Lock aria-hidden width={16} height={16} />
          <span className="max-[760px]:hidden">Microphone</span>
        </button>
      ) : null}
      {camLocked ? (
        <button
          type="button"
          className="lk-button"
          aria-label="Camera locked"
          title={locked ? MIC_LOCKED_MESSAGE : CAM_LOCKED_MESSAGE}
          data-mic-locked="true"
          onClick={noteCamLocked}
        >
          <Lock aria-hidden width={16} height={16} />
          <span className="max-[760px]:hidden">Camera</span>
        </button>
      ) : null}
      <ControlBar controls={{ chat: true, settings: false }} style={{ display: 'contents' }} />
      {/* Owner, Host and Moderator: "Mute all" and "Lock", right of Leave. */}
      <HostMicControlBarButtons />
    </div>
  );
}
