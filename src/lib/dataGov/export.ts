// src/lib/dataGov/export.ts
//
// "Download my data": everything the app holds about one person, as JSON and
// CSV inside a ZIP, stored in R2 and handed out through a short-lived signed
// link. Only the person's own data — never other people's: meetings they own
// are exported without the guests, their chat messages without the replies
// of others, their groups without the other members. What each section
// covers and leaves out is in src/lib/dataMap.ts.
//
// Built in steps so no single request runs long (Vercel's time limit):
//
//   startExport()    creates the record; nothing is read yet
//   advanceExport()  runs sections until its time budget is spent, keeping
//                    each section's output in KV; the last call zips them,
//                    uploads the ZIP and marks the export ready
//
// The browser (or the admin page) calls advance until status is "ready".
//
//   neo:data:export:<id>               ExportJob JSON (7 days)
//   neo:data:export:<id>:part:<name>   one section's output (1 day)
//   neo:data:exports:<uid>             list of export ids, newest first (7 days)
//   R2 data-exports/<uid>/<id>.zip     the file (7 days; purged by erase and the exports sweep)

import { randomBytes } from "node:crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { isR2Configured, putObject, signGetUrl } from "@/lib/r2";
import { eventStore } from "@/lib/eventStore";
import { listGroupsForUser } from "@/lib/groupStore";
import { listUserPayments } from "@/lib/paymentsStore";
import { getActiveSessions } from "@/lib/sessionStore";
import { listDevices } from "@/lib/pushStore";
import { listFcmDevices } from "@/lib/fcmStore";
import { userPrefix } from "@/lib/eventRecordings";
import { getDeletion, getSuspension, listSupportSessions, type ClerkUserish } from "@/lib/admin/users";
import { buildZip, toCsv, type ZipEntry } from "@/lib/dataGov/zip";
import { fromB64Url, listPrefix, parseJson, scanKeys } from "@/lib/dataGov/util";
import { DATA_MAP } from "@/lib/dataMap";
import { runJob } from "@/lib/ops/jobs";
import { getHistory, getSubscription } from "@/lib/billing/subscriptions";
import { financeRecordsForUser } from "@/lib/finance/governance";
import { listMessages, listTickets, ticketsForAccount } from "@/lib/support/tickets";
import { listUserActivity } from "@/lib/activity";
import { getPrefs } from "@/lib/comms/prefs";

export const EXPORT_TTL_S = 7 * 24 * 60 * 60;
const PART_TTL_S = 24 * 60 * 60;
export const DOWNLOAD_LINK_S = 5 * 60;
export const EXPORTS_PER_DAY = 3;

const jobKey = (id: string) => `neo:data:export:${id}`;
const partKey = (id: string, name: string) => `neo:data:export:${id}:part:${name}`;
const listKey = (uid: string) => `neo:data:exports:${uid}`;
export const exportR2Key = (uid: string, id: string) => `data-exports/${uid}/${id}.zip`;
export const EXPORT_R2_PREFIX = "data-exports/";

export interface ExportJob {
  id: string;
  userId: string;
  /** "self", or the administrator's user id. */
  by: string;
  createdAt: number;
  status: "running" | "ready" | "failed";
  done: string[];
  counts: Record<string, number>;
  error?: string;
  readyAt?: number;
  r2Key?: string;
  size?: number;
}

/** One section: rows for the CSV, and/or a JSON value. `count` is what the manifest reports. */
interface SectionOut {
  json: unknown;
  csv?: Record<string, unknown>[];
  count: number;
}

type Section = { name: string; label: string; run: (uid: string) => Promise<SectionOut> };

const iso = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : ms ?? null);

async function clerkUser(uid: string): Promise<ClerkUserish & Record<string, unknown>> {
  const client = await clerkClient();
  return (await client.users.getUser(uid)) as unknown as ClerkUserish & Record<string, unknown>;
}

/** Identifiers that are this person: id, every email address, KingsChat handle. */
export async function identitiesOf(uid: string): Promise<{ uid: string; emails: string[]; names: string[]; kcHandle: string | null }> {
  const u = await clerkUser(uid);
  const emails = (u.emailAddresses ?? []).map((e) => e.emailAddress.trim().toLowerCase()).filter(Boolean);
  const meta = (u.publicMetadata ?? {}) as Record<string, unknown>;
  const kc = (meta.kingschat ?? null) as { username?: string } | null;
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return {
    uid,
    emails,
    names: [name, u.username ?? ""].filter((x): x is string => !!x && x.length > 1),
    kcHandle: kc?.username ? String(kc.username).toLowerCase() : null,
  };
}

