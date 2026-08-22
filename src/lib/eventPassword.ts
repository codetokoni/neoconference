// src/lib/eventPassword.ts
//
// Hashing helpers for NeoEvent.password.
//
// FRS §12.2 asks that meeting credentials be stored encrypted. The password
// field on the event record used to be plaintext, which is a leak waiting
// for a KV dump or a stray console.log.
//
// Format:  s1$<salt-hex>$<hash-hex>
//   s1$    — scheme tag (scrypt, v1). Future schemes stay verifiable by prefix.
//   salt   — 16 random bytes, hex-encoded (32 chars).
//   hash   — 32 bytes of scrypt output, hex-encoded (64 chars).
//
// Verifier accepts three shapes so migration is silent:
//   - stored value matches the s1$ prefix -> scrypt compare (timing-safe).
//   - stored value present but no known prefix -> treated as legacy plaintext
//     (any pre-hash row still validates). Next PATCH re-hashes it.
//   - stored value empty -> "no password set"; verifier returns false.
//
// Pure module: node:crypto only. Safe on the edge, in tests, wherever.

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const SCHEME = "s1$";
const KEY_LEN = 32;
const SALT_BYTES = 16;

export function isMeetingPasswordHash(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(SCHEME);
}

/**
 * Hash a meeting password with a fresh per-event salt. Returns the encoded
 * `s1$<salt>$<hash>` string ready to persist. An empty input returns undefined
 * so callers can `?? undefined` to unset the field cleanly.
 */
export function hashMeetingPassword(plain: string): string | undefined {
  if (!plain) return undefined;
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = scryptSync(plain, salt, KEY_LEN).toString("hex");
  return `${SCHEME}${salt}$${hash}`;
}

/**
 * Compare a caller-supplied password against a stored value. Timing-safe for
 * the hashed path; the legacy plaintext branch is a direct string equality
 * because there is nothing to hide when the stored value is itself the secret.
 */
export function verifyMeetingPassword(plain: string, stored: string | undefined | null): boolean {
  if (!stored || !plain) return false;
  if (!stored.startsWith(SCHEME)) {
    // Legacy plaintext row — will be upgraded on the next PATCH.
    return stored === plain;
  }
  const rest = stored.slice(SCHEME.length);
  const sep = rest.indexOf("$");
  if (sep <= 0) return false;
  const salt = rest.slice(0, sep);
  const hashHex = rest.slice(sep + 1);
  if (!salt || !hashHex) return false;
  const computed = scryptSync(plain, salt, KEY_LEN);
  let storedBuf: Buffer;
  try {
    storedBuf = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (computed.length !== storedBuf.length) return false;
  return timingSafeEqual(computed, storedBuf);
}
