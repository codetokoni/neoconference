// src/components/conference/bigMeetingSubscriptions.ts
//
// Applies big-meeting receiving (src/lib/bigMeeting.ts) to a LiveKit room
// connected with autoSubscribe off: on every change in what is published,
// muted, spoken or on screen, it subscribes to what the plan says and lets
// go of the rest. Which cameras are on screen comes from the tiles
// themselves (TILE_IDENTITY_SELECTOR, watched with an IntersectionObserver).
// Inside the scrolling grid a tile counts once it is actually in view (the
// grid clips it), so a camera scrolled to arrives a fraction of a second later.
//
// No React: the room's wrapper (BigMeetingReceiver.tsx) starts it, and the
// browser tests run it against the real livekit-client.

import { RoomEvent, Track, type Participant, type RemoteTrackPublication, type Room, type TrackPublication } from "livekit-client";
import { receivePlan, type PubInfo, type PubSource } from "@/lib/bigMeeting";
import { TILE_IDENTITY_SELECTOR, tileIdentityOf } from "./roomLayout";

function sourceOf(s: string | undefined): PubSource {
  if (s === Track.Source.Microphone) return "microphone";
  if (s === Track.Source.Camera) return "camera";
  if (s === Track.Source.ScreenShare) return "screen_share";
  if (s === Track.Source.ScreenShareAudio) return "screen_share_audio";
  return "unknown";
}

function roleOf(p: Participant): string {
  try {
    return String((JSON.parse(p.metadata || "{}") as { role?: unknown }).role ?? "");
  } catch {
    return "";
  }
}

const keyOf = (p: Participant, pub: TrackPublication) => `${p.identity}/${pub.trackSid}`;

/** Wait after a change before re-planning, so a burst of events plans once. */
const SETTLE_MS = 150;
/** Wait after the page changes before looking for new tiles. */
const SCAN_MS = 200;

export interface ReceiverOptions {
  /** Where the tiles are (the page). */
  root?: Document;
  now?: () => number;
}

/** Start receiving selectively; returns a function that stops it. */
export function startReceiving(room: Room, opts: ReceiverOptions = {}): () => void {
  const doc = opts.root ?? document;
  const now = opts.now ?? Date.now;
  const spokeAt = new Map<string, number>();
  const liveAt = new Map<string, number>();
  const tiles = new Map<Element, string>();
  const onScreen = new Set<Element>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const apply = () => {
    timer = undefined;
    if (stopped) return;
    const pubs: PubInfo[] = [];
    const byKey = new Map<string, RemoteTrackPublication>();
    const priority = new Set<string>();
    for (const p of room.remoteParticipants.values()) {
      const role = roleOf(p);
      if (role === "host" || role === "cohost") priority.add(p.identity);
      for (const pub of p.trackPublications.values()) {
        const key = keyOf(p, pub);
        byKey.set(key, pub);
        pubs.push({ key, identity: p.identity, kind: pub.kind === Track.Kind.Audio ? "audio" : "video", source: sourceOf(pub.source), muted: pub.isMuted });
      }
    }
    const visible = new Set<string>();
    for (const el of onScreen) {
      const id = tiles.get(el);
      if (id) visible.add(id);
    }
    for (const [key, want] of receivePlan(pubs, { spokeAt, liveAt, visible, priority })) {
      const pub = byKey.get(key);
      if (pub && pub.isSubscribed !== want) pub.setSubscribed(want);
    }
  };
  const schedule = () => {
    if (!timer && !stopped) timer = setTimeout(apply, SETTLE_MS);
  };
  const onLive = (pub: TrackPublication, p: Participant) => {
    if (p && !p.isLocal) liveAt.set(keyOf(p, pub), now());
    schedule();
  };
  const onSpeakers = (speakers: Participant[]) => {
    const t = now();
    for (const s of speakers) spokeAt.set(s.identity, t);
    schedule();
  };
  const plain = [
    RoomEvent.Connected,
    RoomEvent.Reconnected,
    RoomEvent.TrackUnpublished,
    RoomEvent.TrackMuted,
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
    RoomEvent.ParticipantMetadataChanged,
  ] as const;
  room.on(RoomEvent.TrackPublished, onLive).on(RoomEvent.TrackUnmuted, onLive).on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
  for (const e of plain) room.on(e, schedule);

  const io =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (e.isIntersecting) onScreen.add(e.target);
              else onScreen.delete(e.target);
            }
            schedule();
          },
          { rootMargin: "200px" },
        );
  const scan = () => {
    scanTimer = undefined;
    if (stopped) return;
    const present = new Set(Array.from(doc.querySelectorAll(TILE_IDENTITY_SELECTOR)));
    for (const el of present) {
      const id = tileIdentityOf(el);
      if (!tiles.has(el)) io?.observe(el);
      if (id) tiles.set(el, id);
    }
    for (const el of Array.from(tiles.keys())) {
      if (present.has(el)) continue;
      io?.unobserve(el);
      tiles.delete(el);
      onScreen.delete(el);
    }
    schedule();
  };
  const mo = new MutationObserver(() => {
    if (!scanTimer && !stopped) scanTimer = setTimeout(scan, SCAN_MS);
  });
  mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-neo-identity", "data-lk-participant-identity"] });
  scan();

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(scanTimer);
    mo.disconnect();
    io?.disconnect();
    room.off(RoomEvent.TrackPublished, onLive).off(RoomEvent.TrackUnmuted, onLive).off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    for (const e of plain) room.off(e, schedule);
  };
}