const SECTIONS: Section[] = [
  {
    name: "profile",
    label: "Your account",
    run: async (uid) => {
      const u = await clerkUser(uid);
      const meta = (u.publicMetadata ?? {}) as Record<string, unknown>;
      const profile = {
        userId: u.id,
        firstName: u.firstName ?? null,
        lastName: u.lastName ?? null,
        username: u.username ?? null,
        imageUrl: u.imageUrl ?? null,
        emailAddresses: (u.emailAddresses ?? []).map((e) => ({ address: e.emailAddress, verified: e.verification?.status === "verified" })),
        createdAt: iso(u.createdAt),
        lastSignInAt: iso(u.lastSignInAt),
        plan: meta.plan ?? "free",
        planExpiresAt: iso(meta.planExpiresAt),
        meetingsCreated: meta.meetingsCreated ?? 0,
        kingschat: meta.kingschat ? { username: (meta.kingschat as Record<string, unknown>).username ?? null, linkedAt: (meta.kingschat as Record<string, unknown>).linkedAt ?? null } : null,
        neoemail: meta.neoemail ? { email: (meta.neoemail as Record<string, unknown>).email ?? null, linkedAt: (meta.neoemail as Record<string, unknown>).linkedAt ?? null } : null,
      };
      return { json: profile, count: 1 };
    },
  },
  {
    name: "meetings",
    label: "Meetings you own",
    run: async (uid) => {
      const own = await eventStore.listByOwner(uid);
      const rows = own.map((e) => {
        const x = e as unknown as Record<string, unknown>;
        return {
          id: e.id,
          slug: e.slug,
          name: e.name,
          description: e.description ?? null,
          visibility: e.visibility,
          createdAt: e.createdAt ?? null,
          scheduledAt: x.scheduledAt ?? null,
          startedAt: x.startedAt ?? null,
          endedAt: x.endedAt ?? null,
          state: x.state ?? null,
          groupId: x.groupId ?? null,
          waitingRoomEnabled: e.waitingRoomEnabled,
          // Guests, role holders, waiting room and ticket buyers are other people: counts only.
          roleAssignments: Array.isArray(x.roles) ? (x.roles as unknown[]).length : 0,
          transcripts: Array.isArray(x.recordings) ? (x.recordings as { kind?: string }[]).filter((r) => r.kind === "transcript").length : 0,
        };
      });
      const personal = await kv.get(`neo:personal-room:${uid}`);
      const apiIds = ((await kv.smembers(`meetings:user:${uid}`)) ?? []) as string[];
      const api = (await Promise.all(apiIds.map((id) => kv.get(`meeting:${id}`)))).map((m) => parseJson<Record<string, unknown>>(m)).filter(Boolean);
      const recurring = Object.keys(((await kv.hgetall(`neo:owner:${uid}:recurring`)) ?? {}) as Record<string, unknown>).length;
      return {
        json: { meetings: rows, personalRoomId: personal ?? null, apiMeetings: api, recurringRoleEntries: recurring },
        csv: rows,
        count: rows.length + api.length,
      };
    },
  },
  {
    name: "attendance",
    label: "Meetings you joined",
    run: async (uid) => {
      const invited = (await kv.zrange(`neo:user:${uid}:meetings`, 0, -1, { withScores: true })) as unknown[];
      const meetings: { eventId: string; start: unknown }[] = [];
      for (let i = 0; i + 1 < invited.length; i += 2) meetings.push({ eventId: String(invited[i]), start: iso(Number(invited[i + 1])) });
      const rows: Record<string, unknown>[] = [];
      for (const key of await scanKeys("neo:attendance:*:events")) {
        const eventId = key.slice("neo:attendance:".length, -":events".length);
        for (const raw of ((await kv.lrange(key, 0, -1)) ?? []) as unknown[]) {
          const e = parseJson<Record<string, unknown>>(raw);
          if (!e || e.userId !== uid) continue;
          rows.push({ eventId, at: iso(e.ts), action: e.action, role: e.role ?? null, source: e.source ?? null, nameShown: e.name ?? null });
        }
      }
      rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return { json: { invitedOrJoined: meetings, attendance: rows }, csv: rows, count: rows.length };
    },
  },
  {
    name: "chat",
    label: "Meeting chat you wrote",
    run: async (uid) => {
      const rows: Record<string, unknown>[] = [];
      for (const key of await scanKeys("neo:chat:*")) {
        const list = parseJson<Record<string, unknown>[]>(await kv.get(key)) ?? [];
        for (const m of Array.isArray(list) ? list : []) {
          if (m.userId !== uid) continue;
          rows.push({
            eventId: key.slice("neo:chat:".length),
            at: m.ts,
            text: m.text,
            directMessage: !!m.toUserId,
            attachments: Array.isArray(m.attachments) ? (m.attachments as { name?: string }[]).map((a) => a.name).join("; ") : "",
          });
        }
      }
      return { json: rows, csv: rows, count: rows.length };
    },
  },
  {
    name: "groups",
    label: "Your groups",
    run: async (uid) => {
      const groups = await listGroupsForUser(uid);
      const memberships = groups.map((s) => ({ groupId: s.group.id, name: s.group.name, role: s.role, members: s.memberCount, createdAt: s.group.createdAt ?? null }));
      const messages: Record<string, unknown>[] = [];
      for (const key of await scanKeys("neo:group:*:msgs")) {
        const gid = key.slice("neo:group:".length, -":msgs".length);
        for (const raw of ((await kv.lrange(key, 0, -1)) ?? []) as unknown[]) {
          const m = parseJson<Record<string, unknown>>(raw);
          if (!m || m.userId !== uid || m.deleted) continue;
          messages.push({ groupId: gid, at: m.ts ?? m.createdAt ?? null, text: m.text, attachments: Array.isArray(m.attachments) ? (m.attachments as { name?: string }[]).map((a) => a.name).join("; ") : "" });
        }
      }
      return { json: { memberships, messages }, csv: memberships, count: memberships.length + messages.length };
    },
  },
  {
    name: "notifications",
    label: "Notifications",
    run: async (uid) => {
      const raw = ((await kv.lrange(`neo:notif:${uid}`, 0, -1)) ?? []) as unknown[];
      const rows = raw
        .map((r) => parseJson<Record<string, unknown>>(r))
        .filter((n): n is Record<string, unknown> => !!n)
        .map((n) => ({ at: iso(n.ts), type: n.type, title: n.title, body: n.body, url: n.url, read: !!n.read }));
      const preferences = await getPrefs(uid);
      return { json: { notifications: rows, preferences }, csv: rows, count: rows.length };
    },
  },
  {
    name: "devices",
    label: "Signed-in devices and alert devices",
    run: async (uid) => {
      const sessions = (await getActiveSessions(uid)).map((s) => ({ userAgent: s.userAgent, ip: s.ip, createdAt: iso(s.createdAt), lastActivityAt: iso(s.lastActivityAt) }));
      // Endpoints, keys and tokens are credentials: never exported.
      const push = [...(await listDevices(uid)).values()].map((d) => ({ kind: "browser", userAgent: d.userAgent, createdAt: iso(d.createdAt), lastOkAt: iso(d.lastOkAt) }));
      const fcm = [...(await listFcmDevices(uid)).values()].map((d) => ({ kind: "android", createdAt: iso(d.createdAt), lastOkAt: iso(d.lastOkAt) }));
      return { json: { sessions, alertDevices: [...push, ...fcm] }, csv: sessions, count: sessions.length + push.length + fcm.length };
    },
  },
  {
    name: "payments",
    label: "Payments",
    run: async (uid) => {
      const rows = (await listUserPayments(uid, 500)).map((p) => ({
        paymentRef: p.paymentRef,
        plan: p.plan,
        billingCycle: p.billingCycle,
        amountEsp: p.amountEsp,
        status: p.status,
        paidAt: iso(p.paidAt),
        periodStart: iso(p.periodStart),
        periodEnd: iso(p.periodEnd),
        invoiceNumber: p.invoiceNumber ?? null,
      }));
      return { json: rows, csv: rows, count: rows.length };
    },
  },
  {
    name: "subscription",
    label: "Subscription and its history",
    run: async (uid) => {
      const sub = await getSubscription(uid);
      // Who changed it: "you" or "an administrator" — not which one.
      const history = (await getHistory(uid, 200)).map((h) => ({
        at: iso(h.ts),
        action: h.action,
        by: h.by.userId === uid ? "you" : "an administrator",
        summary: h.summary,
        before: h.before,
        after: h.after,
      }));
      const current = sub
        ? {
            planId: sub.planId,
            plan: sub.snapshot?.name ?? sub.baseTier,
            status: sub.status,
            cycle: sub.cycle,
            periodStart: iso(sub.periodStart),
            periodEnd: iso(sub.periodEnd),
          }
        : null;
      return {
        json: { current, history },
        csv: history.map((h) => ({ at: h.at, action: h.action, by: h.by, summary: h.summary })),
        count: (current ? 1 : 0) + history.length,
      };
    },
  },
  {
    name: "billing",
    label: "Ticket purchases, invoices and payment reminders",
    run: async (uid) => {
      const f = await financeRecordsForUser(uid);
      const rows = f.payments.map((p) => ({ ...p }));
      return { json: f, csv: rows as Record<string, unknown>[], count: f.payments.length + f.invoices.length + f.checkouts.length + f.reminders.length };
    },
  },
  {
    name: "support-tickets",
    label: "Support tickets",
    run: async (uid) => {
      const u = await clerkUser(uid);
      const emails = (u.emailAddresses ?? []).map((e) => e.emailAddress.trim().toLowerCase());
      const tickets = ticketsForAccount(await listTickets(), uid, emails);
      const out = [];
      for (const t of tickets) {
        // The conversation, without support's internal notes or the agents' names.
        const messages = (await listMessages(t.id)).map((m) => ({
          at: iso(m.ts),
          from: m.author === "user" ? "you" : m.author === "agent" ? "NeoConference support" : "system",
          body: m.body,
          attachments: m.attachments.map((a) => a.name).join("; "),
        }));
        out.push({ number: t.number, subject: t.subject, category: t.category, status: t.status, createdAt: iso(t.createdAt), messages });
      }
      return {
        json: out,
        csv: out.map(({ messages, ...t }) => ({ ...t, messages: messages.length })),
        count: out.length,
      };
    },
  },
  {
    name: "activity",
    label: "Your activity log",
    run: async (uid) => {
      const rows = (await listUserActivity(uid, { limit: 500 })).map((e) => {
        const x = e as unknown as Record<string, unknown>;
        return { at: iso(x.ts as number), type: x.type, props: x.props ?? null };
      });
      return { json: rows, csv: rows, count: rows.length };
    },
  },
  {
    name: "api-keys",
    label: "Developer API keys",
    run: async (uid) => {
      const ids = ((await kv.smembers(`apikeys:user:${uid}`)) ?? []) as string[];
      const rows: Record<string, unknown>[] = [];
      for (const id of ids) {
        const m = parseJson<Record<string, unknown>>(await kv.get(`apikey:meta:${id}`));
        if (!m) continue;
        // Never the hash, never the masked key: name, plan, dates and status only.
        rows.push({ id, name: m.name ?? null, plan: m.plan ?? null, createdAt: iso(m.createdAt), lastUsedAt: iso(m.lastUsedAt), revoked: !!m.revoked });
      }
      return { json: rows, csv: rows, count: rows.length };
    },
  },
  {
    name: "recordings",
    label: "Recordings, uploads and transcripts",
    run: async (uid) => {
      const prefix = userPrefix(uid);
      const files = [...(await listPrefix(prefix)), ...(await listPrefix(`chat/${uid}/`))].map((o) => ({
        file: o.key.split("/").pop(),
        path: o.key,
        kind: o.key.startsWith("chat/") ? "chat upload" : "recording",
        size: o.size,
        lastModified: o.lastModified ?? null,
        downloadIn: o.key.startsWith("chat/") ? "the meeting chat" : "/dashboard/recordings",
      }));
      const transcripts: Record<string, unknown>[] = [];
      for (const key of await scanKeys("neo:transcribe:key:*")) {
        const recordingKey = fromB64Url(key.slice("neo:transcribe:key:".length));
        if (!recordingKey.startsWith(prefix)) continue;
        const jobId = String((await kv.get(key)) ?? "");
        const job = parseJson<Record<string, unknown>>(await kv.get(`neo:transcribe:${jobId}`));
        if (!job) continue;
        // The text is everyone's words: listed with where to read it, not copied.
        transcripts.push({ jobId, recording: recordingKey, status: job.status ?? null, createdAt: job.createdAt ?? null, readIn: "/dashboard/recordings" });
      }
      const usage = ((await kv.hgetall(`neo:rec-usage:${uid}`)) ?? {}) as Record<string, unknown>;
      return { json: { files, transcripts, recordingSecondsByMonth: usage }, csv: files, count: files.length + transcripts.length };
    },
  },
  {
    name: "account-history",
    label: "Account administration",
    run: async (uid) => {
      const suspension = await getSuspension(uid);
      const deletion = await getDeletion(uid);
      // Support sessions: when and why — not which administrator.
      const support = (await listSupportSessions(uid, 50)).map((s) => ({ startedAt: iso(s.startedAt), endedAt: iso(s.endedAt), reason: s.reason }));
      return {
        json: {
          suspension: suspension ? { at: iso(suspension.at), reason: suspension.reason } : null,
          deletionRequest: deletion ? { requestedAt: iso(deletion.requestedAt), deleteAfter: iso(deletion.deleteAfter), reason: deletion.reason } : null,
          supportSessions: support,
        },
        count: support.length + (suspension ? 1 : 0) + (deletion ? 1 : 0),
      };
    },
  },
];

