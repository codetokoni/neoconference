// /api/admin/settings — branding, contacts, the site-wide notice, regional
// settings and the registration rules. Live within seconds of saving
// (src/lib/platform/settings.ts), no redeploy.
//
// GET   (settings:write)  the settings
// PATCH (settings:write)  { section: "branding" | "contacts" | "notice" | "regional" | "registration", value }

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { actorOf, requireAdmin } from "@/lib/admin/context";
import { diff, recordAdminAction } from "@/lib/admin/audit";
import { fail, readJson } from "@/lib/admin/http";
import { getPlatformSettings, savePlatformSettings } from "@/lib/platform/settings";
import {
  DATE_STYLES,
  NOTICE_LEVELS,
  SIGNUP_MODES,
  SettingsInputError,
  cleanBranding,
  cleanContacts,
  cleanNotice,
  cleanRegional,
  cleanRegistration,
  type PlatformSettings,
} from "@/lib/platform/model";
import { emitPlatformEvent } from "@/lib/platform/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECTIONS = ["branding", "contacts", "notice", "regional", "registration"] as const;
type Section = (typeof SECTIONS)[number];

export async function GET(req: Request) {
  const g = await requireAdmin(req, "settings:write");
  if (!g.ok) return g.response;
  return NextResponse.json({
    ok: true,
    settings: await getPlatformSettings(),
    options: { noticeLevels: NOTICE_LEVELS, dateStyles: DATE_STYLES, signupModes: SIGNUP_MODES },
  });
}

export async function PATCH(req: Request) {
  const g = await requireAdmin(req, "settings:write");
  if (!g.ok) return g.response;
  const body = await readJson<{ section?: unknown; value?: unknown }>(req);
  const section = body?.section as Section;
  if (!SECTIONS.includes(section)) return fail("invalid_section", "Say which settings to change.");

  const current = await getPlatformSettings();
  const now = Date.now();
  let next: PlatformSettings;
  try {
    const value =
      section === "branding"
        ? cleanBranding(body?.value, current.branding)
        : section === "contacts"
          ? cleanContacts(body?.value)
          : section === "notice"
            ? cleanNotice(body?.value, `n_${randomUUID().slice(0, 8)}`)
            : section === "regional"
              ? cleanRegional(body?.value)
              : cleanRegistration(body?.value, current.registration, now);
    next = { ...current, [section]: value };
  } catch (err) {
    if (err instanceof SettingsInputError) return fail(err.code, err.message);
    throw err;
  }

  const saved = await savePlatformSettings(next);
  const before = current[section] as unknown as Record<string, unknown>;
  const after = saved[section] as unknown as Record<string, unknown>;
  const changes = diff(before, after);
  await recordAdminAction(actorOf(g.ctx), req, {
    action: `settings.${section}.update`,
    targetType: "settings",
    targetId: section,
    targetLabel: section,
    before: changes.before,
    after: changes.after,
  });
  await emitPlatformEvent("settings.changed", { section, changed: Object.keys(changes.after) });
  return NextResponse.json({ ok: true, settings: saved });
}
