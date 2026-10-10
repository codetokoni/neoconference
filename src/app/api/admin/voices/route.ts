// /api/admin/voices — cloned speaker voices for meeting translation.
//
//   GET     list, this month's characters, whether Cartesia is configured
//   POST    multipart: userId, name, sampleLanguage, consentBy, consentAt,
//           consentStatement, clip (the recording) → makes the voice
//   PATCH   { userId, enabled }                    → switch it on or off
//   DELETE  ?userId=                               → remove it here and at Cartesia
//
// voices:manage is sensitive, so changes need a fresh authenticator code.
// A voice is never made without a recorded consent: who gave it, when, and
// the words they agreed to.

import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { recordAdminAction } from "@/lib/admin/audit";
import { CARTESIA_LANGUAGES, cartesiaConfigured, cloneVoice, deleteVoice } from "@/lib/cartesia";
import {
  dailyCharCap,
  getVoiceProfile,
  listVoiceProfiles,
  monthlyChars,
  removeVoiceProfile,
  saveVoiceProfile,
  type VoiceProfile,
} from "@/lib/voiceProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CLIP_BYTES = 16 * 1024 * 1024;

export async function GET(req: Request) {
  const g = await requireAdmin(req, "voices:manage", { readOnly: true });
  if (!g.ok) return g.response;
  const month = new Date().toISOString().slice(0, 7);
  return NextResponse.json({
    ok: true,
    configured: cartesiaConfigured(),
    voices: await listVoiceProfiles(),
    usage: { month, characters: await monthlyChars(month), dailyCapPerMeeting: dailyCharCap() },
    languages: Array.from(CARTESIA_LANGUAGES),
  });
}

export async function POST(req: Request) {
  const g = await requireAdmin(req, "voices:manage");
  if (!g.ok) return g.response;
  if (!cartesiaConfigured()) {
    return NextResponse.json({ ok: false, error: "not_configured", message: "CARTESIA_API_KEY is not set." }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request", message: "Send the form with the recording." }, { status: 400 });
  }
  const str = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);
  const userId = str("userId", 64);
  const name = str("name", 80);
  const sampleLanguage = str("sampleLanguage", 8).toLowerCase() || "en";
  const consentBy = str("consentBy", 120);
  const consentStatement = str("consentStatement", 2000);
  const consentAt = Date.parse(str("consentAt", 40));
  const clip = form.get("clip");

  const missing = [
    !userId && "the speaker's account",
    !name && "the speaker's name",
    !consentBy && "who gave consent",
    !consentStatement && "the consent statement",
    !Number.isFinite(consentAt) && "the date consent was given",
    !(clip instanceof Blob) && "the recording",
  ].filter(Boolean);
  if (missing.length) {
    return NextResponse.json({ ok: false, error: "missing", message: `Missing: ${missing.join(", ")}.` }, { status: 400 });
  }
  if (!CARTESIA_LANGUAGES.has(sampleLanguage)) {
    return NextResponse.json({ ok: false, error: "language", message: "That recording language is not supported." }, { status: 400 });
  }
  const file = clip as Blob;
  if (file.size === 0 || file.size > MAX_CLIP_BYTES) {
    return NextResponse.json({ ok: false, error: "clip_size", message: "The recording must be under 16 MB." }, { status: 400 });
  }

  try {
    const client = await clerkClient();
    await client.users.getUser(userId);
  } catch {
    return NextResponse.json({ ok: false, error: "no_user", message: "No NeoConference account with that id." }, { status: 404 });
  }

  const filename = (clip as File).name || "recording.wav";
  const made = await cloneVoice(file, filename, name, sampleLanguage);
  if (!made.ok) {
    await recordAdminAction(actorOf(g.ctx), req, {
      action: "voice.create",
      targetType: "user",
      targetId: userId,
      targetLabel: name,
      outcome: "failed",
      note: `Cartesia ${made.status}: ${made.detail}`.slice(0, 300),
    });
    return NextResponse.json(
      { ok: false, error: "cartesia_failed", message: `Cartesia could not make the voice (${made.status || "no answer"}).` },
      { status: 502 },
    );
  }

  const previous = await getVoiceProfile(userId);
  const profile: VoiceProfile = {
    userId,
    name,
    voiceId: made.value,
    sampleLanguage,
    enabled: true,
    consent: { by: consentBy, at: consentAt, statement: consentStatement },
    createdAt: Date.now(),
    createdBy: g.ctx.email,
  };
  await saveVoiceProfile(profile);
  // A new recording replaces the old voice: remove the old one at Cartesia.
  if (previous && previous.voiceId !== profile.voiceId) await deleteVoice(previous.voiceId);

  await recordAdminAction(actorOf(g.ctx), req, {
    action: "voice.create",
    targetType: "user",
    targetId: userId,
    targetLabel: name,
    before: previous ? { voiceId: previous.voiceId } : undefined,
    after: { voiceId: profile.voiceId, consentBy, consentAt: new Date(consentAt).toISOString() },
  });
  return NextResponse.json({ ok: true, voice: profile });
}

export async function PATCH(req: Request) {
  const g = await requireAdmin(req, "voices:manage");
  if (!g.ok) return g.response;
  let body: { userId?: unknown; enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const userId = String(body.userId ?? "");
  const p = await getVoiceProfile(userId);
  if (!p) return NextResponse.json({ ok: false, error: "not_found", message: "No voice for that speaker." }, { status: 404 });
  if (typeof body.enabled !== "boolean") return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  const next = { ...p, enabled: body.enabled };
  await saveVoiceProfile(next);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: body.enabled ? "voice.enable" : "voice.disable",
    targetType: "user",
    targetId: userId,
    targetLabel: p.name,
    before: { enabled: p.enabled },
    after: { enabled: next.enabled },
  });
  return NextResponse.json({ ok: true, voice: next });
}

export async function DELETE(req: Request) {
  const g = await requireAdmin(req, "voices:manage");
  if (!g.ok) return g.response;
  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  const p = await getVoiceProfile(userId);
  if (!p) return NextResponse.json({ ok: false, error: "not_found", message: "No voice for that speaker." }, { status: 404 });
  const removedAtCartesia = await deleteVoice(p.voiceId);
  await removeVoiceProfile(userId);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: "voice.delete",
    targetType: "user",
    targetId: userId,
    targetLabel: p.name,
    before: { voiceId: p.voiceId },
    note: removedAtCartesia ? undefined : "Cartesia did not confirm the delete; remove it there by hand.",
  });
  return NextResponse.json({ ok: true, removedAtCartesia });
}