export const EXPORT_SECTIONS = SECTIONS.map((s) => ({ name: s.name, label: s.label }));

function parseJob(raw: unknown): ExportJob | null {
  return parseJson<ExportJob>(raw);
}

export async function getExport(id: string): Promise<ExportJob | null> {
  if (!/^exp_[A-Za-z0-9]+$/.test(id)) return null;
  return parseJob(await kv.get(jobKey(id)));
}

async function saveJob(job: ExportJob): Promise<void> {
  await kv.set(jobKey(job.id), JSON.stringify(job), { ex: EXPORT_TTL_S });
}

export async function listExports(uid: string): Promise<ExportJob[]> {
  const ids = ((await kv.lrange(listKey(uid), 0, 19)) ?? []) as unknown[];
  const jobs = await Promise.all(ids.map((id) => getExport(String(id))));
  return jobs.filter((j): j is ExportJob => !!j);
}

export type StartRefusal = "r2_not_configured" | "already_running" | "daily_limit";

export async function startExport(uid: string, by: string, now = Date.now()): Promise<{ job: ExportJob } | { refused: StartRefusal }> {
  if (!isR2Configured()) return { refused: "r2_not_configured" };
  const recent = await listExports(uid);
  const running = recent.find((j) => j.status === "running" && now - j.createdAt < 60 * 60 * 1000);
  if (running) return { refused: "already_running" };
  if (by === "self" && recent.filter((j) => j.by === "self" && now - j.createdAt < 24 * 60 * 60 * 1000).length >= EXPORTS_PER_DAY) {
    return { refused: "daily_limit" };
  }
  const job: ExportJob = {
    id: `exp_${now.toString(36)}${randomBytes(6).toString("hex")}`,
    userId: uid,
    by,
    createdAt: now,
    status: "running",
    done: [],
    counts: {},
  };
  await saveJob(job);
  await kv.lpush(listKey(uid), job.id);
  await kv.ltrim(listKey(uid), 0, 19);
  await kv.expire(listKey(uid), EXPORT_TTL_S);
  return { job };
}

