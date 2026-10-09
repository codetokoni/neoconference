// src/lib/platform/model.ts
//
// Platform settings and feature controls as data, and the decisions made
// from them: which feature is on for whom, whether maintenance mode lets a
// request through, whether a new account passes the registration rules.
// Pure — no KV, no Clerk, no Node APIs — so client components, the
// middleware (Edge) and the smoke tests all import the same rules.
// Storage is src/lib/platform/settings.ts.

import { PLANS, type Plan } from "@/lib/planLimits";

export const DEFAULT_PLATFORM_NAME = "NeoConference";
export const DEFAULT_SUPPORT_EMAIL = "info@neoconference.app";

/* -------------------------------- branding -------------------------------- */

export interface Branding {
  platformName: string;
  /** R2 key of the uploaded logo, served at /api/platform/logo. */
  logoKey: string | null;
  logoType: string | null;
  /** Bumped on every upload so browsers fetch the new one. */
  logoVersion: number;
}

export interface ContactLink {
  label: string;
  url: string;
}

export interface Contacts {
  supportEmail: string;
  supportPhone: string;
  links: ContactLink[];
}

/* --------------------------------- notice --------------------------------- */

export type NoticeLevel = "info" | "warning" | "critical";
export const NOTICE_LEVELS: NoticeLevel[] = ["info", "warning", "critical"];

export interface PlatformNotice {
  /** Changes on every save, so a dismissed notice comes back once it is edited. */
  id: string;
  enabled: boolean;
  level: NoticeLevel;
  message: string;
  linkUrl: string;
  linkLabel: string;
  startsAt: number | null;
  endsAt: number | null;
  dismissible: boolean;
}

/** Whether the banner shows now. */
export function noticeActive(n: PlatformNotice | null | undefined, now = Date.now()): boolean {
  if (!n || !n.enabled || !n.message.trim()) return false;
  if (n.startsAt && now < n.startsAt) return false;
  if (n.endsAt && now >= n.endsAt) return false;
  return true;
}

/* -------------------------------- regional -------------------------------- */

export type DateStyle = "medium" | "long" | "iso" | "day-month" | "month-day";
export const DATE_STYLES: { id: DateStyle; label: string }[] = [
  { id: "medium", label: "9 Oct 2026, 14:05 (short month)" },
  { id: "long", label: "9 October 2026 at 14:05 (long month)" },
  { id: "iso", label: "2026-10-09 14:05 (ISO)" },
  { id: "day-month", label: "09/10/2026 14:05 (day first)" },
  { id: "month-day", label: "10/09/2026 2:05 PM (month first)" },
];

export interface Regional {
  /** BCP 47 tag, e.g. "en", "fr". The page language (<html lang>). */
  defaultLanguage: string;
  /** IANA zone used when a meeting is created without one. */
  defaultTimezone: string;
  dateStyle: DateStyle;
  /** Locale for numbers, e.g. "en-US" (1,234.5) or "de-DE" (1.234,5). */
  numberLocale: string;
  /** The zone the admin area shows timestamps in. "local" = each administrator's own clock. */
  adminTimezone: string;
}

/* ------------------------------ registration ------------------------------ */

export type SignupMode = "open" | "closed" | "invite_only";
export const SIGNUP_MODES: SignupMode[] = ["open", "closed", "invite_only"];

export interface DatedEntry {
  value: string;
  addedAt: number;
}

/**
 * Rules for NEW accounts. Each rule carries when it came into force and
 * applies only to accounts created after that, so tightening the rules
 * never locks out people who already had an account.
 */
export interface Registration {
  mode: SignupMode;
  modeSince: number | null;
  requireVerifiedEmail: boolean;
  verifySince: number | null;
  /** Non-empty = only these email domains may sign up (since the earliest entry). */
  allowDomains: DatedEntry[];
  blockDomains: DatedEntry[];
  /** Addresses let in while sign-up is invite-only. */
  invited: DatedEntry[];
  trials: { enabled: boolean; defaultDays: number };
}

export interface PlatformSettings {
  branding: Branding;
  contacts: Contacts;
  notice: PlatformNotice;
  regional: Regional;
  registration: Registration;
  updatedAt: number;
}

