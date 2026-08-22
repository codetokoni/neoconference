// src/lib/streamlab.ts
//
// StreamLab Cloud REST client.
// Base: https://streamlab.cloud/api/v1
// Auth: X-API-Key: <STREAMLAB_API_KEY>  (Bearer is stripped by cPanel's Apache)
// Limit: 300 req/min

const BASE = (process.env.STREAMLAB_BASE_URL || 'https://streamlab.cloud/api/v1').replace(/\/+$/, '');
const KEY = process.env.STREAMLAB_API_KEY || '';

export interface StreamLabDestination {
  id?: string;
  platform: 'youtube' | 'facebook' | 'twitch' | 'rtmp';
  rtmp_url?: string;
  stream_key?: string;
  label?: string;
}

export interface StreamLabStream {
  id: string;
  name?: string;
  rtmpUrl?: string;
  streamKey?: string;
  hlsUrl?: string;
  playbackId?: string;
  status?: string;
}

export class StreamLabError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = 'StreamLabError';
  }
}

export function isStreamLabConfigured(): boolean {
  return KEY.length > 0;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!KEY) throw new StreamLabError(0, 'STREAMLAB_API_KEY is not configured');
  const url = BASE + path;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': KEY, 'Authorization': 'Bearer ' + KEY, 'User-Agent': 'NeoConference/1.0 (+https://neoconference.app)',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let body: unknown = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!res.ok) {
    const msg = (body && typeof body === 'object' && 'error' in body)
      ? String((body as { error: unknown }).error)
      : 'StreamLab ' + res.status;
    throw new StreamLabError(res.status, msg, body);
  }
  return body as T;
}

/**
 * Create a new stream. Returns a flattened StreamLabStream.
 * The remote response is { stream: {...} } and we unwrap to a flat object.
 */
export async function createStream(input: {
  name: string;
  mode?: 'single' | 'multistream';
  latency?: 'ultra' | 'low' | 'hls';
}): Promise<StreamLabStream> {
  const r = await call<{ stream: StreamLabStream } | StreamLabStream>(
    '/streams/create.php',
    {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        mode: input.mode ?? 'single',
        latency: input.latency ?? 'hls',
      }),
    }
  );
  // Unwrap { stream } if wrapped.
  return (r as { stream?: StreamLabStream }).stream ?? (r as StreamLabStream);
}

export async function getStreamStatus(streamId: string): Promise<StreamLabStream> {
  const r = await call<{ stream: StreamLabStream } | StreamLabStream>(
    '/streams/status.php?id=' + encodeURIComponent(streamId)
  );
  return (r as { stream?: StreamLabStream }).stream ?? (r as StreamLabStream);
}

export function fireBroadcastNow(input: { stream_id: string; title?: string }) {
  return call<{ ok: true; broadcast_id: string }>('/broadcasts/fire-now', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function cancelBroadcast(input: { broadcast_id: string }) {
  return call<{ ok: true }>('/broadcasts/cancel', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function addDestination(input: {
  stream_id: string;
  destination: StreamLabDestination;
}) {
  return call<{ destination: StreamLabDestination }>('/streams/destinations', {
    method: 'POST',
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
