// src/lib/kcNameBackfill.ts
//
// Fill in the KingsChat name of accounts that signed in with KingsChat before
// names were kept (#669), so their past and future attendance shows a full
// name without waiting for their next sign-in (src/lib/attendeeName.ts).
//
// Who: every account with stored KingsChat tokens (neo:kc:tokens:<userId>,
// written at web sign-in) whose account has no kingschat.name yet. For each,
// the stored token is refreshed if needed, KingsChat's profile is read with
// it, and the name is saved exactly as sign-in saves it: kingschat.name, and
// the account's first and last name only while those are empty.
//
// In runs: one run stops starting people after `budgetMs`, and the next picks
// up whoever is still unnamed. Someone KingsChat gave no name is not asked
// again for a month; a token or KingsChat failure is retried after 6 hours,
// three times at most (Tried), so later runs move on. Once a run finds no one left, it says so and later runs only check
// that (DONE_KEY). Safe to run again: it only touches accounts still unnamed.
//
// Accounts that only ever signed in from the phone app have no stored tokens
// (the app's tokens cannot be refreshed here); they get their name at their
// next sign-in.

import { kv } from "@/lib/kv";
import { cleanFullName, isKcAccount, kcProfileName, localFullName, splitFullName, type NamedAccount } from "@/lib/attendeeName";

export const DONE_KEY = "neo:kc:name-backfill:done";
const triedKey = (uid: string) => `neo:kc:name-backfill:tried:${uid}`;
/** How long a try is remembered (its failures count across this). */
const TRIED_KEEP_S = 30 * 24 * 60 * 60;
/** A token or KingsChat failure: try again after 6 hours, three times at most. */
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const MAX_FAILED_TRIES = 3;
const TOKEN_PREFIX = "neo:kc:tokens:";

/**
 * Why someone was not named, how many failed tries so far, and when a
 * failed one may be tried again. Kept TRIED_KEEP_S; "no_name" (KingsChat has
 * none) and "gave_up" (three failures) are not retried while it is kept.
 */
export interface Tried {
  reason: "no_name" | "failed" | "gave_up";
  failures: number;
  /** Epoch ms; for "failed". */
  retryAt?: number;
}

export interface BackfillAccount extends NamedAccount {
  id: string;
}

export interface BackfillDeps {
  /** Accounts with stored KingsChat tokens. */
  tokenUserIds(): Promise<string[]>;
  /** The accounts, by id; a missing id is an account that no longer exists. */
  accounts(ids: string[]): Promise<Map<string, BackfillAccount>>;
  /** A usable access token, refreshed if needed; null when there is none. */
  accessToken(userId: string): Promise<string | null>;
  /** KingsChat's profile for a token; null when it could not be read. */
  profile(accessToken: string): Promise<unknown | null>;
  /** Save kingschat.name, and first/last name when given. */
  save(userId: string, name: string, names: { firstName: string; lastName: string } | null): Promise<void>;
  /** The last try, while its waiting period lasts. */
  tried(userId: string): Promise<Tried | null>;
  markTried(userId: string, t: Tried): Promise<void>;
  isDone(): Promise<boolean>;
  setDone(): Promise<void>;
}

export interface BackfillResult {
  ok: boolean;
  skipped?: boolean;
  /** Accounts with stored KingsChat tokens. */
  withTokens: number;
  alreadyNamed: number;
  gone: number;
  notKingsChat: number;
  /** A failed try within its waiting period: a later run tries again. */
  waiting: number;
  /** Not named, and not tried again for a month: no name at KingsChat, or three failures. */
  settled: number;
  named: number;
  /** Of those named, how many also got a first and last name (they had none). */
  filledAccountName: number;
  noNameAtKingsChat: number;
  noToken: number;
  profileFailed: number;
  saveFailed: number;
  /** Not reached in this run's time; the next run continues. */
  leftForNextRun: number;
  done: boolean;
  summary: string;
}

function hasKcName(u: NamedAccount): boolean {
  const md = u.publicMetadata as { kingschat?: { name?: unknown } } | null | undefined;
  return Boolean(cleanFullName(md?.kingschat?.name));
}

