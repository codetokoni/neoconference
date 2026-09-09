import { AMS_HTTP } from "@/lib/simulcast";
import { roomMainTrack } from "@/lib/participantCodes";

/**
 * Publish URLs a professional broadcaster (OBS, vMix, Wirecast, a
 * hardware encoder) needs to push a fully-mixed programme feed into
 * a NeoConference room's main broadcaster instead of using the
 * browser-based Studio page.
 *
 * Two flavours because different tools speak different protocols:
 *
 *   WHIP  — modern, WebRTC-based, one-way publish over HTTPS. OBS
 *           30+, vMix 27+, Larix Broadcaster and OBS-WHIP all
 *           understand it. Sub-second latency to the audience.
 *
 *   RTMP  — legacy but universal. Every encoder built in the last
 *           15 years speaks it. Higher latency (~2-5s) and requires
 *           TCP port 1935 open on the AMS host.
 *
 * The room slug is the only credential — same shared-secret pattern
 * the Studio browser URL already uses. If the token later needs
 * hardening (per-event JWTs, expiring streamKeys) the derivation
 * changes in this one file and nothing on the hub or the encoder
 * side has to move.
 */

export interface BroadcastEndpoints {
  streamId: string;
  /** Full WHIP URL — OBS 30+ "WHIP" service, Server field. */
  whipUrl: string;
  /** RTMP server URL — Custom / OBS "RTMP" service, Server field. */
  rtmpServer: string;
  /** RTMP stream key — the same as streamId; OBS "Stream Key" field. */
  rtmpKey: string;
  /** Convenience: fully-qualified RTMP URL (server + "/" + key). */
  rtmpFull: string;
  /** SRT publish URL if AMS's SRT ingest is enabled. */
  srtUrl: string | null;
}

function parseAms(url: string): { host: string; appName: string } | null {
  try {
    const u = new URL(url);
    const appName = u.pathname.replace(/^\/|\/$/g, "") || "LiveApp";
    return { host: u.hostname, appName };
  } catch {
    return null;
  }
}

export function broadcastEndpointsForRoom(room: string): BroadcastEndpoints | null {
  const parts = parseAms(AMS_HTTP);
  if (!parts) return null;
  const streamId = roomMainTrack(room);

  // WHIP: newer AMS versions expose /<app>/whip/<streamId>. Override
  // via NEXT_PUBLIC_AMS_WHIP_BASE (full base up to just before the
  // streamId segment) if your AMS lives at a non-standard path.
  const whipBase = (
    process.env.NEXT_PUBLIC_AMS_WHIP_BASE?.trim() || `${AMS_HTTP.replace(/\/$/, "")}/whip`
  ).replace(/\/$/, "");
  const whipUrl = `${whipBase}/${encodeURIComponent(streamId)}`;

  // RTMP: AMS listens on 1935 by default with the app path from
  // AMS_HTTP. Override via NEXT_PUBLIC_AMS_RTMP (fully-qualified
  // server URL, no trailing slash) when the ingest host or port
  // differs from the HTTP host — common in multi-node setups.
  const rtmpServer = (
    process.env.NEXT_PUBLIC_AMS_RTMP?.trim() ||
    `rtmp://${parts.host}:1935/${parts.appName}`
  ).replace(/\/$/, "");
  const rtmpFull = `${rtmpServer}/${streamId}`;

  // SRT is optional — only surface it when the operator explicitly
  // opts in via env. A phantom SRT URL that fails silently would be
  // worse than not offering it.
  const srtUrl = process.env.NEXT_PUBLIC_AMS_SRT?.trim()
    ? `${process.env.NEXT_PUBLIC_AMS_SRT.trim()}?streamid=${encodeURIComponent(streamId)}`
    : null;

  return {
    streamId,
    whipUrl,
    rtmpServer,
    rtmpKey: streamId,
    rtmpFull,
    srtUrl,
  };
}