const README = (job: ExportJob, sections: string[]) =>
  [
    "NeoConference — your data",
    "",
    `Account: ${job.userId}`,
    `Prepared: ${new Date(job.readyAt ?? Date.now()).toISOString()}`,
    "",
    "Each section is a JSON file (everything) and, where it is a list, a CSV file (opens in a spreadsheet).",
    "",
    ...sections.map((s) => `  ${s}`),
    "",
    "Not included, on purpose:",
    "  - other people's details (guests and role holders of your meetings, other members of your groups, other people's messages);",
    "  - secrets: API key values, push and app tokens, KingsChat sign-in tokens;",
    "  - recording and file contents: they are listed with where to download them in the app;",
    "  - administrators' internal notes about your account.",
    "",
    "manifest.json lists every place NeoConference keeps data about people and what happens to it when an account is deleted.",
  ].join("\n");

/** The job runner's name for export steps (src/lib/ops/jobs.ts): one step at a time, each recorded. */
export const EXPORT_JOB = "data-export";

/**
 * Run sections until `budgetMs` is spent, as a step of the "data-export" job
 * (locked and recorded by the operations job runner). Returns the job as it
 * stands; while another export's step holds the lock, unchanged — call again.
 * Safe to call again after a failure or timeout: finished sections are kept.
 */
