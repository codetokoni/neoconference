// src/lib/ops/siteSurface.ts
//
// Where incidents and maintenance windows reach users: the site-wide notice
// banner and maintenance mode that the settings area owns. Ops has neither
// of its own. Every call names an owner ("incident:<id>",
// "maintenance:<id>"); ops only replaces or clears a notice, or ends
// maintenance mode, that it put there under that owner — what an
// administrator set by hand is left alone and reported back.

import { settingsSurface } from "@/lib/platform/opsSurface";

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

// The settings area (src/lib/platform/opsSurface.ts) is the one real backend.
let current: SiteSurface = settingsSurface;

export const siteSurface: SiteSurface = {
  showNotice: (o, n) => current.showNotice(o, n),
  clearNotice: (o) => current.clearNotice(o),
  startMaintenance: (o, m, e) => current.startMaintenance(o, m, e),
  endMaintenance: (o) => current.endMaintenance(o),
};

/** Tests: stand in for the settings area. Null restores the default. */
export function __setSiteSurface(s: SiteSurface | null): void {
  current = s ?? settingsSurface;
}
