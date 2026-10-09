// src/lib/dataGov/erase.ts
//
// Completing an account deletion: every location in src/lib/dataMap.ts
// marked delete or anonymise, in order, with a count for each, then the
// Clerk user last. Every step can run "dry" — it counts what it would touch
// and changes nothing — which is the preview an administrator sees before
// completing a deletion.
//
// Refused, before anything runs, for:
//   - the platform owner (isOwnerEmailList on the Clerk account, here, not
//     only in the routes);
//   - an account under legal hold;
//   - an account that owns a group other people are in (hand it over first).
//
// The result is a deletion certificate: what was removed (counts per data
// map location), when, by whom — and no personal data. It goes into the
// admin audit trail and the closed-requests log. The account id is added to
// neo:data:erased so a later backup restore can tell it must not return.

import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "@/lib/kv";
import { eventStore } from "@/lib/eventStore";
import { cancelMeetingJobs } from "@/lib/scheduler";
import { adminRemoveMember, deleteGroup, listGroupsForUser, pendingKeyFor } from "@/lib/groupStore";
import { logout } from "@/lib/sessionStore";
import { userPrefix } from "@/lib/eventRecordings";
import { isOwnerEmailList } from "@/lib/admin/owner";
import { forgetUser, type ClerkUserish } from "@/lib/admin/users";
import { getMember, saveMember } from "@/lib/admin/store";
import { getHold } from "@/lib/dataGov/requests";
import { identitiesOf, forgetExports } from "@/lib/dataGov/export";
import { listTrash, purgeTrashItem, TRASH_PREFIX } from "@/lib/dataGov/trash";
import { forgetSubscriptionUser, getHistory, getSubscription } from "@/lib/billing/subscriptions";
import { anonymiseFinanceForUser, financeRecordsForUser } from "@/lib/finance/governance";
import { anonymiseTicketsForAccount, listTickets, ticketsForAccount } from "@/lib/support/tickets";
import { forgetCommsUser } from "@/lib/comms/forget";
import { forgetUserActivity } from "@/lib/activity";
import { DELETED_NAME, deletePrefix, fromB64Url, listPrefix, parseJson, rewriteList, rewriteValue, scanKeys } from "@/lib/dataGov/util";

export interface Person {
  uid: string;
  emails: string[];
  names: string[];
  kcHandle: string | null;
  /** Stands in for the id where a kept record needs one. Same person, same pseudonym; resolves to no one. */
  pseudonym: string;
}

export function pseudonymFor(uid: string): string {
  const s = process.env.ADMIN_MFA_KEY || process.env.CLERK_SECRET_KEY || "neo";
  const key = Buffer.from(hkdfSync("sha256", s, "neo-data", "erasure-pseudonym", 32));
  return "erased_" + createHmac("sha256", key).update(uid).digest("hex").slice(0, 16);
}

/** Field names and identifiers that mean this person (ids, lowercased emails, KingsChat). */
function identSet(p: Person): Set<string> {
  const s = new Set<string>([p.uid, ...p.emails]);
  if (p.kcHandle) {
    s.add(`kc:${p.kcHandle}`);
    s.add(p.kcHandle);
  }
  return s;
}

const matchesId = (p: Person, v: unknown) => typeof v === "string" && (v === p.uid || identSet(p).has(v.trim().toLowerCase()));

/** Replace the person's names, emails and handle in free text. */
function scrub(p: Person, text: string): string {
  let out = text;
  for (const term of [...p.names, ...p.emails, ...(p.kcHandle ? [`@${p.kcHandle}`, p.kcHandle] : [])]) {
    if (!term || term.length < 2) continue;
    out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), DELETED_NAME);
  }
  return out;
}

/** A reply to one of the person's messages (by id), or quoting one of their names. */
function repliesTo(p: Person, m: Record<string, unknown>, mine: Set<string>): boolean {
  const r = m.replyTo as { id?: string; name?: string } | undefined;
  return !!r && (mine.has(String(r.id)) || p.names.includes(String(r.name ?? "")));
}