export async function advanceExport(id: string, budgetMs = 8_000): Promise<ExportJob | null> {
  const job = await getExport(id);
  if (!job || job.status !== "running") return job;
  let out: ExportJob | null = job;
  const r = await runJob(
    EXPORT_JOB,
    async () => {
      out = await advanceExportNow(id, budgetMs);
      return { ok: out?.status !== "failed", summary: `${id}: ${out?.status} (${out?.done.length ?? 0}/${SECTIONS.length} sections)`, error: out?.error };
    },
    // A step runs for seconds; a step killed mid-way frees the lock within a minute.
    { trigger: "manual", actor: job.by === "self" ? "account holder" : job.by, lockMs: 60_000 },
  );
  return r.status === "locked" ? job : out;
}

async function advanceExportNow(id: string, budgetMs: number): Promise<ExportJob | null> {
  const job = await getExport(id);
  if (!job || job.status !== "running") return job;
  const started = Date.now();
  try {
    for (const s of SECTIONS) {
      if (job.done.includes(s.name)) continue;
      if (job.done.length && Date.now() - started > budgetMs) {
        await saveJob(job);
        return job;
      }
      const out = await s.run(job.userId);
      await kv.set(partKey(id, s.name), JSON.stringify(out), { ex: PART_TTL_S });
      job.done.push(s.name);
      job.counts[s.name] = out.count;
    }
    // Everything read: build the file.
    job.readyAt = Date.now();
    const entries: ZipEntry[] = [];
    const listed: string[] = [];
    for (const s of SECTIONS) {
      const out = parseJson<SectionOut>(await kv.get(partKey(id, s.name)));
      if (!out) throw new Error(`section ${s.name} went missing`);
      entries.push({ name: `${s.name}.json`, data: JSON.stringify(out.json, null, 2) });
      if (out.csv?.length) entries.push({ name: `${s.name}.csv`, data: toCsv(out.csv) });
      listed.push(`${s.name}.json${out.csv?.length ? ` / ${s.name}.csv` : ""} — ${s.label} (${out.count})`);
    }
    const manifest = {
      format: "neoconference-export/1",
      exportId: job.id,
      userId: job.userId,
      preparedAt: new Date(job.readyAt).toISOString(),
      sections: SECTIONS.map((s) => ({ name: s.name, label: s.label, records: job.counts[s.name] ?? 0 })),
      dataMap: DATA_MAP.map((d) => ({ id: d.id, where: d.pattern, holds: d.holds, exported: d.exported, onDelete: d.onDelete, why: d.why })),
    };
    entries.unshift({ name: "README.txt", data: README(job, listed) }, { name: "manifest.json", data: JSON.stringify(manifest, null, 2) });
    const zip = buildZip(entries, new Date(job.readyAt));
    const r2Key = exportR2Key(job.userId, job.id);
    await putObject(r2Key, zip, "application/zip");
    job.r2Key = r2Key;
    job.size = zip.length;
    job.status = "ready";
    await saveJob(job);
    for (const s of SECTIONS) await kv.del(partKey(id, s.name));
    return job;
  } catch (err) {
    console.error("[data-export] failed", id, err);
    job.status = "failed";
    job.error = err instanceof Error ? err.message.slice(0, 300) : "failed";
    await saveJob(job);
    return job;
  }
}

