// src/lib/partners/store.ts
//
// Partner integrations: another website (PrayerClouds first) embeds a
// meeting per "zone" of its own — /zone/FALF on their site is always the
// same FALF meeting here, joined under each visitor's own name.
//
// Everything is in KV, like the rest of the platform. There is no SQL
// table, so the uniqueness a database constraint would give comes from
// atomic set-if-absent on one key per (integration, zone), and the meeting
// itself is claimed through eventStore.createIfSlugFree on a slug derived
// from the same pair: concurrent first visits all land in one meeting.
//
// Keys (docs/integrations/partner-zones.md has the full layout):
//   neo:partner:<id>                     the integration
//   neo:partner:all                      set of integration ids
//   neo:partner:origins                  set of every active integration's approved origins
//   neo:partner:<id>:keys                set of its key ids
//   neo:partner:keymeta:<keyId>          key metadata (masked, never the key)
//   neo:partner:keyhash:<keyId>          sha256 of the key, to revoke it
//   neo:partner:key:<sha256>             -> { integrationId, keyId }
//   neo:partner:<id>:zone:<ZONE>         the zone -> meeting mapping (set NX)
//   neo:partner:<id>:zones               set of its zone ids
//   neo:partner:code:<sha256>            a one-time join code (2 min)
//   neo:partner:codeused:<sha256>        claimed once, so a code works once
//   neo:partner:<id>:audit               its last 500 events, newest first

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { kv } from "@/lib/kv";
import { eventStore, generateId, generateQrSeed } from "@/lib/eventStore";
import type { NeoEvent } from "@/types/event";

/* --------------------------------- types --------------------------------- */

export type PartnerIntegration = {
  id: string;
  name: string;
  /** The account that owns the zone meetings this integration creates. */
  ownerUserId: string;
  ownerEmail?: string;
  /** Websites allowed to embed the widget, as origins ("https://herald.prayerclouds.org"). */
  origins: string[];
  /** Create a zone's meeting the first time it is asked for. Off: an administrator connects each zone. */
  autoCreateZones: boolean;
  /** Let the partner send visitors without an account (name only, marked unverified). */
  guestAccess: boolean;
  /** "{zone}" is replaced by the zone id. */
  titleTemplate: string;
  /** What a zone's meeting is: one permanent room (the only policy so far, owner 2026-10-20). */
  lifecycle: "permanent";
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  /** IANA timezone for report periods (today, this week, this month). Absent: UTC. */
  timezone?: string;
  /** Aggregate figures a zone's public page may show; none unless switched on. */
  publicStats?: PublicStat[];
};

export const PUBLIC_STATS = ["sessions", "uniqueParticipants", "connectedNow", "totalPrayerSeconds", "averagePrayerSeconds"] as const;
export type PublicStat = (typeof PUBLIC_STATS)[number];

export type PartnerKeyMeta = {
  id: string;
  integrationId: string;
  /** "nlm_pk_1a2b…wxyz" — enough to recognise, not to use. */
  masked: string;
  createdAt: string;
  createdBy?: string;
  revokedAt?: string;
  lastUsedAt?: string;
};

export type ZoneMapping = {
  integrationId: string;
  zoneId: string;
  eventId: string;
  slug: string;
  title: string;
  ownerUserId: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  /** "auto": made on the first visit; "admin": connected by an administrator. */
  source: "auto" | "admin";
};

export type AuditEvent = { at: string; action: string; actor?: string; detail?: Record<string, unknown> };

export class PartnerError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/* --------------------------------- keys ---------------------------------- */

const P = "neo:partner:";
const K = {
  integration: (id: string) => `${P}${id}`,
  all: `${P}all`,
  origins: `${P}origins`,
  keys: (id: string) => `${P}${id}:keys`,
  keyMeta: (keyId: string) => `${P}keymeta:${keyId}`,
  keyHash: (keyId: string) => `${P}keyhash:${keyId}`,
  key: (hash: string) => `${P}key:${hash}`,
  zone: (id: string, zone: string) => `${P}${id}:zone:${zone}`,
  zones: (id: string) => `${P}${id}:zones`,
  code: (hash: string) => `${P}code:${hash}`,
  codeUsed: (hash: string) => `${P}codeused:${hash}`,
  audit: (id: string) => `${P}${id}:audit`,
  admins: (id: string) => `${P}${id}:admins`,
  leaders: (id: string, zone: string) => `${P}${id}:zone:${zone}:leaders`,
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rand = (bytes: number) => randomBytes(bytes).toString("hex");
const nowIso = () => new Date().toISOString();

/* ------------------------------- validation ------------------------------ */

/** "FALF", "falf" → "FALF". Letters, digits, "-" and "_", up to 40. */
export function normalizeZone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const z = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(z) ? z.toUpperCase() : null;
}