async function delKeys(keys: string[], dry: boolean): Promise<number> {
  let n = 0;
  for (const k of keys) {
    if (Number(await kv.exists(k)) > 0) {
      n++;
      if (!dry) await kv.del(k);
    }
  }
  return n;
}

/** Remove fields from a hash; returns how many were there. */
async function hdelFields(key: string, wanted: (field: string) => boolean, dry: boolean): Promise<number> {
  const all = ((await kv.hgetall(key)) ?? {}) as Record<string, unknown>;
  const fields = Object.keys(all).filter(wanted);
  if (fields.length && !dry) await kv.hdel(key, ...fields);
  return fields.length;
}

export interface EraseStep {
  id: string;
  label: string;
  /** Data map ids it covers. */
  covers: string[];
  run: (p: Person, dry: boolean) => Promise<number>;
}

/** A meeting's own keys (the delete in eventStore leaves most of these). */
function eventSubkeys(id: string, slug: string): string[] {
  return [
    `neo:chat:${id}`,
    `neo:attendance:${id}:events`,
    `neo:event:${id}:calls`,
    `neo:event:${id}:invited`,
    `neo:report:${id}`,
    `neo:meeting:${id}:hidden-videos`,
    `neo:timer:${id}`,
    `neo:breakouts:${slug}`,
    `neo:invites:${id}`,
  ];
}

async function ownedEvents(uid: string) {
  const byIndex = await eventStore.listByOwner(uid);
  // A meeting moved between owners can be missing from the index: check every one.
  const all = await eventStore.listAll();
  const map = new Map(byIndex.map((e) => [e.id, e]));
  for (const e of all) if (e.ownerUserId === uid) map.set(e.id, e);
  return [...map.values()];
}

