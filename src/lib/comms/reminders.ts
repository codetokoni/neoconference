// src/lib/comms/reminders.ts
//
// Usage-limit reminders: a note to someone when they near or reach their
// plan's allowance, so nobody meets a limit unawares.
//
//   meetings   lifetime meeting cap (Free: 5), counted in Clerk
//              publicMetadata.meetingsCreated (src/lib/plan.ts) — checked
//              each time one is counted
//   recording  recording hours per month (src/lib/recordingUsage.ts) —
//              checked each time a finished recording is counted
//
//   neo:comms:reminders                         JSON  the settings below
//   neo:comms:rem:<uid>:meetings:<pct>          "1"   sent (once, ever)
//   neo:comms:rem:<uid>:recording:<month>:<pct> "1"   sent (once a month)
//
// Off until an administrator turns them on (Admin → Communication →
// Reminders). Each respects the person's "Usage reminders" preference per
// channel. Renewal and failed-payment reminders belong to billing.

import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { addNotification } from "@/lib/notificationStore";
import { getPlanLimitsForUserId } from "@/lib/plan";
import { nextMonthStart, recordedSeconds, usageMonth } from "@/lib/recordingUsage";
import { allows, getPrefs, oneClickUrl } from "@/lib/comms/prefs";
import { renderEmail, sendTemplateEmail } from "@/lib/comms/templates";

const CONFIG = "neo:comms:reminders";

export type ReminderKind = "meetings" | "recording";
export interface ReminderRule {
  enabled: boolean;
  /** Percent of the allowance, e.g. [80, 100]. */
  thresholds: number[];
  channels: { email: boolean; inApp: boolean };
}
export interface ReminderConfig {
  meetings: ReminderRule;
  recording: ReminderRule;
  updatedAt: number | null;
  updatedBy: string | null;
}

export function defaultReminderConfig(): ReminderConfig {
  const rule = (): ReminderRule => ({ enabled: false, thresholds: [80, 100], channels: { email: true, inApp: true } });
  return { meetings: rule(), recording: rule(), updatedAt: null, updatedBy: null };
}

function cleanRule(raw: unknown, base: ReminderRule): ReminderRule {
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const thresholds = Array.isArray(r.thresholds)
    ? [...new Set(r.thresholds.map(Number).filter((n) => Number.isInteger(n) && n >= 10 && n <= 100))].sort((a, b) => a - b).slice(0, 5)
    : base.thresholds;
  const ch = (r.channels ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled,
    thresholds: thresholds.length ? thresholds : base.thresholds,
    channels: {
      email: typeof ch.email === "boolean" ? ch.email : base.channels.email,
      inApp: typeof ch.inApp === "boolean" ? ch.inApp : base.channels.inApp,
    },
  };
}

export async function getReminderConfig(): Promise<ReminderConfig> {
  const base = defaultReminderConfig();
  const raw = await kv.get(CONFIG).catch(() => null);
  let o: unknown = raw;
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw);
    } catch {
      o = null;
    }
  }
  if (!o || typeof o !== "object") return base;
  const r = o as Partial<ReminderConfig>;
  return {
    meetings: cleanRule(r.meetings, base.meetings),
    recording: cleanRule(r.recording, base.recording),
    updatedAt: r.updatedAt ?? null,
    updatedBy: r.updatedBy ?? null,
  };
}

export async function saveReminderConfig(patch: unknown, actorEmail: string): Promise<{ before: ReminderConfig; after: ReminderConfig }> {
  const before = await getReminderConfig();
  const p = (patch ?? {}) as Record<string, unknown>;
  const after: ReminderConfig = {
    meetings: cleanRule(p.meetings, before.meetings),
    recording: cleanRule(p.recording, before.recording),
    updatedAt: Date.now(),
    updatedBy: actorEmail,
  };
  await kv.set(CONFIG, JSON.stringify(after));
  return { before, after };
}

function origin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://www.neoconference.app").replace(/\/+$/, "");
}

/** The highest threshold `pct` has reached, or null. */
export function crossed(thresholds: number[], pct: number): number | null {
  const hit = thresholds.filter((t) => pct >= t);
  return hit.length ? Math.max(...hit) : null;
}

const planName = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

