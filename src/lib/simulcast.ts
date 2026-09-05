export type ChannelId = string;

export interface SimulcastChannel {
  /** AMS stream id this channel is published under */
  id: ChannelId;
  /** Shown in the channel rail */
  label: string;
  /** Short code shown on chat messages */
  code: string;
  /** BCP-47, used for the <audio lang> attribute */
  lang: string;
  /** Accent colour for the rail + now-hearing chip */
  color: string;
  /** True for the stream that carries the picture */
  video?: boolean;
}

export interface ChatMessage {
  seq: number;
  ts: number;
  name: string;
  /** language channel the sender was listening on */
  code: string;
  text: string;
}

export const SIMULCAST_MAIN =
  process.env.NEXT_PUBLIC_SIMULCAST_MAIN?.trim() || "neoconf";

export const AMS_WS =
  process.env.NEXT_PUBLIC_AMS_WS?.trim() ||
  "wss://ingest.streamlab.cloud/LiveApp/websocket";

export const AMS_HTTP =
  process.env.NEXT_PUBLIC_AMS_HTTP?.trim() ||
  "https://ingest.streamlab.cloud/LiveApp";

/**
 * Edit this list to add or remove interpretation booths.
 * The first entry MUST be the video-bearing stream.
 */
export const SIMULCAST_CHANNELS: SimulcastChannel[] = [
  { id: `${SIMULCAST_MAIN}-video`, label: "Floor — English", code: "EN", lang: "en", color: "#7C8C98", video: true },
  { id: `${SIMULCAST_MAIN}-a-fr`,  label: "Français",        code: "FR", lang: "fr", color: "#3F80EE" },
  { id: `${SIMULCAST_MAIN}-a-es`,  label: "Español",         code: "ES", lang: "es", color: "#E0912C" },
  { id: `${SIMULCAST_MAIN}-a-pt`,  label: "Português",       code: "PT", lang: "pt", color: "#2FA268" },
  { id: `${SIMULCAST_MAIN}-a-ar`,  label: "العربية", code: "AR", lang: "ar", color: "#A96BDD" },
];

export const VIDEO_CHANNEL =
  SIMULCAST_CHANNELS.find((c) => c.video) ?? SIMULCAST_CHANNELS[0];

/**
 * The only subtracks a public viewer should ever be sent from the broadcast
 * group. Participant cameras publish into their own main track, so naming
 * these explicitly is what stops a viewer receiving fifty of them.
 */
export const CHANNEL_TRACK_IDS: string[] = SIMULCAST_CHANNELS.map((c) => c.id);

/** Redis key holding the participant currently featured to air, if any. */
export const featuredKey = (room: string) => `neo:video:featured:${room}`;

export interface FeaturedState {
  /** AMS stream id of the featured participant, played directly by viewers. */
  streamId: string;
  /** Shown under the player while they are on air. */
  label: string;
  at: number;
}

export function channelById(id: string): SimulcastChannel | undefined {
  return SIMULCAST_CHANNELS.find((c) => c.id === id);
}

/** AMS prefixes WebRTC track ids; normalise back to the stream id. */
export function normaliseTrackId(raw: string): string {
  let id = raw || "";
  for (const p of ["ARDAMSx", "ARDAMSv", "ARDAMSa", "ARDAMS"]) {
    if (id.startsWith(p)) { id = id.slice(p.length); break; }
  }
  return id;
}

export function hlsUrl(streamId: string): string {
  return `${AMS_HTTP}/streams/${encodeURIComponent(streamId)}.m3u8`;
}

/* ---------------- server-side only ---------------- */

export const AMS_REST =
  process.env.AMS_REST_BASE?.trim() || `${AMS_HTTP}/rest/v2`;

export interface AmsBroadcast {
  streamId: string;
  status: string;
  mainTrackStreamId?: string;
  webRTCViewerCount?: number;
  hlsViewerCount?: number;
  startTime?: number;
}

/** Live subtracks of the main track. Falls back to the flat list endpoint. */
export async function fetchSubtracks(main = SIMULCAST_MAIN): Promise<AmsBroadcast[]> {
  const opts: RequestInit = { cache: "no-store", signal: AbortSignal.timeout(6000) };

  try {
    const r = await fetch(
      `${AMS_REST}/broadcasts/${encodeURIComponent(main)}/subtracks?offset=0&size=100`,
      opts,
    );
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j)) return j as AmsBroadcast[];
    }
  } catch {
    /* fall through to the list endpoint */
  }

  const r = await fetch(`${AMS_REST}/broadcasts/list/0/200`, opts);
  if (!r.ok) throw new Error(`AMS list ${r.status}`);
  const all = (await r.json()) as AmsBroadcast[];
  return all.filter((b) => b.mainTrackStreamId === main || b.streamId === main);
}

/**
 * Is this stream currently pushing to AMS.
 *
 * Used to self-heal a stale "featured" pointer whose publisher has gone
 * away without anyone clearing the KV entry. Conservative on failure:
 * on a network error or a 5xx we return true so a transient AMS blip
 * does not evict a valid pointer. A 404 or a status field that is not
 * "broadcasting" are the only signals we treat as a definite no.
 */
export async function isBroadcasting(streamId: string): Promise<boolean> {
  try {
    const r = await fetch(
      `${AMS_REST}/broadcasts/${encodeURIComponent(streamId)}`,
      { cache: "no-store", signal: AbortSignal.timeout(4000) },
    );
    if (r.status === 404) return false;
    if (!r.ok) return true;
    const b = (await r.json()) as AmsBroadcast;
    return b?.status === "broadcasting";
  } catch {
    return true;
  }
}
