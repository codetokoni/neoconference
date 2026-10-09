// /api/admin/settings/logo — the platform logo, stored in R2.
//
// POST   (settings:write)  multipart form, field "logo": PNG, JPEG or WebP, at most 512 KB
// DELETE (settings:write)  back to the built-in mark
//
// The type is judged by the file's first bytes, not by what the browser
// says it is. SVG is refused: it can carry script.

import { NextResponse } from "next/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { fail } from "@/lib/admin/http";
import { getPlatformSettings, savePlatformSettings } from "@/lib/platform/settings";
import { deleteObject, isR2Configured, putObject } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LOGO_BYTES = 512 * 1024;

/** The image type from the file's magic bytes, or null. */
function sniffImage(b: Uint8Array): { type: string; ext: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "image/png", ext: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return { type: "image/webp", ext: "webp" };
  return null;
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "settings:write");
  if (!g.ok) return g.response;
  if (!isR2Configured()) return fail("storage_not_configured", "File storage (R2) is not set up on this deployment, so a logo cannot be stored.", 503);

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("logo");
    file = f && typeof f === "object" && "arrayBuffer" in f ? (f as File) : null;
  } catch {
    return fail("invalid_upload", "Send the logo as a form upload in the field \"logo\".");
  }
  if (!file) return fail("invalid_upload", "Choose an image to upload.");
  if (file.size > MAX_LOGO_BYTES) return fail("too_large", `The logo can be at most ${MAX_LOGO_BYTES / 1024} KB; this one is ${Math.ceil(file.size / 1024)} KB.`, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_LOGO_BYTES) return fail("too_large", `The logo can be at most ${MAX_LOGO_BYTES / 1024} KB.`, 413);
  const kind = sniffImage(bytes);
  if (!kind) return fail("unsupported_type", "The logo must be a PNG, JPEG or WebP image (SVG is not accepted).", 415);

  const current = await getPlatformSettings();
  const key = `platform/logo-${Date.now()}.${kind.ext}`;
  await putObject(key, bytes, kind.type, { cacheControl: "public, max-age=31536000, immutable" });
  const saved = await savePlatformSettings({
    ...current,
    branding: { ...current.branding, logoKey: key, logoType: kind.type, logoVersion: (current.branding.logoVersion || 0) + 1 },
  });
  if (current.branding.logoKey) await deleteObject(current.branding.logoKey).catch(() => undefined);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "settings.logo.upload",
    targetType: "settings",
    targetId: "branding",
    targetLabel: "logo",
    before: { logoKey: current.branding.logoKey },
    after: { logoKey: key, type: kind.type, bytes: bytes.length },
  });
  return NextResponse.json({ ok: true, settings: saved });
}

export async function DELETE(req: Request) {
  const g = await requireAdmin(req, "settings:write");
  if (!g.ok) return g.response;
  const current = await getPlatformSettings();
  if (!current.branding.logoKey) return NextResponse.json({ ok: true, settings: current });
  const saved = await savePlatformSettings({
    ...current,
    branding: { ...current.branding, logoKey: null, logoType: null, logoVersion: (current.branding.logoVersion || 0) + 1 },
  });
  await deleteObject(current.branding.logoKey).catch(() => undefined);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "settings.logo.remove",
    targetType: "settings",
    targetId: "branding",
    targetLabel: "logo",
    before: { logoKey: current.branding.logoKey },
    after: { logoKey: null },
  });
  return NextResponse.json({ ok: true, settings: saved });
}
