"use client";

// The cameras, microphones and speakers this browser offers, kept current
// as devices are plugged in or removed. Virtual cameras (OBS Virtual Camera,
// vMix, Snap Camera, NDI…) are ordinary video inputs to the browser, so they
// are listed like any other.
//
// Browsers hide device names until the page has been allowed the camera or
// mic once; until then the lists hold "Camera 1"-style placeholders and
// `labelled` is false. Call refresh() after permission is granted.

import { useCallback, useEffect, useState } from "react";

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface MediaDevicesState {
  cameras: DeviceOption[];
  microphones: DeviceOption[];
  speakers: DeviceOption[];
  /** Real names are showing (permission was granted at least once). */
  labelled: boolean;
  /** This browser can send sound to a chosen speaker (setSinkId). */
  canChooseSpeaker: boolean;
  refresh: () => Promise<void>;
}

export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

export function deviceOptions(list: Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[], kind: MediaDeviceKind, noun: string): DeviceOption[] {
  const seen = new Set<string>();
  const out: DeviceOption[] = [];
  for (const d of list) {
    if (d.kind !== kind) continue;
    // "default" and "communications" are aliases Chrome adds on Windows for
    // devices already in the list; the empty choice ("System default")
    // stands for them.
    if (d.deviceId === "default" || d.deviceId === "communications") continue;
    if (!d.deviceId || seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    out.push({ deviceId: d.deviceId, label: d.label || `${noun} ${out.length + 1}` });
  }
  return out;
}

export function useMediaDevices(): MediaDevicesState {
  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [microphones, setMicrophones] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);
  const [labelled, setLabelled] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setCameras(deviceOptions(list, "videoinput", "Camera"));
      setMicrophones(deviceOptions(list, "audioinput", "Microphone"));
      setSpeakers(deviceOptions(list, "audiooutput", "Speaker"));
      setLabelled(list.some((d) => d.label));
    } catch {
      /* enumeration refused: the lists stay as they were */
    }
  }, []);

  useEffect(() => {
    refresh();
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    md?.addEventListener?.("devicechange", refresh);
    return () => md?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  return { cameras, microphones, speakers, labelled, canChooseSpeaker: canChooseSpeaker(), refresh };
}

/** A remembered choice that is no longer plugged in falls back to the system default. */
export function stillThere(id: string, list: DeviceOption[]): string {
  return id && list.some((d) => d.deviceId === id) ? id : "";
}
