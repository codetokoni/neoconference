/**
 * hsmoh.org Shortlink API client
 *
 * Base: https://hsmoh.org/api
 * Auth: X-API-Key: <HSMOH_API_KEY>
 * Limit: 100 req/hour (free) — upgrade for more
 */

const BASE = (process.env.HSMOH_BASE_URL || "https://hsmoh.org").replace(/\/+$/, "");
const KEY  = process.env.HSMOH_API_KEY || "";

export type HsmohLink = {
  id: number;
  short_code: string;
  short_url: string;
  long_url: string;
  click_count?: number;
  is_active?: 0 | 1;
  created_at?: string;
};

export type HsmohAnalytics = {
  link: { short_code: string; click_count: number };
  analytics: {
    unique: number;
    timeline:  Array<{ date: string; clicks: number }>;
    countries: Array<{ country: string; clicks: number }>;
    devices:   Array<{ device_type: string; clicks: number }>;
    referrers: Array<{ referrer_source: string; clicks: number }>;
    browsers:  Array<{ browser: string; clicks: number }>;
  };
};

export class HsmohError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "HsmohError";
  }
}

export function isHsmohConfigured(): boolean { return KEY.length > 0; }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!KEY) throw new HsmohError(0, "HSMOH_API_KEY is not configured");
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": KEY,
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = undefined;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  const ok = res.ok && body && typeof body === "object" && "success" in body && (body as { success: unknown }).success === true;
  if (!ok) {
    const msg = (body && typeof body === "object" && "error" in body) ? String((body as { error: unknown }).error) : `HSMOH ${res.status}`;
    throw new HsmohError(res.status, msg, body);
  }
  return body as T;
}

/** Create a short link. Optional alias / password / expiry / max_clicks. */
export function shorten(input: {
  url: string;
  alias?: string;
  title?: string;
  password?: string;
  expires_at?: string;     // YYYY-MM-DD HH:MM:SS
  max_clicks?: number;
}) {
  return call<{ success: true } & HsmohLink>("/shorten", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** List your short links (paginated). */
export function listLinks(input: { page?: number; limit?: number } = {}) {
  const q = new URLSearchParams();
  if (input.page)  q.set("page",  String(input.page));
  if (input.limit) q.set("limit", String(input.limit));
  const qs = q.toString();
  return call<{ success: true; total: number; page: number; links: HsmohLink[] }>(`/links${qs ? "?" + qs : ""}`);
}

/** Click analytics for a code. */
export function getStats(code: string, days: 7 | 30 | 90 = 30) {
  return call<{ success: true } & HsmohAnalytics>(`/stats/${encodeURIComponent(code)}?days=${days}`);
}

/** Permanently delete a link. */
export function deleteLink(code: string) {
  return call<{ success: true; message: string }>(`/links/${encodeURIComponent(code)}`, { method: "DELETE" });
}

/** Convenience: shorten with an alias and silently fall back to auto-alias on collision. */
export async function shortenWithFallback(longUrl: string, preferredAlias?: string, opts: { title?: string } = {}) {
  if (preferredAlias) {
    try {
      return await shorten({ url: longUrl, alias: preferredAlias, title: opts.title });
    } catch (err) {
      if (!(err instanceof HsmohError) || err.status !== 400) throw err;
    }
  }
  return shorten({ url: longUrl, title: opts.title });
}

export const hsmoh = {
  isConfigured: isHsmohConfigured,
  shorten,
  shortenWithFallback,
  listLinks,
  getStats,
  deleteLink,
};
