// src/lib/analytics.ts
// Lightweight Vercel KV-backed counters for recordings.
// Tracks per-key counts for: views (replay page hits), downloads, share-resolves.
// All operations are best-effort: when KV is not configured, they no-op.
//
// Keys:
//   neo:rec:views:<base64url(key)>      -> integer
//   neo:rec:downloads:<base64url(key)>  -> integer
//   neo:rec:shares:<base64url(key)>     -> integer

import { kv } from "@vercel/kv";

export type RecordingMetric = "views" | "downloads" | "shares";

export type RecordingStats = {
  views: number;
  downloads: number;
  shares: number;
};

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
  );
}

function encodeKey(objectKey: string): string {
  return Buffer.from(objectKey, "utf8").toString("base64url");
}

function counterKey(metric: RecordingMetric, objectKey: string): string {
  return `neo:rec:${metric}:${encodeKey(objectKey)}`;
}

export const recordingAnalytics = {
  isConfigured: isKvConfigured,

  async bump(metric: RecordingMetric, objectKey: string): Promise<number | null> {
    if (!isKvConfigured() || !objectKey) return null;
    try {
      return await kv.incr(counterKey(metric, objectKey));
    } catch {
      return null;
    }
  },

  async getStats(objectKey: string): Promise<RecordingStats> {
    const empty: RecordingStats = { views: 0, downloads: 0, shares: 0 };
    if (!isKvConfigured() || !objectKey) return empty;
    try {
      const [v, d, s] = await Promise.all([
        kv.get<number>(counterKey("views", objectKey)),
        kv.get<number>(counterKey("downloads", objectKey)),
        kv.get<number>(counterKey("shares", objectKey)),
      ]);
      return {
        views: Number(v) || 0,
        downloads: Number(d) || 0,
        shares: Number(s) || 0,
      };
    } catch {
      return empty;
    }
  },

  async getStatsBatch(objectKeys: string[]): Promise<Record<string, RecordingStats>> {
    const out: Record<string, RecordingStats> = {};
    if (!isKvConfigured()) {
      for (const k of objectKeys) out[k] = { views: 0, downloads: 0, shares: 0 };
      return out;
    }
    await Promise.all(
      objectKeys.map(async (k) => {
        out[k] = await recordingAnalytics.getStats(k);
      })
    );
    return out;
  },
};
