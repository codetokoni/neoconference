// src/lib/ops/incidents.ts
//
// Incidents (investigating → identified → monitoring → resolved, with a
// timeline of updates) and scheduled maintenance windows.
//
// Neither has a banner or a switch of its own: an incident can be shown in
// the site-wide notice, and a maintenance window can turn on maintenance
// mode for its duration — both through the settings phase's notice and
// maintenance mode (src/lib/ops/siteSurface.ts). Ops only ever clears what
// it put there itself; an administrator's own notice is never overwritten.
//
//   neo:ops:incidents     hash id -> Incident
//   neo:ops:maintenance   hash id -> MaintenanceWindow

import { kv } from "@/lib/kv";
import { newId, readHash, parseJson } from "@/lib/ops/util";
import { siteSurface, type SurfaceResult } from "@/lib/ops/siteSurface";

export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const IMPACTS = ["minor", "major", "critical"] as const;
export type Impact = (typeof IMPACTS)[number];

export interface IncidentUpdate {
  at: number;
  status: IncidentStatus;
  message: string;
  by: string;
}

export interface Incident {
  id: string;
  title: string;
  impact: Impact;
  status: IncidentStatus;
  services: string[];
  showBanner: boolean;
  /** What happened when ops tried to show it on the site. */
  banner?: SurfaceResult;
  updates: IncidentUpdate[];
  createdAt: number;
  createdBy: string;
  resolvedAt?: number;
}

export type MaintenanceState = "scheduled" | "active" | "completed" | "cancelled";

export interface MaintenanceWindow {
  id: string;
  title: string;
  message: string;
  startsAt: number;
  endsAt: number;
  /** Turn maintenance mode on for the window (otherwise only the notice). */
  maintenanceMode: boolean;
  /** Show the notice before it starts, from this time. */
  announceFrom: number | null;
  state: MaintenanceState;
  createdAt: number;
  createdBy: string;
  surface?: SurfaceResult;
  history: Array<{ at: number; event: string; by: string }>;
}

const INCIDENTS = "neo:ops:incidents";
const MAINT = "neo:ops:maintenance";

export function isIncidentStatus(v: unknown): v is IncidentStatus {
  return typeof v === "string" && (INCIDENT_STATUSES as readonly string[]).includes(v);
}
export function isImpact(v: unknown): v is Impact {
  return typeof v === "string" && (IMPACTS as readonly string[]).includes(v);
}

const level = (i: Impact) => (i === "critical" ? "critical" : i === "major" ? "warning" : "info") as "info" | "warning" | "critical";

