// src/lib/dispatchAuth.ts
//
// The scheduler tick's credential check (POST /api/internal/dispatch):
// "Authorization: Bearer <secret>" against DISPATCH_SECRET or CRON_SECRET.

import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** The token after "Bearer ", trimmed, or null. */
function bearer(header: string | null): string | null {
  const m = (header || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Whether the header carries one of the configured secrets. Both sides are
 * trimmed (a value pasted into a dashboard often keeps a trailing newline)
 * and hashed, so they are the same length and the comparison takes the same
 * time whatever was sent. Unset secrets match nothing.
 */
export function authorizedDispatch(header: string | null, secrets: Array<string | undefined>): boolean {
  const token = bearer(header);
  if (!token) return false;
  const given = digest(token);
  let ok = false;
  for (const s of secrets) {
    const want = s?.trim();
    if (want && timingSafeEqual(given, digest(want))) ok = true;
  }
  return ok;
}

/**
 * Why a tick was refused, for the server log: lengths only, never a value,
 * so "the secret isn't set here" and "it is, but differs" read differently.
 */
export function dispatchRefusal(header: string | null, secrets: Record<string, string | undefined>): string {
  const token = bearer(header);
  if (!token) return "no Bearer token sent";
  const configured = Object.entries(secrets).filter(([, v]) => v?.trim());
  if (configured.length === 0) return `none of ${Object.keys(secrets).join(", ")} is set`;
  const lengths = configured.map(([k, v]) => `${k} is ${v!.trim().length} chars`).join(", ");
  return `token of ${token.length} chars matches no secret (${lengths})`;
}
