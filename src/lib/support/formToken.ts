// src/lib/support/formToken.ts
//
// Bot protection for the signed-out contact form that nobody has to solve:
//
//   - a signed token from GET /api/support/session, stamped with the time the
//     form was opened. A submission needs one, at least MIN_FILL_MS old (people
//     take longer than that to type a request) and at most MAX_AGE_MS;
//   - a honeypot field ("website") that is hidden from people and filled by
//     form-filling bots;
//   - rate limits per IP address and per email (the intake route).

import { createHmac, timingSafeEqual } from "node:crypto";

export const MIN_FILL_MS = 3_000;
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function secret(): string {
  return process.env.SUPPORT_FORM_SECRET || process.env.CLERK_SECRET_KEY || "neoconference-support-form";
}

function sign(ts: number): string {
  return createHmac("sha256", secret()).update(`support-form:${ts}`).digest("base64url").slice(0, 32);
}

export function issueFormToken(now = Date.now()): string {
  return `${now}.${sign(now)}`;
}

export type FormTokenCheck = { ok: true } | { ok: false; reason: "missing" | "invalid" | "too_fast" | "expired" };

export function checkFormToken(token: unknown, now = Date.now()): FormTokenCheck {
  if (typeof token !== "string" || !token) return { ok: false, reason: "missing" };
  const [tsRaw, sig] = token.split(".");
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || !sig) return { ok: false, reason: "invalid" };
  const want = Buffer.from(sign(ts));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "invalid" };
  if (now - ts < MIN_FILL_MS) return { ok: false, reason: "too_fast" };
  if (now - ts > MAX_AGE_MS) return { ok: false, reason: "expired" };
  return { ok: true };
}
