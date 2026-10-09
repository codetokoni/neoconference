// /api/me/data/export — "Download my data" on the account page.
//
// GET                  my recent exports
// GET  ?download=<id>  a signed link to the ZIP, valid for 5 minutes
// POST {}              start an export (one at a time, three a day)
// POST { id }          advance it; call until status is "ready"

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { advanceExport, downloadLink, getExport, listExports, publicExport, startExport, DOWNLOAD_LINK_S, EXPORTS_PER_DAY } from "@/lib/dataGov/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const err = (error: string, message: string, status: number) => NextResponse.json({ error, message }, { status });

async function mine(uid: string, id: unknown) {
  const job = typeof id === "string" ? await getExport(id) : null;
  return job && job.userId === uid && job.by === "self" ? job : null;
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return err("unauthenticated", "Sign in first.", 401);
  const id = new URL(req.url).searchParams.get("download");
  if (id) {
    const job = await mine(userId, id);
    if (!job) return err("not_found", "No such export.", 404);
    const url = await downloadLink(job);
    if (!url) return err("not_ready", "That export is not ready yet.", 409);
    return NextResponse.json({ url, expiresIn: DOWNLOAD_LINK_S });
  }
  const items = (await listExports(userId)).filter((j) => j.by === "self").map(publicExport);
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return err("unauthenticated", "Sign in first.", 401);
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  if (body?.id !== undefined) {
    const job = await mine(userId, body.id);
    if (!job) return err("not_found", "No such export.", 404);
    const next = await advanceExport(job.id);
    return NextResponse.json({ ok: true, export: next ? publicExport(next) : null });
  }
  const r = await startExport(userId, "self");
  if ("refused" in r) {
    if (r.refused === "daily_limit") return err("daily_limit", `You can make ${EXPORTS_PER_DAY} exports a day. Try again tomorrow.`, 429);
    if (r.refused === "already_running") return err("already_running", "An export is already being prepared.", 409);
    return err("unavailable", "Exports are not available right now.", 503);
  }
  return NextResponse.json({ ok: true, export: publicExport(r.job) });
}
