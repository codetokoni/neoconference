// src/lib/ops/siteSurface.ts
//
// Where incidents and maintenance windows reach users: the site-wide notice
// banner and maintenance mode that the settings area owns. Ops has neither
// of its own. Every call names an owner ("incident:<id>",
// "maintenance:<id>"); ops only replaces or clears a notice, or ends
// maintenance mode, that it put there under that owner — what an
// administrator set by hand is left alone and reported back.

import { kv } from "@/lib/kv";
import { getFeatureControls, getPlatformSettings, saveFeatureControls, savePlatformSettings } from "@/lib/platform/settings";
import { maintenanceActive, noticeActive, type PlatformNotice } from "@/lib/platform/model";
import { newId } from "@/lib/ops/util";

export interface SurfaceResult {
  ok: boolean;
  detail: string;
}

export interface NoticeInput {
  level: "info" | "warning" | "critical";
  message: string;
  endsAt: number | null;
}

export interface SiteSurface {
  showNotice(owner: string, n: NoticeInput): Promise<SurfaceResult>;
  clearNotice(owner: string): Promise<SurfaceResult>;
  startMaintenance(owner: string, message: string, endsAt: number): Promise<SurfaceResult>;
  endMaintenance(owner: string): Promise<SurfaceResult>;
}

// Which notice ops last put up, so it only ever replaces or clears its own:
//   neo:ops:surface:notice   { owner, noticeId }
// Maintenance mode records its starter itself (startedBy "ops:<owner>").
const NOTICE_OWNER = "neo:ops:surface:notice";

type NoticeOwner = { owner: string; noticeId: string };

async function noticeOwner(): Promise<NoticeOwner | null> {
  const raw = await kv.get(NOTICE_OWNER);
  if (!raw) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as NoticeOwner;
}

/** The Settings area's site notice and maintenance mode (src/lib/platform/settings.ts). */
export const platformSurface: SiteSurface = {
  async showNotice(owner, n) {
    const settings = await getPlatformSettings();
    const cur = settings.notice;
    const mine = await noticeOwner();
    const oursNow = !!mine && mine.noticeId === cur.id;
    if (noticeActive(cur) && !oursNow) return { ok: false, detail: "the site notice is in use by an administrator; not replaced" };
    if (oursNow && mine!.owner === owner && cur.enabled && cur.message === n.message && cur.level === n.level && cur.endsAt === n.endsAt) {
      // Unchanged: no new id, so a visitor who dismissed it is not shown it again.
      return { ok: true, detail: "shown in the site notice" };
    }
    const notice: PlatformNotice = {
      id: newId("ops"),
      enabled: true,
      level: n.level,
      message: n.message,
      linkUrl: "",
      linkLabel: "",
      startsAt: null,
      endsAt: n.endsAt,
      dismissible: n.level !== "critical",
    };
    await savePlatformSettings({ ...settings, notice });
    await kv.set(NOTICE_OWNER, JSON.stringify({ owner, noticeId: notice.id }));
    return { ok: true, detail: "shown in the site notice" };
  },
  async clearNotice(owner) {
    const mine = await noticeOwner();
    if (!mine || mine.owner !== owner) return { ok: true, detail: "nothing of this shown on the site" };
    const settings = await getPlatformSettings();
    if (settings.notice.id === mine.noticeId && settings.notice.enabled) {
      await savePlatformSettings({ ...settings, notice: { ...settings.notice, enabled: false } });
    }
    await kv.del(NOTICE_OWNER);
    return { ok: true, detail: "taken off the site notice" };
  },
  async startMaintenance(owner, message, endsAt) {
    const controls = await getFeatureControls();
    const m = controls.maintenance;
    const by = `ops:${owner}`;
    if (maintenanceActive(m) && m.startedBy !== by) return { ok: false, detail: "maintenance mode is already on (turned on by someone else); left as it is" };
    if (m.enabled && m.startedBy === by && m.message === message && m.endsAt === endsAt) return { ok: true, detail: "maintenance mode on" };
    await saveFeatureControls({ ...controls, maintenance: { enabled: true, message, endsAt, startedAt: m.startedBy === by && m.startedAt ? m.startedAt : Date.now(), startedBy: by } });
    return { ok: true, detail: "maintenance mode on" };
  },
  async endMaintenance(owner) {
    const controls = await getFeatureControls();
    const m = controls.maintenance;
    if (!m.enabled || m.startedBy !== `ops:${owner}`) return { ok: true, detail: "maintenance mode not ours; left as it is" };
    await saveFeatureControls({ ...controls, maintenance: { ...m, enabled: false } });
    return { ok: true, detail: "maintenance mode off" };
  },
};

let current: SiteSurface = platformSurface;

export const siteSurface: SiteSurface = {
  showNotice: (o, n) => current.showNotice(o, n),
  clearNotice: (o) => current.clearNotice(o),
  startMaintenance: (o, m, e) => current.startMaintenance(o, m, e),
  endMaintenance: (o) => current.endMaintenance(o),
};

/** Tests: stand in for the settings area. Null restores the default. */
export function __setSiteSurface(s: SiteSurface | null): void {
  current = s ?? platformSurface;
}
