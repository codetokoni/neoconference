"use client";

// src/components/DeviceSelectListener.tsx
//
// Bridges the Settings modal's CustomEvent broadcasts to the live LiveKit
// session so changing a device or audio-processing toggle in Settings
// actually takes effect mid-call.
//
// Events handled:
//   neoconf:device-select  detail: { kind: "audioinput"|"videoinput"|"audiooutput", deviceId: string }
//     -> room.switchActiveDevice(kind, deviceId)
//
//   neoconf:audio-prefs    detail: { ns?: boolean; ec?: boolean; agc?: boolean }
//     -> republish mic track with merged noise-suppression / echo-cancel / AGC
//        constraints via localParticipant.setMicrophoneEnabled(true, captureOptions)
//        (only when mic is currently enabled; never auto-unmutes the user)
//
// Side-effect-only component; renders null. Mount inside <LiveKitRoom>.

import { useEffect, useRef } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";

type DeviceKind = "audioinput" | "videoinput" | "audiooutput";

const SETTINGS_LS = {
  mic: "neoconf:device:mic",
  cam: "neoconf:device:cam",
  spk: "neoconf:device:spk",
} as const;

const LEGACY_LS = {
  audioinput: "neoconf:device:audioId",
  videoinput: "neoconf:device:videoId",
  audiooutput: "neoconf:device:audioOutId",
} as const;

const AUDIO_PREFS_LS = {
  ns: "neoconf:audio:noiseSuppression",
  ec: "neoconf:audio:echoCancellation",
  agc: "neoconf:audio:autoGainControl",
} as const;

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1" || raw === "true";
  } catch {
    return fallback;
  }
}

function mirrorDeviceIdToLegacyKeys(kind: DeviceKind, deviceId: string) {
  try {
    window.localStorage.setItem(LEGACY_LS[kind], deviceId);
    const settingsKey =
      kind === "audioinput" ? SETTINGS_LS.mic
      : kind === "videoinput" ? SETTINGS_LS.cam
      : SETTINGS_LS.spk;
    window.localStorage.setItem(settingsKey, deviceId);
  } catch {
    // localStorage may be blocked in private modes; non-fatal.
  }
}

/**
 * DeviceSelectListener
 *
 * Mount inside <LiveKitRoom> (anywhere — it renders null). Subscribes once
 * on mount to two window CustomEvents emitted by the Settings modal and
 * applies them to the live Room. No UI, no toolbar footprint.
 */
export default function DeviceSelectListener() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();

  // Latest known mic enabled state, captured fresh on each republish.
  // Stored in a ref so the audio-prefs listener doesn't need a re-bind
  // every time isMicrophoneEnabled flips.
  const busyRef = useRef(false);
  const lastDeviceAppliedAtRef = useRef<Record<DeviceKind, number>>({
    audioinput: 0,
    videoinput: 0,
    audiooutput: 0,
  });

  // ---- neoconf:device-select ----
  useEffect(() => {
    if (!room) return;

    const onSelect = async (e: Event) => {
      const ce = e as CustomEvent<{ kind?: DeviceKind; deviceId?: string }>;
      const kind = ce.detail?.kind;
      const deviceId = ce.detail?.deviceId;
      if (!kind || !deviceId) return;

      // Debounce duplicate dispatches (Settings can fire on every keystroke
      // inside the select; we want at most one switch per ~150ms per kind).
      const now = Date.now();
      const last = lastDeviceAppliedAtRef.current[kind];
      if (now - last < 150) return;
      lastDeviceAppliedAtRef.current[kind] = now;

      try {
        await room.switchActiveDevice(kind, deviceId);
        mirrorDeviceIdToLegacyKeys(kind, deviceId);
      } catch (err) {
        // Browser may lack setSinkId, or the device was unplugged between
        // enumerate and apply. Either way: silent recovery.
        console.warn("[device-select] switchActiveDevice failed", kind, err);
      }
    };

    window.addEventListener("neoconf:device-select", onSelect as EventListener);
    return () => {
      window.removeEventListener("neoconf:device-select", onSelect as EventListener);
    };
  }, [room]);

  // ---- neoconf:audio-prefs ----
  useEffect(() => {
    if (!localParticipant) return;

    const onPrefs = async (e: Event) => {
      const ce = e as CustomEvent<{ ns?: boolean; ec?: boolean; agc?: boolean }>;

      // The dispatcher may include only the changed field; always read the
      // full triplet from storage so we republish with a coherent set.
      const ns = ce.detail?.ns ?? readBool(AUDIO_PREFS_LS.ns, true);
      const ec = ce.detail?.ec ?? readBool(AUDIO_PREFS_LS.ec, true);
      const agc = ce.detail?.agc ?? readBool(AUDIO_PREFS_LS.agc, true);

      // Never auto-unmute the user. If they're currently muted, persist
      // the preference (Settings already did) and let next unmute pick
      // it up via the prejoin captureOptions path.
      if (!localParticipant.isMicrophoneEnabled) return;
      if (busyRef.current) return;
      busyRef.current = true;

      try {
        // Carry over the active mic device id so the republish stays
        // on the user's chosen input.
        let deviceId: string | undefined;
        try {
          const stored =
            window.localStorage.getItem(LEGACY_LS.audioinput) ||
            window.localStorage.getItem(SETTINGS_LS.mic) ||
            "";
          if (stored) deviceId = stored;
        } catch {
          /* ignore */
        }

        const captureOptions: Record<string, unknown> = {
          noiseSuppression: ns,
          echoCancellation: ec,
          autoGainControl: agc,
        };
        if (deviceId) captureOptions.deviceId = deviceId;

        await localParticipant.setMicrophoneEnabled(true, captureOptions);
      } catch (err) {
        console.warn("[audio-prefs] republish failed", err);
      } finally {
        // Brief tail so back-to-back toggles coalesce instead of fighting
        // the WebRTC track-restart machinery.
        setTimeout(() => {
          busyRef.current = false;
        }, 250);
      }
    };

    window.addEventListener("neoconf:audio-prefs", onPrefs as EventListener);
    return () => {
      window.removeEventListener("neoconf:audio-prefs", onPrefs as EventListener);
    };
  }, [localParticipant]);

  return null;
}
