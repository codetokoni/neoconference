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
  if (participants.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-white/40 text-sm"
        style={{
          minHeight: '100%',
          background: 'radial-gradient(ellipse at top, #0a1a24 0%, #000 60%)',
        }}
      >
        Connecting…
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={{
        minHeight: '100%',
        background: 'radial-gradient(ellipse at top, #0a1a24 0%, #000 60%)',
      }}
    >
      <LayoutGroup>
        <div className="grid grid-cols-3 gap-2 px-3 pb-4 overflow-y-auto">
          {participants.map((p) => (
            <div key={p.identity} ref={refCallback(p.identity)}>
              <MobileParticipantTile
                participant={p}
                localIsHost={localIsHost}
                participantIsHost={isHostRole(p)}
                slug={slug}
                isVisible={visibilityMap.get(p.identity) ?? true}
              />
            </div>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
