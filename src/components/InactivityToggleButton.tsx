'use client';

// src/components/InactivityToggleButton.tsx
//
// Host-only toolbar toggle for the "Are you still here?" idle prompt.
// Lives in the DesktopMoreMenu (data-in-more="true"). Flipping it PATCHes
// the event's inactivity.enabled flag so the change persists across page
// loads and other participants pick it up on their next role-refresh.
// Non-host roles never render this button.

import { useState } from 'react';
import { TimerReset, TimerOff } from 'lucide-react';

const TOOLBAR_BTN_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-transparent px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/10 hover:border-white/25 active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed';

export interface InactivityToggleConfig {
  enabled?: boolean;
  warningMs?: number;
  responseMs?: number;
  autoRemove?: boolean;
  exemptAdmins?: boolean;
}

export default function InactivityToggleButton({
  roomRole,
  eventId,
  config,
  onConfigChanged,
}: {
  roomRole?: string;
  /** Event's id (from /api/events/role). Missing while the role response
   *  is still in flight — button stays disabled in that window rather than
   *  firing a PATCH against a bogus URL. */
  eventId?: string | null;
  config?: InactivityToggleConfig | null;
  onConfigChanged?: (next: InactivityToggleConfig) => void;
}) {
  const [busy, setBusy] = useState(false);
  const isHost = roomRole === 'host' || roomRole === 'cohost';
  if (!isHost) return null;

  // The client-side default is ON (see InactivityDetector), so an
  // unset config reads as enabled.
  const enabled = config?.enabled ?? true;
  const canSave = !busy && Boolean(eventId);

  async function toggle() {
    if (!eventId || busy) return;
    setBusy(true);
    // Send the full config so the PATCH endpoint doesn't wipe the other
    // fields (warningMs, responseMs, autoRemove, exemptAdmins) that the
    // dashboard editor may have set. Only enabled flips.
    const next: InactivityToggleConfig = {
      ...(config ?? {}),
      enabled: !enabled,
    };
    try {
      const res = await fetch('/api/events/' + encodeURIComponent(eventId), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inactivity: next }),
      });
      if (res.ok) {
        onConfigChanged?.(next);
      }
    } catch {
      // silent — button just stays on its current state, host can retry
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      data-toolbar-item="true"
      data-room-chrome="true"
      data-in-more="true"
      onClick={toggle}
      disabled={!canSave}
      className={TOOLBAR_BTN_CLASS}
      title={
        enabled
          ? "Turn off the 'Are you still here?' idle prompt"
          : "Turn on the 'Are you still here?' idle prompt"
      }
      aria-pressed={enabled}
    >
      {enabled ? (
        <TimerReset size={16} aria-hidden />
      ) : (
        <TimerOff size={16} aria-hidden />
      )}
      {enabled ? 'Idle timer on' : 'Idle timer off'}
    </button>
  );
}
