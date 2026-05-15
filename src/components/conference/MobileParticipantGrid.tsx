'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutGroup } from 'framer-motion';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { MobileParticipantTile } from './MobileParticipantTile';

// TODO: dedicated screen-share tiles — see follow-up issue

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MobileParticipantGridProps {
  slug: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isHostRole(p: Participant | undefined | null): boolean {
  if (!p?.metadata) return false;
  try {
    const j = JSON.parse(p.metadata);
    return j && (j.role === 'host' || j.role === 'cohost');
  } catch {
    return false;
  }
}

// Adaptive density (mobile only — this whole component is gated to <640px).
// 1   → 1 col, 16:9 (fullscreen-ish solo)
// 2   → 1 col, 16:9 (stacked landscape, big faces for 1-on-1)
// 3-4 → 2 cols, square (2x2)
// 5-8 → 2 cols, square (scrolls if needed)
// 9+  → 3 cols, square (gallery)
function densityFor(count: number): { cols: string; aspect: 'square' | 'video' } {
  if (count <= 2) return { cols: 'grid-cols-1', aspect: 'video' };
  if (count <= 8) return { cols: 'grid-cols-2', aspect: 'square' };
  return { cols: 'grid-cols-3', aspect: 'square' };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function MobileParticipantGrid({ slug }: MobileParticipantGridProps) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const localIsHost = isHostRole(localParticipant);

  /* ---------- IntersectionObserver visibility tracking ---------- */
  const [visibilityMap, setVisibilityMap] = useState<Map<string, boolean>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeMap = useRef<Map<string, Element>>(new Map());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibilityMap((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const entry of entries) {
            const identity = (entry.target as HTMLElement).dataset.lkParticipantIdentity;
            if (!identity) continue;
            const visible = entry.isIntersecting;
            if (next.get(identity) !== visible) {
              next.set(identity, visible);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { threshold: 0.1, root: null, rootMargin: '0px' },
    );
    observerRef.current = observer;

    // Observe any nodes already registered before the observer was created
    nodeMap.current.forEach((node) => observer.observe(node));

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  const refCallback = useCallback(
    (identity: string) => (node: HTMLDivElement | null) => {
      const prev = nodeMap.current.get(identity);
      if (prev && observerRef.current) {
        observerRef.current.unobserve(prev);
      }
      if (node) {
        nodeMap.current.set(identity, node);
        if (observerRef.current) {
          observerRef.current.observe(node);
        }
      } else {
        nodeMap.current.delete(identity);
      }
    },
    [],
  );

  /* ---------- render ---------- */
  // Outer wrapper uses absolute inset-0 so it fills the parent
  // (<div className="flex-1 relative overflow-hidden"> in MobileVideoConference).
  // min-height: 100% on a flow child of a flex item doesn't reliably resolve,
  // which left the gradient painted only behind the tiles. inset:0 anchors it
  // to the full middle area and lets the grid scroll inside it.
  if (participants.length === 0) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center text-white/40 text-sm"
        style={{
          background: 'radial-gradient(ellipse at top, #0a1a24 0%, #000 60%)',
        }}
      >
        Connecting…
      </div>
    );
  }

  const { cols, aspect } = densityFor(participants.length);

  return (
    <div
      className="absolute inset-0 overflow-y-auto"
      style={{
        background: 'radial-gradient(ellipse at top, #0a1a24 0%, #000 60%)',
      }}
    >
      <LayoutGroup>
        <div className={`grid ${cols} gap-2 px-3 pb-4`}>
          {participants.map((p) => (
            <div key={p.identity} ref={refCallback(p.identity)}>
              <MobileParticipantTile
                participant={p}
                localIsHost={localIsHost}
                participantIsHost={isHostRole(p)}
                slug={slug}
                isVisible={visibilityMap.get(p.identity) ?? true}
                aspect={aspect}
              />
            </div>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
