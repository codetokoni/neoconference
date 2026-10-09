// src/lib/ops/alerts.ts
//
// Alert rules, evaluated after every health check (the 5-minute cron):
//
//   service_down       a service down for at least N minutes (target: a probe or "*")
//   service_degraded   degraded (answering, but slow or partly failing) for at least N
//                      minutes; a service that is down raises service_down instead
//   kv_keys / kv_bytes KV key count / memory over a limit
//   r2_bytes           R2 bytes over a limit
//   recording_hours    hours recorded this month (all owners) over a limit
//   payment_failures   failed checkouts + failed payments in 24 hours ≥ N
//   job_failures       a job (or "*") failed N times in a row
//
// De-duplication: one open alert per rule and subject. While it is open (or
// acknowledged) a condition that is still true only bumps its count. When
// the condition clears the alert resolves itself.
// Cooldown: after notifying about a rule and subject, nobody is notified
// about it again for cooldownMinutes — a flapping service opens new alerts
// (so the history is true) but does not page anyone each time.
//
//   neo:ops:alert:rules            hash ruleId -> AlertRule (absent = the defaults)
//   neo:ops:alerts                 hash alertId -> OpsAlert
//   neo:ops:alerts:order           list of alertIds, newest first, capped at 500
//   neo:ops:alert:open:<key>       alertId of the open alert for rule+subject
//   neo:ops:alert:notified:<key>   when anyone was last notified for rule+subject

import { kv } from "@/lib/kv";
import { failingSince, healthHistory, type ProbeResult, type ProbeStatus } from "@/lib/ops/probes";
import { consecutiveFailures, jobNames, listRuns } from "@/lib/ops/jobs";
import { JOBS } from "@/lib/ops/jobRegistry";
import { recordedHoursThisMonth } from "@/lib/ops/media";
import { paymentFailures } from "@/lib/ops/queues";
import { notifyOps, type NotifyResult } from "@/lib/ops/notify";
import { newId, parseJson, readHash } from "@/lib/ops/util";

export const ALERT_KINDS = [
  { kind: "service_down", label: "Service down", unit: "minutes" },
  { kind: "service_degraded", label: "Service degraded", unit: "minutes" },
  { kind: "kv_keys", label: "KV keys over", unit: "keys" },
  { kind: "kv_bytes", label: "KV memory over", unit: "bytes" },
  { kind: "r2_bytes", label: "R2 storage over", unit: "bytes" },
  { kind: "recording_hours", label: "Recorded hours this month over", unit: "hours" },
  { kind: "payment_failures", label: "Payment failures in 24 h at least", unit: "failures" },
  { kind: "job_failures", label: "Job failed in a row at least", unit: "runs" },
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number]["kind"];

export function isAlertKind(v: unknown): v is AlertKind {
  return typeof v === "string" && ALERT_KINDS.some((k) => k.kind === v);
}