export async function listIncidents(): Promise<Incident[]> {
  return Object.values(await readHash<Incident>(INCIDENTS)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getIncident(id: string): Promise<Incident | null> {
  return parseJson<Incident>(await kv.hget(INCIDENTS, id));
}

async function saveIncident(i: Incident): Promise<void> {
  await kv.hset(INCIDENTS, { [i.id]: JSON.stringify(i) });
}

async function syncIncidentBanner(i: Incident): Promise<SurfaceResult> {
  const owner = `incident:${i.id}`;
  if (i.showBanner && i.status !== "resolved") {
    const latest = i.updates[i.updates.length - 1];
    return siteSurface.showNotice(owner, {
      level: level(i.impact),
      message: `${i.title}: ${latest?.message ?? i.status}`.slice(0, 400),
      endsAt: null,
    });
  }
  return siteSurface.clearNotice(owner);
}

export async function createIncident(input: {
  title: string;
  impact: Impact;
  status: IncidentStatus;
  services: string[];
  message: string;
  showBanner: boolean;
  by: string;
}): Promise<Incident> {
  const now = Date.now();
  const i: Incident = {
    id: newId("inc"),
    title: input.title,
    impact: input.impact,
    status: input.status,
    services: input.services,
    showBanner: input.showBanner,
    updates: [{ at: now, status: input.status, message: input.message, by: input.by }],
    createdAt: now,
    createdBy: input.by,
    ...(input.status === "resolved" ? { resolvedAt: now } : {}),
  };
  i.banner = await syncIncidentBanner(i);
  await saveIncident(i);
  return i;
}

export async function updateIncident(
  id: string,
  input: { status?: IncidentStatus; message?: string; showBanner?: boolean; impact?: Impact; by: string },
): Promise<Incident | null> {
  const i = await getIncident(id);
  if (!i) return null;
  const now = Date.now();
  const status = input.status ?? i.status;
  const next: Incident = {
    ...i,
    status,
    impact: input.impact ?? i.impact,
    showBanner: input.showBanner ?? i.showBanner,
    updates: input.message || input.status ? [...i.updates, { at: now, status, message: input.message || `Status: ${status}`, by: input.by }] : i.updates,
    ...(status === "resolved" && !i.resolvedAt ? { resolvedAt: now } : {}),
  };
  next.banner = await syncIncidentBanner(next);
  await saveIncident(next);
  return next;
}

/* ------------------------------ maintenance ------------------------------ */

export async function listMaintenance(): Promise<MaintenanceWindow[]> {
  return Object.values(await readHash<MaintenanceWindow>(MAINT)).sort((a, b) => b.startsAt - a.startsAt);
}

export async function getMaintenance(id: string): Promise<MaintenanceWindow | null> {
  return parseJson<MaintenanceWindow>(await kv.hget(MAINT, id));
}

async function saveMaintenance(m: MaintenanceWindow): Promise<void> {
  await kv.hset(MAINT, { [m.id]: JSON.stringify(m) });
}

export async function scheduleMaintenance(input: {
  title: string;
  message: string;
  startsAt: number;
  endsAt: number;
  maintenanceMode: boolean;
  announceFrom: number | null;
  by: string;
}): Promise<MaintenanceWindow> {
  const now = Date.now();
  const { by, ...fields } = input;
  const m: MaintenanceWindow = {
    id: newId("mw"),
    ...fields,
    state: "scheduled",
    createdAt: now,
    createdBy: by,
    history: [{ at: now, event: "scheduled", by }],
  };
  await saveMaintenance(m);
  const [applied] = await applyMaintenanceWindows(now, [m.id]);
  return applied ?? m;
}

export async function cancelMaintenance(id: string, by: string): Promise<MaintenanceWindow | null> {
  const m = await getMaintenance(id);
  if (!m || m.state === "completed" || m.state === "cancelled") return m;
  const owner = `maintenance:${m.id}`;
  const notice = await siteSurface.clearNotice(owner);
  const mode = await siteSurface.endMaintenance(owner);
  const next: MaintenanceWindow = {
    ...m,
    state: "cancelled",
    surface: { ok: notice.ok && mode.ok, detail: `${notice.detail}; ${mode.detail}` },
    history: [...m.history, { at: Date.now(), event: "cancelled", by }],
  };
  await saveMaintenance(next);
  return next;
}

/**
 * Bring every window's notice and maintenance mode in line with the clock:
 * announce, start, end. Called by the health cron every 5 minutes, and at
 * once when a window is scheduled. Returns the windows it changed.
 */
export async function applyMaintenanceWindows(now = Date.now(), only?: string[]): Promise<MaintenanceWindow[]> {
  const changed: MaintenanceWindow[] = [];
  for (const m of await listMaintenance()) {
    if (only && !only.includes(m.id)) continue;
    if (m.state === "completed" || m.state === "cancelled") continue;
    const owner = `maintenance:${m.id}`;
    let next: MaintenanceWindow | null = null;
    if (now >= m.endsAt) {
      const notice = await siteSurface.clearNotice(owner);
      const mode = m.maintenanceMode ? await siteSurface.endMaintenance(owner) : { ok: true, detail: "maintenance mode not used" };
      next = { ...m, state: "completed", surface: { ok: notice.ok && mode.ok, detail: `${notice.detail}; ${mode.detail}` }, history: [...m.history, { at: now, event: "completed", by: "system" }] };
    } else if (now >= m.startsAt) {
      const notice = await siteSurface.showNotice(owner, { level: "warning", message: `${m.title}: ${m.message}`.slice(0, 400), endsAt: m.endsAt });
      const mode = m.maintenanceMode ? await siteSurface.startMaintenance(owner, m.message, m.endsAt) : { ok: true, detail: "maintenance mode not used" };
      const surface = { ok: notice.ok && mode.ok, detail: `${notice.detail}; ${mode.detail}` };
      if (m.state !== "active" || m.surface?.detail !== surface.detail) {
        next = { ...m, state: "active", surface, history: m.state === "active" ? m.history : [...m.history, { at: now, event: "started", by: "system" }] };
      }
    } else if (m.announceFrom && now >= m.announceFrom) {
      const when = new Date(m.startsAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      const notice = await siteSurface.showNotice(owner, { level: "info", message: `Scheduled maintenance ${when}: ${m.message}`.slice(0, 400), endsAt: m.endsAt });
      if (m.surface?.detail !== notice.detail) next = { ...m, surface: notice };
    }
    if (next) {
      await saveMaintenance(next);
      changed.push(next);
    }
  }
  return changed;
}
