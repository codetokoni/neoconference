      "Content-Type": "application/json",
      Authorization: `Bearer ${KEY}`,
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && typeof body === "object" && "error" in body) ? String((body as { error: unknown }).error) : `StreamLab ${res.status}`;
    throw new StreamLabError(res.status, msg, body);
  }
  return body as T;
}

/** Create a new stream. Returns RTMP ingest + HLS playback URLs. */
export function createStream(input: { name: string; mode?: "single" | "multistream"; latency?: "ultra" | "low" | "hls"; }) {
  return call<{ stream: StreamLabStream }>("/streams/create", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      mode: input.mode ?? "single",
      latency: input.latency ?? "hls",
    }),
  });
}

/** Get current status of a stream. */
export function getStreamStatus(streamId: string) {
  return call<{ stream: StreamLabStream }>(`/streams/status?id=${encodeURIComponent(streamId)}`);
}

/** Trigger a broadcast immediately. */
export function fireBroadcastNow(input: { stream_id: string; title?: string; }) {
  return call<{ ok: true; broadcast_id: string }>("/broadcasts/fire-now", {
    method: "POST",
    body: JSON.stringify(input),
  });

}

/** Cancel a scheduled broadcast. */
export function cancelBroadcast(input: { broadcast_id: string }) {
  return call<{ ok: true }>("/broadcasts/cancel", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Add a multistream destination (YouTube, Facebook, Twitch, custom RTMP). */
export function addDestination(input: { stream_id: string; destination: StreamLabDestination }) {
  return call<{ destination: StreamLabDestination }>("/streams/destinations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export const streamlab = {
  isConfigured: isStreamLabConfigured,
  createStream,
  getStreamStatus,
  fireBroadcastNow,
  cancelBroadcast,
  addDestination,
};