/** Run once. `now` is for tests. */
export async function backfillKcNames(
  opts: { budgetMs?: number; concurrency?: number; now?: () => number } = {},
  d: BackfillDeps = defaultDeps(),
): Promise<BackfillResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const budgetMs = opts.budgetMs ?? 240_000;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  const r: BackfillResult = {
    ok: true, withTokens: 0, alreadyNamed: 0, gone: 0, notKingsChat: 0, waiting: 0, settled: 0, named: 0, filledAccountName: 0,
    noNameAtKingsChat: 0, noToken: 0, profileFailed: 0, saveFailed: 0, leftForNextRun: 0, done: false, summary: "",
  };
  if (await d.isDone()) {
    r.done = true;
    r.skipped = true;
    r.summary = "nothing left: every account with stored KingsChat tokens has been named or tried";
    return r;
  }

  const ids = await d.tokenUserIds();
  r.withTokens = ids.length;
  const accounts = await d.accounts(ids);

  const todo: BackfillAccount[] = [];
  for (const id of ids) {
    const u = accounts.get(id);
    if (!u) r.gone++;
    else if (!isKcAccount(u)) r.notKingsChat++;
    else if (hasKcName(u)) r.alreadyNamed++;
    else todo.push(u);
  }

  let next = 0;
  /** Failures this run that a later run will try again (not given up). */
  let retryPending = 0;
  const one = async (u: BackfillAccount): Promise<void> => {
    const before = await d.tried(u.id);
    if (before && before.reason !== "failed") {
      r.settled++;
      return;
    }
    if (before && (before.retryAt ?? 0) > now()) {
      r.waiting++;
      return;
    }
    // A failure: retried after a while, three times at most.
    const failed = async () => {
      const failures = (before?.failures ?? 0) + 1;
      if (failures < MAX_FAILED_TRIES) retryPending++;
      await d.markTried(
        u.id,
        failures >= MAX_FAILED_TRIES ? { reason: "gave_up", failures } : { reason: "failed", failures, retryAt: now() + RETRY_AFTER_MS },
      );
    };
    const token = await d.accessToken(u.id);
    if (!token) {
      r.noToken++;
      await failed();
      return;
    }
    const profile = await d.profile(token);
    if (profile === null) {
      r.profileFailed++;
      await failed();
      return;
    }
    const name = kcProfileName(profile);
    if (!name) {
      r.noNameAtKingsChat++;
      await d.markTried(u.id, { reason: "no_name", failures: 0 });
      return;
    }
    const fill = localFullName(u) ? null : splitFullName(name);
    try {
      await d.save(u.id, name, fill);
      r.named++;
      if (fill) r.filledAccountName++;
    } catch (err) {
      console.warn("[kc-name-backfill] save failed", err);
      r.saveFailed++;
      await failed();
    }
  };
  const worker = async () => {
    while (next < todo.length) {
      if (now() - started >= budgetMs) return;
      const u = todo[next++];
      try {
        await one(u);
      } catch (err) {
        console.warn("[kc-name-backfill] one account failed", err);
        r.profileFailed++;
        retryPending++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, todo.length)) }, worker));
  r.leftForNextRun = todo.length - next;

  // Finished when no one is left to try now or later: nobody unreached,
  // nobody waiting to be tried again after a failure. Those settled for a
  // month (no name at KingsChat, or given up) do not hold it open.
  if (r.leftForNextRun === 0 && r.waiting === 0 && retryPending === 0) {
    r.done = true;
    await d.setDone();
  }
  r.summary =
    `${r.named} named (${r.filledAccountName} also got an account name), ` +
    `${r.alreadyNamed} already named, ${r.noNameAtKingsChat} with no name at KingsChat, ` +
    `${r.noToken} without a usable token, ${r.profileFailed} profile reads failed, ${r.saveFailed} saves failed, ` +
    `${r.waiting} waiting to retry, ${r.settled} settled earlier, ${r.leftForNextRun} left for the next run, ${r.gone} accounts gone` +
    (r.done ? "; finished" : "");
  return r;
}

function defaultDeps(): BackfillDeps {
  return {
    async tokenUserIds() {
      const { scanKeys } = await import("@/lib/ops/util");
      const { keys } = await scanKeys(TOKEN_PREFIX + "*", 100_000);
      return keys.map((k) => k.slice(TOKEN_PREFIX.length)).filter(Boolean);
    },
    async accounts(ids) {
      const { clerkClient } = await import("@clerk/nextjs/server");
      const cc = await clerkClient();
      const out = new Map<string, BackfillAccount>();
      for (let i = 0; i < ids.length; i += 100) {
        const list = await cc.users.getUserList({ userId: ids.slice(i, i + 100), limit: 100 });
        for (const u of list.data) out.set(u.id, u);
      }
      return out;
    },
    async accessToken(userId) {
      const { senderToken } = await import("@/lib/kingschat-send");
      const t = await senderToken(userId);
      return "token" in t ? t.token : null;
    },
    async profile(accessToken) {
      const { PROFILE_URL } = await import("@/lib/kc-signin");
      try {
        const res = await fetch(PROFILE_URL, { headers: { Authorization: "Bearer " + accessToken }, cache: "no-store" });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
    async save(userId, name, names) {
      const { clerkClient } = await import("@clerk/nextjs/server");
      const cc = await clerkClient();
      // Merged into the account's metadata, never replacing it.
      await cc.users.updateUserMetadata(userId, { publicMetadata: { kingschat: { name } } });
      if (names) await cc.users.updateUser(userId, names);
    },
    async tried(userId) {
      const v = await kv.get<Tried | string>(triedKey(userId));
      if (!v) return null;
      try {
        return typeof v === "string" ? (JSON.parse(v) as Tried) : v;
      } catch {
        return null;
      }
    },
    async markTried(userId, t) {
      await kv.set(triedKey(userId), JSON.stringify(t), { ex: TRIED_KEEP_S });
    },
    async isDone() {
      return Boolean(await kv.get(DONE_KEY));
    },
    async setDone() {
      await kv.set(DONE_KEY, new Date().toISOString());
    },
  };
}