export const ERASE_STEPS: EraseStep[] = [
  {
    id: "groups",
    label: "Group memberships, groups owned alone, pending invitations",
    covers: ["kv.groups.membership", "kv.groups.owned", "kv.groups.pending", "r2.groupUploads"],
    run: async (p, dry) => {
      let n = 0;
      for (const s of await listGroupsForUser(p.uid)) {
        n++;
        if (dry) continue;
        if (s.role === "owner") {
          // Only reached when nobody else is in it (erasureBlockers refuses otherwise).
          await deleteGroup(s.group.id);
          await kv.del(`neo:group:${s.group.id}:meetings`);
          await deletePrefix(`groups/${s.group.id}/`);
        } else {
          await adminRemoveMember(s.group.id, p.uid, "system");
        }
      }
      const pendingKeys = [
        ...p.emails.map((e) => pendingKeyFor("email", e)),
        ...(p.kcHandle ? [pendingKeyFor("kc", p.kcHandle)] : []),
      ].filter((k): k is string => !!k);
      for (const key of pendingKeys) {
        const gids = ((await kv.smembers(`neo:pending-member:${key}`)) ?? []) as string[];
        n += gids.length;
        if (dry) continue;
        for (const gid of gids) await kv.hdel(`neo:group:${gid}:pending`, key);
        await kv.del(`neo:pending-member:${key}`);
      }
      n += await delKeys([`neo:user:${p.uid}:groups`], dry);
      return n;
    },
  },
  {
    id: "ownedEvents",
    label: "Meetings owned, with their chat, attendance, reports, roles and invitations",
    covers: ["kv.event.owned", "kv.event.subkeys", "kv.event.ownerIndex"],
    run: async (p, dry) => {
      const events = await ownedEvents(p.uid);
      if (!dry) {
        for (const e of events) {
          const invites = (parseJson<{ token?: string }[]>(await kv.get(`neo:invites:${e.id}`)) ?? []) as unknown[];
          const tokens = invites.map((t) => (typeof t === "string" ? t : (t as { token?: string })?.token)).filter((t): t is string => !!t);
          await kv.del(...eventSubkeys(e.id, e.slug), ...tokens.map((t) => `neo:invite:${t}`));
          await cancelMeetingJobs(e.id);
          await eventStore.delete(e.id);
        }
      }
      return events.length + (await delKeys([`neo:owner:${p.uid}`, `neo:personal-room:${p.uid}`, `neo:owner:${p.uid}:recurring`], dry));
    },
  },
  {
    id: "othersEvents",
    label: "Entries in other people's meetings (roles, waiting room, ticket buyers)",
    covers: ["kv.event.others"],
    run: async (p, dry) => {
      let n = 0;
      for (const e of await eventStore.listAll()) {
        if (e.ownerUserId === p.uid) continue;
        const x = e as unknown as Record<string, unknown>;
        const roles = Array.isArray(x.roles) ? (x.roles as { identifier?: string }[]) : [];
        const wr = Array.isArray(x.waitingRoom) ? (x.waitingRoom as { id?: string; email?: string }[]) : [];
        const red = Array.isArray(x.recentRedemptions) ? (x.recentRedemptions as { identifier?: string }[]) : [];
        const keepRoles = roles.filter((r) => !matchesId(p, r.identifier));
        const keepWr = wr.filter((w) => w.id !== p.uid && !matchesId(p, w.email));
        const keepRed = red.filter((r) => !matchesId(p, r.identifier));
        const removed = roles.length - keepRoles.length + wr.length - keepWr.length + red.length - keepRed.length;
        if (!removed) continue;
        n += removed;
        if (!dry) {
          await eventStore.update(e.id, (prev) => ({
            ...prev,
            ...(Array.isArray(x.roles) ? { roles: keepRoles } : {}),
            ...(Array.isArray(x.waitingRoom) ? { waitingRoom: keepWr } : {}),
            ...(Array.isArray(x.recentRedemptions) ? { recentRedemptions: keepRed } : {}),
          }) as typeof prev);
        }
      }
      return n;
    },
  },
  {
    id: "fieldsInOthers",
    label: "Roles, invitations, ringing, hidden videos and breakouts in others' meetings",
    covers: ["kv.meetingRoles", "kv.recurringRoles", "kv.callsInvited"],
    run: async (p, dry) => {
      let n = 0;
      const mine = (f: string) => matchesId(p, f);
      for (const k of await scanKeys("neo:meeting:*:roles")) n += await hdelFields(k, mine, dry);
      for (const k of await scanKeys("neo:owner:*:recurring")) if (k !== `neo:owner:${p.uid}:recurring`) n += await hdelFields(k, mine, dry);
      for (const k of await scanKeys("neo:event:*:calls")) n += await hdelFields(k, (f) => f === p.uid, dry);
      for (const k of await scanKeys("neo:event:*:invited")) n += await hdelFields(k, mine, dry);
      for (const k of await scanKeys("neo:meeting:*:hidden-videos")) n += await hdelFields(k, (f) => f === p.uid, dry);
      for (const k of await scanKeys("neo:breakouts:*")) {
        const b = parseJson<{ assignments?: Record<string, unknown> }>(await kv.get(k));
        if (!b?.assignments || !(p.uid in b.assignments)) continue;
        n++;
        if (!dry) {
          const { [p.uid]: _gone, ...rest } = b.assignments;
          void _gone;
          await rewriteValue(k, { ...b, assignments: rest });
        }
      }
      return n;
    },
  },
  {
    id: "meetingChat",
    label: "Meeting chat messages (author anonymised)",
    covers: ["kv.chat"],
    run: async (p, dry) => {
      let n = 0;
      for (const k of await scanKeys("neo:chat:*")) {
        const list = parseJson<Record<string, unknown>[]>(await kv.get(k));
        if (!Array.isArray(list)) continue;
        let changed = 0;
        const mine = new Set(list.filter((m) => m.userId === p.uid).map((m) => String(m.id)));
        const next = list.map((m) => {
          const authored = m.userId === p.uid;
          const toMe = m.toUserId === p.uid;
          const repliesToMe = repliesTo(p, m, mine);
          const mentioned = Array.isArray(m.mentions) && (m.mentions as string[]).includes(p.uid);
          if (!authored && !toMe && !repliesToMe && !mentioned) return m;
          changed++;
          const out: Record<string, unknown> = { ...m };
          if (authored) {
            out.userId = null;
            out.name = DELETED_NAME;
            // Their uploads are deleted with the account (chat/<uid>/).
            delete out.attachments;
          }
          if (toMe) out.toUserId = null;
          if (repliesToMe) out.replyTo = { ...(m.replyTo as object), name: DELETED_NAME };
          if (mentioned) out.mentions = (m.mentions as string[]).filter((x) => x !== p.uid);
          return out;
        });
        n += changed;
        if (changed && !dry) await rewriteValue(k, next);
      }
      return n;
    },
  },
  {
    id: "attendance",
    label: "Attendance in others' meetings (anonymised)",
    covers: ["kv.attendance"],
    run: async (p, dry) => {
      let n = 0;
      for (const k of await scanKeys("neo:attendance:*:events")) {
        const raw = ((await kv.lrange(k, 0, -1)) ?? []) as unknown[];
        let changed = 0;
        const next = raw.map((r) => {
          const e = parseJson<Record<string, unknown>>(r);
          if (!e || !(e.userId === p.uid || matchesId(p, e.email))) return r;
          changed++;
          const { email: _e, ...rest } = e;
          void _e;
          return { ...rest, userId: p.pseudonym, name: DELETED_NAME };
        });
        n += changed;
        if (changed && !dry) await rewriteList(k, next);
      }
      return n;
    },
  },
  {
    id: "reports",
    label: "Meeting reports (the person's row anonymised)",
    covers: ["kv.reports"],
    run: async (p, dry) => {
      let n = 0;
      for (const k of await scanKeys("neo:report:*")) {
        const r = parseJson<Record<string, unknown>>(await kv.get(k));
        if (!r || !Array.isArray(r.participants)) continue;
        let changed = 0;
        // The names this report shows for the person, so hosts and firsts/lasts can be found too.
        const shown = new Set(p.names);
        const participants = (r.participants as Record<string, unknown>[]).map((x) => {
          if (!(x.userId === p.uid || matchesId(p, x.email) || matchesId(p, x.key))) return x;
          changed++;
          if (typeof x.name === "string") shown.add(x.name);
          return { ...x, key: p.pseudonym, userId: undefined, name: DELETED_NAME, email: "" };
        });
        const hosts = Array.isArray(r.hosts) ? (r.hosts as string[]).map((h) => (shown.has(h) ? (changed++, DELETED_NAME) : h)) : r.hosts;
        const summary = { ...((r.summary ?? {}) as Record<string, unknown>) };
        for (const f of ["firstToJoin", "lastToLeave"]) if (typeof summary[f] === "string" && shown.has(summary[f] as string)) summary[f] = DELETED_NAME;
        if (!changed) continue;
        n += changed;
        if (!dry) await rewriteValue(k, { ...r, participants, hosts, summary });
      }
      return n;
    },
  },
  {
    id: "groupChat",
    label: "Group chat, activity and read markers in others' groups (anonymised)",
    covers: ["kv.groups.messages", "kv.groups.activity"],
    run: async (p, dry) => {
      let n = 0;
      for (const k of await scanKeys("neo:group:*:msgs")) {
        const raw = ((await kv.lrange(k, 0, -1)) ?? []) as unknown[];
        let changed = 0;
        const mine = new Set(raw.map((r) => parseJson<Record<string, unknown>>(r)).filter((m) => m?.userId === p.uid).map((m) => String(m!.id)));
        const next = raw.map((r) => {
          const m = parseJson<Record<string, unknown>>(r);
          if (!m) return r;
          const authored = m.userId === p.uid;
          const repliesToMe = repliesTo(p, m, mine);
          const mentioned = Array.isArray(m.mentions) && (m.mentions as string[]).includes(p.uid);
          if (!authored && !repliesToMe && !mentioned) return r;
          changed++;
          const out: Record<string, unknown> = { ...m };
          if (authored) {
            out.userId = p.pseudonym;
            out.name = DELETED_NAME;
          }
          if (repliesToMe) out.replyTo = { ...(m.replyTo as object), name: DELETED_NAME };
          if (mentioned) out.mentions = (m.mentions as string[]).filter((x) => x !== p.uid);
          return out;
        });
        n += changed;
        if (changed && !dry) await rewriteList(k, next);
      }
      for (const k of await scanKeys("neo:group:*:activity")) {
        const raw = ((await kv.lrange(k, 0, -1)) ?? []) as unknown[];
        let changed = 0;
        const next = raw.map((r) => {
          const a = parseJson<Record<string, unknown>>(r);
          if (!a) return r;
          const detail = typeof a.detail === "string" ? scrub(p, a.detail) : a.detail;
          if (a.actorId !== p.uid && detail === a.detail) return r;
          changed++;
          return { ...a, actorId: a.actorId === p.uid ? p.pseudonym : a.actorId, detail };
        });
        n += changed;
        if (changed && !dry) await rewriteList(k, next);
      }
      for (const k of await scanKeys("neo:group:*:read")) n += await hdelFields(k, (f) => f === p.uid, dry);
      // Who created a group, who added each member: the pseudonym stands in.
      for (const k of await scanKeys("neo:group:*")) {
        if (/^neo:group:[^:]+$/.test(k)) {
          if (String((await kv.hget(k, "creatorId")) ?? "") !== p.uid) continue;
          n++;
          if (!dry) await kv.hset(k, { creatorId: JSON.stringify(p.pseudonym) }); // encoded as groupStore writes fields
        } else if (/^neo:group:[^:]+:members$/.test(k)) {
          const all = ((await kv.hgetall(k)) ?? {}) as Record<string, unknown>;
          for (const [field, v] of Object.entries(all)) {
            const m = parseJson<Record<string, unknown>>(v);
            if (!m || m.addedBy !== p.uid) continue;
            n++;
            if (!dry) await kv.hset(k, { [field]: JSON.stringify({ ...m, addedBy: p.pseudonym }) });
          }
        }
      }
      return n;
    },
  },
  {
    id: "personalKeys",
    label: "Invitations list, notifications, devices, sessions, KingsChat tokens, presence",
    covers: ["kv.userMeetings", "kv.notifications", "kv.push", "kv.kingschat", "kv.sessions", "kv.shortLived"],
    run: async (p, dry) => {
      let n = await delKeys(
        [
          `neo:user:${p.uid}:meetings`,
          `neo:notif:${p.uid}`,
          `neo:notif:${p.uid}:unread`,
          `neo:push:${p.uid}`,
          `neo:fcm:${p.uid}`,
          `neo:kc:tokens:${p.uid}`,
          `neo:presence:${p.uid}`,
          `apiplan:${p.uid}`,
        ],
        dry,
      );
      for (const k of await scanKeys("neo:kc:handle-to-clerk:*")) {
        if (String((await kv.get(k)) ?? "") !== p.uid) continue;
        n++;
        if (!dry) await kv.del(k);
      }
      const sessions = ((await kv.smembers(`neo:sessions:${p.uid}`)) ?? []) as string[];
      const devices = await scanKeys(`neo:session-device:${p.uid}:*`);
      n += sessions.length + devices.length;
      if (!dry) {
        await logout(p.uid, null, "all");
        await kv.del(`neo:sessions:${p.uid}`, ...devices);
      }
      return n;
    },
  },
  {
    id: "subscriptions",
    label: "Subscription (removed) and its history (kept as a billing record, detached)",
    covers: ["kv.subscriptions"],
    run: async (p, dry) => {
      if (dry) return ((await getSubscription(p.uid)) ? 1 : 0) + (await getHistory(p.uid, 1000)).length;
      return (await forgetSubscriptionUser(p.uid)).removed;
    },
  },
  {
    id: "finance",
    label: "Ticket purchases, invoices and reminders (kept, names and emails blanked)",
    covers: ["kv.finance"],
    run: async (p, dry) => {
      if (dry) {
        const f = await financeRecordsForUser(p.uid);
        return f.invoices.length + f.payments.filter((x) => x.kind === "ticket").length + f.reminders.length;
      }
      let n = (await anonymiseFinanceForUser(p.uid, { email: p.emails[0] })).records;
      // Guest ticket purchases under any other address of theirs.
      for (const email of p.emails.slice(1)) n += (await anonymiseFinanceForUser(p.uid, { email })).records;
      return n;
    },
  },
  {
    id: "tickets",
    label: "Support tickets (kept for support history, requester removed, attachments deleted)",
    covers: ["kv.supportTickets"],
    run: async (p, dry) => {
      if (dry) return ticketsForAccount(await listTickets(), p.uid, p.emails).length;
      return (await anonymiseTicketsForAccount(p.uid, p.emails)).tickets;
    },
  },
  {
    id: "comms",
    label: "Notification preferences, reminder flags, bounce flags; delivery logs anonymised",
    covers: ["kv.comms"],
    run: async (p, dry) => {
      if (dry) {
        return (
          (await delKeys([`neo:comms:prefs:${p.uid}`, ...p.emails.map((e) => `neo:comms:bounced:${e}`)], true)) +
          (await scanKeys(`neo:comms:rem:${p.uid}:*`)).length
        );
      }
      return (await forgetCommsUser(p.uid, p.emails)).removed;
    },
  },
  {
    id: "activity",
    label: "Activity log: the person's own stream and raw events deleted; daily counts keep only the pseudonym",
    covers: ["kv.activity"],
    run: async (p, dry) => {
      let n = 0;
      // Daily counts: the id becomes the pseudonym, so totals stay right.
      for (const k of [...(await scanKeys("neo:act:dau:*")), ...(await scanKeys("neo:act:new:*"))]) {
        if (Number(await kv.sismember(k, p.uid)) !== 1) continue;
        n++;
        if (!dry) {
          await kv.srem(k, p.uid);
          await kv.sadd(k, p.pseudonym);
        }
      }
      for (const k of await scanKeys("neo:act:acct:*")) {
        const all = ((await kv.hgetall(k)) ?? {}) as Record<string, unknown>;
        for (const [field, v] of Object.entries(all)) {
          if (!field.startsWith(`${p.uid}|`)) continue;
          n++;
          if (!dry) {
            await kv.hincrby(k, p.pseudonym + field.slice(p.uid.length), Number(v) || 0);
            await kv.hdel(k, field);
          }
        }
      }
      // The person's own stream and their raw events: the analytics phase's own function.
      if (!dry) return n + (await forgetUserActivity(p.uid)).removed;
      n += Number(await kv.llen(`neo:act:u:${p.uid}`));
      for (const k of await scanKeys("neo:act:log:*")) {
        const raw = ((await kv.lrange(k, 0, -1)) ?? []) as unknown[];
        n += raw.filter((r) => {
          const e = parseJson<Record<string, unknown>>(r);
          return !!e && (e.userId === p.uid || e.account === p.uid);
        }).length;
      }
      return n;
    },
  },
  {
    id: "payments",
    label: "Payments kept for legal retention, detached from the person",
    covers: ["kv.payments", "kv.paymentsIndex"],
    run: async (p, dry) => {
      const refs = ((await kv.lrange(`billing:payments:${p.uid}`, 0, -1)) ?? []) as unknown[];
      let n = 0;
      for (const ref of refs) {
        const rec = parseJson<Record<string, unknown>>(await kv.get(`billing:payment:${String(ref)}`));
        if (!rec || rec.userId !== p.uid) continue;
        n++;
        if (!dry) await kv.set(`billing:payment:${String(ref)}`, { ...rec, userId: p.pseudonym });
      }
      return n + (await delKeys([`billing:payments:${p.uid}`], dry));
    },
  },
  {
    id: "apiKeys",
    label: "Developer API keys and API meetings",
    covers: ["kv.apiKeys", "kv.apiMeetings"],
    run: async (p, dry) => {
      let n = 0;
      for (const id of ((await kv.smembers(`apikeys:user:${p.uid}`)) ?? []) as string[]) {
        const hash = await kv.get(`apikey:hash:${id}`);
        n += await delKeys([`apikey:meta:${id}`, `apikey:hash:${id}`, ...(hash ? [`apikey:${String(hash)}`] : [])], dry);
      }
      for (const id of ((await kv.smembers(`meetings:user:${p.uid}`)) ?? []) as string[]) n += await delKeys([`meeting:${id}`], dry);
      return n + (await delKeys([`apikeys:user:${p.uid}`, `meetings:user:${p.uid}`], dry));
    },
  },
  {
    id: "recordingMeta",
    label: "Transcripts, recording counters, share links, recording minutes",
    covers: ["kv.transcripts", "kv.recordingMeta"],
    run: async (p, dry) => {
      const prefix = userPrefix(p.uid);
      let n = 0;
      for (const k of await scanKeys("neo:transcribe:key:*")) {
        if (!fromB64Url(k.slice("neo:transcribe:key:".length)).startsWith(prefix)) continue;
        const jobId = String((await kv.get(k)) ?? "");
        n += await delKeys([k, ...(jobId ? [`neo:transcribe:${jobId}`] : [])], dry);
      }
      for (const k of await scanKeys("neo:rec:*")) {
        const enc = k.split(":").slice(3).join(":");
        if (fromB64Url(enc).startsWith(prefix)) n += await delKeys([k], dry);
      }
      for (const k of await scanKeys("neo:share:*")) {
        const s = parseJson<{ ownerUserId?: string }>(await kv.get(k));
        if (s?.ownerUserId === p.uid) n += await delKeys([k], dry);
      }
      return n + (await delKeys([`neo:rec-usage:${p.uid}`], dry));
    },
  },
  {
    id: "r2",
    label: "Recordings and chat uploads in storage",
    covers: ["r2.recordings", "r2.chatUploads"],
    run: async (p, dry) => {
      const prefixes = [userPrefix(p.uid), `chat/${p.uid}/`, TRASH_PREFIX + userPrefix(p.uid), `${TRASH_PREFIX}chat/${p.uid}/`];
      let n = 0;
      for (const pre of prefixes) n += dry ? (await listPrefix(pre)).length : (await deletePrefix(pre)).objects;
      return n;
    },
  },
  {
    id: "trash",
    label: "The person's trash",
    covers: ["trash"],
    run: async (p, dry) => {
      const items = await listTrash({ ownerId: p.uid, includeRestored: true });
      if (!dry) for (const t of items) await purgeTrashItem(t);
      return items.length;
    },
  },
  {
    id: "exports",
    label: "Data exports",
    covers: ["r2.exports", "kv.data.governance"],
    run: async (p, dry) => {
      if (dry) {
        const ids = ((await kv.lrange(`neo:data:exports:${p.uid}`, 0, -1)) ?? []) as unknown[];
        return ids.length + (await listPrefix(`data-exports/${p.uid}/`)).length;
      }
      return forgetExports(p.uid, deletePrefix);
    },
  },
  {
    id: "admin",
    label: "Administrators' notes, tags, support history; administrator record and two-factor",
    covers: ["kv.admin.userRecords", "kv.admin.member"],
    run: async (p, dry) => {
      let n = 0;
      for (const h of ["neo:admin:user-tags", "neo:admin:suspensions"]) n += (await kv.hget(h, p.uid)) != null ? 1 : 0;
      n += await delKeys([`neo:admin:user:${p.uid}:notes`, `neo:admin:user:${p.uid}:support`, `neo:admin:mfa:${p.uid}`, `neo:admin:mfa:pending:${p.uid}`, `neo:admin:mfa:fail:${p.uid}`], dry);
      const m = await getMember(p.uid);
      if (m) n++;
      if (!dry) {
        // The open request (neo:admin:deletions) is closed by the caller; forgetUser drops it with the rest.
        await forgetUser(p.uid);
        if (m) await saveMember({ ...m, status: "removed", email: "", name: DELETED_NAME, updatedAt: Date.now() });
      }
      return n;
    },
  },
];

