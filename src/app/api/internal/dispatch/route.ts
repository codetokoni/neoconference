// src/app/api/internal/dispatch/route.ts
//
// One scheduler tick: run the reminders and rings that are due
// (src/lib/ringEngine.ts runDispatch). Called every 30 s by the scheduler
// container on the droplet (scheduler-worker/), and by a Vercel cron if one
// is ever added.
//
// Public in middleware (no Clerk session), gated here instead:
//   Authorization: Bearer <DISPATCH_SECRET>   (or <CRON_SECRET>, as Vercel cron sends)
// compared in constant time. Without a matching secret: 401. With neither
// secret configured, nothing can call it.
//
// -> 200 { ran, skipped, errors, locked? }

import { NextResponse } from "next/server";
import { runDispatch } from "@/lib/ringEngine";
import { authorizedDispatch, dispatchRefusal } from "@/lib/dispatchAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  const header = req.headers.get("authorization");
  if (!authorizedDispatch(header, [process.env.DISPATCH_SECRET, process.env.CRON_SECRET])) {
    const why = dispatchRefusal(header, { DISPATCH_SECRET: process.env.DISPATCH_SECRET, CRON_SECRET: process.env.CRON_SECRET });
    console.warn(`[dispatch] 401: ${why}`);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const result = await runDispatch(started);
  console.info(
    `[dispatch] ran=${result.ran} skipped=${result.skipped} errors=${result.errors}` +
      (result.chat ? ` chat_started=${result.chat.started} chat_ended=${result.chat.ended} open=${result.chat.open}` : "") +
      `${result.locked ? " locked" : ""} ms=${Date.now() - started}`
  );
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export const POST = handle;
export const GET = handle;
