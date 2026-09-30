// src/lib/inactivity.ts
//
// The "Are you still in the meeting?" prompt (FRS §11), as a meeting has
// it when its host never touched the setting. One place for the defaults:
// the room and the dashboard used to keep their own copies, and they
// disagreed on the one that matters — the room removed an idle person by
// default while the dashboard showed hosts "Auto-remove" off. In seven
// days that put 130 people out of their meetings for sitting still: a
// listener on a phone, hearing the translation, touches nothing for five
// minutes and is gone.

export type InactivityConfig = {
  enabled?: boolean;
  /** Idle for this long: show the prompt. */
  warningMs?: number;
  /** Answer within this long, or the prompt closes. */
  responseMs?: number;
  /** An unanswered prompt removes the person from the room. Opt-in. */
  autoRemove?: boolean;
  exemptAdmins?: boolean;
};

export const INACTIVITY_DEFAULTS: Required<InactivityConfig> = {
  enabled: true,
  warningMs: 5 * 60 * 1000,
  responseMs: 60 * 1000,
  // Sitting still is not leaving. A host who wants idle people out says so
  // on the meeting's Edit page; nobody is removed on a default.
  autoRemove: false,
  exemptAdmins: true,
};

/** The prompt's settings for a meeting: what the host set, defaults for the rest. */
export function resolveInactivityConfig(config?: InactivityConfig | null): Required<InactivityConfig> {
  return {
    enabled: config?.enabled ?? INACTIVITY_DEFAULTS.enabled,
    warningMs: config?.warningMs ?? INACTIVITY_DEFAULTS.warningMs,
    responseMs: config?.responseMs ?? INACTIVITY_DEFAULTS.responseMs,
    autoRemove: config?.autoRemove ?? INACTIVITY_DEFAULTS.autoRemove,
    exemptAdmins: config?.exemptAdmins ?? INACTIVITY_DEFAULTS.exemptAdmins,
  };
}
