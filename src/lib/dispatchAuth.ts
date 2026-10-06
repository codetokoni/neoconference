// src/lib/dispatchAuth.ts
//
// The scheduler tick's credential check (POST /api/internal/dispatch):
// "Authorization: Bearer <secret>" against DISPATCH_SECRET or CRON_SECRET.

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Whether the header carries one of the configured secrets. Both sides are
 * hashed first, so they are the same length and the comparison takes the same
 * time whatever was sent. Unset secrets match nothing.
 */
export function authorizedDispatch(header: string | null, secrets: Array<string | undefined>): boolean {
  const m = (header || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const given = digest(m[1].trim());
  let ok = false;
  for (const s of secrets) {
    if (s && timingSafeEqual(given, digest(s))) ok = true;
  }
  return ok;
}
