// src/lib/livestream.ts
//
// Livestreaming a meeting: the meeting's own video, composed by LiveKit
// egress (the same machinery that records), pushed over RTMP to YouTube,
// Facebook, Twitch or any RTMP address. No OBS, no third-party broadcast
// service. Before this, Go Live handed the host StreamLab credentials and
// told them to point OBS at them: the meeting itself was never sent, and
// production had no StreamLab key.
//
// Stream keys are secrets. They go to LiveKit once, at start, and are
// never stored: the event keeps only which platforms it is live on.

/** The part of LiveKit's StreamInfo this reads (status is its enum). */
export type StreamInfoLike = { status: number; error: string };

export type StreamPlatform = "youtube" | "facebook" | "twitch" | "rtmp";

export const STREAM_PLATFORMS: ReadonlyArray<{ id: StreamPlatform; label: string; keyHint: string }> = [
  { id: "youtube", label: "YouTube", keyHint: "Stream key from YouTube Studio › Go live" },
  { id: "facebook", label: "Facebook", keyHint: "Stream key from Facebook Live Producer" },
  { id: "twitch", label: "Twitch", keyHint: "Primary stream key from the Twitch dashboard" },
  { id: "rtmp", label: "Custom RTMP", keyHint: "The full rtmp:// or rtmps:// address, key included" },
];

/** What the host asks for: a platform and its key (or a full address). */
export type StreamDestinationInput = {
  platform: StreamPlatform;
  /** The stream key for youtube / facebook / twitch; the whole URL for rtmp. */
  key: string;
  /** Optional name shown to everyone, e.g. "Church channel". */
  label?: string;
};

/** What is kept and shown: never the key. */
export type StreamDestination = {
  platform: StreamPlatform;
  label: string;
};

/** The stream, as stored on the event while it runs. */
export type LiveStreamState = {
  egressId: string;
  startedAt: string;
  startedBy: string;
  destinations: StreamDestination[];
};

export function platformLabel(platform: StreamPlatform): string {
  return STREAM_PLATFORMS.find((p) => p.id === platform)?.label ?? platform;
}

/**
 * The RTMP address LiveKit is given for a destination, key included.
 * The platform bases are the ones each publishes for "custom" encoders.
 */
export function rtmpUrlFor(d: StreamDestinationInput): string {
  const key = d.key.trim();
  switch (d.platform) {
    case "youtube":
      return "rtmp://a.rtmp.youtube.com/live2/" + key;
    case "facebook":
      return "rtmps://live-api-s.facebook.com:443/rtmp/" + key;
    case "twitch":
      return "rtmp://live.twitch.tv/app/" + key;
    case "rtmp":
      return key;
  }
}

/**
 * A reason the destination cannot be used, or null. Keys are checked for
 * shape only — a wrong key is something the platform reports, and LiveKit
 * passes that on per URL (see [destinationStatus]).
 */
export function destinationProblem(d: StreamDestinationInput): string | null {
  const key = (d.key || "").trim();
  if (!STREAM_PLATFORMS.some((p) => p.id === d.platform)) return "Unknown platform.";
  if (!key) return d.platform === "rtmp" ? "Enter the RTMP address." : "Enter the stream key.";
  if (d.platform === "rtmp") {
    if (!/^rtmps?:\/\/\S+$/i.test(key)) return "The address must start with rtmp:// or rtmps://.";
    return null;
  }
  if (/\s/.test(key)) return "A stream key has no spaces.";
  if (/^rtmps?:\/\//i.test(key)) return "Paste just the stream key, not the whole address.";
  if (key.length < 8 || key.length > 200) return "That does not look like a stream key.";
  return null;
}

/** What is kept of a destination: platform and a name, never the key. */
export function publicDestination(d: StreamDestinationInput): StreamDestination {
  const label = (d.label || "").trim().slice(0, 40);
  return { platform: d.platform, label: label || platformLabel(d.platform) };
}

export type DestinationStatus = "connecting" | "live" | "ended" | "failed";

/**
 * LiveKit reports each RTMP URL's state in the egress info. The URL holds
 * the key, so it is matched back to a destination by position and never
 * returned; only the status and LiveKit's error text are.
 */
export function destinationStatus(info: StreamInfoLike | undefined): {
  status: DestinationStatus;
  error?: string;
} {
  if (!info) return { status: "connecting" };
  // StreamInfo_Status: ACTIVE = 0, FINISHED = 1, FAILED = 2.
  switch (info.status as number) {
    case 0:
      return { status: "live" };
    case 1:
      return { status: "ended" };
    case 2:
      return { status: "failed", error: info.error || "The platform refused the stream." };
    default:
      return { status: "connecting" };
  }
}

/** "Live on YouTube and Facebook" — for the room and the event page. */
export function liveOnText(destinations: StreamDestination[]): string {
  const names = destinations.map((d) => d.label);
  if (names.length === 0) return "Live";
  if (names.length === 1) return "Live on " + names[0];
  return "Live on " + names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}
