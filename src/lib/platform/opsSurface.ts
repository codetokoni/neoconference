// src/lib/platform/opsSurface.ts
//
// The settings area's side of src/lib/ops/siteSurface.ts: incidents and
// maintenance windows (system operations) shown through the site notice
// banner and maintenance mode. Ops never takes over what an administrator
// set by hand:
//
//   - a notice is replaced only when none is live, or the live one is one
//     ops wrote (KV neo:ops:surface:notice remembers { owner, noticeId });
//     it is cleared only by the owner that wrote it;
//   - maintenance mode is turned on only when it is off or already ops's
//     under the same owner (startedBy "ops:<owner>"), and off only by that
//     owner.
//
// Every change is audited as the system actor "ops:<owner>", and the
// maintenance webhooks fire as they do for an administrator.

import { randomUUID } from "crypto";
import { kv } from "@/lib/kv";
import { recordAdminAction } from "@/lib/admin/audit";
import { maintenanceActive, type PlatformNotice } from "@/lib/platform/model";
import { getFeatureControls, getPlatformSettings, saveFeatureControls, savePlatformSettings } from "@/lib/platform/settings";
import { emitPlatformEvent } from "@/lib/platform/webhooks";
import type { NoticeInput, SiteSurface, SurfaceResult } from "@/lib/ops/siteSurface";

const OPS_NOTICE = "neo:ops:surface:notice";

type OpsNotice = { owner: string; noticeId: string };

function parse<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

const actor = (owner: string) => ({ userId: "system", email: `ops:${owner}` });

/** Live, or still to come: an administrator's notice in this state is never replaced. */
function noticeInPlay(n: PlatformNotice, now = Date.now()): boolean {
  return n.enabled && !!n.message.trim() && !(n.endsAt && now >= n.endsAt);
}

async function showNotice(owner: string, input: NoticeInput): Promise<SurfaceResult> {
  const settings = await getPlatformSettings();
  const mine = parse<OpsNotice>(await kv.get(OPS_NOTICE));
  const current = settings.notice;
  const opsWroteIt = !!mine && mine.noticeId === current.id;
  if (noticeInPlay(current) && !opsWroteIt) {
    return { ok: false, detail: "site notice in use by an administrator; not replaced" };
  }
  const message = input.message.trim().slice(0, 500);
  if (!message) return { ok: false, detail: "nothing to show" };
  // Same owner, same words: leave it, so a dismissed notice is not shown again on every run.
  if (opsWroteIt && mine!.owner === owner && noticeInPlay(current) && current.message === message && current.level === input.level && current.endsAt === input.endsAt) {
    return { ok: true, detail: "notice already showing" };
  }
  const notice: PlatformNotice = {
    id: `ops_${randomUUID().slice(0, 8)}`,
    enabled: true,
    level: input.level,
    message,
    linkUrl: "",
    linkLabel: "",
    startsAt: null,
    endsAt: input.endsAt,
    dismissible: input.level !== "critical",
  };
  await savePlatformSettings({ ...settings, notice });
  await kv.set(OPS_NOTICE, JSON.stringify({ owner, noticeId: notice.id } satisfies OpsNotice));
  await recordAdminAction(actor(owner), null, {
    action: "settings.notice.ops",
    targetType: "settings",
    targetId: "notice",
    targetLabel: owner,
    before: { id: current.id, enabled: current.enabled, message: current.message },
    after: { id: notice.id, enabled: true, level: notice.level, message, endsAt: notice.endsAt },
  });
  return { ok: true, detail: "notice shown" };
}

async function clearNotice(owner: string): Promise<SurfaceResult> {
  const settings = await getPlatformSettings();
  const mine = parse<OpsNotice>(await kv.get(OPS_NOTICE));
  if (!mine || mine.owner !== owner || mine.noticeId !== settings.notice.id) {
    return { ok: true, detail: "no notice of this one's on the site" };
  }
  await savePlatformSettings({ ...settings, notice: { ...settings.notice, enabled: false } });
  await kv.del(OPS_NOTICE);
  await recordAdminAction(actor(owner), null, {
    action: "settings.notice.ops",
    targetType: "settings",
    targetId: "notice",
    targetLabel: owner,
    before: { id: settings.notice.id, enabled: settings.notice.enabled },
    after: { id: settings.notice.id, enabled: false },
  });
  return { ok: true, detail: "notice cleared" };
}

async function startMaintenance(owner: string, message: string, endsAt: number): Promise<SurfaceResult> {
  const controls = await getFeatureControls();
  const m = controls.maintenance;
  const by = `ops:${owner}`;
  if (maintenanceActive(m) && m.startedBy !== by) {
    return { ok: false, detail: `maintenance mode already on (${m.startedBy ?? "an administrator"}); not changed` };
  }
  const text = message.trim().slice(0, 1000) || m.message;
  if (maintenanceActive(m) && m.message === text && m.endsAt === endsAt) return { ok: true, detail: "maintenance mode already on" };
  const wasOn = maintenanceActive(m);
  await saveFeatureControls({
    ...controls,
    maintenance: { enabled: true, message: text, endsAt, startedAt: wasOn ? m.startedAt : Date.now(), startedBy: by },
  });
  await recordAdminAction(actor(owner), null, {
    action: wasOn ? "maintenance.update" : "maintenance.on",
    targetType: "maintenance",
    targetId: "platform",
    targetLabel: "maintenance mode",
    before: { enabled: wasOn, message: m.message, endsAt: m.endsAt },
    after: { enabled: true, message: text, endsAt },
  });
  if (!wasOn) await emitPlatformEvent("maintenance.started", { message: text, endsAt, by });
  return { ok: true, detail: "maintenance mode on" };
}

async function endMaintenance(owner: string): Promise<SurfaceResult> {
  const controls = await getFeatureControls();
  const m = controls.maintenance;
  if (!m.enabled || m.startedBy !== `ops:${owner}`) return { ok: true, detail: "maintenance mode not this one's" };
  await saveFeatureControls({ ...controls, maintenance: { enabled: false, message: m.message, endsAt: null, startedAt: null, startedBy: null } });
  await recordAdminAction(actor(owner), null, {
    action: "maintenance.off",
    targetType: "maintenance",
    targetId: "platform",
    targetLabel: "maintenance mode",
    before: { enabled: true, message: m.message, endsAt: m.endsAt },
    after: { enabled: false },
  });
  await emitPlatformEvent("maintenance.ended", { message: m.message, by: `ops:${owner}` });
  return { ok: true, detail: "maintenance mode off" };
}

export const settingsSurface: SiteSurface = { showNotice, clearNotice, startMaintenance, endMaintenance };
