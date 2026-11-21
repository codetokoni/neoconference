'use client';

// The computer layout's control bar: LiveKit's own, plus a locked
// microphone button while an Owner, Host or Moderator has locked this
// person's microphone (micLockClient.ts).
//
// LiveKit's bar leaves the microphone button out by itself when the server
// takes the permission away; this puts a button with a lock where it was,
// which says why instead of trying. The wrapper is the bar (lk-control-bar)
// and LiveKit's own is laid out inside it (display: contents), so the
// buttons sit in one row as before.

import { ControlBar } from '@livekit/components-react';
import { Lock } from 'lucide-react';
import { MIC_LOCKED_MESSAGE, noteMicLocked, useMicLocked } from './micLockClient';

export default function NeoControlBar() {
  const locked = useMicLocked();
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
      <ControlBar controls={{ chat: true, settings: false }} style={{ display: 'contents' }} />
    </div>
  );
}