export function defaultPlatformSettings(): PlatformSettings {
  return {
    branding: { platformName: DEFAULT_PLATFORM_NAME, logoKey: null, logoType: null, logoVersion: 0 },
    contacts: { supportEmail: DEFAULT_SUPPORT_EMAIL, supportPhone: "", links: [] },
    notice: {
      id: "none",
      enabled: false,
      level: "info",
      message: "",
      linkUrl: "",
      linkLabel: "",
      startsAt: null,
      endsAt: null,
      dismissible: true,
    },
    regional: {
      defaultLanguage: "en",
      defaultTimezone: "UTC",
      dateStyle: "medium",
      numberLocale: "en-US",
      adminTimezone: "local",
    },
    registration: {
      mode: "open",
      modeSince: null,
      requireVerifiedEmail: false,
      verifySince: null,
      allowDomains: [],
      blockDomains: [],
      invited: [],
      trials: { enabled: true, defaultDays: 14 },
    },
    updatedAt: 0,
  };
}

/** Stored settings over the defaults, section by section, so a new field never reads as undefined. */
export function withDefaults(raw: unknown): PlatformSettings {
  const d = defaultPlatformSettings();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<PlatformSettings>;
  return {
    branding: { ...d.branding, ...(r.branding ?? {}) },
    contacts: { ...d.contacts, ...(r.contacts ?? {}) },
    notice: { ...d.notice, ...(r.notice ?? {}) },
    regional: { ...d.regional, ...(r.regional ?? {}) },
    registration: {
      ...d.registration,
      ...(r.registration ?? {}),
      trials: { ...d.registration.trials, ...(r.registration?.trials ?? {}) },
    },
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

/* ------------------------------- validation ------------------------------- */

export class SettingsInputError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const bad = (code: string, message: string): never => {
  throw new SettingsInputError(code, message);
};

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isEmail(v: string): boolean {
  return EMAIL_RE.test(v);
}

/** "@Example.COM", "example.com", "*@example.com" -> "example.com"; anything else null. */
export function cleanDomain(v: unknown): string | null {
  const d = text(v, 260).toLowerCase().replace(/^\*?@/, "").replace(/^\*\./, "");
  return DOMAIN_RE.test(d) ? d : null;
}

/** https:// (or mailto:/tel:) only — never javascript: or data:. */
export function cleanUrl(v: unknown, field: string): string {
  const s = text(v, 500);
  if (!s) return "";
  if (/^(mailto|tel):/i.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return bad("invalid_url", `${field}: enter a full web address starting with https://`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) {
    return bad("invalid_url", `${field}: only https:// addresses are allowed.`);
  }
  return u.toString();
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isLocale(tag: string): boolean {
  try {
    return Intl.NumberFormat.supportedLocalesOf([tag]).length > 0;
  } catch {
    return false;
  }
}

function time(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(n) || n < 0) return bad("invalid_time", `${field} is not a valid date and time.`);
  return Math.floor(n);
}

export function cleanBranding(raw: unknown, current: Branding): Branding {
  const r = (raw ?? {}) as Record<string, unknown>;
  const platformName = "platformName" in r ? text(r.platformName, 60) : current.platformName;
  if (!platformName) bad("name_required", "The platform needs a name.");
  // The logo itself changes only through its upload route.
  return { ...current, platformName };
}

export function cleanContacts(raw: unknown): Contacts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const supportEmail = text(r.supportEmail, 200).toLowerCase();
  if (supportEmail && !isEmail(supportEmail)) bad("invalid_email", "The support email is not a valid address.");
  const supportPhone = text(r.supportPhone, 40);
  if (supportPhone && !/^[+()\d\s.-]{5,40}$/.test(supportPhone)) bad("invalid_phone", "The support phone may contain digits, spaces, +, ( ), - and . only.");
  const links: ContactLink[] = [];
  for (const l of Array.isArray(r.links) ? r.links.slice(0, 8) : []) {
    const label = text((l as ContactLink)?.label, 40);
    const url = cleanUrl((l as ContactLink)?.url, label || "Link");
    if (label && url) links.push({ label, url });
  }
  return { supportEmail, supportPhone, links };
}

export function cleanNotice(raw: unknown, newId: string): PlatformNotice {
  const r = (raw ?? {}) as Record<string, unknown>;
  const level = NOTICE_LEVELS.includes(r.level as NoticeLevel) ? (r.level as NoticeLevel) : "info";
  const message = text(r.message, 500);
  const enabled = r.enabled === true;
  if (enabled && !message) bad("message_required", "Write the notice before turning it on.");
  const startsAt = time(r.startsAt, "Start");
  const endsAt = time(r.endsAt, "End");
  if (startsAt && endsAt && endsAt <= startsAt) bad("invalid_window", "The notice must end after it starts.");
  const linkUrl = cleanUrl(r.linkUrl, "Notice link");
  return {
    id: newId,
    enabled,
    level,
    message,
    linkUrl,
    linkLabel: linkUrl ? text(r.linkLabel, 40) || "Learn more" : "",
    startsAt,
    endsAt,
    // A critical notice cannot be dismissed unless the administrator says so.
    dismissible: r.dismissible === undefined ? level !== "critical" : r.dismissible === true,
  };
}

export function cleanRegional(raw: unknown): Regional {
  const r = (raw ?? {}) as Record<string, unknown>;
  const defaultLanguage = text(r.defaultLanguage, 20) || "en";
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(defaultLanguage)) bad("invalid_language", "The language must be a code like en, fr or pt-BR.");
  const defaultTimezone = text(r.defaultTimezone, 64) || "UTC";
  if (!isTimeZone(defaultTimezone)) bad("invalid_timezone", `${defaultTimezone} is not a time zone (use a name like Africa/Lagos or UTC).`);
  const adminTimezone = text(r.adminTimezone, 64) || "local";
  if (adminTimezone !== "local" && !isTimeZone(adminTimezone)) bad("invalid_timezone", `${adminTimezone} is not a time zone.`);
  const dateStyle = DATE_STYLES.some((s) => s.id === r.dateStyle) ? (r.dateStyle as DateStyle) : "medium";
  const numberLocale = text(r.numberLocale, 20) || "en-US";
  if (!isLocale(numberLocale)) bad("invalid_locale", `${numberLocale} is not a number format this server knows.`);
  return { defaultLanguage, defaultTimezone, dateStyle, numberLocale, adminTimezone };
}

/**
 * Registration rules from the form, keeping each rule's "since": a rule
 * already in force keeps its date; a rule switched on now starts now.
 */
export function cleanRegistration(raw: unknown, current: Registration, now: number): Registration {
  const r = (raw ?? {}) as Record<string, unknown>;
  const mode = SIGNUP_MODES.includes(r.mode as SignupMode) ? (r.mode as SignupMode) : "open";
  const requireVerifiedEmail = r.requireVerifiedEmail === true;

  const dated = (list: unknown, clean: (v: unknown) => string | null, field: string, prev: DatedEntry[], cap: number): DatedEntry[] => {
    const out: DatedEntry[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const raw = typeof item === "object" && item ? (item as DatedEntry).value : item;
      const v = clean(raw);
      if (!v) bad("invalid_entry", `${field}: "${String(raw).slice(0, 80)}" is not valid.`);
      if (out.some((e) => e.value === v)) continue;
      out.push({ value: v as string, addedAt: prev.find((p) => p.value === v)?.addedAt ?? now });
    }
    if (out.length > cap) bad("too_many", `${field}: at most ${cap} entries.`);
    return out;
  };
  const allowDomains = dated(r.allowDomains, cleanDomain, "Allowed domains", current.allowDomains, 200);
  const blockDomains = dated(r.blockDomains, cleanDomain, "Blocked domains", current.blockDomains, 500);
  const invited = dated(
    r.invited,
    (v) => {
      const e = text(v, 200).toLowerCase();
      return isEmail(e) ? e : null;
    },
    "Invited addresses",
    current.invited,
    2000,
  );
  const both = allowDomains.find((a) => blockDomains.some((b) => b.value === a.value));
  if (both) bad("allowed_and_blocked", `${both.value} is both allowed and blocked.`);

  const t = (r.trials ?? {}) as Record<string, unknown>;
  const days = Number(t.defaultDays ?? current.trials.defaultDays);
  if (!Number.isInteger(days) || days < 0 || days > 365) bad("invalid_trial", "Trial length is a whole number of days from 0 to 365.");

  return {
    mode,
    modeSince: mode === "open" ? null : mode === current.mode && current.modeSince ? current.modeSince : now,
    requireVerifiedEmail,
    verifySince: !requireVerifiedEmail ? null : current.requireVerifiedEmail && current.verifySince ? current.verifySince : now,
    allowDomains,
    blockDomains,
    invited,
    trials: { enabled: t.enabled === undefined ? current.trials.enabled : t.enabled === true, defaultDays: days },
  };
}

/* ------------------------- registration decisions ------------------------- */

export function registrationRulesActive(r: Registration): boolean {
  return r.mode !== "open" || r.requireVerifiedEmail || r.allowDomains.length > 0 || r.blockDomains.length > 0;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** example.com matches example.com and any subdomain of it. */
export function domainMatches(domain: string, rule: string): boolean {
  return domain === rule || domain.endsWith("." + rule);
}

export interface AccountFacts {
  createdAt: number;
  /** The address the rules judge: the primary email. */
  email: string;
  hasVerifiedEmail: boolean;
}

export type RegistrationRefusal = "signup_closed" | "invite_only" | "domain_blocked" | "domain_not_allowed" | "email_unverified";

export const REGISTRATION_MESSAGES: Record<RegistrationRefusal, string> = {
  signup_closed: "New sign-ups are closed at the moment, so this new account cannot be used yet.",
  invite_only: "Sign-up is by invitation only, and this email address has not been invited.",
  domain_blocked: "Accounts with this email domain cannot be used on this platform.",
  domain_not_allowed: "Only accounts with an approved email domain can be used on this platform.",
  email_unverified: "Verify your email address to use this account.",
};

export type RegistrationDecision = { ok: true } | { ok: false; reason: RegistrationRefusal; message: string };

/**
 * Whether a (new) account passes the registration rules. Each rule only
 * applies to accounts created after it came into force.
 */
export function decideRegistration(r: Registration, a: AccountFacts): RegistrationDecision {
  const no = (reason: RegistrationRefusal): RegistrationDecision => ({ ok: false, reason, message: REGISTRATION_MESSAGES[reason] });
  const after = (since: number | null | undefined) => since != null && a.createdAt >= since;
  const email = a.email.toLowerCase();
  const domain = email ? domainOf(email) : "";

  if (r.mode === "closed" && after(r.modeSince)) return no("signup_closed");
  if (r.mode === "invite_only" && after(r.modeSince) && !r.invited.some((i) => i.value === email)) return no("invite_only");
  const blocked = r.blockDomains.find((b) => domain && domainMatches(domain, b.value));
  if (blocked && a.createdAt >= blocked.addedAt) return no("domain_blocked");
  if (r.allowDomains.length) {
    const since = Math.min(...r.allowDomains.map((d) => d.addedAt));
    if (a.createdAt >= since && !(domain && r.allowDomains.some((d) => domainMatches(domain, d.value)))) return no("domain_not_allowed");
  }
  if (r.requireVerifiedEmail && after(r.verifySince) && !a.hasVerifiedEmail) return no("email_unverified");
  return { ok: true };
}

/* -------------------------------- features -------------------------------- */

export const FEATURES = [
  { key: "recording", label: "Cloud recording", catalog: true, enforcedAt: "Starting a recording (room recording gate)" },
  { key: "translation", label: "Choosing translation languages", catalog: true, enforcedAt: "Creating a meeting with languages" },
  { key: "livestream", label: "Livestream (RTMP)", catalog: true, enforcedAt: "Going live, and provisioning a stream at meeting creation" },
  { key: "breakouts", label: "Breakout rooms", catalog: true, enforcedAt: "The room's breakout controls (from the host's token)" },
  { key: "branding", label: "Custom branding", catalog: true, enforcedAt: null },
  { key: "captions", label: "Live captions", catalog: false, enforcedAt: "Starting live captions in a room" },
  { key: "transcription", label: "Recording transcripts", catalog: false, enforcedAt: "Requesting a transcript of a recording" },
  { key: "ai_summary", label: "AI meeting summary", catalog: false, enforcedAt: "Generating a meeting summary" },
  { key: "developer_api", label: "Developer API", catalog: false, enforcedAt: "Every /api/v1 request, and creating API keys" },
  { key: "group_calls", label: "Group calls", catalog: false, enforcedAt: "Starting a call from a group" },
] as const;

export type FeatureKey = (typeof FEATURES)[number]["key"];
export const FEATURE_KEYS: FeatureKey[] = FEATURES.map((f) => f.key);

export function isFeatureKey(v: unknown): v is FeatureKey {
  return typeof v === "string" && (FEATURE_KEYS as string[]).includes(v);
}

/** Per-plan values for these come from the plan catalog (phase 3), not from here. */
export function isCatalogFeature(f: FeatureKey): boolean {
  return FEATURES.find((x) => x.key === f)!.catalog;
}

export type AccountOverride = "allow" | "deny";

export interface Maintenance {
  enabled: boolean;
  message: string;
  endsAt: number | null;
  startedAt: number | null;
  startedBy: string | null;
}

export interface FeatureControls {
  /** false = off for everyone. Missing or true = on (subject to the other layers). */
  global: Partial<Record<FeatureKey, boolean>>;
  /** Only for features the plan catalog does not carry. */
  perPlan: Partial<Record<FeatureKey, Partial<Record<Plan, boolean>>>>;
  maintenance: Maintenance;
  updatedAt: number;
}

export const DEFAULT_MAINTENANCE_MESSAGE = "We're doing some maintenance and will be back shortly. Thank you for your patience.";

export function defaultFeatureControls(): FeatureControls {
  return {
    global: {},
    perPlan: {},
    maintenance: { enabled: false, message: DEFAULT_MAINTENANCE_MESSAGE, endsAt: null, startedAt: null, startedBy: null },
    updatedAt: 0,
  };
}

export function controlsWithDefaults(raw: unknown): FeatureControls {
  const d = defaultFeatureControls();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Partial<FeatureControls>;
  return {
    global: { ...(r.global ?? {}) },
    perPlan: { ...(r.perPlan ?? {}) },
    maintenance: { ...d.maintenance, ...(r.maintenance ?? {}) },
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

/** Plan defaults for the features the plan catalog does not carry: on everywhere, as before. */
export function builtInPlanDefault(_f: FeatureKey, _plan: Plan): boolean {
  return true;
}

export type FeatureSource = "global" | "account" | "plan" | "plan_default" | "exempt";

export interface FeatureDecision {
  feature: FeatureKey;
  enabled: boolean;
  source: FeatureSource;
}

export interface FeatureSubject {
  plan: Plan;
  /** The plan's own value, already worked out by the caller (plan catalog / getPlanLimits). */
  planAllows?: boolean;
  override?: AccountOverride | null;
  /** Platform operators the plan layers do not apply to (owner, ADMIN_EMAILS). */
  exempt?: boolean;
}

/**
 * The precedence, in one place:
 *   global off  >  account allow/deny  >  per-plan switch  >  plan default.
 * Operators skip the two plan layers, not the global switch or a deny.
 */
export function resolveFeature(controls: FeatureControls, feature: FeatureKey, s: FeatureSubject): FeatureDecision {
  if (controls.global[feature] === false) return { feature, enabled: false, source: "global" };
  if (s.override === "allow" || s.override === "deny") return { feature, enabled: s.override === "allow", source: "account" };
  if (s.exempt) return { feature, enabled: true, source: "exempt" };
  if (!isCatalogFeature(feature)) {
    const p = controls.perPlan[feature]?.[s.plan];
    if (typeof p === "boolean") return { feature, enabled: p, source: "plan" };
  }
  return { feature, enabled: s.planAllows ?? builtInPlanDefault(feature, s.plan), source: "plan_default" };
}

export function featureLabel(f: FeatureKey): string {
  return FEATURES.find((x) => x.key === f)!.label;
}

/** What to tell the person refused, by the layer that refused them. */
export function featureRefusalMessage(d: FeatureDecision): string {
  const label = featureLabel(d.feature);
  if (d.source === "global") return `${label} is turned off on the platform at the moment.`;
  if (d.source === "account") return `${label} is turned off for this account. Contact support if you think this is a mistake.`;
  return `${label} is not included in this plan.`;
}

export function cleanPerPlan(raw: unknown): FeatureControls["perPlan"] {
  const out: FeatureControls["perPlan"] = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [f, plans] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFeatureKey(f)) continue;
    if (isCatalogFeature(f)) bad("plan_catalog_owns", `${featureLabel(f)} is set per plan in Plans, not here.`);
    const row: Partial<Record<Plan, boolean>> = {};
    for (const [p, v] of Object.entries((plans ?? {}) as Record<string, unknown>)) {
      if ((PLANS as string[]).includes(p) && typeof v === "boolean") row[p as Plan] = v;
    }
    if (Object.keys(row).length) out[f] = row;
  }
  return out;
}

/* ------------------------------- maintenance ------------------------------ */

export function maintenanceActive(m: Maintenance | null | undefined, now = Date.now()): boolean {
  return !!m && m.enabled && !(m.endsAt && now >= m.endsAt);
}

/**
 * Paths that keep working during maintenance for everyone: the admin area
 * (so it can be turned off again), signing in and out, health and version
 * checks, scheduled jobs, inbound webhooks and payment returns, the logo.
 */
const MAINTENANCE_OPEN: RegExp[] = [
  /^\/admin(\/|$)/,
  /^\/api\/admin(\/|$)/,
  /^\/sign-in(\/|$)/,
  /^\/sign-out(\/|$)/,
  /^\/api\/auth\//,
  /^\/app\/auth(\/|$)/,
  /^\/api\/health(\/|$)/,
  /^\/api\/version(\/|$)/,
  /^\/api\/cron\//,
  /^\/api\/internal\/dispatch(\/|$)/,
  /^\/api\/livekit\/webhook(\/|$)/,
  /^\/api\/stripe\/webhook(\/|$)/,
  /^\/api\/transcribe\/deepgram(\/|$)/,
  /^\/api\/billing\/espees\/(return|fail)(\/|$)/,
  /^\/api\/platform\/logo(\/|$)/,
  /^\/\.well-known\//,
];

export function maintenanceExemptPath(pathname: string): boolean {
  return MAINTENANCE_OPEN.some((re) => re.test(pathname));
}

/** Paths a refused new account can still reach: where they are told why, sign-out, help. */
const REGISTRATION_OPEN: RegExp[] = [
  /^\/access-blocked(\/|$)/,
  /^\/sign-in(\/|$)/,
  /^\/sign-up(\/|$)/,
  /^\/sign-out(\/|$)/,
  /^\/support(\/|$)/,
  /^\/api\/auth\//,
  /^\/app\/auth(\/|$)/,
  /^\/api\/health(\/|$)/,
  /^\/api\/version(\/|$)/,
  /^\/api\/cron\//,
  /^\/api\/internal\/dispatch(\/|$)/,
  /^\/api\/livekit\/webhook(\/|$)/,
  /^\/api\/stripe\/webhook(\/|$)/,
  /^\/api\/transcribe\/deepgram(\/|$)/,
  /^\/api\/platform\/logo(\/|$)/,
  /^\/\.well-known\//,
];

export function registrationExemptPath(pathname: string): boolean {
  return REGISTRATION_OPEN.some((re) => re.test(pathname));
}

/** HTML-escape for the few strings the middleware writes into a page itself. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/* -------------------------------- formatting ------------------------------ */

/** Date-time options for a style, in a zone (undefined = the viewer's own). */
export function dateTimeFormat(style: DateStyle, timeZone?: string): { locale: string | undefined; options: Intl.DateTimeFormatOptions } {
  const tz = timeZone ? { timeZone } : {};
  switch (style) {
    case "long":
      return { locale: "en-GB", options: { ...tz, dateStyle: "long", timeStyle: "short" } };
    case "iso":
      return { locale: "sv-SE", options: { ...tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } };
    case "day-month":
      return { locale: "en-GB", options: { ...tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" } };
    case "month-day":
      return { locale: "en-US", options: { ...tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit" } };
    case "medium":
    default:
      return { locale: "en-GB", options: { ...tz, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } };
  }
}
