"use client";

// Camera, microphone and speaker pickers for the join page: before joining
// (with a preview and a test sound) and while live (switched in place).

import type { DeviceOption, MediaDevicesState } from "./useMediaDevices";

export interface DeviceChoice {
  cameraId: string;
  micId: string;
  speakerId: string;
}

function Picker({
  label,
  value,
  options,
  onChange,
  disabled,
  defaultLabel,
}: {
  label: string;
  value: string;
  options: DeviceOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
  defaultLabel: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-white/45">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="w-full min-w-0 truncate rounded-lg border border-white/12 bg-[#0B1319] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
      >
        <option value="">{defaultLabel}</option>
        {options.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function DeviceSettings({
  devices,
  choice,
  onChange,
  show = { camera: true, mic: true, speaker: true },
  onTestSpeaker,
}: {
  devices: MediaDevicesState;
  choice: DeviceChoice;
  onChange: (next: DeviceChoice) => void;
  show?: { camera: boolean; mic: boolean; speaker: boolean };
  onTestSpeaker?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {show.camera && (
        <Picker
          label="Camera"
          value={choice.cameraId}
          options={devices.cameras}
          defaultLabel={devices.cameras.length ? "System default camera" : "No camera found"}
          onChange={(cameraId) => onChange({ ...choice, cameraId })}
        />
      )}
      {show.mic && (
        <Picker
          label="Microphone"
          value={choice.micId}
          options={devices.microphones}
          defaultLabel={devices.microphones.length ? "System default microphone" : "No microphone found"}
          onChange={(micId) => onChange({ ...choice, micId })}
        />
      )}
      {show.speaker &&
        (devices.canChooseSpeaker ? (
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Picker
                label="Speaker"
                value={choice.speakerId}
                options={devices.speakers}
                defaultLabel="System default speaker"
                onChange={(speakerId) => onChange({ ...choice, speakerId })}
              />
            </div>
            {onTestSpeaker && (
              <button
                type="button"
                onClick={onTestSpeaker}
                className="shrink-0 rounded-lg border border-white/12 px-3 py-2 text-sm text-white/85 transition hover:bg-white/10"
              >
                Test
              </button>
            )}
          </div>
        ) : (
          <p className="text-xs text-white/50">
            Speaker: this browser plays through your system&apos;s output. Change it in your device&apos;s sound settings
            (choosing a speaker here works in Chrome, Edge and Firefox on a computer).
          </p>
        ))}
      {(show.camera || show.mic) && !devices.labelled && (devices.cameras.length > 0 || devices.microphones.length > 0) && (
        <p className="text-xs text-white/50">Device names appear once you allow the camera and microphone.</p>
      )}
    </div>
  );
}