/** A signed link, valid DOWNLOAD_LINK_S seconds. */
export async function downloadLink(job: ExportJob): Promise<string | null> {
  if (job.status !== "ready" || !job.r2Key) return null;
  return signGetUrl(job.r2Key, DOWNLOAD_LINK_S);
}

/** What the browser may see of an export. */
export function publicExport(job: ExportJob) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    readyAt: job.readyAt ?? null,
    expiresAt: job.createdAt + EXPORT_TTL_S * 1000,
    size: job.size ?? null,
    progress: { done: job.done.length, total: SECTIONS.length },
    counts: job.counts,
    error: job.error ?? null,
    by: job.by === "self" ? "you" : "an administrator",
  };
}

/** Remove an account's exports: records, parts and files. Used by erase. */
export async function forgetExports(uid: string, deleteR2: (prefix: string) => Promise<{ objects: number }>): Promise<number> {
  const ids = ((await kv.lrange(listKey(uid), 0, -1)) ?? []) as unknown[];
  for (const id of ids) {
    await kv.del(jobKey(String(id)));
    for (const s of SECTIONS) await kv.del(partKey(String(id), s.name));
  }
  await kv.del(listKey(uid));
  const r2 = await deleteR2(`${EXPORT_R2_PREFIX}${uid}/`);
  return ids.length + r2.objects;
}
