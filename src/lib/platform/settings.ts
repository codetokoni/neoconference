// src/lib/platform/settings.ts
//
// Platform settings and feature controls in KV, so a change reaches every
// server instance within seconds and needs no redeploy:
//
//   neo:settings:platform   PlatformSettings JSON (branding, contacts, notice,
//                           regional, registration)
//   neo:settings:features   FeatureControls JSON (global and per-plan feature
//                           switches, maintenance mode)
//   neo:features:accounts   hash userId -> { feature: "allow" | "deny" }
//
// Reads are cached in process memory for CACHE_MS: the middleware asks on
// every request, and a few seconds of lag is the price of not adding a KV
// round trip to each one. A write here clears this instance's cache at
// once; other instances catch up when theirs expires.
//
// Edge-safe (KV only): the middleware imports it.

import { kv } from "@/lib/kv";
import {
  controlsWithDefaults,
  defaultFeatureControls,
  defaultPlatformSettings,
  withDefaults,
  type AccountOverride,
  type FeatureControls,
  type FeatureKey,
  type PlatformSettings,
} from "@/lib/platform/model";

const PLATFORM = "neo:settings:platform";
const FEATURES = "neo:settings:features";
const ACCOUNTS = "neo:features:accounts";

export const CACHE_MS = 5_000;

type Cached<T> = { value: T; at: number };
let platformCache: Cached<PlatformSettings> | null = null;
let controlsCache: Cached<FeatureControls> | null = null;

function parse(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** Forget cached reads (after a write, and between test steps). */
export function clearSettingsCache(): void {
  platformCache = null;
  controlsCache = null;
}

/**
 * The platform settings. A KV failure gives the defaults, so an outage shows the stock name and no banner rather than an
 * error page.
 */
export async function getPlatformSettings(): Promise<PlatformSettings> {
  const now = Date.now();
  if (platformCache && now - platformCache.at < CACHE_MS) return platformCache.value;
  try {
    const value = withDefaults(parse(await kv.get(PLATFORM)));
    platformCache = { value, at: now };
    return value;
  } catch (err) {
    console.error("[platform-settings] read failed", err);
    // Cached too, so an outage costs one failed read per window, not one per request.
    platformCache = { value: defaultPlatformSettings(), at: now };
    return platformCache.value;
  }
}

export async function savePlatformSettings(next: PlatformSettings): Promise<PlatformSettings> {
  const value = { ...next, updatedAt: Date.now() };
  await kv.set(PLATFORM, JSON.stringify(value));
  platformCache = { value, at: Date.now() };
  return value;
}

/**
 * Feature switches and maintenance mode. A KV failure gives the defaults —
 * everything on, maintenance off — so an outage of the settings store can
 * never shut the platform (or its owner) out.
 */
export async function getFeatureControls(): Promise<FeatureControls> {
  const now = Date.now();
  if (controlsCache && now - controlsCache.at < CACHE_MS) return controlsCache.value;
  try {
    const value = controlsWithDefaults(parse(await kv.get(FEATURES)));
    controlsCache = { value, at: now };
    return value;
  } catch (err) {
    console.error("[feature-controls] read failed", err);
    controlsCache = { value: defaultFeatureControls(), at: now };
    return controlsCache.value;
  }
}

export async function saveFeatureControls(next: FeatureControls): Promise<FeatureControls> {
  const value = { ...next, updatedAt: Date.now() };
  await kv.set(FEATURES, JSON.stringify(value));
  controlsCache = { value, at: Date.now() };
  return value;
}

/* ---------------------------- account overrides --------------------------- */

export type AccountOverrides = Partial<Record<FeatureKey, AccountOverride>>;

export async function getAccountOverrides(userId: string): Promise<AccountOverrides> {
  if (!userId) return {};
  try {
    return (parse(await kv.hget(ACCOUNTS, userId)) as AccountOverrides | null) ?? {};
  } catch (err) {
    console.error("[feature-controls] override read failed", err);
    return {};
  }
}

export async function setAccountOverrides(userId: string, o: AccountOverrides): Promise<void> {
  if (Object.keys(o).length) await kv.hset(ACCOUNTS, { [userId]: JSON.stringify(o) });
  else await kv.hdel(ACCOUNTS, userId);
}

export async function listAccountOverrides(): Promise<{ userId: string; overrides: AccountOverrides }[]> {
  const all = ((await kv.hgetall(ACCOUNTS)) ?? {}) as Record<string, unknown>;
  return Object.entries(all)
    .map(([userId, v]) => ({ userId, overrides: (parse(v) as AccountOverrides | null) ?? {} }))
    .filter((x) => Object.keys(x.overrides).length > 0);
}

/* ---------------------------------- trials -------------------------------- */

/**
 * Whether new subscriptions may start with a free trial, and how long one
 * lasts when a plan does not set its own length. Read by the plan catalog
 * (phase 3) when it grants a trial.
 */
export async function getTrialPolicy(): Promise<{ enabled: boolean; defaultDays: number }> {
  return (await getPlatformSettings()).registration.trials;
}
