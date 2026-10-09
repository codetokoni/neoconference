// src/lib/admin/overview/aggregate.ts
//
// Builds the Overview from ./sources.ts for one administrator:
//
//   - only the sources every one of whose permissions they hold — a source
//     they may not see is left out, never shown as zero;
//   - each source on its own: one that throws or takes longer than
//     SOURCE_TIMEOUT_MS becomes an error on its card and nothing else;
//   - each source's result cached in KV for CACHE_SECONDS, keyed by the
//     period it was computed for (or once for all periods when its figures
//     do not depend on one), and shown with the time it was computed.
//
//   neo:admin:overview:<version>:<source>:<period key>   JSON { at, data }   TTL 60 s

import { kv } from "@/lib/kv";
import type { AdminPermission } from "@/lib/admin/catalog";
import type { Periods } from "@/lib/admin/overview/period";
import { SOURCES, type SourceData, type SourceDef, type SourceId } from "@/lib/admin/overview/sources";

export const CACHE_SECONDS = 60;
export const SOURCE_TIMEOUT_MS = 25_000;
const VERSION = "v1";

export type SourceResult<T> =
  | { status: "ok"; at: number; cached: boolean; data: T }
  | { status: "error"; at: number; message: string };

export type OverviewSources = { [K in SourceId]?: SourceResult<SourceData[K]> };

export interface Overview {
  /** When the oldest figure shown was computed. */
  asOf: number | null;
  periods: {
    current: PeriodInfo;
    previous: PeriodInfo;
    range: Periods["range"];
    compare: Periods["compare"];
  };
  sources: OverviewSources;
}

type PeriodInfo = { from: string; to: string; tz: string; startMs: number; endMs: number };
const info = (p: PeriodInfo): PeriodInfo => ({ from: p.from, to: p.to, tz: p.tz, startMs: p.startMs, endMs: p.endMs });

export function cacheKey(def: Pick<SourceDef<unknown>, "id" | "periodic">, periods: Periods): string {
  const { current: c, previous: p } = periods;
  const span = def.periodic ? `${c.tz}:${c.from}:${c.to}:${p.from}:${p.to}` : "now";
  return `neo:admin:overview:${VERSION}:${def.id}:${span}`;
}

export function allowedSources(permissions: readonly AdminPermission[]): SourceDef<unknown>[] {
  return (SOURCES as readonly SourceDef<unknown>[]).filter((s) => s.permissions.every((p) => permissions.includes(p)));
}

function parse(raw: unknown): { at: number; data: unknown } | null {
  if (raw == null) return null;
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" && typeof (v as { at?: unknown }).at === "number" ? (v as { at: number; data: unknown }) : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer after ${Math.round(ms / 1000)} s.`)), ms);
  });
  return Promise.race([work, late]).finally(() => timer && clearTimeout(timer));
}

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return (m || "Unknown error").slice(0, 300);
}

async function runSource(def: SourceDef<unknown>, periods: Periods, now: number, fresh: boolean): Promise<SourceResult<unknown>> {
  const key = cacheKey(def, periods);
  if (!fresh) {
    try {
      const hit = parse(await kv.get(key));
      if (hit) return { status: "ok", at: hit.at, cached: true, data: hit.data };
    } catch (err) {
      // A cache that cannot be read is no reason to fail the card: compute it.
      console.warn("[admin-overview] cache read failed", def.id, messageOf(err));
    }
  }
  try {
    const data = await withTimeout(def.load({ periods, now }), SOURCE_TIMEOUT_MS);
    const at = Date.now();
    try {
      await kv.set(key, JSON.stringify({ at, data }), { ex: CACHE_SECONDS });
    } catch (err) {
      console.warn("[admin-overview] cache write failed", def.id, messageOf(err));
    }
    return { status: "ok", at, cached: false, data };
  } catch (err) {
    console.error("[admin-overview] source failed", def.id, err);
    return { status: "error", at: Date.now(), message: messageOf(err) };
  }
}

/** Parts of a source's data that need a permission of their own on top of the source's. */
function redact(id: SourceId, data: unknown, permissions: readonly AdminPermission[]): unknown {
  if (id === "errors" && !permissions.includes("audit:read")) {
    // Failed administrator actions come from the admin audit: audit:read only.
    const { admin: _admin, ...rest } = data as SourceData["errors"];
    void _admin;
    return rest;
  }
  return data;
}

export async function buildOverview(
  permissions: readonly AdminPermission[],
  periods: Periods,
  opts: { fresh?: boolean; only?: string[]; now?: number } = {},
): Promise<Overview> {
  const now = opts.now ?? Date.now();
  const defs = allowedSources(permissions).filter((d) => !opts.only?.length || opts.only.includes(d.id));
  const results = await Promise.all(defs.map((d) => runSource(d, periods, now, !!opts.fresh)));
  const sources: Record<string, SourceResult<unknown>> = {};
  defs.forEach((d, i) => {
    const r = results[i];
    sources[d.id] = r.status === "ok" ? { ...r, data: redact(d.id as SourceId, r.data, permissions) } : r;
  });
  const oks = results.filter((r) => r.status === "ok").map((r) => r.at);
  return {
    asOf: oks.length ? Math.min(...oks) : null,
    periods: { current: info(periods.current), previous: info(periods.previous), range: periods.range, compare: periods.compare },
    sources: sources as OverviewSources,
  };
}
