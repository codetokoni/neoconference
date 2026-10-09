// src/app/api/cron/downgrade-expired-plans/route.ts
//
// Daily expiry sweeper. Scans Clerk users and downgrades any whose
// publicMetadata.planExpiresAt is in the past back to "free", clearing
// planExpiresAt at the same time. Triggered by Vercel Cron (configured
// in vercel.json). Auth mirrors /api/cron/redemption-digest: either a
// Bearer CRON_SECRET header or a Vercel-stamped x-vercel-cron header.
//
// Defense-in-depth: readPlanFromMetadata() already treats expired metadata
// as "free" at read time, so users see the downgrade immediately even if
// this sweeper has not yet run. The cron exists to make the demotion
// durable in Clerk so downstream tools (admin views, billing) reflect it.
//
// Subscriptions first (src/lib/billing/subscriptions.ts sweepDue): every
// subscription record whose period has ended either starts the plan an
// administrator scheduled for that date or ends — trials and
// cancellations included — before the Clerk sweep below would read the
// same accounts as expired and drop them to Free.
//
// Pagination: Clerk's getUserList returns { data, totalCount } with a max
// page size of 500. We page through using offset until we've covered the
// reported totalCount, with a hard ceiling of 10,000 users for safety.

import { NextResponse, type NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { isPlanExpired } from "@/lib/plan";
import { sweepDue } from "@/lib/billing/subscriptions";
import { activity } from "@/lib/activity";
import { cronRoute } from "@/lib/ops/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;
const SAFETY_CAP = 10000;

function isAuthed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If unset, only allow when Vercel marks the request as cron-driven.
    return req.headers.get("x-vercel-cron") === "1";
  }
  const auth = req.headers.get("authorization") || "";
  return auth === ("Bearer " + secret);
}

async function handle(req: NextRequest) {
  if (!isAuthed(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let subscriptions: Awaited<ReturnType<typeof sweepDue>> | { error: string };
  try {
    subscriptions = await sweepDue();
    for (const e of subscriptions.errors) {
      // eslint-disable-next-line no-console
      console.error("[cron/downgrade-expired-plans] subscription sweep failed for", e.userId, e.reason);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[cron/downgrade-expired-plans] subscription sweep failed", e);
    subscriptions = { error: (e as Error).message || "unknown" };
  }

  const client = await clerkClient();
  let scanned = 0;
  let downgraded = 0;
  let offset = 0;
  let totalCount = Infinity;
  let truncated = false;
  const errors: Array<{ userId: string; reason: string }> = [];

  while (offset < totalCount && scanned < SAFETY_CAP) {
    let page: { data: Array<{ id: string; publicMetadata?: unknown }>; totalCount: number };
    try {
      page = await client.users.getUserList({ limit: PAGE_SIZE, offset });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[cron/downgrade-expired-plans] getUserList failed at offset", offset, e);
      return NextResponse.json(
        { ok: false, error: "list_failed", scanned, downgraded, offset, subscriptions },
        { status: 500 },
      );
    }

    totalCount = page.totalCount;
    if (!page.data.length) break;

    for (const user of page.data) {
      scanned++;
      if (isPlanExpired(user.publicMetadata)) {
        try {
          await client.users.updateUserMetadata(user.id, {
            publicMetadata: {
              ...((user.publicMetadata as Record<string, unknown>) ?? {}),
              plan: "free",
              planExpiresAt: null,
              planId: null,
              planVersion: null,
              planLimits: null,
            },
          });
          downgraded++;
          const was = (user.publicMetadata as Record<string, unknown> | undefined)?.plan;
          await activity.record("plan.downgraded", { userId: user.id, props: { from: typeof was === "string" ? was : null, to: "free", reason: "expired" } });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[cron/downgrade-expired-plans] downgrade failed for", user.id, e);
          errors.push({ userId: user.id, reason: (e as Error).message || "unknown" });
        }
      }
      if (scanned >= SAFETY_CAP) {
        truncated = true;
        break;
      }
    }
    offset += page.data.length;
  }

  if (truncated) {
    // eslint-disable-next-line no-console
    console.warn("[cron/downgrade-expired-plans] hit SAFETY_CAP of", SAFETY_CAP, "users");
  }

  return NextResponse.json({
    ok: true,
    scanned,
    downgraded,
    totalCount: Number.isFinite(totalCount) ? totalCount : 0,
    truncated,
    errorCount: errors.length,
    subscriptions:
      "errors" in subscriptions
        ? { changed: subscriptions.changed, expired: subscriptions.expired, errorCount: subscriptions.errors.length }
        : subscriptions,
  });
}

// Recorded and locked by the ops job runner (Operations > Jobs); the
// schedule and what the route does are unchanged.
export const GET = cronRoute("downgrade-expired-plans", handle);
