// src/lib/ops/util.ts — small helpers shared by the system-operations code.

import { kv } from "@/lib/kv";

export function parseJson<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

/** LPUSH + LTRIM: a newest-first list that never grows past `cap`. */
export async function pushCapped(key: string, value: unknown, cap: number): Promise<void> {
  await kv.lpush(key, typeof value === "string" ? value : JSON.stringify(value));
  await kv.ltrim(key, 0, cap - 1);
}

export async function readList<T>(key: string, limit: number): Promise<T[]> {
  const raw = ((await kv.lrange(key, 0, Math.max(0, limit - 1))) ?? []) as unknown[];
  return raw.map((r) => parseJson<T>(r)).filter((x): x is T => x != null);
}

export async function readHash<T>(key: string): Promise<Record<string, T>> {
  const all = ((await kv.hgetall(key)) ?? {}) as Record<string, unknown>;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(all)) {
    const p = parseJson<T>(v);
    if (p != null) out[k] = p;
  }
  return out;
}

/**
 * Keys matching `match` (a Redis glob), by SCAN — never KEYS, which blocks
 * the store. Stops at `cap` keys; `truncated` says it did.
 */
export async function scanKeys(match: string, cap = 5000): Promise<{ keys: string[]; truncated: boolean }> {
  const keys: string[] = [];
  let cursor: string | number = 0;
  do {
    const [next, batch] = (await kv.scan(cursor, { match, count: 1000 })) as [string | number, string[]];
    keys.push(...batch);
    cursor = next;
    if (keys.length >= cap) return { keys: keys.slice(0, cap), truncated: true };
  } while (String(cursor) !== "0");
  return { keys, truncated: false };
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Environment variables whose values must never reach a response, a log line
 * or a stored record. Anything a provider echoes back (an error body, a URL)
 * goes through redact() first.
 */
const SECRET_ENV = [
  "KV_REST_API_TOKEN",
  "KV_REST_API_READ_ONLY_TOKEN",
  "KV_URL",
  "REDIS_URL",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "DEEPGRAM_API_KEY",
  "ASSEMBLYAI_API_KEY",
  "DEEPL_API_KEY",
  "OPENAI_API_KEY",
  "RESEND_API_KEY",
  "FIREBASE_SERVICE_ACCOUNT",
  "ESPEES_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "CLERK_SECRET_KEY",
  "CRON_SECRET",
  "HEALTH_CHECK_TOKEN",
  "DISPATCH_SECRET",
  "STREAMLAB_API_KEY",
  "ADMIN_MFA_KEY",
  "VAPID_PRIVATE_KEY",
];

export function redact(text: string): string {
  let out = String(text ?? "");
  for (const name of SECRET_ENV) {
    const v = process.env[name];
    if (v && v.length >= 6) out = out.split(v).join(`[${name}]`);
  }
  // Bearer tokens and key=value credentials in URLs, whatever produced them.
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  out = out.replace(/([?&](?:token|key|apikey|api_key|secret|signature|X-Amz-Signature|X-Amz-Credential)=)[^&\s"]+/gi, "$1[redacted]");
  return out.slice(0, 500);
}

export function errorText(e: unknown): string {
  return redact(e instanceof Error ? e.message || e.name : String(e));
}

export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
