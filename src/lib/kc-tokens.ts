// src/lib/kc-tokens.ts
//
// KV-backed store for a signed-in user's KingsChat OAuth tokens. Kept
// out of Clerk publicMetadata on purpose: publicMetadata is served to
// the browser with every session read and access tokens have no
// business being reachable client-side. Everything here is Node-only
// and read/written from server routes only.
//
// Storage
//   neo:kc:tokens:<clerkUserId>  -> { accessToken, refreshToken, expiresAt }
//
//   accessToken       most recent Bearer token for this user
//   refreshToken      long-lived refresh token to mint a new access token
//   expiresAt         epoch ms; refresh when Date.now() >= expiresAt - 60_000
//
// The KV outage behaviour is fail-closed: if we can't read tokens we
// treat the person as unreachable (returns null), so the sender falls
// back to the copy-invite path.

import { kv } from '@vercel/kv';

const PREFIX = 'neo:kc:tokens:';

export interface KcTokens {
  accessToken: string;
  /** May be missing on very old rows written before we started persisting
   *  refresh tokens — sendKcMessage() treats it as "no refresh possible"
   *  and the person needs to re-sign-in when their access token expires. */
  refreshToken?: string;
  /** Epoch ms. 0 or missing means "unknown" — treat as already expired. */
  expiresAt: number;
}

function isKvConfigured(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN,
  );
}

export async function saveKcTokens(
  clerkUserId: string,
  tokens: KcTokens,
): Promise<void> {
  if (!clerkUserId || !isKvConfigured()) return;
  try {
    await kv.set(PREFIX + clerkUserId, tokens);
  } catch (err) {
    console.error('[kc-tokens] save failed for', clerkUserId, err);
  }
}

export async function loadKcTokens(
  clerkUserId: string,
): Promise<KcTokens | null> {
  if (!clerkUserId || !isKvConfigured()) return null;
  try {
    const v = await kv.get<KcTokens>(PREFIX + clerkUserId);
    return v ?? null;
  } catch (err) {
    console.error('[kc-tokens] load failed for', clerkUserId, err);
    return null;
  }
}

export async function clearKcTokens(clerkUserId: string): Promise<void> {
  if (!clerkUserId || !isKvConfigured()) return;
  try {
    await kv.del(PREFIX + clerkUserId);
  } catch (err) {
    console.error('[kc-tokens] clear failed for', clerkUserId, err);
  }
}
