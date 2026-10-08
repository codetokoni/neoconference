import { TRANSLATION_LANGUAGES } from "./translationLanguages";

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
  /**
   * True for a language with no interpreter booth: no AMS stream behind
   * it, only the translation worker's captions, read aloud by the browser.
   */
  machine?: boolean;
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
/**
 * Channel template. Each entry becomes `${room}<suffix>` when scoped to
 * a room — Floor English is always `<room>-video`, French is
 * `<room>-a-fr`, etc. The first entry MUST be the video-bearing stream.
 * Same shape across every room today; per-room language configs can
 * come later when a venue actually differs.
 */
interface ChannelTemplate {
  suffix: string;
  label: string;
  code: string;
  lang: string;
  color: string;
  video?: boolean;
}

const CHANNEL_TEMPLATE: ChannelTemplate[] = [
  { suffix: "-video", label: "Floor — English", code: "EN", lang: "en", color: "#7C8C98", video: true },
  { suffix: "-a-fr",  label: "Français",        code: "FR", lang: "fr", color: "#3F80EE" },
  { suffix: "-a-es",  label: "Español",         code: "ES", lang: "es", color: "#E0912C" },
  { suffix: "-a-pt",  label: "Português",       code: "PT", lang: "pt", color: "#2FA268" },
  { suffix: "-a-ar",  label: "العربية", code: "AR", lang: "ar", color: "#A96BDD" },
];

export function channelsForRoom(room = SIMULCAST_MAIN): SimulcastChannel[] {
  return CHANNEL_TEMPLATE.map(({ suffix, ...rest }) => ({
    id: `${room}${suffix}`,
    ...rest,
  }));
}

/**
 * Every other language the translation worker captions into (DeepL), for
 * the player's "More languages" list. Not AMS streams: their ids
 * (`<room>-t-<code>`) are never subscribed to or polled, so the studio
 * console and /api/video/status keep to the booths above. English is the
 * floor; Português is the booth (Brazilian), so neither Portuguese entry
 * is repeated here.
 */
export function machineChannelsForRoom(room = SIMULCAST_MAIN): SimulcastChannel[] {
  const booths = new Set(CHANNEL_TEMPLATE.map((c) => c.lang));
  return TRANSLATION_LANGUAGES.filter((l) => !booths.has(l.code) && l.code !== "pt-br")
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((l) => ({
      id: `${room}-t-${l.code}`,
      // English first, for a list in alphabetical order; the language's
      // own name after it, for the person looking for theirs.
      label: l.native === l.label ? l.label : `${l.label} · ${l.native}`,
      // Chat keeps four characters of it.
      code: l.code === "zh-hant" ? "ZHTW" : l.code.toUpperCase(),
      lang: l.code,
      color: "#5E7684",
      machine: true,
    }));
}

/**
 * The More languages that get a button of their own, in order. Started as
 * the first ten of POPULAR_TRANSLATION_CODES past English and the booths;
 * on 8 Oct 2026 Hausa and Igbo took Dutch's and Polish's places for this
 * audience. The player's own list, so the home page and the meeting
 * translator keep theirs.
 */
export const TOP_MACHINE_CODES = ["de", "it", "ha", "ja", "ko", "zh", "hi", "ru", "tr", "ig"];

/**
 * More languages as the rail shows them: TOP_MACHINE_CODES as buttons, in
 * that order, and the rest in the list, alphabetical.
 */
export function splitMachineChannels(more: SimulcastChannel[]): {
  top: SimulcastChannel[];
  rest: SimulcastChannel[];
} {
  const byLang = new Map(more.map((c) => [c.lang, c]));
  const top = TOP_MACHINE_CODES.map((code) => byLang.get(code)).filter(
    (c): c is SimulcastChannel => Boolean(c),
  );
  const topIds = new Set(top.map((c) => c.id));
  return { top, rest: more.filter((c) => !topIds.has(c.id)) };
}

export function videoChannelForRoom(room = SIMULCAST_MAIN): SimulcastChannel {
  const chans = channelsForRoom(room);
  return chans.find((c) => c.video) ?? chans[0];
}

/**
 * Build the query string portion of an internal moderator URL.
 * ALWAYS emits `?room=<slug>` — even when the slug matches the
 * SIMULCAST_MAIN default — so every URL across the app carries the
 * same shape. An earlier revision collapsed the query on the default
 * room, but operator feedback preferred visual uniformity across
 * rooms over shorter URLs on one specific room. Trade-off recorded
 * here so a future contributor doesn't quietly re-shorten it.
 *
 * Extras are appended in the order the caller passed them; falsy
 * values (undefined / null / empty string / false) are dropped so
 * `roomLink(room, { screen: undefined })` doesn't emit `screen=`.
 * Values are `encodeURIComponent`-encoded on the way out.
 */
export function roomLink(
  room: string,
  extras: Record<string, string | number | boolean | undefined | null> = {},
): string {
  const parts: string[] = [];
  if (room) parts.push(`room=${encodeURIComponent(room)}`);
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function channelTrackIdsForRoom(room = SIMULCAST_MAIN): string[] {
  return channelsForRoom(room).map((c) => c.id);
}

/** Default-room presets kept as exports for callers that predate multi-tenant. */
export const SIMULCAST_CHANNELS: SimulcastChannel[] = channelsForRoom(SIMULCAST_MAIN);
export const VIDEO_CHANNEL: SimulcastChannel = videoChannelForRoom(SIMULCAST_MAIN);
export const CHANNEL_TRACK_IDS: string[] = channelTrackIdsForRoom(SIMULCAST_MAIN);

/** Redis key holding the participant currently featured to air, if any. */
export const featuredKey = (room: string) => `neo:video:featured:${room}`;

export interface FeaturedState {
  /** AMS stream id of the featured participant, played directly by viewers. */
  streamId: string;
  /** Shown under the player while they are on air. */
  label: string;
  /**
   * Roster fields captured at feature-time and displayed as a lower
   * third over the featured video. Optional — a featured participant
   * from a room without a roster upload has neither, and the overlay
   * gracefully collapses to just the label.
   */
  condition?: string;
  country?: string;
  at: number;
}

export function channelById(
  id: string,
  channels: SimulcastChannel[] = SIMULCAST_CHANNELS,
): SimulcastChannel | undefined {
  return channels.find((c) => c.id === id);
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
