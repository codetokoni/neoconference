// src/app/api/events/[id]/redemptions/stream/route.ts
// Owner-only Server-Sent Events stream of new invite redemptions.
// Polls eventStore every few seconds and emits any redemptions newer than
// the timestamp tracked per-connection.

import { auth } from "@clerk/nextjs/server";
import { eventStore } from "@/lib/eventStore";
import { assertOwnerOrAdmin } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 3500;
const MAX_LIFETIME_MS = 4 * 60 * 1000;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) {
    return new Response("unauthorized", { status: 401 });
  }
  const { id } = await ctx.params;
  const ev = await eventStore.byId(id);
  if (!ev) {
    return new Response("not_found", { status: 404 });
  }
  const check = await assertOwnerOrAdmin(ev, userId);
  if (!check.ok) {
    return new Response("forbidden", { status: 403 });
  }

  let lastTs = Date.now();
  const startedAt = Date.now();
  let interval: any = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      send({ ok: true, hello: true, ts: Date.now() });

      const tick = async () => {
        if (closed) return;
        if (Date.now() - startedAt > MAX_LIFETIME_MS) {
          send({ bye: true, reason: "max_lifetime" });
          closed = true;
          try { controller.close(); } catch {}
          if (interval) clearInterval(interval);
          return;
        }
        try {
          const fresh = await eventStore.byId(id);
          const list = (fresh?.recentRedemptions || []).filter((r: any) => r.ts > lastTs);
          if (list.length > 0) {
            for (const r of list.sort((a: any, b: any) => a.ts - b.ts)) {
              send({ redemption: r });
              lastTs = Math.max(lastTs, r.ts);
            }
          } else {
            send({ heartbeat: true, ts: Date.now() });
          }
        } catch (e: any) {
          send({ error: e?.message || "poll_failed" });
        }
      };
      interval = setInterval(tick, POLL_MS);
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
