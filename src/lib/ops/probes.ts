// src/lib/ops/probes.ts
//
// Service health: one probe per dependency, each read-only — it lists,
// counts or asks for a balance; it never creates, sends, restarts or
// changes anything (AMS is asked about broadcasts, never told to relink;
// Firebase mints a token and sends nothing; eSPees is only checked for
// reachability because it has no read-only endpoint).
//
// Every result is up | degraded | down | not_configured, with latency, when
// it was checked, a short detail and the last failure. Details go through
// redact() — a provider's error text never carries a key back out.
//
//   neo:ops:health:latest   hash probeId -> ProbeResult
//   neo:ops:health:h:<id>   list of { t, s, l } newest first, 288 entries
//                           (24 hours at the 5-minute schedule)

import { RoomServiceClient } from "livekit-server-sdk";
import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { bucketUsage, isR2Configured } from "@/lib/r2";
import { AMS_REST, SIMULCAST_MAIN, isSurelyBroadcasting, videoChannelForRoom } from "@/lib/simulcast";
import { checkFcmCredentials, isFcmConfigured } from "@/lib/fcmStore";
import { errorText, pushCapped, readHash, readList, redact } from "@/lib/ops/util";

export type ProbeStatus = "up" | "degraded" | "down" | "not_configured";

export type ProbeMetrics = Record<string, number | string | boolean | null>;

export interface ProbeResult {
  id: string;
  label: string;
  group: string;
  status: ProbeStatus;
  latencyMs: number | null;
  checkedAt: number;
  detail: string;
  metrics?: ProbeMetrics;
  lastFailureAt: number | null;
  lastFailure: string | null;
}

export interface HealthPoint {
  t: number;
  s: ProbeStatus;
  l: number | null;
}

type ProbeOutput = { status: ProbeStatus; detail: string; metrics?: ProbeMetrics; latencyMs?: number };

interface ProbeDef {
  id: string;
  label: string;
  group: string;
  /** Environment variable names it needs (names only). */
  needs: string[];
  configured: () => boolean;
  /** Slower than this (ms) and an "up" answer reads as degraded. */
  slowMs?: number;
  run: () => Promise<ProbeOutput>;
}

const TIMEOUT_MS = 8000;
const HISTORY_CAP = 288;
const LATEST = "neo:ops:health:latest";
const histKey = (id: string) => `neo:ops:health:h:${id}`;

