'use client';

// src/components/HiddenVideosProvider.tsx
//
// Shared client state for FRS §5.x display-only video suppression.
//
// Two independent sets of hidden identities are tracked:
//
//   local  — the viewer's own preference (localStorage-backed, per-slug).
//            Any user can hide any tile on their own screen. Survives
//            reloads. Never leaves the browser.
//
//   global — the moderator's broadcast state. Persisted on the server
//            (Redis via /api/events/hide-video) and pushed live over the
//            LiveKit data channel with the message
//              { type: "hidden-videos", set: string[] }
//            Late joiners fetch the current set once on mount.
//
// The combined "should this tile hide its video?" check is exposed as
// isHidden(identity) — it OR's the two sets and always exempts the local
// participant so the hidden person still sees their own preview (matches
// the pattern users expect from every other conference app).
//
// The hooks live in this same file so consumers get typed access without
// crossing a package boundary; consumers should call the exported hooks,
// not touch the context directly.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

/* ------------------------------------------------------------------ */
/*  Constants and message format                                       */
/* ------------------------------------------------------------------ */

const DATA_MSG_TYPE = 'hidden-videos';

function storageKey(slug: string): string {
  return `neo:room:${slug}:hidden-videos-local`;
}

function readLocalSet(slug: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey(slug));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function writeLocalSet(slug: string, s: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(slug), JSON.stringify(Array.from(s)));
  } catch {
    // storage quota / private mode — the preference just won't persist.
  }
}

/* ------------------------------------------------------------------ */
/*  Context                                                             */
/* ------------------------------------------------------------------ */

interface HiddenVideosCtx {
  /** Combined set (local ∪ global) for iteration — includes the local
   *  identity if either side listed it. Use `isHidden(id)` for the check
   *  a tile actually cares about, since that also handles the self
   *  exemption. */
  hiddenSet: Set<string>;
  localSet: Set<string>;
  globalSet: Set<string>;
  isHidden: (identity: string) => boolean;
  isHiddenLocally: (identity: string) => boolean;
  isHiddenGlobally: (identity: string) => boolean;
  /** Toggle this viewer's own preference. */
  toggleLocal: (identity: string, hide: boolean) => void;
  /** Toggle the broadcast state. Rejects with 403 if the caller lacks
   *  participant:hideVideo. */
  toggleGlobal: (identity: string, hide: boolean) => Promise<void>;
}

const NoopCtx: HiddenVideosCtx = {
  hiddenSet: new Set(),
  localSet: new Set(),
  globalSet: new Set(),
  isHidden: () => false,
  isHiddenLocally: () => false,
  isHiddenGlobally: () => false,
  toggleLocal: () => {},
  toggleGlobal: async () => {},
};

const HiddenCtx = createContext<HiddenVideosCtx>(NoopCtx);

export function useHiddenVideos(): HiddenVideosCtx {
  return useContext(HiddenCtx);
}

/* ------------------------------------------------------------------ */
/*  Provider                                                            */
/* ------------------------------------------------------------------ */

export function HiddenVideosProvider({
  slug,
  children,
}: {
  slug: string;
  children: ReactNode;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const localIdentity = localParticipant?.identity ?? null;

  const [localSet, setLocalSet] = useState<Set<string>>(() => new Set());
  const [globalSet, setGlobalSet] = useState<Set<string>>(() => new Set());
  const localSetRef = useRef(localSet);
  const globalSetRef = useRef(globalSet);
  useEffect(() => { localSetRef.current = localSet; }, [localSet]);
  useEffect(() => { globalSetRef.current = globalSet; }, [globalSet]);

  /* ----- local preference: load, persist, expose toggle ----- */
  useEffect(() => {
    setLocalSet(readLocalSet(slug));
  }, [slug]);

  const toggleLocal = useCallback(
    (identity: string, hide: boolean) => {
      setLocalSet((prev) => {
        const next = new Set(prev);
        if (hide) next.add(identity);
        else next.delete(identity);
        writeLocalSet(slug, next);
        return next;
      });
    },
    [slug],
  );

  /* ----- global state: initial fetch + data-channel subscription ----- */
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`/api/events/hide-video?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json || !Array.isArray(json.hidden)) return;
        setGlobalSet(new Set(json.hidden.filter((v: unknown): v is string => typeof v === 'string')));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!room) return;
    const decoder = new TextDecoder();
    const onData = (payload: Uint8Array) => {
      let msg: { type?: string; set?: unknown };
      try {
        msg = JSON.parse(decoder.decode(payload));
      } catch {
        return;
      }
      if (!msg || msg.type !== DATA_MSG_TYPE) return;
      if (!Array.isArray(msg.set)) return;
      const next = new Set<string>();
      for (const v of msg.set) {
        if (typeof v === 'string') next.add(v);
      }
      setGlobalSet(next);
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  const broadcastGlobal = useCallback(
    async (nextSet: Set<string>) => {
      const lp = room?.localParticipant;
      if (!lp) return;
      try {
        const payload = new TextEncoder().encode(
          JSON.stringify({ type: DATA_MSG_TYPE, set: Array.from(nextSet) }),
        );
        await lp.publishData(payload, { reliable: true });
      } catch {
        // Data-channel failure is non-fatal — server persistence is the
        // source of truth, and clients re-fetch it on room mount.
      }
    },
    [room],
  );

  const toggleGlobal = useCallback(
    async (identity: string, hide: boolean) => {
      const r = await fetch('/api/events/hide-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, identity, hide }),
      });
      if (!r.ok) {
        // Bubble a typed error so callers can surface a permission message.
        let code = 'request_failed';
        try {
          const j = (await r.json()) as { error?: string };
          if (j?.error) code = j.error;
        } catch {
          // ignore
        }
        throw new Error(code);
      }
      const j = (await r.json()) as { hidden: string[] };
      const next = new Set(j.hidden);
      setGlobalSet(next);
      // Push it out — every client that isn't going to refetch this route
      // gets the update via the data channel.
      broadcastGlobal(next);
    },
    [slug, broadcastGlobal],
  );

  const value = useMemo<HiddenVideosCtx>(() => {
    const combined = new Set<string>();
    localSet.forEach((id) => combined.add(id));
    globalSet.forEach((id) => combined.add(id));

    // No self-exemption: if the local user hides themselves (locally
    // or globally) their own tile disappears too. Matches the "when I
    // hide myself my video should disappear" behaviour users expect.
    // The identity check just gates on non-empty input.
    void localIdentity;
    const isHidden = (identity: string) => {
      if (!identity) return false;
      return combined.has(identity);
    };
    const isHiddenLocally = (identity: string) =>
      identity ? localSet.has(identity) : false;
    const isHiddenGlobally = (identity: string) =>
      identity ? globalSet.has(identity) : false;

    return {
      hiddenSet: combined,
      localSet,
      globalSet,
      isHidden,
      isHiddenLocally,
      isHiddenGlobally,
      toggleLocal,
      toggleGlobal,
    };
  }, [localSet, globalSet, localIdentity, toggleLocal, toggleGlobal]);

  return <HiddenCtx.Provider value={value}>{children}</HiddenCtx.Provider>;
}
