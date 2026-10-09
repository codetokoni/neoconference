// src/lib/ops/jobRegistry.ts
//
// The jobs the Operations > Jobs page knows: what each does, its schedule
// (the same expression as in vercel.json — this file does not schedule
// anything, Vercel does), and whether running it again is safe.
//
// retrySafe is a promise about the job's effect, not its code path: a job is
// safe to retry when a second run cannot do anything the first did not
// (it changes only what is still unchanged, or only reads). A job that
// sends mail or charges money is not, and the admin API refuses to re-run it.
//
// runRegisteredJob() runs one exactly as its schedule would — a cron route
// is called in-process through its own (wrapped) GET with cronRequestFor(),
// so the lock and the run record are the same ones the schedule uses.

import type { NextRequest } from "next/server";
import { cronRequestFor } from "@/lib/ops/cron";
import { getRun, runJob, type JobRun, type JobTrigger } from "@/lib/ops/jobs";

export interface JobDef {
  name: string;
  label: string;
  description: string;
  /** Cron expression (UTC) from vercel.json, or null when it has no schedule. */
  schedule: string | null;
  scheduleText: string;
  retrySafe: boolean;
  /** Why it is, or is not, safe to run again. Shown next to the button. */
  retryNote: string;
  /** The cron route that runs it, when it is one. */
  route?: string;
  /** Runs it in-process. For route jobs, the route's wrapped GET. */
  invoke: (opts: { trigger: JobTrigger; actor: string; retryOf?: string }) => Promise<{ run: JobRun | null; locked: boolean; status: number }>;
}

type RouteModule = { GET: (req: NextRequest) => Promise<Response> };

function routeJob(def: Omit<JobDef, "invoke"> & { route: string; load: () => Promise<RouteModule> }): JobDef {
  const { load, ...rest } = def;
  return {
    ...rest,
    invoke: async (opts) => {
      const mod = await load();
      const res = await mod.GET(cronRequestFor(def.route, opts));
      const id = res.headers.get("x-neo-job-run");
      return { run: id ? await getRun(id) : null, locked: res.status === 409, status: res.status };
    },
  };
}

export const JOBS: JobDef[] = [
  routeJob({
    name: "ops-health",
    label: "Service health checks",
    description: "Probes every dependency, keeps the history, evaluates alert rules and starts or ends scheduled maintenance windows.",
    schedule: "*/5 * * * *",
    scheduleText: "Every 5 minutes",
    retrySafe: true,
    retryNote: "Read-only probes; alerts de-duplicate, so running it again only refreshes the figures.",
    route: "/api/cron/ops-health",
    load: () => import("@/app/api/cron/ops-health/route") as Promise<RouteModule>,
  }),
  routeJob({
    name: "ops-backup",
    label: "KV snapshot to R2",
    description: "Copies the KV store (except caches and rate limits) into a compressed, checksummed snapshot in R2 and applies retention.",
    schedule: "30 3 * * *",
    scheduleText: "Daily at 03:30 UTC",
    retrySafe: true,
    retryNote: "Writes one more snapshot; retention removes the oldest beyond the limit. Nothing is overwritten.",
    route: "/api/cron/ops-backup",
    load: () => import("@/app/api/cron/ops-backup/route") as Promise<RouteModule>,
  }),
  routeJob({
    name: "downgrade-expired-plans",
    label: "Subscriptions due and expired plans",
    description: "Starts plans scheduled for today and ends subscriptions whose period is over, then moves accounts whose paid period has ended back to Free in Clerk.",
    schedule: "0 2 * * *",
    scheduleText: "Daily at 02:00 UTC",
    retrySafe: true,
    retryNote: "Only changes subscriptions and accounts whose date has passed; once changed they are no longer due, so a second run finds none left.",
    route: "/api/cron/downgrade-expired-plans",
    load: () => import("@/app/api/cron/downgrade-expired-plans/route") as Promise<RouteModule>,
  }),
  routeJob({
    name: "comms",
    label: "Announcement delivery (backstop)",
    description: "Works through announcements that still have recipients left. The scheduler's 30-second tick does this all day; this daily run is the backstop if that container is down.",
    schedule: "30 3 * * *",
    scheduleText: "Daily at 03:30 UTC",
    retrySafe: true,
    retryNote: "Each recipient and channel is claimed before anything is sent (at most once, never twice), so a second run only continues where the first stopped.",
    route: "/api/cron/comms",
    load: () => import("@/app/api/cron/comms/route") as Promise<RouteModule>,
  }),
  routeJob({
    name: "redemption-digest",
    label: "Invite redemption digest",
    description: "Emails each meeting owner the invites redeemed in the last 24 hours.",
    schedule: "0 14 * * *",
    scheduleText: "Daily at 14:00 UTC",
    retrySafe: false,
    retryNote: "Sends email. Running it again would send everyone the same digest twice.",
    route: "/api/cron/redemption-digest",
    load: () => import("@/app/api/cron/redemption-digest/route") as Promise<RouteModule>,
  }),
  {
    name: "meeting-sweep",
    label: "Stale meeting sweep",
    description: "Ends meetings still marked live whose LiveKit room is gone. Also runs on its own, at most every 5 minutes, when people list their meetings.",
    schedule: null,
    scheduleText: "On reads, at most every 5 minutes",
    retrySafe: true,
    retryNote: "Only ends meetings whose room no longer exists; a second run finds none.",
    invoke: async (opts) => {
      const { runMeetingSweep } = await import("@/lib/meetingSweep");
      const r = await runJob(
        "meeting-sweep",
        async () => {
          const s = await runMeetingSweep();
          return { ok: s.ok, summary: `scanned ${s.scanned}, ended ${s.ended}, still active ${s.stillActive}, failed ${s.failed}`, error: s.ok ? undefined : s.error };
        },
        opts,
      );
      return r.status === "locked" ? { run: null, locked: true, status: 409 } : { run: r.run, locked: false, status: r.run.outcome === "failed" ? 500 : 200 };
    },
  },
];

export function jobDef(name: string): JobDef | undefined {
  return JOBS.find((j) => j.name === name);
}

export async function runRegisteredJob(
  name: string,
  opts: { trigger: JobTrigger; actor: string; retryOf?: string },
): Promise<{ run: JobRun | null; locked: boolean; status: number }> {
  const def = jobDef(name);
  if (!def) throw new Error(`unknown job ${name}`);
  return def.invoke(opts);
}