const env = (n: string) => (process.env[n] || "").trim();
const has = (...names: string[]) => names.every((n) => !!env(n));

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { cache: "no-store", ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function bodyText(r: Response): Promise<string> {
  return redact((await r.text().catch(() => "")).slice(0, 300));
}

function livekitHttpUrl(): string {
  const ws = env("NEXT_PUBLIC_LIVEKIT_URL") || env("LIVEKIT_WS_URL") || env("LIVEKIT_URL");
  return ws.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

function translationBase(): string {
  return (env("NEXT_PUBLIC_TRANSLATION_SSE") || env("TRANSLATION_SSE")).replace(/\/$/, "");
}

function gb(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return Math.round(bytes / 1e3) + " kB";
}

export const PROBES: ProbeDef[] = [
  {
    id: "kv",
    label: "Upstash KV",
    group: "Platform",
    needs: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    // The admin area itself runs on KV, so it is never "not configured": an
    // unreachable store is down.
    configured: () => true,
    slowMs: 1000,
    run: async () => {
      const t0 = Date.now();
      const keys = Number(await kv.dbsize());
      const latencyMs = Date.now() - t0;
      // INFO is not part of the client; ask the REST endpoint directly. Upstash
      // may not answer it — then memory is simply unknown.
      let usedMemoryBytes: number | null = null;
      if (has("KV_REST_API_URL", "KV_REST_API_TOKEN")) {
        try {
          const r = await get(env("KV_REST_API_URL"), {
            method: "POST",
            headers: { authorization: `Bearer ${env("KV_REST_API_TOKEN")}`, "content-type": "application/json" },
            body: JSON.stringify(["INFO"]),
          });
          const j = (await r.json().catch(() => null)) as { result?: unknown } | null;
          const m = typeof j?.result === "string" ? j.result.match(/used_memory:(\d+)/) : null;
          if (m) usedMemoryBytes = Number(m[1]);
        } catch {
          /* unknown */
        }
      }
      return {
        status: "up",
        latencyMs,
        detail: `${keys.toLocaleString("en")} keys${usedMemoryBytes != null ? `, ${gb(usedMemoryBytes)} used` : ""}`,
        metrics: { keys, usedMemoryBytes },
      };
    },
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    group: "Platform",
    needs: ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"],
    configured: isR2Configured,
    slowMs: 6000,
    run: async () => {
      const u = await bucketUsage(20);
      return {
        status: "up",
        detail: `${u.truncated ? "≥ " : ""}${u.objects.toLocaleString("en")} objects, ${u.truncated ? "≥ " : ""}${gb(u.bytes)}`,
        metrics: { objects: u.objects, bytes: u.bytes, truncated: u.truncated },
      };
    },
  },
  {
    id: "livekit",
    label: "LiveKit Cloud",
    group: "Media",
    needs: ["NEXT_PUBLIC_LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
    configured: () => has("LIVEKIT_API_KEY", "LIVEKIT_API_SECRET") && !!livekitHttpUrl(),
    run: async () => {
      const svc = new RoomServiceClient(livekitHttpUrl(), env("LIVEKIT_API_KEY"), env("LIVEKIT_API_SECRET"));
      const rooms = (await svc.listRooms()) ?? [];
      const participants = rooms.reduce((n, r) => n + Number((r as { numParticipants?: number }).numParticipants ?? 0), 0);
      return { status: "up", detail: `${rooms.length} active room${rooms.length === 1 ? "" : "s"}, ${participants} participants`, metrics: { rooms: rooms.length, participants } };
    },
  },
  {
    id: "ams",
    label: "Ant Media Server",
    group: "Media",
    needs: ["AMS_REST_BASE (or NEXT_PUBLIC_AMS_HTTP)"],
    configured: () => !!AMS_REST,
    run: async () => {
      const r = await get(`${AMS_REST}/broadcasts/active-live-stream-count`);
      if (!r.ok) return { status: r.status >= 500 ? "down" : "degraded", detail: `REST answered HTTP ${r.status}` };
      const j = (await r.json().catch(() => null)) as { number?: number } | null;
      const live = Number(j?.number ?? 0);
      const programmeId = videoChannelForRoom(SIMULCAST_MAIN).id;
      const programme = await isSurelyBroadcasting(programmeId);
      return {
        status: "up",
        detail: `${live} live stream${live === 1 ? "" : "s"}; ${programmeId} ${programme ? "broadcasting" : "not broadcasting"}`,
        metrics: { liveStreams: live, programmeLive: programme },
      };
    },
  },
  {
    id: "translation",
    label: "Translation worker",
    group: "Media",
    needs: ["NEXT_PUBLIC_TRANSLATION_SSE"],
    configured: () => !!translationBase(),
    run: async () => {
      const h = await get(`${translationBase()}/healthz`);
      if (!h.ok) return { status: "down", detail: `healthz HTTP ${h.status}` };
      const s = await get(`${translationBase()}/stats`).catch(() => null);
      const j = s?.ok ? ((await s.json().catch(() => null)) as { rooms?: Array<{ errorsWindow?: number; lastErrorMessage?: string | null }> } | null) : null;
      const rooms = Array.isArray(j?.rooms) ? j!.rooms! : [];
      const errors = rooms.reduce((n, r) => n + Number(r.errorsWindow ?? 0), 0);
      const lastError = rooms.find((r) => r.lastErrorMessage)?.lastErrorMessage ?? null;
      return {
        status: errors > 0 ? "degraded" : "up",
        detail: errors > 0 ? `${errors} DeepL error(s) in the last minute: ${redact(String(lastError ?? ""))}` : `${rooms.length} room(s) translating`,
        metrics: { rooms: rooms.length, errorsLastMinute: errors },
      };
    },
  },
  {
    id: "deepgram",
    label: "Deepgram",
    group: "Speech & language",
    needs: ["DEEPGRAM_API_KEY"],
    configured: () => has("DEEPGRAM_API_KEY"),
    run: async () => {
      const headers = { authorization: `Token ${env("DEEPGRAM_API_KEY")}` };
      const r = await get("https://api.deepgram.com/v1/projects", { headers });
      if (r.status === 401 || r.status === 403) return { status: "down", detail: `key rejected (HTTP ${r.status})` };
      if (!r.ok) return { status: "down", detail: `HTTP ${r.status} ${await bodyText(r)}` };
      const j = (await r.json().catch(() => null)) as { projects?: Array<{ project_id?: string }> } | null;
      const pid = j?.projects?.[0]?.project_id;
      let balance: number | null = null;
      if (pid) {
        const b = await get(`https://api.deepgram.com/v1/projects/${encodeURIComponent(pid)}/balances`, { headers }).catch(() => null);
        const bj = b?.ok ? ((await b.json().catch(() => null)) as { balances?: Array<{ amount?: number }> } | null) : null;
        if (bj?.balances?.length) balance = bj.balances.reduce((n, x) => n + Number(x.amount ?? 0), 0);
      }
      return {
        status: "up",
        detail: balance != null ? `key accepted; balance ${balance.toFixed(2)}` : "key accepted",
        metrics: { balance },
      };
    },
  },
  {
    id: "assemblyai",
    label: "AssemblyAI",
    group: "Speech & language",
    needs: ["ASSEMBLYAI_API_KEY"],
    configured: () => has("ASSEMBLYAI_API_KEY"),
    run: async () => {
      const r = await get("https://api.assemblyai.com/v2/transcript?limit=1", { headers: { authorization: env("ASSEMBLYAI_API_KEY") } });
      if (r.status === 401 || r.status === 403) return { status: "down", detail: `key rejected (HTTP ${r.status})` };
      if (!r.ok) return { status: "down", detail: `HTTP ${r.status} ${await bodyText(r)}` };
      return { status: "up", detail: "key accepted" };
    },
  },
  {
    id: "deepl",
    label: "DeepL",
    group: "Speech & language",
    needs: ["DEEPL_API_KEY"],
    configured: () => has("DEEPL_API_KEY"),
    run: async () => {
      const key = env("DEEPL_API_KEY");
      const host = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
      const r = await get(`${host}/v2/usage`, { headers: { authorization: `DeepL-Auth-Key ${key}` } });
      if (r.status === 403 || r.status === 401) return { status: "down", detail: `key rejected (HTTP ${r.status})` };
      if (r.status === 456) return { status: "down", detail: "quota exceeded (HTTP 456)" };
      if (!r.ok) return { status: "down", detail: `HTTP ${r.status} ${await bodyText(r)}` };
      const j = (await r.json().catch(() => ({}))) as { character_count?: number; character_limit?: number };
      const used = Number(j.character_count ?? 0);
      const limit = Number(j.character_limit ?? 0);
      const pct = limit > 0 ? used / limit : 0;
      return {
        status: pct >= 1 ? "down" : pct >= 0.9 ? "degraded" : "up",
        detail: limit > 0 ? `${used.toLocaleString("en")} of ${limit.toLocaleString("en")} characters this period (${Math.round(pct * 100)}%)` : "key accepted",
        metrics: { characters: used, characterLimit: limit || null },
      };
    },
  },
  {
    id: "resend",
    label: "Resend (email)",
    group: "Messaging",
    needs: ["RESEND_API_KEY"],
    configured: () => has("RESEND_API_KEY"),
    run: async () => {
      const r = await get("https://api.resend.com/domains", { headers: { authorization: `Bearer ${env("RESEND_API_KEY")}` } });
      if (r.ok) {
        const j = (await r.json().catch(() => null)) as { data?: Array<{ name?: string; status?: string }> } | null;
        const domains = j?.data ?? [];
        const unverified = domains.filter((d) => d.status && d.status !== "verified");
        return {
          status: unverified.length ? "degraded" : "up",
          detail: domains.length ? domains.map((d) => `${d.name} ${d.status}`).join(", ") : "key accepted, no domains",
          metrics: { domains: domains.length, unverified: unverified.length },
        };
      }
      const text = await r.text().catch(() => "");
      // A sending-only key may not list domains — it is still a working key.
      if (r.status === 401 && /restricted_api_key/.test(text)) return { status: "up", detail: "sending-only key (cannot list domains)" };
      return { status: "down", detail: `HTTP ${r.status} ${redact(text.slice(0, 200))}` };
    },
  },
  {
    id: "firebase",
    label: "Firebase (push)",
    group: "Messaging",
    needs: ["FIREBASE_SERVICE_ACCOUNT"],
    configured: isFcmConfigured,
    run: async () => {
      const { projectId } = await checkFcmCredentials();
      return { status: "up", detail: `service account accepted (project ${projectId})` };
    },
  },
  {
    id: "espees",
    label: "eSPees",
    group: "Payments",
    needs: ["ESPEES_API_KEY", "ESPEES_MERCHANT_WALLET", "ESPEES_PRODUCT_SKU"],
    configured: () => has("ESPEES_API_KEY"),
    run: async () => {
      // No read-only endpoint exists (the only call starts a payment), so
      // this only shows the API host answers. The key is not checked.
      const r = await get("https://api.espees.org/", { method: "GET" });
      return {
        status: r.status >= 500 ? "degraded" : "up",
        detail: `API host answered HTTP ${r.status} (reachability only — the key cannot be checked without starting a payment)`,
      };
    },
  },
  {
    id: "stripe",
    label: "Stripe",
    group: "Payments",
    needs: ["STRIPE_SECRET_KEY"],
    configured: () => has("STRIPE_SECRET_KEY"),
    run: async () => {
      const r = await get("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${env("STRIPE_SECRET_KEY")}` } });
      if (r.status === 401) return { status: "down", detail: "key rejected (HTTP 401)" };
      if (!r.ok) return { status: "down", detail: `HTTP ${r.status}` };
      const live = env("STRIPE_SECRET_KEY").startsWith("sk_live_") || env("STRIPE_SECRET_KEY").startsWith("rk_live_");
      return { status: "up", detail: `key accepted (${live ? "live" : "test"} mode)`, metrics: { live } };
    },
  },
  {
    id: "clerk",
    label: "Clerk (sign-in)",
    group: "Platform",
    needs: ["CLERK_SECRET_KEY"],
    configured: () => has("CLERK_SECRET_KEY"),
    run: async () => {
      const client = await clerkClient();
      const page = (await client.users.getUserList({ limit: 1 })) as { totalCount?: number };
      const users = Number(page.totalCount ?? 0);
      return { status: "up", detail: `${users.toLocaleString("en")} accounts`, metrics: { users } };
    },
  },
];

async function runOne(def: ProbeDef): Promise<Omit<ProbeOutput, "latencyMs"> & { latencyMs: number | null }> {
  if (!def.configured()) {
    return { status: "not_configured", latencyMs: null, detail: `needs ${def.needs.join(", ")}` };
  }
  const t0 = Date.now();
  try {
    const out = await Promise.race<ProbeOutput>([
      def.run(),
      new Promise<ProbeOutput>((resolve) =>
        setTimeout(() => resolve({ status: "down", detail: `no answer within ${TIMEOUT_MS / 1000} s` }), TIMEOUT_MS + 500),
      ),
    ]);
    const latencyMs = out.latencyMs ?? Date.now() - t0;
    const slow = out.status === "up" && latencyMs > (def.slowMs ?? 3000);
    return {
      ...out,
      status: slow ? "degraded" : out.status,
      detail: redact(slow ? `${out.detail} — slow (${latencyMs} ms)` : out.detail),
      latencyMs,
    };
  } catch (e) {
    return { status: "down", latencyMs: Date.now() - t0, detail: errorText(e) };
  }
}

export async function latestResults(): Promise<Record<string, ProbeResult>> {
  return readHash<ProbeResult>(LATEST);
}

/** Run the probes (all, or `only`), keep the results and history, and return them. */
export async function runHealthChecks(only?: string[]): Promise<ProbeResult[]> {
  const defs = only?.length ? PROBES.filter((p) => only.includes(p.id)) : PROBES;
  const previous = await latestResults();
  const now = Date.now();
  const results = await Promise.all(
    defs.map(async (def): Promise<ProbeResult> => {
      const out = await runOne(def);
      const prev = previous[def.id];
      const failed = out.status === "down" || out.status === "degraded";
      return {
        id: def.id,
        label: def.label,
        group: def.group,
        status: out.status,
        latencyMs: out.latencyMs,
        checkedAt: now,
        detail: out.detail,
        ...(out.metrics ? { metrics: out.metrics } : {}),
        lastFailureAt: failed ? now : prev?.lastFailureAt ?? null,
        lastFailure: failed ? out.detail : prev?.lastFailure ?? null,
      };
    }),
  );
  const update: Record<string, string> = {};
  for (const r of results) update[r.id] = JSON.stringify(r);
  await kv.hset(LATEST, update);
  await Promise.all(results.map((r) => pushCapped(histKey(r.id), { t: r.checkedAt, s: r.status, l: r.latencyMs }, HISTORY_CAP)));
  return results;
}

export async function healthHistory(id: string, limit = HISTORY_CAP): Promise<HealthPoint[]> {
  return readList<HealthPoint>(histKey(id), Math.min(limit, HISTORY_CAP));
}

/**
 * Since when `id` has been in one of `statuses` without a break, from its
 * history (newest first). Null when the latest point is not.
 */
export function failingSince(history: HealthPoint[], statuses: ProbeStatus[]): number | null {
  let since: number | null = null;
  for (const p of history) {
    if (!statuses.includes(p.s)) break;
    since = p.t;
  }
  return since;
}
