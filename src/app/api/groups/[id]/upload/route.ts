// src/app/api/groups/[id]/upload/route.ts
//
// POST multipart { file } — an attachment for the group's chat (group:read).
// Same size and type limits as the meeting chat (src/lib/chatUploadRules.ts).
// Stored under groups/<gid>/ in R2; the reply carries the key, which the
// message keeps, plus a link to show it straight away. Links to old
// messages' files are signed afresh whenever the chat is read.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isR2Configured, putObject, signGetUrl } from "@/lib/r2";
import { recordMediaEvent } from "@/lib/ops/media";
import { CHAT_IMAGE_MIMES, CHAT_UPLOAD_ALLOWED, CHAT_UPLOAD_MAX_BYTES, safeFilename } from "@/lib/chatUploadRules";
import { requireGroupPermission } from "@/lib/groupAuthz";
import { activity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = await requireGroupPermission(id, "group:read");
  if (!gate.ok) return gate.response;
  if (!isR2Configured()) return NextResponse.json({ error: "storage_not_configured" }, { status: 503 });

  if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "expected_multipart" }, { status: 400 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "bad_form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file_field_missing" }, { status: 400 });
  if (file.size <= 0) return NextResponse.json({ error: "empty_file" }, { status: 400 });
  if (file.size > CHAT_UPLOAD_MAX_BYTES) {
    return NextResponse.json({ error: "too_large", limit: CHAT_UPLOAD_MAX_BYTES, size: file.size }, { status: 413 });
  }
  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!CHAT_UPLOAD_ALLOWED.has(mime)) return NextResponse.json({ error: "unsupported_type", mime }, { status: 415 });

  const name = safeFilename(file.name || "file");
  const key = `groups/${id}/${randomUUID()}-${name}`;
  try {
    await putObject(key, Buffer.from(await file.arrayBuffer()), mime, { cacheControl: "private, max-age=86400" });
  } catch (err) {
    console.error("[groups/upload] R2 put failed", err);
    await recordMediaEvent("upload", false, key, (err as Error)?.message);
    return NextResponse.json({ error: "upload_failed" }, { status: 502 });
  }
  await recordMediaEvent("upload", true, key);
  await activity.record("upload", { userId: gate.member.userId, account: gate.member.userId, props: { where: "group", groupId: id, bytes: file.size, mime } });
  return NextResponse.json({
    ok: true,
    attachment: {
      key,
      url: await signGetUrl(key, 24 * 60 * 60),
      name,
      size: file.size,
      mime,
      kind: CHAT_IMAGE_MIMES.has(mime) ? "image" : "file",
    },
  });
}
