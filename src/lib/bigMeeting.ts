// src/lib/bigMeeting.ts
//
// Big-meeting receiving: what one browser receives in a meeting of hundreds.
//
// LiveKit's default sends every browser every microphone and camera in the
// meeting. On 23 November 2026, 865 people (638 at once) in one meeting made
// 10,641 joins: browsers, mostly phones, gave up under hundreds of streams and
// rejoined, over and over (median stay 53 s). It stopped within two minutes
// each time a host locked everyone's microphones and cameras — and started
// again when they were unlocked — so the load of receiving everyone is what
// broke it.
//
// So, with the feature on (the meeting owner's "big_meeting_receiving"), the
// room subscribes by itself (autoSubscribe off) to:
//
//   microphones   only unmuted ones, at most MAX_AUDIO: the meeting's Hosts and
//                 Moderators first, then whoever spoke or unmuted most recently.
//                 Everyone may still speak; when someone unmutes or starts
//                 speaking they are received within about half a second.
//   cameras       only those whose tile is on screen (or about to be), at most
//                 MAX_VIDEO. Scrolled away, the stream is let go, not paused.
//   screen shares always.
//
// And someone joining a meeting of BIG_MEETING_AT or more comes in muted
// (not its Hosts or Moderators); they unmute themselves to speak.
//
// Pure: no React, no LiveKit import. The room applies it
// (components/conference/BigMeetingReceiver.tsx).

/** From this many in the meeting, people join muted. */
export const BIG_MEETING_AT = 50;
/** Most microphones one browser receives at once. */
export const MAX_AUDIO = 10;
/** Most cameras one browser receives at once. */
export const MAX_VIDEO = 25;

export type PubSource = "microphone" | "camera" | "screen_share" | "screen_share_audio" | "unknown";

export interface PubInfo {
  /** Unique per publication (participant identity + track sid). */
  key: string;
  identity: string;
  kind: "audio" | "video";
  source: PubSource;
  muted: boolean;
}

export interface ReceiveState {
  /** When each identity was last reported speaking (ms). */
  spokeAt: ReadonlyMap<string, number>;
  /** When each publication was last unmuted or published (ms). */
  liveAt: ReadonlyMap<string, number>;
  /** Identities with a tile on screen (or just off it). */
  visible: ReadonlySet<string>;
  /** Identities always heard first: the meeting's Hosts and Moderators. */
  priority: ReadonlySet<string>;
}

/** Which publications to receive: key → true (subscribe) or false (let go). */
export function receivePlan(pubs: readonly PubInfo[], st: ReceiveState, caps = { audio: MAX_AUDIO, video: MAX_VIDEO }): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const mics: PubInfo[] = [];
  const cams: PubInfo[] = [];
  for (const p of pubs) {
    if (p.source === "screen_share" || p.source === "screen_share_audio") out.set(p.key, true);
    else if (p.kind === "audio") {
      if (p.muted) out.set(p.key, false);
      else mics.push(p);
    } else if (st.visible.has(p.identity)) cams.push(p);
    else out.set(p.key, false);
  }
  const recent = (p: PubInfo) => Math.max(st.spokeAt.get(p.identity) ?? 0, st.liveAt.get(p.key) ?? 0);
  mics.sort((a, b) => Number(st.priority.has(b.identity)) - Number(st.priority.has(a.identity)) || recent(b) - recent(a));
  mics.forEach((p, i) => out.set(p.key, i < caps.audio));
  cams.sort((a, b) => Number(st.priority.has(b.identity)) - Number(st.priority.has(a.identity)) || recent(b) - recent(a));
  cams.forEach((p, i) => out.set(p.key, i < caps.video));
  return out;
}

/** What the token route says about receiving, for the room. */
export interface ReceiveMode {
  receive: "selective" | "all";
  joinMuted: boolean;
}

export function receiveModeOf(body: unknown): ReceiveMode {
  const b = (body ?? {}) as { receive?: unknown; joinMuted?: unknown };
  return { receive: b.receive === "selective" ? "selective" : "all", joinMuted: b.joinMuted === true };
}
