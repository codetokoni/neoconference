// src/app/api/groups/[id]/upload/route.ts
//
// POST multipart { file } — an attachment for the group's chat (group:read).
// Size and type limits are set in the admin area (Content > Limits,
// src/lib/content/limits.ts); the same as the meeting chat until changed.
// Stored under groups/<gid>/ in R2; the reply carries the key, which the
// message keeps, plus a link to show it straight away. Links to old
// messages' files are signed afresh whenever the chat is read.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { isR2Configured, putObject, signGetUrl } from "@/lib/r2";
import { recordMediaEvent } from "@/lib/ops/media";
import { CHAT_IMAGE_MIMES, safeFilename } from "@/lib/chatUploadRules";
import { requireGroupPermission } from "@/lib/groupAuthz";
import { refuseUpload, uploadRule } from "@/lib/content/limits";
import { storedMime } from "@/lib/content/model";
import { indexUpload, indexUploadFailed } from "@/lib/content/files";
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
  const refused = await refuseUpload("group", file, gate.member.userId);
  if (refused) return refused;
  const mime = storedMime(await uploadRule("group"), file);

  const name = safeFilename(file.name || "file");
  const key = `groups/${id}/${randomUUID()}-${name}`;
  const body = Buffer.from(await file.arrayBuffer());
  const indexed = { key, type: "group_upload" as const, ownerId: gate.member.userId, groupId: id, name, size: file.size, contentType: mime, body };
  try {
    await putObject(key, body, mime, { cacheControl: "private, max-age=86400" });
  } catch (err) {
    console.error("[groups/upload] R2 put failed", err);
    await indexUploadFailed({ ...indexed, detail: (err as Error)?.message || "upload failed" });
    await recordMediaEvent("upload", false, key, (err as Error)?.message);
    return NextResponse.json({ error: "upload_failed" }, { status: 502 });
  }
  await indexUpload(indexed);
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