export interface AlertRule {
  id: string;
  kind: AlertKind;
  /** A probe id or job name, or "*" for all of them. Ignored by the resource rules. */
  target: string;
  threshold: number;
  cooldownMinutes: number;
  enabled: boolean;
  email: boolean;
  inApp: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface OpsAlert {
  id: string;
  ruleId: string;
  kind: AlertKind;
  subject: string;
  title: string;
  message: string;
  status: AlertStatus;
  openedAt: number;
  lastSeenAt: number;
  occurrences: number;
  notified: boolean;
  suppressed?: "cooldown" | "channels_off";
  notifyResult?: NotifyResult;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
  resolvedAt?: number;
  resolvedBy?: string;
  resolution?: string;
}

const RULES = "neo:ops:alert:rules";
const ALERTS = "neo:ops:alerts";
const ORDER = "neo:ops:alerts:order";
const openKey = (k: string) => `neo:ops:alert:open:${k}`;
const notifiedKey = (k: string) => `neo:ops:alert:notified:${k}`;
const ORDER_CAP = 500;

export const DEFAULT_RULES: AlertRule[] = [
  { id: "default_down", kind: "service_down", target: "*", threshold: 10, cooldownMinutes: 60, enabled: true, email: true, inApp: true },
  { id: "default_degraded", kind: "service_degraded", target: "*", threshold: 30, cooldownMinutes: 180, enabled: true, email: false, inApp: true },
  { id: "default_jobs", kind: "job_failures", target: "*", threshold: 2, cooldownMinutes: 360, enabled: true, email: true, inApp: true },
  { id: "default_payments", kind: "payment_failures", target: "*", threshold: 3, cooldownMinutes: 360, enabled: true, email: true, inApp: true },
  { id: "default_kv_bytes", kind: "kv_bytes", target: "*", threshold: 200_000_000, cooldownMinutes: 1440, enabled: true, email: true, inApp: true },
  { id: "default_r2_bytes", kind: "r2_bytes", target: "*", threshold: 8_000_000_000, cooldownMinutes: 1440, enabled: true, email: true, inApp: true },
  { id: "default_recording", kind: "recording_hours", target: "*", threshold: 500, cooldownMinutes: 1440, enabled: false, email: true, inApp: true },
];

export async function listRules(): Promise<AlertRule[]> {
  const stored = await readHash<AlertRule>(RULES);
  const list = Object.values(stored);
  return (list.length ? list : DEFAULT_RULES).sort((a, b) => a.id.localeCompare(b.id));
}

/** Saving any rule turns the defaults into stored rules first, so editing one keeps the rest. */
async function materialise(): Promise<void> {
  const stored = await readHash<AlertRule>(RULES);
  if (Object.keys(stored).length) return;
  const all: Record<string, string> = {};
  for (const r of DEFAULT_RULES) all[r.id] = JSON.stringify(r);
  await kv.hset(RULES, all);
}

export async function saveRule(rule: AlertRule): Promise<void> {
  await materialise();
  await kv.hset(RULES, { [rule.id]: JSON.stringify(rule) });
}

export async function deleteRule(id: string): Promise<boolean> {
  await materialise();
  return Number(await kv.hdel(RULES, id)) > 0;
}

export function newRuleId(): string {
  return newId("rule");
}

export async function getAlert(id: string): Promise<OpsAlert | null> {
  return parseJson<OpsAlert>(await kv.hget(ALERTS, id));
}

async function saveAlert(a: OpsAlert): Promise<void> {
  await kv.hset(ALERTS, { [a.id]: JSON.stringify(a) });
}

export async function listAlerts(opts: { status?: AlertStatus | "active"; limit?: number } = {}): Promise<OpsAlert[]> {
  const ids = ((await kv.lrange(ORDER, 0, ORDER_CAP - 1)) ?? []).map(String);
  const all = await readHash<OpsAlert>(ALERTS);
  let out = ids.map((id) => all[id]).filter((a): a is OpsAlert => !!a);
  if (opts.status === "active") out = out.filter((a) => a.status !== "resolved");
  else if (opts.status) out = out.filter((a) => a.status === opts.status);
  return out.slice(0, opts.limit ?? 200);
}

export async function acknowledgeAlert(id: string, by: string): Promise<OpsAlert | null> {
  const a = await getAlert(id);
  if (!a || a.status !== "open") return a;
  const next: OpsAlert = { ...a, status: "acknowledged", acknowledgedAt: Date.now(), acknowledgedBy: by };
  await saveAlert(next);
  return next;
}

export async function resolveAlert(id: string, by: string, resolution?: string): Promise<OpsAlert | null> {
  const a = await getAlert(id);
  if (!a || a.status === "resolved") return a;
  const next: OpsAlert = { ...a, status: "resolved", resolvedAt: Date.now(), resolvedBy: by, ...(resolution ? { resolution } : {}) };
  await saveAlert(next);
  const key = `${a.ruleId}:${a.subject}`;
  if (String((await kv.get(openKey(key))) ?? "") === a.id) await kv.del(openKey(key));
  return next;
}

interface Finding {
  subject: string;
  title: string;
  message: string;
}

const MIN = 60_000;

function fmtBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

/** Which subjects of `rule` are firing now. */
async function findings(rule: AlertRule, results: ProbeResult[], now: number, cache: Map<string, unknown>): Promise<Finding[]> {
  const once = async <T>(k: string, f: () => Promise<T>): Promise<T> => {
    if (!cache.has(k)) cache.set(k, await f());
    return cache.get(k) as T;
  };
  const out: Finding[] = [];
  switch (rule.kind) {
    case "service_down":
    case "service_degraded": {
      const statuses: ProbeStatus[] = rule.kind === "service_down" ? ["down"] : ["down", "degraded"];
      for (const r of results) {
        if (r.status === "not_configured" || (rule.target !== "*" && rule.target !== r.id)) continue;
        // Degraded fires only while degraded: a down service is service_down's, not both.
        if (rule.kind === "service_degraded" ? r.status !== "degraded" : r.status !== "down") continue;
        const since = failingSince(await once(`h:${r.id}`, () => healthHistory(r.id, 288)), statuses) ?? r.checkedAt;
        const minutes = Math.floor((now - since) / MIN);
        if (now - since < rule.threshold * MIN) continue;
        out.push({
          subject: r.id,
          title: `${r.label} is ${r.status}`,
          message: `${r.label} has been ${rule.kind === "service_down" ? "down" : "degraded"} for ${minutes} minute${minutes === 1 ? "" : "s"}: ${r.detail}`,
        });
      }
      break;
    }
    case "kv_keys":
    case "kv_bytes": {
      const m = results.find((r) => r.id === "kv")?.metrics;
      const v = Number(rule.kind === "kv_keys" ? m?.keys : m?.usedMemoryBytes);
      if (m && Number.isFinite(v) && v > rule.threshold && (rule.kind === "kv_keys" ? m.keys != null : m.usedMemoryBytes != null)) {
        out.push({
          subject: "kv",
          title: rule.kind === "kv_keys" ? "KV key count over the limit" : "KV memory over the limit",
          message: rule.kind === "kv_keys" ? `${v.toLocaleString("en")} keys (limit ${rule.threshold.toLocaleString("en")}).` : `${fmtBytes(v)} used (limit ${fmtBytes(rule.threshold)}).`,
        });
      }
      break;
    }
    case "r2_bytes": {
      const m = results.find((r) => r.id === "r2")?.metrics;
      const v = Number(m?.bytes);
      if (m && Number.isFinite(v) && v > rule.threshold) {
        out.push({ subject: "r2", title: "R2 storage over the limit", message: `${m.truncated ? "At least " : ""}${fmtBytes(v)} stored (limit ${fmtBytes(rule.threshold)}).` });
      }
      break;
    }
    case "recording_hours": {
      const u = await once("rec", () => recordedHoursThisMonth(now));
      if (u.hours > rule.threshold) {
        out.push({ subject: u.month, title: "Recording hours over the limit", message: `${u.hours.toFixed(1)} hours recorded in ${u.month} by ${u.owners} owner(s) (limit ${rule.threshold}).` });
      }
      break;
    }
    case "payment_failures": {
      const p = await once("pay", () => paymentFailures(24 * 60 * MIN, now));
      if (p.count >= rule.threshold) {
        out.push({ subject: "payments", title: "Payment failures", message: `${p.count} failed checkout(s) or payment(s) in the last 24 hours (threshold ${rule.threshold}).` });
      }
      break;
    }
    case "job_failures": {
      // Automation rules raise their own alert after their own threshold (raiseAlert below).
      const names =
        rule.target === "*"
          ? [...new Set([...JOBS.map((j) => j.name), ...(await once("jobs", jobNames))])].filter((n) => !n.startsWith("automation:"))
          : [rule.target];
      for (const name of names) {
        const runs = await listRuns(name, 20);
        const n = consecutiveFailures(runs);
        if (n < rule.threshold) continue;
        const last = runs.find((r) => r.outcome === "failed" || r.outcome === "abandoned");
        out.push({ subject: name, title: `Job ${name} is failing`, message: `${name} failed ${n} time${n === 1 ? "" : "s"} in a row. Last error: ${last?.error ?? last?.outcome ?? "unknown"}` });
      }
      break;
    }
  }
  return out;
}

export interface EvaluateSummary {
  firing: number;
  opened: number;
  notified: number;
  suppressed: number;
  autoResolved: number;
}

/** Evaluate every enabled rule against the latest results. Awaited by the health cron. */
export async function evaluateAlerts(results: ProbeResult[], now = Date.now()): Promise<EvaluateSummary> {
  const sum: EvaluateSummary = { firing: 0, opened: 0, notified: 0, suppressed: 0, autoResolved: 0 };
  const rules = (await listRules()).filter((r) => r.enabled);
  const active = await listAlerts({ status: "active", limit: ORDER_CAP });
  const cache = new Map<string, unknown>();
  for (const rule of rules) {
    let found: Finding[];
    try {
      found = await findings(rule, results, now, cache);
    } catch (e) {
      console.warn("[ops-alerts] rule failed", rule.id, e instanceof Error ? e.message : e);
      continue;
    }
    const firingSubjects = new Set(found.map((f) => f.subject));
    sum.firing += found.length;
    for (const f of found) {
      const key = `${rule.id}:${f.subject}`;
      const openId = await kv.get(openKey(key));
      const existing = openId ? await getAlert(String(openId)) : null;
      if (existing && existing.status !== "resolved") {
        await saveAlert({ ...existing, lastSeenAt: now, occurrences: existing.occurrences + 1, message: f.message });
        continue;
      }
      const lastNotified = Number((await kv.get(notifiedKey(key))) ?? 0);
      const cooling = lastNotified > 0 && now - lastNotified < rule.cooldownMinutes * MIN;
      const channelsOff = !rule.email && !rule.inApp;
      const alert: OpsAlert = {
        id: newId("alert"),
        ruleId: rule.id,
        kind: rule.kind,
        subject: f.subject,
        title: f.title,
        message: f.message,
        status: "open",
        openedAt: now,
        lastSeenAt: now,
        occurrences: 1,
        notified: false,
        ...(cooling ? { suppressed: "cooldown" as const } : channelsOff ? { suppressed: "channels_off" as const } : {}),
      };
      if (!cooling && !channelsOff) {
        alert.notifyResult = await notifyFor(rule, alert);
        alert.notified = true;
        await kv.set(notifiedKey(key), now, { ex: Math.max(60, rule.cooldownMinutes * 60) });
        sum.notified++;
      } else {
        sum.suppressed++;
      }
      await saveAlert(alert);
      await kv.set(openKey(key), alert.id);
      await kv.lpush(ORDER, alert.id);
      await kv.ltrim(ORDER, 0, ORDER_CAP - 1);
      sum.opened++;
    }
    for (const a of active) {
      if (a.ruleId === rule.id && !firingSubjects.has(a.subject)) {
        await resolveAlert(a.id, "system", "Condition cleared");
        sum.autoResolved++;
      }
    }
  }
  return sum;
}

async function notifyFor(rule: AlertRule, alert: OpsAlert): Promise<NotifyResult> {
  return notifyOps({ title: `NeoConference ops: ${alert.title}`, body: alert.message, url: "/admin/ops/alerts" }, { email: rule.email, inApp: rule.inApp });
}

/* ------------------------- alerts raised by others ------------------------ */

const RAISED_COOLDOWN_MIN = 360;

/**
 * An alert raised directly by another part of the platform (an automation
 * rule that keeps failing), rather than found by an alert rule. One open
 * alert per source and subject: raising it again while it is open only
 * updates it. Notifies the owner and ops admins, at most once per
 * RAISED_COOLDOWN_MIN for the same source and subject.
 */
export async function raiseAlert(a: { source: string; subject: string; title: string; message: string; url: string }, now = Date.now()): Promise<OpsAlert> {
  const key = `${a.source}:${a.subject}`;
  const openId = await kv.get(openKey(key));
  const existing = openId ? await getAlert(String(openId)) : null;
  if (existing && existing.status !== "resolved") {
    const next: OpsAlert = { ...existing, lastSeenAt: now, occurrences: existing.occurrences + 1, title: a.title, message: a.message };
    await saveAlert(next);
    return next;
  }
  const lastNotified = Number((await kv.get(notifiedKey(key))) ?? 0);
  const cooling = lastNotified > 0 && now - lastNotified < RAISED_COOLDOWN_MIN * MIN;
  const alert: OpsAlert = {
    id: newId("alert"),
    ruleId: a.source,
    kind: "job_failures",
    subject: a.subject,
    title: a.title,
    message: a.message,
    status: "open",
    openedAt: now,
    lastSeenAt: now,
    occurrences: 1,
    notified: false,
    ...(cooling ? { suppressed: "cooldown" as const } : {}),
  };
  if (!cooling) {
    alert.notifyResult = await notifyOps({ title: `NeoConference ops: ${a.title}`, body: a.message, url: a.url });
    alert.notified = true;
    await kv.set(notifiedKey(key), now, { ex: RAISED_COOLDOWN_MIN * 60 });
  }
  await saveAlert(alert);
  await kv.set(openKey(key), alert.id);
  await kv.lpush(ORDER, alert.id);
  await kv.ltrim(ORDER, 0, ORDER_CAP - 1);
  return alert;
}

/** Resolve the open alert raiseAlert() made for this source and subject, if there is one. */
export async function resolveAlertFor(source: string, subject: string, by: string, resolution?: string): Promise<OpsAlert | null> {
  const id = await kv.get(openKey(`${source}:${subject}`));
  return id ? resolveAlert(String(id), by, resolution) : null;
}
