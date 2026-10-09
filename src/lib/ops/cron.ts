// src/lib/ops/cron.ts
//
// cronRoute() wraps a cron route's GET in the job runner (src/lib/ops/jobs.ts)
// without changing what the route does:
//
//   async function handle(req: NextRequest) { …the route, as it was… }
//   export const GET = cronRoute("downgrade-expired-plans", handle);
//
// A request that fails the cron check goes straight to the handler, which
// refuses it as before; it takes no lock and is not a run. (One that claims
// to be Vercel's cron by user agent is recorded as a failed run, so a broken
// CRON_SECRET shows on the Jobs page instead of as silence.)
//
// An authenticated request runs the handler under the job's lock and records
// the run. If the job is already running the request gets 409 and the
// handler does not run. A throw is recorded and rethrown, so the response is
// what it always was.
//
// The admin "Run now" / "Retry" buttons call the same GET in-process with
// cronRequestFor() — never over the network — and say who started it.

import { NextRequest, NextResponse } from "next/server";
import { jobReplacement, runJob, type JobTrigger } from "@/lib/ops/jobs";

/** The check every cron route already makes: Bearer CRON_SECRET, or Vercel's cron header when no secret is set. */
export function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return req.headers.get("x-vercel-cron") === "1";
  return (req.headers.get("authorization") || "") === "Bearer " + secret;
}

const TRIGGERS: JobTrigger[] = ["schedule", "manual", "retry", "automation"];

/** A request the cron routes accept, for running a job from inside the app. */
export function cronRequestFor(
  path: string,
  opts: { trigger: JobTrigger; actor: string; retryOf?: string },
): NextRequest {
  const headers: Record<string, string> = {
    "x-neo-job-trigger": opts.trigger,
    "x-neo-job-actor": opts.actor.slice(0, 200),
  };
  if (opts.retryOf) headers["x-neo-job-retry-of"] = opts.retryOf;
  const secret = process.env.CRON_SECRET;
  if (secret) headers.authorization = "Bearer " + secret;
  else {
    headers["x-vercel-cron"] = "1";
    // /api/cron/comms takes the dispatch secret when there is no CRON_SECRET.
    // In-process only: this request never leaves the function.
    if (process.env.DISPATCH_SECRET) headers.authorization = "Bearer " + process.env.DISPATCH_SECRET;
  }
  const origin = process.env.NEXT_PUBLIC_SITE_URL || "https://www.neoconference.app";
  return new NextRequest(new URL(path, origin).toString(), { method: "GET", headers });
}

function summarise(body: unknown): string {
  if (body == null) return "";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > 300 ? text.slice(0, 297) + "…" : text;
}

export function cronRoute<R extends Request = NextRequest>(
  name: string,
  handler: (req: R) => Promise<Response>,
  opts: { lockMs?: number } = {},
): (req: R) => Promise<Response> {
  return async (req: R) => {
    if (!isCronRequest(req)) {
      const res = await handler(req);
      if (/vercel-cron/i.test(req.headers.get("user-agent") || "")) {
        await runJob(name, async () => ({ ok: false, error: `cron request refused: HTTP ${res.status} (check CRON_SECRET)` }), {
          trigger: "schedule",
        });
      }
      return res;
    }
    const t = req.headers.get("x-neo-job-trigger") as JobTrigger | null;
    const trigger: JobTrigger = t && TRIGGERS.includes(t) ? t : "schedule";
    const actor = req.headers.get("x-neo-job-actor") || (trigger === "schedule" ? "vercel-cron" : "system");
    const retryOf = req.headers.get("x-neo-job-retry-of") || undefined;

    // An automation rule has taken this job over: its scheduled run stands
    // down (recorded, so the Jobs page says why). Runs started by hand, as a
    // retry or by the rule itself are not affected.
    if (trigger === "schedule") {
      const by = await jobReplacement(name);
      if (by) {
        await runJob(name, async () => ({ ok: true, skipped: true, summary: `skipped (replaced by automation rule ${by.ruleName})` }), { trigger, actor });
        return NextResponse.json({ ok: true, skipped: "replaced_by_automation", job: name, ruleId: by.ruleId });
      }
    }

    let response: Response | null = null;
    const result = await runJob(
      name,
      async () => {
        response = await handler(req);
        const body = await response.clone().json().catch(() => null) as { ok?: unknown; skipped?: unknown; error?: unknown } | null;
        const ok = response.ok && body?.ok !== false;
        return {
          ok,
          skipped: ok && !!body?.skipped,
          summary: summarise(body ?? `HTTP ${response.status}`),
          error: ok ? undefined : String(body?.error ?? `HTTP ${response.status}`),
        };
      },
      { trigger, actor, retryOf, lockMs: opts.lockMs },
    );
    if (result.status === "locked") {
      return NextResponse.json({ ok: false, skipped: "already_running", job: name, heldBy: result.heldBy }, { status: 409 });
    }
    if (result.error !== undefined) {
      // On the schedule the route throws exactly as it did before. Started
      // from the admin area (in-process) the caller needs the run instead.
      if (trigger === "schedule") throw result.error;
      const failed = NextResponse.json({ ok: false, error: result.run.error }, { status: 500 });
      failed.headers.set("x-neo-job-run", result.run.id);
      return failed;
    }
    const res = response as Response | null;
    if (!res) return NextResponse.json({ ok: false, error: "no_response" }, { status: 500 });
    const out = new Response(res.body, res);
    out.headers.set("x-neo-job-run", result.run.id);
    return out;
  };
}
