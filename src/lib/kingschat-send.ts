// src/lib/kingschat-send.ts
//
// Server-side "send a KingsChat message to someone" helper.
//
// Matches KingsChat's own web SDK (kingschat-web-sdk 0.1.0,
// dist/api/message.api.js and dist/api/token.api.js), which is the only
// authoritative description of their API we have:
//
//   send     POST https://connect.kingsch.at/api/users/{recipientKcId}/new_message
//            Authorization: Bearer <SENDER's access token>
//            { "message": { "body": { "text": { "body": "<text>" } } } }
//
//   refresh  POST https://connect.kingsch.at/oauth2/token   (JSON body)
//            { client_id, grant_type: "refresh_token", refresh_token }
//            -> { access_token, refresh_token, expires_in_millis }
//
// A KingsChat message goes FROM the person whose token signs the request
// TO the user named in the path. The previous version of this file got
// that backwards: it signed with the recipient's own token and named no
// recipient at all, posting to a guessed /developer/api/send-message with
// a guessed payload, and every invite came back SEND_FAILED.
//
// So an invite is sent from the inviting host's KingsChat account, which
// means the host must have signed in here with KingsChat at least once
// (that is when their tokens are stored — see /api/auth/kingschat/callback).
// The recipient must also have signed in once, because that is the only
// way we learn their KingsChat user id.

import { loadKcTokens, saveKcTokens, type KcTokens } from '@/lib/kc-tokens';

const KC_API = (process.env.KINGSCHAT_API_BASE || 'https://connect.kingsch.at').replace(/\/+$/, '');

const REFRESH_LEAD_MS = 60_000; // Refresh 60 s before actual expiry.

export type KcSendResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'sender_not_linked' | 'refresh_failed' | 'send_failed';
      status?: number;
      body?: string;
    };

/**
 * Refresh an access token using the stored refresh token.
 * Returns the fresh tokens (already persisted via saveKcTokens) or null.
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
  try {
    const r = await fetch(KC_API + '/oauth2/token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      }),
      cache: 'no-store',
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('[kc-send] refresh failed', r.status, t.slice(0, 200));
      return null;
    }
    const j = (await r.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in_millis?: number;
      expires_in?: number;
    };
    if (!j.access_token) return null;
    // KingsChat reports milliseconds; expires_in (seconds) is kept only as
    // a fallback in case that ever changes. An hour if neither is given.
    const lifetimeMs =
      j.expires_in_millis ?? (j.expires_in ? j.expires_in * 1000 : 3_600_000);
    const fresh: KcTokens = {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + lifetimeMs,
    };
    await saveKcTokens(clerkUserId, fresh);
    return fresh;
  } catch (err) {
    console.warn('[kc-send] refresh threw', err);
    return null;
  }
}

/** The sender's usable access token, refreshing it when near expiry. */
async function senderToken(
  senderClerkId: string,
): Promise<{ token: string } | { reason: 'sender_not_linked' | 'refresh_failed' }> {
  let tokens = await loadKcTokens(senderClerkId);
  if (!tokens?.accessToken) return { reason: 'sender_not_linked' };

  if (!tokens.expiresAt || Date.now() >= tokens.expiresAt - REFRESH_LEAD_MS) {
    if (!tokens.refreshToken) return { reason: 'sender_not_linked' };
    const refreshed = await refreshKcAccessToken(senderClerkId, tokens);
    if (!refreshed) return { reason: 'refresh_failed' };
    tokens = refreshed;
  }
  return { token: tokens.accessToken };
}

/**
 * Send `message` from the KingsChat account of `senderClerkId` to the
 * KingsChat user `recipientKcId`.
 */
export async function sendKcMessage(
  senderClerkId: string,
  recipientKcId: string,
  message: string,
): Promise<KcSendResult> {
  if (!senderClerkId || !recipientKcId || !message.trim()) {
    return { ok: false, reason: 'send_failed', body: 'missing_sender_recipient_or_message' };
  }

  const auth = await senderToken(senderClerkId);
  if ('reason' in auth) return { ok: false, reason: auth.reason };

  try {
    const r = await fetch(
      KC_API + '/api/users/' + encodeURIComponent(recipientKcId) + '/new_message',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + auth.token,
        },
        body: JSON.stringify({ message: { body: { text: { body: message } } } }),
        cache: 'no-store',
      },
    );
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).slice(0, 200);
      // Logged, because the caller only passes a reason word back to the
      // page — the old sender failed for days with nothing recorded.
      console.error('[kc-send] KingsChat refused the message', r.status, body);
      // 401 means the sender's grant is gone: they need to sign in with
      // KingsChat again before invites can go out from their account.
      if (r.status === 401) {
        return { ok: false, reason: 'sender_not_linked', status: 401, body };
      }
      return { ok: false, reason: 'send_failed', status: r.status, body };
    }
    return { ok: true };
  } catch (err) {
    const body = err instanceof Error ? err.message : String(err);
    console.error('[kc-send] KingsChat send threw', body);
    return { ok: false, reason: 'send_failed', body };
  }
}

/**
 * The KingsChat user id recorded for a Clerk user when they signed in
 * with KingsChat, or null if they never have.
 */
export async function kcIdForClerkUser(clerkUserId: string): Promise<string | null> {
  const { clerkClient } = await import('@clerk/nextjs/server');
  try {
    const cc = await clerkClient();
    const u = await cc.users.getUser(clerkUserId);
    const fromMeta = (u.publicMetadata as { kingschat?: { id?: unknown } })?.kingschat?.id;
    if (fromMeta) return String(fromMeta);
    // Every KingsChat sign-in also sets externalId to "kc:<id>".
    if (u.externalId?.startsWith('kc:')) return u.externalId.slice(3);
    return null;
  } catch (err) {
    console.warn('[kc-send] could not read KingsChat id for user', err);
    return null;
  }
}