export const CLERK_STEP = { id: "clerk", label: "The account in Clerk (last)", covers: ["clerk.user", "clerk.publicMetadata"] };

export type Blocker =
  | { code: "owner_protected"; message: string }
  | { code: "legal_hold"; message: string }
  | { code: "owns_groups"; message: string; groups: { id: string; name: string; members: number }[] };

/** Why this account cannot be erased now, if anything. */
export async function erasureBlockers(uid: string, user: ClerkUserish): Promise<Blocker[]> {
  const out: Blocker[] = [];
  if (isOwnerEmailList(user.emailAddresses)) {
    out.push({ code: "owner_protected", message: "The platform owner's account can never be deleted." });
    return out;
  }
  const hold = await getHold(uid);
  if (hold) out.push({ code: "legal_hold", message: "A legal hold is on this account; it cannot be deleted until the hold is lifted." });
  const owned = (await listGroupsForUser(uid)).filter((s) => s.role === "owner" && s.memberCount > 1);
  if (owned.length) {
    out.push({
      code: "owns_groups",
      message: "This account owns groups other people are in. Hand them to another member first (Groups page).",
      groups: owned.map((s) => ({ id: s.group.id, name: s.group.name, members: s.memberCount })),
    });
  }
  return out;
}

export async function personFor(uid: string): Promise<Person> {
  const ids = await identitiesOf(uid);
  return { ...ids, pseudonym: pseudonymFor(uid) };
}

