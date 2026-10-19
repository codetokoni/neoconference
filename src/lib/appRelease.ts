// src/lib/appRelease.ts
//
// The Android app's newest version on the LoveWorld AppStore, and the oldest
// one still allowed to join meetings.
//
// A meeting link on a phone opens whatever NeoConference app is installed;
// nothing in an old app tells its owner a newer one exists. So joining asks:
// an app older than MIN_APP_VERSION (or one too old to say its version at
// all — 1.2.3 and earlier) is refused with a message telling them to
// update, which every app version shows as the join failure. From 1.2.5 the
// app also reads GET /api/app/latest itself and offers the update.
//
// Release steps: after a new version is live on the store, set
// LATEST_APP_VERSION here; raise MIN_APP_VERSION only when older apps must
// stop joining. APP_MIN_VERSION in Vercel overrides the minimum without a
// code change (e.g. "0" to let every app in again during an event).
// Between the minimum and the newest, an app is nudged: told once a day,
// with Try again letting it in (shouldNudgeUpdate). SCHEDULED_MIN raises
// the minimum on a date, after a week of nudges.

import { BRAND } from "@/lib/brand";
export const LATEST_APP_VERSION = "1.2.5";
export const MIN_APP_VERSION = "1.2.4";

/**
 * Moving everyone to 1.2.5 (owner, 2026-10-18): 53 people joined from 1.2.4
 * in the week before, and 1.2.4 has no update pop-up. So for a week an app
 * older than LATEST is nudged — told once a day, and let in on Try again —
 * and from this date the minimum rises and older apps must update.
 */
export const SCHEDULED_MIN = { version: "1.2.5", from: Date.parse("2026-10-25T00:00:00Z") };

export function minAppVersion(now: number = Date.now()): string {
  const env = (process.env.APP_MIN_VERSION || "").trim();
  if (/^\d+(\.\d+){0,3}$/.test(env)) return env;
  return now >= SCHEDULED_MIN.from && compareVersions(SCHEDULED_MIN.version, MIN_APP_VERSION) > 0
    ? SCHEDULED_MIN.version
    : MIN_APP_VERSION;
}

/** -1, 0 or 1, comparing dotted version numbers ("1.2.10" > "1.2.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The app version in a join's client string ("android 1.2.4+5218 OPPO …"). */
export function appVersionOf(client: string): string | null {
  const m = /^(?:android|ios)\s+(\d+(?:\.\d+){0,3})/i.exec(client.trim());
  return m ? m[1] : null;
}

/** Short enough to type: redirects to the store page (src/app/download). */
export const UPDATE_URL = `${BRAND.origin}/download`;

/**
 * Old apps show this as plain text, so it spells out the steps. Downloads go
 * through the LoveWorld AppStore (APP_STORE_URL, behind /download) so they
 * are counted there; its KingsChat sign-in is the quickest.
 */
export const UPDATE_MESSAGE =
  `A new version of ${BRAND.name} is available. To update: on this phone, open ${BRAND.domain}/download, ` +
  "sign in to the LoveWorld AppStore with KingsChat and tap Download. Then open the meeting link again. " +
  "You can also join from a web browser.";

/**
 * Whether a join must update the app first. Only app requests are judged:
 * the app signs its calls with `Authorization: Bearer`, the website with
 * its cookie. An app that sends no version is 1.2.3 or older.
 */
export function needsAppUpdate(input: { authorization: string | null; client: string }): boolean {
  if (!/^Bearer\s+\S/i.test(input.authorization || "")) return false;
  const version = appVersionOf(input.client);
  if (!version) return compareVersions("1.2.3", minAppVersion()) < 0;
  return compareVersions(version, minAppVersion()) < 0;
}

/**
 * An app still allowed to join but older than LATEST_APP_VERSION. 1.2.4
 * has no update pop-up of its own, so joining tells it — once a day
 * (claimNudge), and Try again on its failure screen goes straight in.
 */
export function shouldNudgeUpdate(input: { authorization: string | null; client: string }): boolean {
  if (!/^Bearer\s+\S/i.test(input.authorization || "")) return false;
  const version = appVersionOf(input.client);
  if (!version || compareVersions(version, minAppVersion()) < 0) return false;
  return compareVersions(version, LATEST_APP_VERSION) < 0;
}

/**
 * Shown by every app as the join failure, above its Try again button. The
 * cut-off is only mentioned while it is still ahead.
 */
export function nudgeMessage(now: number = Date.now()): string {
  const cutOff = now < SCHEDULED_MIN.from ? ", and from 25 October older apps cannot join" : "";
  return (
    `${BRAND.name} ${LATEST_APP_VERSION} is ready${cutOff}. To update: on this phone, open ${BRAND.domain}/download, ` +
    "sign in to the LoveWorld AppStore with KingsChat and tap Download. To join this meeting now, tap Try again."
  );
}

/** One nudge per person per 20 hours: the first join is told, the rest go in. */
export const NUDGE_TTL_SECONDS = 20 * 60 * 60;

export function nudgeKey(userId: string): string {
  return `neo:app:nudged:${userId}`;
}
