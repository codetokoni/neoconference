// src/types/event.ts
// NeoConference unified event schema.
// Single source of truth for the entire ecosystem:
//   LiveKit room <-> StreamLab stream <-> HSMOH shortlink <-> QR code <-> replay.

export type EventRole = 'host' | 'cohost' | 'speaker' | 'viewer';

export type EventState =
  | 'scheduled' // created, not yet open
  | 'waiting'   // open, attendees in waiting room
  | 'live'      // active call / streaming
  | 'ended'     // call closed, no replay yet
  | 'replay'    // recording available
  | 'archived'; // soft-deleted

export type EventVisibility = 'public' | 'unlisted' | 'private';

export interface RoleAssignment {
  /** Clerk user id when known, otherwise email or display name. */
  identifier: string;
  role: EventRole;
  /** Optional display label for the directory UI. */
  label?: string;
  /** When true, attendee skips the waiting room. */
  preApproved?: boolean;
}

export interface WaitingRoomEntry {
  id: string;
  name: string;
  email?: string;
  requestedAt: number;
  status: 'pending' | 'admitted' | 'denied';
}

export interface StreamLabBinding {
  streamId: string;
  rtmpUrl?: string;
  streamKey?: string;
  hlsUrl?: string;
  playbackId?: string;
  destinations?: Array<{ id: string; platform: string; label?: string }>;
}

export interface HsmohBinding {
  shortCode: string;
  shortUrl: string;
  /** True when fallback (local /e/<slug>) is being used. */
  fallback?: boolean;
}

export interface RecordingArtifact {
  /** R2 object key. */
  key: string;
  /** Bytes, when known. */
  size?: number;
  /** ISO timestamp. */
  createdAt: string;
  /** mp4, hls, etc. */
  kind: 'mp4' | 'hls' | 'audio' | 'transcript';
  /** Optional caption / language. */
  label?: string;
}

export interface Chapter {
  /** Stable id (slug-of-label or hash). */
  id: string;
  /** Start of this chapter in seconds from beginning of recording. */
  startSec: number;
  /** Optional end. When omitted, chapter runs until next chapter or EOF. */
  endSec?: number;
  /** Short human label, e.g. "Welcome & Intros". */
  label: string;
  /** Optional 1-2 sentence summary. */
  summary?: string;
  /** Source: heuristic = derived from transcript silences/keywords, ai = LLM-labeled, manual = host-edited. */
  source: 'heuristic' | 'ai' | 'manual';
}

export interface NeoEvent {
  /** Internal UUID. */
  id: string;
  /** URL-safe public slug, e.g. friday-keynote-x4f. */
  slug: string;
  /** Human title, e.g. "Friday Keynote". */
  name: string;
  /** Optional rich description / agenda (markdown). */
  description?: string;

  /** Clerk user id of the creator. */
  ownerUserId: string;
  /** Optional human display name for the owner (snapshot at create time). */
  ownerName?: string;

  visibility: EventVisibility;
  /** When set, attendees must enter this password before joining. */
  password?: string;
  /** When true, every join request must be approved by host/cohost. */
  waitingRoomEnabled: boolean;

  /** Custom domain (e.g. live.acme.com) routed to /e/<slug> by middleware. */
  customDomain?: string;

  /** ISO timestamp for scheduled start. */
  scheduledAt?: string;
  /** ISO timestamp for when host actually went live. */
  startedAt?: string;
  /** ISO timestamp for when event ended. */
  endedAt?: string;

  /** LiveKit room name (must match the route /room/<name>). */
  livekitRoom: string;

  /** StreamLab Cloud binding (optional, only set when Go-Live used). */
  streamlab?: StreamLabBinding;

  /** HSMOH shortlink binding (optional, falls back to /e/<slug>). */
  hsmoh?: HsmohBinding;

  /** Random seed used for QR rotation / signed URLs. */
  qrSeed: string;

  /** Role assignments by identifier. */
  roles: RoleAssignment[];

  /** Pending / processed waiting-room queue. */
  waitingRoom: WaitingRoomEntry[];

  /** Persistent recording / replay artifacts. */
  recordings: RecordingArtifact[];

  /** Auto-derived or AI-labeled chapter markers for the replay timeline. */
  chapters?: Chapter[];

  /** Lifecycle state. */
  state: EventState;

  /** ISO created / updated timestamps. */
  createdAt: string;
  updatedAt: string;
}

/**
 * Subset of NeoEvent that is safe to expose to anonymous viewers
 * (waiting-room and replay pages). Strips all secrets.
 */
export interface PublicEventView {
  id: string;
  slug: string;
  name: string;
  description?: string;
  ownerName?: string;
  scheduledAt?: string;
  startedAt?: string;
  endedAt?: string;
  state: EventState;
  hasPassword: boolean;
  waitingRoomEnabled: boolean;
  customDomain?: string;
  hlsUrl?: string;
  shortUrl?: string;
  recordings: RecordingArtifact[];
  chapters?: Chapter[];
}

export function toPublicView(e: NeoEvent): PublicEventView {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    ownerName: e.ownerName,
    scheduledAt: e.scheduledAt,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    state: e.state,
    hasPassword: Boolean(e.password),
    waitingRoomEnabled: e.waitingRoomEnabled,
    customDomain: e.customDomain,
    hlsUrl: e.streamlab?.hlsUrl,
    shortUrl: e.hsmoh?.shortUrl,
    recordings: e.recordings,
    chapters: e.chapters,
  };
}
