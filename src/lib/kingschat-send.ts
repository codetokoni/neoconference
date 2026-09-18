// src/lib/kingschat-send.ts
//
// Server-side "push a text message to a KingsChat user's chat" helper.
//
// Prerequisites:
//   - The recipient has signed in through /api/auth/kingschat with our
//     app and granted the send_chat_message scope. That's already true
//     for anyone who has ever used the KingsChat sign-in option here.
//   - The callback stored their accessToken + refreshToken + expiresAt
//     in KV via saveKcTokens() (see /api/auth/kingschat/callback).
//
// Env vars (all optional, sensible defaults):
//   KINGSCHAT_SEND_URL    POST endpoint. Default:
//                         https://connect.kingsch.at/developer/api/send-message
//   KINGSCHAT_TOKEN_URL   OAuth token refresh endpoint. Default:
//                         https://accounts.kingsch.at/oauth2/token
//   KINGSCHAT_CLIENT_ID   OAuth client id, required for refresh. Falls
//                         back to the same value used for the auth flow.
//
// KC's send endpoint isn't documented uniformly across their SDKs — if
// the exact URL or payload shape changes, override with env vars and no
// code change is needed.

import { loadKcTokens, saveKcTokens, type KcTokens } from '@/lib/kc-tokens';

const DEFAULT_SEND_URL =
  process.env.KINGSCHAT_SEND_URL ||
  'https://connect.kingsch.at/developer/api/send-message';
const DEFAULT_TOKEN_URL =
  process.env.KINGSCHAT_TOKEN_URL ||
  'https://accounts.kingsch.at/oauth2/token';

const REFRESH_LEAD_MS = 60_000; // Refresh 60 s before actual expiry.

export type KcSendResult =
  | { ok: true }
  | { ok: false; reason: 'not_linked' | 'no_refresh' | 'refresh_failed' | 'send_failed'; status?: number; body?: string };

/**
 * Refresh the recipient's access token using their refresh token.
 * Returns the fresh tokens (already persisted via saveKcTokens) or
 * null if refresh failed or no refresh token is stored.
 */
async function refreshKcAccessToken(
  clerkUserId: string,
  tokens: KcTokens,
): Promise<KcTokens | null> {
  if (!tokens.refreshToken) return null;
  const clientId = process.env.KINGSCHAT_CLIENT_ID;
  if (!clientId) {
    console.warn('[kc-send] KINGSCHAT_CLIENT_ID missing; cannot refresh');
    return null;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: clientId,
  });
  try {
    const r = await fetch(DEFAULT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('[kc-send] refresh failed', r.status, t.slice(0, 200));
      return null;
    }
    const j = (await r.json()) as {
      access_token?: string;
      accessToken?: string;
      refresh_token?: string;
      refreshToken?: string;
      expires_in?: number;
      expiresIn?: number;
    };
    const accessToken = j.access_token || j.accessToken;
    if (!accessToken) return null;
    const refreshToken = j.refresh_token || j.refreshToken || tokens.refreshToken;
    const expiresIn = j.expires_in || j.expiresIn || 3600;
    const fresh: KcTokens = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    await saveKcTokens(clerkUserId, fresh);
    return fresh;
  } catch (err) {
    console.warn('[kc-send] refresh threw', err);
    return null;
  }
}

/**
 * Push a plain-text message to the KingsChat user linked to
 * `clerkUserId`. Refreshes the access token when it's within
 * REFRESH_LEAD_MS of expiry.
 */
export async function sendKcMessage(
  clerkUserId: string,
  message: string,
): Promise<KcSendResult> {
  if (!clerkUserId || !message.trim()) {
    return { ok: false, reason: 'send_failed', body: 'empty_message' };
  }

  let tokens = await loadKcTokens(clerkUserId);
  if (!tokens || !tokens.accessToken) {
    return { ok: false, reason: 'not_linked' };
  }

  // Refresh if we're near or past expiry.
  if (
    !tokens.expiresAt ||
    Date.now() >= tokens.expiresAt - REFRESH_LEAD_MS
  ) {
    if (!tokens.refreshToken) {
      return { ok: false, reason: 'no_refresh' };
    }
    const refreshed = await refreshKcAccessToken(clerkUserId, tokens);
    if (!refreshed) return { ok: false, reason: 'refresh_failed' };
    tokens = refreshed;
  }

  // Payload shape kept minimal — KC's send endpoint accepts message +
  // template. Overrides land in KINGSCHAT_SEND_URL if the shape ever
  // changes.
  const payload = {
    message,
    template: 'text_only',
  };

  try {
    const r = await fetch(DEFAULT_SEND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + tokens.accessToken,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      // A 401 after we just refreshed means the refresh token is gone
      // too — the recipient needs to re-sign-in for us to reach them
      // again. Surface as `not_linked` so the UI shows the correct
      // "ask them to re-sign-in" message.
      if (r.status === 401) {
        return { ok: false, reason: 'not_linked', status: 401, body: body.slice(0, 200) };
      }
      return {
        ok: false,
        reason: 'send_failed',
        status: r.status,
        body: body.slice(0, 200),
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'send_failed',
      body: err instanceof Error ? err.message : String(err),
    };
  }
}
