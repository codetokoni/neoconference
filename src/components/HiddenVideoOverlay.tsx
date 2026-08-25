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
import { useLocalParticipant, useParticipants } from '@livekit/components-react';

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
  const participants = useParticipants();
  const localIdentity = localParticipant?.identity ?? null;

  // LiveKit's built-in ParticipantTile only exposes
  // `data-lk-participant-name` in its DOM — never
  // `data-lk-participant-identity` (verified against
  // @livekit/components-react 2.9.20). So a selector keyed on identity
  // matches nothing on desktop, which is why hidden tiles were staying
  // visible even though the local state had flipped. Map identity →
  // name here and hide by name via CSS `:has()`.
  //
  // Names aren't strictly unique in LiveKit, but if two participants
  // share a display name and the moderator hides one, hiding both is
  // acceptable — the alternative is a MutationObserver / class-toggle
  // dance that fights every LiveKit re-render. `:has()` is available
  // in every browser we support.
  //
  // Mobile is unaffected: MobileParticipantGrid filters its own
  // participants array by isHidden(id) before mapping — the tile isn't
  // rendered at all, so no CSS is needed there.

  const nameForId = new Map<string, string>();
  for (const p of participants) {
    nameForId.set(p.identity, (p.name || p.identity).trim());
  }

  const targetNames = Array.from(hiddenSet)
    .filter((id) => id && id !== localIdentity)
    .map((id) => nameForId.get(id))
    .filter((n): n is string => Boolean(n));

  if (targetNames.length === 0) return null;

  const unique = Array.from(new Set(targetNames));
  const selector = unique
    .map(
      (name) =>
        `.lk-participant-tile:has([data-lk-participant-name="${cssEscape(name)}"])`,
    )
    .join(', ');

  // display: none fully collapses the cell so LiveKit's CSS-grid
  // layout re-flows — a room of 3 with 1 hidden looks like a room of 2.
  const css = `${selector} { display: none !important; }`;

  return <style data-neo-hidden-videos>{css}</style>;
}