async function deliver(
  uid: string,
  rule: ReminderRule,
  template: "reminder.meetings" | "reminder.recording",
  vars: Record<string, string | number | boolean>,
): Promise<{ email: string; inApp: string }> {
  const prefs = await getPrefs(uid);
  const out = { email: "off", inApp: "off" };
  if (rule.channels.inApp) {
    if (!allows(prefs, "reminders", "inApp")) out.inApp = "opted_out";
    else {
      const r = await renderEmail(template, vars);
      await addNotification(uid, { type: "reminder", title: r.subject, body: r.short, url: "/pricing" });
      out.inApp = "sent";
    }
  }
  if (rule.channels.email) {
    if (!allows(prefs, "reminders", "email")) out.email = "opted_out";
    else if (!vars.email) out.email = "no_email";
    else {
      const res = await sendTemplateEmail(template, vars, {
        to: String(vars.email),
        headers: { "List-Unsubscribe": `<${oneClickUrl(origin(), uid, "reminders")}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      out.email = res.ok ? "sent" : res.error;
    }
  }
  return out;
}

async function person(uid: string): Promise<{ email: string; name: string }> {
  const client = await clerkClient();
  const u = await client.users.getUser(uid);
  const email = (u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || "").toLowerCase();
  return { email, name: u.firstName || "" };
}

/**
 * For callers other than the events (an automation rule on a schedule):
 * `rule` replaces the Communication → Reminders setting for this call;
 * `dryRun` answers what it would do ("would_send:<pct>", "already_sent",
 * "below", …) without claiming or sending. The neo:comms:rem:* claim is the
 * only one, so an event and a rule never both send the same threshold.
 */
export interface ReminderOpts {
  rule?: ReminderRule;
  dryRun?: boolean;
}

/**
 * After a meeting is counted against a lifetime cap. Never throws: a
 * reminder must not stand in the way of creating a meeting.
 */
export async function meetingCapReminder(uid: string, used: number, cap: number, plan: string, opts: ReminderOpts = {}): Promise<string> {
  try {
    if (!uid || cap <= 0) return "no_cap";
    const rule = opts.rule ? cleanRule(opts.rule, { ...defaultReminderConfig().meetings, enabled: true }) : (await getReminderConfig()).meetings;
    if (!rule.enabled) return "off";
    const t = crossed(rule.thresholds, Math.round((used / cap) * 100));
    if (t == null) return "below";
    if (opts.dryRun) return (await kv.get(`neo:comms:rem:${uid}:meetings:${t}`)) != null ? "already_sent" : `would_send:${t}`;
    if ((await kv.set(`neo:comms:rem:${uid}:meetings:${t}`, "1", { nx: true })) !== "OK") return "already_sent";
    // A higher threshold sent covers the lower ones.
    for (const lower of rule.thresholds.filter((x) => x < t)) await kv.set(`neo:comms:rem:${uid}:meetings:${lower}`, "1");
    const who = await person(uid);
    const res = await deliver(uid, rule, "reminder.meetings", {
      name: who.name,
      email: who.email,
      used,
      cap,
      left: Math.max(0, cap - used),
      reached: used >= cap,
      planName: planName(plan),
      origin: origin(),
    });
    return `sent:${t}:${res.email}/${res.inApp}`;
  } catch (err) {
    console.warn("[comms/reminders] meetings reminder failed", err);
    return "error";
  }
}

/** After a finished recording is counted. Never throws. */
export async function recordingReminder(uid: string, now = Date.now(), opts: ReminderOpts = {}): Promise<string> {
  try {
    if (!uid) return "no_owner";
    const rule = opts.rule ? cleanRule(opts.rule, { ...defaultReminderConfig().recording, enabled: true }) : (await getReminderConfig()).recording;
    if (!rule.enabled) return "off";
    // The plan's own limits, or the snapshot a managed subscription set (billing).
    const { plan, limits } = await getPlanLimitsForUserId(uid);
    const capHours = limits.recordingHoursPerMonth;
    if (capHours <= 0) return "no_cap";
    const month = usageMonth(now);
    const used = await recordedSeconds(uid, month);
    const pct = Math.round((used / (capHours * 3600)) * 100);
    const t = crossed(rule.thresholds, pct);
    if (t == null) return "below";
    if (opts.dryRun) return (await kv.get(`neo:comms:rem:${uid}:recording:${month}:${t}`)) != null ? "already_sent" : `would_send:${t}`;
    if ((await kv.set(`neo:comms:rem:${uid}:recording:${month}:${t}`, "1", { nx: true, ex: 40 * 24 * 3600 })) !== "OK") return "already_sent";
    for (const lower of rule.thresholds.filter((x) => x < t)) {
      await kv.set(`neo:comms:rem:${uid}:recording:${month}:${lower}`, "1", { ex: 40 * 24 * 3600 });
    }
    const who = await person(uid);
    const h = used / 3600;
    const res = await deliver(uid, rule, "reminder.recording", {
      name: who.name,
      email: who.email,
      usedHours: h >= 10 ? h.toFixed(0) : h.toFixed(1),
      capHours,
      percent: Math.min(pct, 100),
      reached: pct >= 100,
      resets: nextMonthStart(now).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }),
      planName: planName(plan),
      origin: origin(),
    });
    return `sent:${t}:${res.email}/${res.inApp}`;
  } catch (err) {
    console.warn("[comms/reminders] recording reminder failed", err);
    return "error";
  }
}
