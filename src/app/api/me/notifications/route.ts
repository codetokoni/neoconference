// src/app/api/me/notifications/route.ts
//
// GET   ?cursor=<offset>     the signed-in person's notifications, newest first,
//                            20 at a time, with the unread count.
// PATCH { ids: string[] }    mark these read
//       { all: true }        mark everything read
//       -> { ok, unread }
// DELETE { ids: string[] }   clear these from the list
//        { all: true }       clear the whole list
//       -> { ok, unread }

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { clearNotifications, listNotifications, markRead } from "@/lib/notificationStore";
import { invalidBody, readJsonObject } from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const raw = new URL(req.url).searchParams.get("cursor");
  const cursor = raw && /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  const page = await listNotifications(userId, cursor);
  return NextResponse.json(page, { headers: { "cache-control": "no-store" } });
}

/** `{ all: true }` or `{ ids }`, or null when the body is neither. */
function which(body: Record<string, unknown>): { all: true } | { ids: string[] } | null {
  if (body.all === true) return { all: true };
  const ids = body.ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 100 ||
    !ids.every((i) => typeof i === "string" && i.length > 0 && i.length <= 32)
  ) {
    return null;
  }
  return { ids: ids as string[] };
}

export async function PATCH(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const target = which(body);
  if (!target) return invalidBody("invalid_ids");
  return NextResponse.json({ ok: true, unread: await markRead(userId, target) });
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  const target = which(body);
  if (!target) return invalidBody("invalid_ids");
  return NextResponse.json({ ok: true, unread: await clearNotifications(userId, target) });
}
