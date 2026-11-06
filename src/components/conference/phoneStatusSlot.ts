'use client';

// src/components/conference/phoneStatusSlot.ts
//
// The phone layout's status strip: a row under the room name, above the
// tiles, in the layout (MobileVideoConference). On a phone the meeting
// timer, the captions (CC) button, the transcript notice and the spotlight
// chip go in it instead of floating over the tiles at fixed positions made
// for a computer. There the timer (top 128, right 16, 160 wide) sat on the
// first row's right-hand tile, its menu button included, and took its taps;
// the CC button and the host's spotlight hint covered the tiles above the
// control bar.

import { useEffect, useState } from 'react';

export const PHONE_STATUS_SLOT_ID = 'nc-phone-status';

/** The phone layout's status strip while it is on the page, else null. */
export function usePhoneStatusSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const find = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setSlot(document.getElementById(PHONE_STATUS_SLOT_ID)));
    };
    setSlot(document.getElementById(PHONE_STATUS_SLOT_ID));
    // The layout switches between phone and computer with the window's
    // width, so the strip comes and goes.
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return slot;
}
