// src/lib/partners/embedAuth.ts — the partner embed's meeting session,
// for the room's own calls (translation, the speaker's voice).
//
// A visitor in a partner's widget has no account here, so the routes those
// components call accept the embed page's signed session instead, sent as
// a header. It is set only by /embed/zone and held in memory; everywhere
// else these return nothing and nothing changes.

let session: string | null = null;

export const EMBED_SESSION_HEADER = "x-neo-embed-session";

export function setEmbedSession(value: string | null): void {
  session = value;
}

export function embedAuthHeaders(): Record<string, string> {
  return session ? { [EMBED_SESSION_HEADER]: session } : {};
}
