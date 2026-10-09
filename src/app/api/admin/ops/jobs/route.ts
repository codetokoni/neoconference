// /api/admin/ops/jobs — the job runner's view.
//
// GET (ops:read)  every registered job (schedule, whether it is safe to run
//                 again, recent runs, whether it is running now), recent
//                 failed runs of any job, and the queues outside the runner:
//                 transcription jobs, announcement sends, pending checkouts and webhook events
//                 that changed nothing.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/context";
import { JOBS } from "@/lib/ops/jobRegistry";
import { jobLockHolder, jobNames, listFailedRuns, listRuns } from "@/lib/ops/jobs";
import { transcriptionJobs } from "@/lib/ops/media";
import { commsSends, pendingCheckouts, webhookRejections } from "@/lib/ops/queues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin(req, "ops:read");
  if (!g.ok) return g.response;
  const known = new Set(JOBS.map((j) => j.name));
  const others = (await jobNames()).filter((n) => !known.has(n));
  const jobs = await Promise.all(
    [...JOBS.map((j) => ({ name: j.name, label: j.label, description: j.description, schedule: j.schedule, scheduleText: j.scheduleText, retrySafe: j.retrySafe, retryNote: j.retryNote, registered: true })),
      ...others.map((name) => ({ name, label: name, description: "Recorded by the job runner (not a registered job).", schedule: null, scheduleText: "—", retrySafe: false, retryNote: "Not a registered job: it can only be started by whatever runs it.", registered: false }))].map(async (j) => ({
      ...j,
      running: !!(await jobLockHolder(j.name)),
      runs: await listRuns(j.name, 10),
    })),
  );
  const [failed, transcription, checkouts, rejections, sends] = await Promise.all([
    listFailedRuns(50),
    transcriptionJobs(),
    pendingCheckouts(),
    webhookRejections(),
    commsSends(),
  ]);
  return NextResponse.json({
    ok: true,
    jobs,
    failed,
    queues: {
      transcription: { byStatus: transcription.byStatus, queued: transcription.queued, total: transcription.total, truncated: transcription.truncated },
      checkouts,
      sends,
      webhookRejections: rejections,
    },
  });
}
