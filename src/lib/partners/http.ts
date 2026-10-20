// src/lib/partners/http.ts — shared plumbing for the partner routes.

import { NextResponse } from "next/server";
import { hitRateLimit } from "@/lib/support/tickets";
import { getClientIp } from "@/lib/sessionStore";
import { PartnerError } from "@/lib/partners/store";

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

/** A refusal in one shape: { error: { code, message } }. Unknown errors say nothing more. */
export function fail(e: unknown): NextResponse {
  if (e instanceof PartnerError) return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status, headers: NO_STORE });
  console.error("[partners]", e);
  return NextResponse.json({ error: { code: "server_error", message: "Something went wrong. Try again." } }, { status: 500, headers: NO_STORE });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* below */
  }
  throw new PartnerError(400, "invalid_body", "Send a JSON object.");
}

/** Fixed-window limit; throws 429 when over. */
export async function limit(bucket: string, max: number, windowSec = 60): Promise<void> {
  const r = await hitRateLimit(`partner:${bucket}`, max, windowSec);
  if (!r.ok) throw new PartnerError(429, "rate_limited", `Too many requests. Try again in ${r.retryAfter} s.`);
}

export function ipOf(req: Request): string {
  return getClientIp(req.headers) ?? "unknown";
}