/**
 * An origin a widget may be embedded on: https, or http only for localhost
 * (a partner developing locally). No paths, no wildcards.
 */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password) return null;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** A display name from a partner: one line, no control characters, up to 60. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
  return s.length >= 1 && s.length <= 60 ? s : null;
}

/** The partner's own id for a user: printable, up to 128. */
export function cleanUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return /^[A-Za-z0-9_.:@|+=-]{1,128}$/.test(s) ? s : null;
}

/** An IANA timezone this server knows ("Africa/Lagos", "UTC"), or null. */
export function normalizeTimezone(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: raw.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function reportTimezone(i: Pick<PartnerIntegration, "timezone">): string {
  return normalizeTimezone(i.timezone) ?? "UTC";
}

/* ------------------------------ integrations ----------------------------- */

export async function getIntegration(id: string): Promise<PartnerIntegration | null> {
  if (!/^pi_[a-f0-9]{12}$/.test(id)) return null;
  return (await kv.get<PartnerIntegration>(K.integration(id))) ?? null;
}

export async function listIntegrations(): Promise<PartnerIntegration[]> {
  const ids = ((await kv.smembers(K.all)) as string[]) || [];
  const all = await Promise.all(ids.map((id) => getIntegration(id)));
  return all.filter((x): x is PartnerIntegration => !!x).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every active integration's origins, for the embed page's frame-ancestors. */
async function refreshOrigins(): Promise<void> {
  const all = await listIntegrations();
  const origins = [...new Set(all.filter((i) => i.status === "active").flatMap((i) => i.origins))];
  await kv.del(K.origins);
  if (origins.length) await kv.sadd(K.origins, origins[0], ...origins.slice(1));
}

export async function approvedOrigins(): Promise<string[]> {
  return (((await kv.smembers(K.origins)) as string[]) || []).filter((o) => !!normalizeOrigin(o));
}

export async function createIntegration(input: {
  name: string;
  ownerUserId: string;
  ownerEmail?: string;
  origins: string[];
  autoCreateZones?: boolean;
  guestAccess?: boolean;
  titleTemplate?: string;
  by?: string;
}): Promise<PartnerIntegration> {
  const at = nowIso();
  const integration: PartnerIntegration = {
    id: `pi_${rand(6)}`,
    name: input.name.trim().slice(0, 80),
    ownerUserId: input.ownerUserId,
    ownerEmail: input.ownerEmail,
    origins: input.origins,
    autoCreateZones: input.autoCreateZones ?? true,
    guestAccess: input.guestAccess ?? false,
    titleTemplate: (input.titleTemplate || "{zone} Meeting").slice(0, 80),
    lifecycle: "permanent",
    status: "active",
    createdAt: at,
    updatedAt: at,
    createdBy: input.by,
  };
  await kv.set(K.integration(integration.id), integration);
  await kv.sadd(K.all, integration.id);
  await refreshOrigins();
  await audit(integration.id, "integration.create", input.by, { name: integration.name, origins: integration.origins });
  return integration;
}

export type IntegrationPatch = Partial<
  Pick<PartnerIntegration, "name" | "ownerUserId" | "ownerEmail" | "origins" | "autoCreateZones" | "guestAccess" | "titleTemplate" | "status" | "timezone" | "publicStats">
>;

export async function updateIntegration(id: string, patch: IntegrationPatch, by?: string): Promise<PartnerIntegration> {
  const prev = await getIntegration(id);
  if (!prev) throw new PartnerError(404, "integration_not_found", "No such integration.");
  const next: PartnerIntegration = { ...prev, ...patch, id: prev.id, updatedAt: nowIso() };
  await kv.set(K.integration(id), next);
  await refreshOrigins();
  await audit(id, "integration.update", by, patch as Record<string, unknown>);
  return next;
}

/* ---------------------------------- keys --------------------------------- */

/** A new secret for the partner's backend. Returned once; only its hash is kept. */
export async function mintPartnerKey(integrationId: string, by?: string): Promise<{ meta: PartnerKeyMeta; raw: string }> {
  const keyId = rand(4);
  const raw = `nlm_pk_${keyId}_${rand(24)}`;
  const hash = sha256(raw);
  const meta: PartnerKeyMeta = {
    id: keyId,
    integrationId,
    masked: `nlm_pk_${keyId}…${raw.slice(-4)}`,
    createdAt: nowIso(),
    createdBy: by,
  };
  await kv.set(K.key(hash), { integrationId, keyId });
  await kv.set(K.keyMeta(keyId), meta);
  await kv.set(K.keyHash(keyId), hash);
  await kv.sadd(K.keys(integrationId), keyId);
  await audit(integrationId, "key.create", by, { keyId, masked: meta.masked });
  return { meta, raw };
}

export async function listPartnerKeys(integrationId: string): Promise<PartnerKeyMeta[]> {
  const ids = ((await kv.smembers(K.keys(integrationId))) as string[]) || [];
  const metas = await Promise.all(ids.map((k) => kv.get<PartnerKeyMeta>(K.keyMeta(k))));
  return metas.filter((m): m is PartnerKeyMeta => !!m).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokePartnerKey(integrationId: string, keyId: string, by?: string): Promise<void> {
  const meta = await kv.get<PartnerKeyMeta>(K.keyMeta(keyId));
  if (!meta || meta.integrationId !== integrationId) throw new PartnerError(404, "key_not_found", "No such key.");
  const hash = await kv.get<string>(K.keyHash(keyId));
  if (hash) await kv.del(K.key(hash));
  await kv.set(K.keyMeta(keyId), { ...meta, revokedAt: nowIso() });
  await audit(integrationId, "key.revoke", by, { keyId, masked: meta.masked });
}

/** The integration a partner backend's key belongs to, or a PartnerError. */
export async function authenticatePartner(authorization: string | null): Promise<{ integration: PartnerIntegration; keyId: string }> {
  const m = /^Bearer\s+(nlm_pk_[a-f0-9]{8}_[a-f0-9]{48})$/.exec((authorization || "").trim());
  if (!m) throw new PartnerError(401, "invalid_key", "Send the integration key as Authorization: Bearer nlm_pk_….");
  const found = await kv.get<{ integrationId: string; keyId: string }>(K.key(sha256(m[1])));
  if (!found) throw new PartnerError(401, "invalid_key", "This integration key is not valid, or was revoked.");
  const integration = await getIntegration(found.integrationId);
  if (!integration) throw new PartnerError(401, "invalid_key", "This integration key is not valid, or was revoked.");
  if (integration.status !== "active") throw new PartnerError(403, "integration_disabled", "This integration is disabled.");
  const meta = await kv.get<PartnerKeyMeta>(K.keyMeta(found.keyId));
  if (meta && !meta.revokedAt) await kv.set(K.keyMeta(found.keyId), { ...meta, lastUsedAt: nowIso() });
  return { integration, keyId: found.keyId };
}

/* ---------------------------------- zones -------------------------------- */

/** The meeting slug a zone's room gets: fixed, so two first visits claim the same one. */
export function zoneSlug(integrationId: string, zone: string): string {
  return `z-${integrationId.slice(3, 9)}-${zone.toLowerCase().replace(/_/g, "-")}`.slice(0, 64);
}

export function zoneTitle(integration: PartnerIntegration, zone: string): string {
  return integration.titleTemplate.replace(/\{zone\}/g, zone).slice(0, 80) || zone;
}

export async function getZone(integrationId: string, zone: string): Promise<ZoneMapping | null> {
  return (await kv.get<ZoneMapping>(K.zone(integrationId, zone))) ?? null;
}

export async function listZones(integrationId: string): Promise<ZoneMapping[]> {
  const ids = ((await kv.smembers(K.zones(integrationId))) as string[]) || [];
  const all = await Promise.all(ids.map((z) => getZone(integrationId, z)));
  return all.filter((x): x is ZoneMapping => !!x).sort((a, b) => a.zoneId.localeCompare(b.zoneId));
}

/**
 * The zone's meeting, made on the first visit when the integration allows
 * it. Idempotent and safe under concurrency: the meeting is claimed by its
 * fixed slug (one winner, everyone else reads the winner) and the mapping
 * by set-if-absent (likewise). A disabled zone, or one not set up when
 * creating is off, is refused.
 */
export async function resolveZone(integration: PartnerIntegration, zone: string): Promise<{ mapping: ZoneMapping; event: NeoEvent }> {
  const existing = await getZone(integration.id, zone);
  if (existing) {
    if (existing.status !== "active") throw new PartnerError(403, "zone_disabled", "This zone's meeting is switched off.");
    const event = await eventStore.byId(existing.eventId);
    if (!event) throw new PartnerError(409, "zone_meeting_missing", "This zone's meeting no longer exists. An administrator can connect it again.");
    return { mapping: existing, event };
  }
  if (!integration.autoCreateZones) {
    throw new PartnerError(404, "zone_not_found", "This zone has no meeting yet. An administrator connects it in NeoLinguaMeet.");
  }

  const slug = zoneSlug(integration.id, zone);
  const title = zoneTitle(integration, zone);
  const at = nowIso();
  const candidate: NeoEvent = {
    id: generateId(),
    slug,
    name: title,
    ownerUserId: integration.ownerUserId,
    ownerEmail: integration.ownerEmail,
    // Reached through the partner's page, not listed or searchable here.
    visibility: "unlisted",
    waitingRoomEnabled: false,
    // A prayer room is opened by whoever comes first; a host can change
    // this, and turn on the waiting room, in the meeting's settings.
    waitForHost: false,
    // One room for the zone for good: a finished session reopens on the
    // next join (meetingLifecycle.reopensOnJoin).
    isPermanent: true,
    livekitRoom: slug,
    state: "live",
    roles: [],
    waitingRoom: [],
    recordings: [],
    qrSeed: generateQrSeed(),
    partner: { integrationId: integration.id, zoneId: zone },
    createdAt: at,
    updatedAt: at,
  } as unknown as NeoEvent;
  const event = await eventStore.createIfSlugFree(candidate);
  if (!event) throw new PartnerError(503, "zone_create_failed", "The zone's meeting could not be created. Try again.");
  const owned = (event as NeoEvent & { partner?: { integrationId: string; zoneId: string } }).partner;
  if (!owned || owned.integrationId !== integration.id || owned.zoneId !== zone) {
    // Someone else's meeting already has this slug: never hand it over.
    throw new PartnerError(409, "zone_slug_taken", "This zone's meeting address is taken. An administrator can connect the zone to a meeting.");
  }

  const mapping: ZoneMapping = {
    integrationId: integration.id,
    zoneId: zone,
    eventId: event.id,
    slug: event.slug,
    title: event.name,
    ownerUserId: event.ownerUserId,
    status: "active",
    createdAt: at,
    updatedAt: at,
    source: "auto",
  };
  const won = await kv.set(K.zone(integration.id, zone), mapping, { nx: true });
  await kv.sadd(K.zones(integration.id), zone);
  if (won) {
    await audit(integration.id, "zone.create", "auto", { zone, eventId: event.id, slug: event.slug });
    return { mapping, event };
  }
  const winner = await getZone(integration.id, zone);
  if (!winner) throw new PartnerError(503, "zone_create_failed", "The zone's meeting could not be created. Try again.");
  const winnerEvent = (await eventStore.byId(winner.eventId)) ?? event;
  return { mapping: winner, event: winnerEvent };
}

/** An administrator points a zone at an existing meeting (made or re-made). */
export async function connectZone(integration: PartnerIntegration, zone: string, eventSlug: string, by?: string): Promise<ZoneMapping> {
  const event = await eventStore.bySlug(eventSlug.trim().toLowerCase());
  if (!event) throw new PartnerError(404, "meeting_not_found", "No meeting has that address.");
  const prev = await getZone(integration.id, zone);
  const at = nowIso();
  const mapping: ZoneMapping = {
    integrationId: integration.id,
    zoneId: zone,
    eventId: event.id,
    slug: event.slug,
    title: event.name,
    ownerUserId: event.ownerUserId,
    status: prev?.status ?? "active",
    createdAt: prev?.createdAt ?? at,
    updatedAt: at,
    source: "admin",
  };
  await kv.set(K.zone(integration.id, zone), mapping);
  await kv.sadd(K.zones(integration.id), zone);
  await audit(integration.id, "zone.connect", by, { zone, from: prev?.slug ?? null, to: event.slug });
  return mapping;
}

export async function setZoneStatus(integrationId: string, zone: string, status: "active" | "disabled", by?: string): Promise<ZoneMapping> {
  const prev = await getZone(integrationId, zone);
  if (!prev) throw new PartnerError(404, "zone_not_found", "No such zone.");
  const next = { ...prev, status, updatedAt: nowIso() };
  await kv.set(K.zone(integrationId, zone), next);
  await audit(integrationId, status === "active" ? "zone.enable" : "zone.disable", by, { zone });
  return next;
}

/** Hands a zone's meeting to another account (the owner's plan sets its limits). */
export async function setZoneOwner(integrationId: string, zone: string, ownerUserId: string, ownerEmail: string | undefined, by?: string): Promise<ZoneMapping> {
  const prev = await getZone(integrationId, zone);
  if (!prev) throw new PartnerError(404, "zone_not_found", "No such zone.");
  const event = await eventStore.byId(prev.eventId);
  if (!event) throw new PartnerError(409, "zone_meeting_missing", "This zone's meeting no longer exists.");
  if (event.ownerUserId !== ownerUserId) {
    await eventStore.update(event.id, { ownerUserId, ownerEmail } as Partial<NeoEvent>);
    // The owner's meeting list is an index of its own.
    await kv.srem(`neo:owner:${event.ownerUserId}`, event.id);
    await kv.sadd(`neo:owner:${ownerUserId}`, event.id);
  }
  const next = { ...prev, ownerUserId, updatedAt: nowIso() };
  await kv.set(K.zone(integrationId, zone), next);
  await audit(integrationId, "zone.owner", by, { zone, from: prev.ownerUserId, to: ownerUserId });
  return next;
}

/* ------------------------------ one-time codes --------------------------- */

/** Who a join code is for: everything the iframe is allowed to do comes from here. */
export type JoinGrant = {
  integrationId: string;
  zoneId: string;
  eventId: string;
  /** The website the widget runs on; the iframe must be talking to exactly this. "self" for an open-in-new-tab hand-off. */
  origin: string;
  externalUserId: string;
  displayName: string;
  /** False for a guest the partner could not vouch for. */
  verified: boolean;
  /** Always "participant": a partner can never make anyone a host. */
  role: "participant";
};

export const CODE_TTL_SECONDS = 120;

export async function issueCode(grant: JoinGrant, ttlSeconds = CODE_TTL_SECONDS): Promise<{ code: string; expiresAt: string }> {
  const code = `nlm_jc_${randomBytes(32).toString("base64url")}`;
  await kv.set(K.code(sha256(code)), { ...grant, exp: Date.now() + ttlSeconds * 1000 }, { ex: ttlSeconds });
  return { code, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
}

/** The grant behind a code, once: a second use, or a late one, is refused. */
export async function redeemCode(code: unknown): Promise<JoinGrant> {
  if (typeof code !== "string" || !/^nlm_jc_[A-Za-z0-9_-]{43}$/.test(code)) {
    throw new PartnerError(400, "invalid_code", "That join code is not valid.");
  }
  const hash = sha256(code);
  const claimed = await kv.set(K.codeUsed(hash), 1, { nx: true, ex: 3600 });
  if (!claimed) throw new PartnerError(410, "code_used", "That join code was already used. The page asks for a new one.");
  const grant = await kv.get<JoinGrant & { exp: number }>(K.code(hash));
  await kv.del(K.code(hash));
  if (!grant || grant.exp < Date.now()) throw new PartnerError(410, "code_expired", "That join code expired. The page asks for a new one.");
  const { exp: _exp, ...rest } = grant;
  void _exp;
  return rest;
}

/* --------------------------- embed sessions (signed) --------------------- */

/**
 * What the iframe holds after redeeming a code: the grant, signed, for two
 * hours. Kept in the iframe's memory only — never in an address, never in
 * storage — and sent back in a request body to join, poll the waiting room
 * or hand off to a new tab.
 */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function sessionSecret(): string {
  const s = process.env.PARTNER_EMBED_SECRET || process.env.CLERK_SECRET_KEY || "";
  if (!s && process.env.NODE_ENV === "production") throw new PartnerError(500, "not_configured", "Embedding is not configured.");
  return s || "dev-only-partner-embed-secret";
}

export function signSession(grant: JoinGrant, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...grant, exp: now + SESSION_TTL_MS })).toString("base64url");
  const mac = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySession(token: unknown, now = Date.now()): JoinGrant {
  if (typeof token !== "string" || token.length > 4000) throw new PartnerError(401, "invalid_session", "This meeting session is not valid.");
  const [body, mac] = token.split(".");
  if (!body || !mac) throw new PartnerError(401, "invalid_session", "This meeting session is not valid.");
  const want = createHmac("sha256", sessionSecret()).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new PartnerError(401, "invalid_session", "This meeting session is not valid.");
  const data = JSON.parse(Buffer.from(body, "base64url").toString()) as JoinGrant & { exp: number };
  if (!(data.exp > now)) throw new PartnerError(401, "session_expired", "This meeting session expired. Reload the page.");
  const { exp: _exp, ...grant } = data;
  void _exp;
  return grant;
}

/* ---------------------------------- audit -------------------------------- */

export async function audit(integrationId: string, action: string, actor?: string, detail?: Record<string, unknown>): Promise<void> {
  try {
    const entry: AuditEvent = { at: nowIso(), action, actor, detail };
    await kv.lpush(K.audit(integrationId), JSON.stringify(entry));
    await kv.ltrim(K.audit(integrationId), 0, 499);
  } catch (e) {
    console.warn("[partners] audit write failed", e);
  }
}

export async function listAudit(integrationId: string, limit = 100): Promise<AuditEvent[]> {
  const raw = ((await kv.lrange(K.audit(integrationId), 0, limit - 1)) as unknown[]) || [];
  return raw
    .map((r) => {
      try {
        return (typeof r === "string" ? JSON.parse(r) : r) as AuditEvent;
      } catch {
        return null;
      }
    })
    .filter((x): x is AuditEvent => !!x);
}

/* ------------------------- who may read the reports ----------------------- */
//
// The partner's own user ids (the `user.id` it sends with join-sessions).
// Organisation administrators read every zone's reports; a zone's leaders
// read that zone's. Set by the partner's server (it holds the key) or by an
// administrator here; a report request names its viewer, and the viewer
// is checked against these lists, never against what the page asked for.

const MAX_ROLE_IDS = 500;

function readIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new PartnerError(400, "invalid_ids", "Send a list of user ids.");
  const out: string[] = [];
  for (const x of raw) {
    const id = cleanUserId(x);
    if (!id) throw new PartnerError(400, "invalid_ids", `${String(x).slice(0, 60)} is not a user id.`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_ROLE_IDS) throw new PartnerError(400, "too_many_ids", `At most ${MAX_ROLE_IDS}.`);
  return out;
}

async function replaceSet(key: string, ids: string[]): Promise<void> {
  await kv.del(key);
  if (ids.length) await kv.sadd(key, ids[0], ...ids.slice(1));
}

export async function getOrgAdmins(integrationId: string): Promise<string[]> {
  return (((await kv.smembers(K.admins(integrationId))) as string[]) || []).sort();
}

export async function setOrgAdmins(integrationId: string, raw: unknown, by?: string): Promise<string[]> {
  const ids = readIds(raw);
  await replaceSet(K.admins(integrationId), ids);
  await audit(integrationId, "roles.admins", by, { count: ids.length });
  return ids.sort();
}

export async function getZoneLeaders(integrationId: string, zone: string): Promise<string[]> {
  return (((await kv.smembers(K.leaders(integrationId, zone))) as string[]) || []).sort();
}

export async function setZoneLeaders(integrationId: string, zone: string, raw: unknown, by?: string): Promise<string[]> {
  const ids = readIds(raw);
  await replaceSet(K.leaders(integrationId, zone), ids);
  await audit(integrationId, "roles.leaders", by, { zone, count: ids.length });
  return ids.sort();
}

/** What a viewer (the partner's user id) may read: everything, or the zones they lead. */
export async function viewerRoles(integrationId: string, viewerId: string): Promise<{ orgAdmin: boolean; leads: string[] }> {
  const orgAdmin = Number(await kv.sismember(K.admins(integrationId), viewerId)) === 1;
  const zones = ((await kv.smembers(K.zones(integrationId))) as string[]) || [];
  const leads: string[] = [];
  await Promise.all(
    zones.map(async (z) => {
      if (Number(await kv.sismember(K.leaders(integrationId, z), viewerId)) === 1) leads.push(z);
    }),
  );
  return { orgAdmin, leads: leads.sort() };
}
