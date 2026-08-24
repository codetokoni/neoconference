'use client';

// src/components/HiddenVideoOverlay.tsx
//
// Desktop-side rendering for the FRS §5.x display-only hide. Mobile tiles
// draw their own hide state directly in MobileParticipantTile — this
// component covers the LiveKit-rendered <VideoConference> path we don't
// own the internals of.
//
// Approach: emit a <style> tag with one rule per currently-hidden identity
// that covers `[data-lk-participant-identity="…"]` with an opaque dark
// overlay via ::after. The video keeps playing behind it (we don't want
// to tear down the subscription — reveal should be instant), but nothing
// visible reaches the viewer. A "Video hidden" label sits centered on top.
//
// Using CSS rather than manipulating LiveKit's DOM keeps this resilient
// to LiveKit re-renders: newly-inserted tiles for the same identity pick
// up the rule automatically, and no MutationObserver is required.

import { useHiddenVideos } from '@/components/HiddenVideosProvider';
import { useLocalParticipant } from '@livekit/components-react';

/**
 * CSS.escape polyfill for identity strings that could contain characters
 * requiring escaping in a selector. Server-safe fallback for SSR.
 */
function cssEscape(v: string): string {
  if (typeof window !== 'undefined' && (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS?.escape) {
    return (window as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(v);
  }
  return v.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `);
}

export default function HiddenVideoOverlay() {
  const { hiddenSet } = useHiddenVideos();
  const { localParticipant } = useLocalParticipant();
  const localIdentity = localParticipant?.identity ?? null;

  const targets = Array.from(hiddenSet).filter((id) => id && id !== localIdentity);
  if (targets.length === 0) return null;

  const selector = targets
    .map((id) => `[data-lk-participant-identity="${cssEscape(id)}"]`)
    .join(', ');

  // Fully remove the tile from layout so the grid re-flows around it —
  // a room of 3 with 1 hidden should look exactly like a room of 2, not
  // like a 3-tile grid with a black hole in it. LiveKit's tile grid
  // uses CSS grid auto-placement, so `display: none` collapses the
  // cell cleanly.
  const css = `${selector} { display: none !important; }`;

  return <style data-neo-hidden-videos>{css}</style>;
}