/** Counts per step, changing nothing. */
export async function planErasure(uid: string): Promise<Record<string, number>> {
  const p = await personFor(uid);
  const counts: Record<string, number> = {};
  for (const s of ERASE_STEPS) counts[s.id] = await s.run(p, true);
  counts[CLERK_STEP.id] = 1;
  return counts;
}

export interface DeletionCertificate {
  certificateId: string;
  /** The deleted account's id: an identifier that, after this, resolves to nothing. */
  accountId: string;
  requestId: string;
  requestedAt: string;
  source: "user" | "admin";
  completedAt: string;
  completedById: string;
  completedByEmail: string;
  removed: Record<string, number>;
  kept: string[];
  steps: { id: string; label: string; count: number }[];
}

/**
 * Erase for real. The caller has checked the request is due and the
 * administrator's permission; this re-checks the blockers (owner, hold,
 * groups) itself, because no route should be the only thing between an
 * account and its deletion.
 */
export async function eraseAccount(
  uid: string,
  actor: { userId: string; email: string },
  request: { id: string; requestedAt: number; source: "user" | "admin" },
): Promise<{ ok: true; certificate: DeletionCertificate } | { ok: false; blockers: Blocker[] }> {
  const client = await clerkClient();
  const user = (await client.users.getUser(uid)) as unknown as ClerkUserish;
  const blockers = await erasureBlockers(uid, user);
  if (blockers.length) return { ok: false, blockers };

  const p = await personFor(uid);
  const removed: Record<string, number> = {};
  const steps: DeletionCertificate["steps"] = [];
  for (const s of ERASE_STEPS) {
    const count = await s.run(p, false);
    removed[s.id] = count;
    steps.push({ id: s.id, label: s.label, count });
  }
  await client.users.deleteUser(uid);
  removed[CLERK_STEP.id] = 1;
  steps.push({ id: CLERK_STEP.id, label: CLERK_STEP.label, count: 1 });
  await kv.sadd("neo:data:erased", uid);

  const certificate: DeletionCertificate = {
    certificateId: `cert_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`,
    accountId: uid,
    requestId: request.id,
    requestedAt: new Date(request.requestedAt).toISOString(),
    source: request.source,
    completedAt: new Date().toISOString(),
    completedById: actor.userId,
    completedByEmail: actor.email,
    removed,
    kept: ["payments (detached, legal retention)", "admin audit trail", "deletion request record and this certificate"],
    steps,
  };
  return { ok: true, certificate };
}
