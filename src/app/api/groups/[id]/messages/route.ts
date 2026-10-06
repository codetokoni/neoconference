// src/app/api/groups/[id]/messages/route.ts
//
// The group's chat (group:read — every member).
//
// GET ?sinceVer=&before=
//   sinceVer equal to the current version -> { unchanged: true, ver } after
//   one read; otherwise { ver, messages (oldest first, 50), hasOlder, live }.
//   before=<message id> pages back through older messages.
// POST { text, replyToId?, attachments? }
//   Up to the meeting chat's length limit; @Name mentions of current members
//   are found in the text and notified (in-app + push). 10 messages per 10 s
//   a person, then 429.

import { NextResponse } from "next/server";
import { listMembers } from "@/lib/groupStore";
import { allowMessage, postMessage, readChat } from "@/lib/groupChat";
import { viewMessages } from "@/lib/groupChatView";
import { listGroupMeetings } from "@/lib/groupMeetings";
import { notifyMention } from "@/lib/groupNotify";
import {
  groupErrorResponse,
  invalidBody,
  readJsonObject,
  requireGroupPermission,
} from "@/lib/groupAuthz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:read");
  if (!gate.ok) return gate.response;

  const q = new URL(req.url).searchParams;
  const rawVer = q.get("sinceVer");
  const sinceVer = rawVer && /^\d{1,15}$/.test(rawVer) ? Number(rawVer) : undefined;
  const before = q.get("before") || undefined;
  if (before && before.length > 40) return invalidBody("invalid_cursor");

  const page = await readChat(id, { ...(sinceVer !== undefined ? { sinceVer } : {}), ...(before ? { before } : {}) });
  if ("unchanged" in page) return NextResponse.json(page, { headers: { "cache-control": "no-store" } });

  // Meetings on right now, for the "Live now · Join" bar. Starting and
  // ending a meeting both post a line, so this is fresh whenever it changes.
  const upcoming = before ? null : await listGroupMeetings(id, gate.member.userId, "upcoming");
  const live = (upcoming?.items ?? []).filter((m) => m.state === "live").map((m) => ({ slug: m.slug, title: m.title }));

  return NextResponse.json(
    { ver: page.ver, messages: await viewMessages(page.messages), hasOlder: page.hasOlder, live },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:read");
  if (!gate.ok) return gate.response;

  const body = await readJsonObject(req);
  if (!body) return invalidBody();
  if (!(await allowMessage(id, gate.member.userId))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const members = await listMembers(id);
    const message = await postMessage(
      id,
      gate.member,
      { text: body.text, replyToId: body.replyToId, attachments: body.attachments },
      members
    );
    if (message.mentions?.length) {
      await notifyMention(message.mentions, {
        groupId: id,
        groupName: gate.group.name,
        senderName: gate.member.name,
        text: message.text,
      });
    }
    const [view] = await viewMessages([message]);
    return NextResponse.json({ ok: true, message: view }, { status: 201 });
  } catch (err) {
    return groupErrorResponse(err);
  }
}
