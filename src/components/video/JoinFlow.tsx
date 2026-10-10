"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAmsPublisher } from "./useAmsPublisher";
import SimulcastPlayer from "./SimulcastPlayer";
import AudioMeter from "./AudioMeter";
import DeviceSettings, { type DeviceChoice } from "./DeviceSettings";
import { stillThere, useMediaDevices } from "./useMediaDevices";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

const DEVICE_KEY = "nc:video-device-id";

/** The camera / mic / speaker chosen on this device, remembered across visits. */
const CHOICE_KEY = "nc:media-devices";

function readChoice(): DeviceChoice {
  try {
    const j = JSON.parse(localStorage.getItem(CHOICE_KEY) || "{}");
    return {
      cameraId: typeof j.cameraId === "string" ? j.cameraId : "",
      micId: typeof j.micId === "string" ? j.micId : "",
      speakerId: typeof j.speakerId === "string" ? j.speakerId : "",
    };
  } catch {
    return { cameraId: "", micId: "", speakerId: "" };
  }
}

/** Half a second of a soft 660 Hz tone, as a WAV the browser can play anywhere. */
function testToneUrl(): string {
  const rate = 8000;
  const n = rate / 2;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 400, (n - i) / 400);
    v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 660 * i) / rate) * 6000 * fade, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

interface Slot {
  slot: number;
  name: string;
  streamId: string;
  mainTrack: string;
  wsUrl: string;
  rejoined: boolean;
  /** Checked every few seconds; a moderator can sign this page out. */
  session: string;
}

/** Without storage (some in-app browsers), at least stable for this page. */
let pageDeviceId: string | null = null;

/** Stable per-browser id so a participant can rejoin their own slot. */
function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const made = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    pageDeviceId ??= "nostore-" + Math.random().toString(36).slice(2);
    return pageDeviceId;
  }
}

export default function JoinFlow({ room = SIMULCAST_MAIN }: { room?: string }) {
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  // Join page locked by the moderators (see the effect below).
  const [locked, setLocked] = useState(false);
  // A code was accepted on this visit. Unlocks the languages, and keeps
  // them unlocked after Leave: the code is what's asked for, not the camera.
  const [unlocked, setUnlocked] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Camera, mic and speaker: chosen before joining and changeable while live.
  const devices = useMediaDevices();
  const [choice, setChoiceState] = useState<DeviceChoice>({ cameraId: "", micId: "", speakerId: "" });
  useEffect(() => setChoiceState(readChoice()), []);
  const setChoice = useCallback((next: DeviceChoice) => {
    setChoiceState(next);
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(next));
    } catch {
      /* not remembered this time */
    }
  }, []);
  // A remembered device that is no longer plugged in: back to the default.
  useEffect(() => {
    setChoiceState((c) => {
      const next = {
        cameraId: devices.cameras.length ? stillThere(c.cameraId, devices.cameras) : c.cameraId,
        micId: devices.microphones.length ? stillThere(c.micId, devices.microphones) : c.micId,
        speakerId: devices.speakers.length ? stillThere(c.speakerId, devices.speakers) : c.speakerId,
      };
      return next.cameraId === c.cameraId && next.micId === c.micId && next.speakerId === c.speakerId ? c : next;
    });
  }, [devices.cameras, devices.microphones, devices.speakers]);

  const pub = useAmsPublisher({
    wsUrl: slot?.wsUrl ?? "",
    streamId: slot?.streamId ?? "",
    mainTrack: slot?.mainTrack ?? "",
    videoDeviceId: choice.cameraId,
    audioDeviceId: choice.micId,
  });

  // Before joining: an optional preview of the chosen camera and mic, so
  // the choice can be checked. The camera is on only while testing.
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const publishing = Boolean(pub.localStream);
  const refreshDevices = devices.refresh;
  useEffect(() => {
    if (!testing || publishing) return;
    let cancelled = false;
    let s: MediaStream | null = null;
    setPreviewError(null);
    navigator.mediaDevices
      .getUserMedia({
        video: choice.cameraId ? { deviceId: { exact: choice.cameraId } } : true,
        audio: choice.micId ? { deviceId: { exact: choice.micId } } : true,
      })
      .then((stream) => {
        s = stream;
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        setPreview(stream);
        refreshDevices();
      })
      .catch(() => {
        if (!cancelled) setPreviewError("Could not open that camera or microphone. Allow access, or pick another one.");
      });
    return () => {
      cancelled = true;
      s?.getTracks().forEach((t) => t.stop());
      setPreview(null);
    };
  }, [testing, publishing, choice.cameraId, choice.micId, refreshDevices]);

  // Once live, the browser has permission: real device names can be listed.
  useEffect(() => {
    if (publishing) refreshDevices();
  }, [publishing, refreshDevices]);

  const shown = pub.localStream ?? preview;
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (shown && el.srcObject !== shown) {
      el.srcObject = shown;
      el.play().catch(() => {});
    }
    if (!shown) el.srcObject = null;
  }, [shown]);

  const testSpeaker = useCallback(async () => {
    const url = testToneUrl();
    const a = new Audio(url) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    try {
      if (choice.speakerId && a.setSinkId) await a.setSinkId(choice.speakerId);
    } catch {
      /* plays on the default output */
    }
    a.onended = () => URL.revokeObjectURL(url);
    a.play().catch(() => URL.revokeObjectURL(url));
  }, [choice.speakerId]);

  const joinWithCamera = useCallback(() => {
    // Free the preview's camera first: some webcams open only once.
    setTesting(false);
    pub.start();
  }, [pub]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const value = code.trim();
      if (!value || checking) return;

      setChecking(true);
      setError(null);
      try {
        const r = await fetch(`/api/video/join?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: value, deviceId: deviceId() }),
        });
        const j = await r.json();
        if (!j.ok) {
          if (j.locked) {
            setLocked(true);
            setError(null);
            return;
          }
          setError(j.error ?? "That code did not work.");
          return;
        }
        setUnlocked(true);
        setSlot({
          slot: j.slot,
          name: j.name,
          streamId: j.streamId,
          mainTrack: j.mainTrack,
          wsUrl: j.wsUrl,
          rejoined: Boolean(j.rejoined),
          session: String(j.session ?? ""),
        });
      } catch {
        setError("Could not reach the event. Check your connection.");
      } finally {
        setChecking(false);
      }
    },
    [code, checking, room],
  );

  const leave = useCallback(async () => {
    pub.stop();
    try {
      await fetch(`/api/video/join?room=${encodeURIComponent(room)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, deviceId: deviceId(), leave: true }),
      });
    } catch {
      /* the claim expires on its own */
    }
    setSlot(null);
    setCode("");
  }, [pub, code, room]);

  // Every 10 s (and on coming back to the tab) ask whether this page may
  // keep its slot. Signed out by a moderator, or the code moved to another
  // device: stop the camera here so it cannot reconnect, and say why.
  // The join page can be locked by the moderators: codes do not work until
  // they open it. Asked on arrival and every 15 s until joined, so the page
  // opens by itself the moment they do.
  const joined = Boolean(slot);
  useEffect(() => {
    if (joined) return;
    let stop = false;
    const ask = async () => {
      try {
        const r = await fetch(`/api/video/join?room=${encodeURIComponent(room)}`, { cache: "no-store" });
        const j = (await r.json()) as { locked?: boolean };
        if (!stop) setLocked(Boolean(j.locked));
      } catch {
        /* ask again next time */
      }
    };
    void ask();
    const t = setInterval(ask, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [room, joined]);

  const session = slot?.session ?? "";
  // The publisher object is new on every render; reach its stop() through a
  // ref so the timer is not reset each time.
  const stopRef = useRef(pub.stop);
  stopRef.current = pub.stop;
  useEffect(() => {
    if (!session) return;
    let gone = false;
    const check = async () => {
      if (gone) return;
      try {
        const r = await fetch(`/api/video/join?room=${encodeURIComponent(room)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ check: session }),
        });
        const j = (await r.json()) as { keep?: boolean; reason?: string };
        if (gone || j.keep !== false) return;
        gone = true;
        stopRef.current();
        setSlot(null);
        setCode("");
        setError(
          j.reason === "signed_out"
            ? "A moderator signed you out. Enter your code to join again."
            : "Your code is now in use on another device.",
        );
      } catch {
        /* offline for a moment: ask again next time */
      }
    };
    const timer = setInterval(check, 10_000);
    const onShow = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      gone = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [session, room]);

  const statusLine = (() => {
    switch (pub.state) {
      case "requesting-camera":
        return "Asking for your camera…";
      case "connecting":
        return "Connecting…";
      case "publishing":
        return "You are live in the control room.";
      case "reconnecting":
        return "Connection dropped — reconnecting…";
      case "denied":
        return "Camera blocked.";
      case "taken":
        return "Slot already live elsewhere.";
      case "failed":
        return "Could not publish.";
      default:
        return "Ready when you are.";
    }
  })();

  const live = pub.state === "publishing";

  return (
    <div className="mx-auto grid w-full gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* Programme feed is the main focus. Participants watch the show
          they're joining and can listen in a chosen language while they
          enter their code or wait for their turn on air. Player renders
          full-width on mobile, then side-by-side with the join / slot
          panel on lg+ so both are visible at once without scrolling. */}
      <div className="min-w-0">
        {/* The programme's sound plays for everyone, starting on the first
            tap anywhere, with no mute. Everything else on the page — the
            picture, the languages, going on camera — needs the code first. */}
        <SimulcastPlayer
          room={room}
          showChat={false}
          soundOnFirstTap
          sinkId={choice.speakerId}
          pictureLocked={unlocked ? undefined : "Listen now. Enter your code to see the video."}
          languagesLocked={unlocked ? undefined : "Enter your code to choose a language."}
        />
      </div>

      <div className="flex flex-col gap-4">
      {!slot ? (
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-xl border border-white/12 bg-[#141C22] p-6"
        >
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
              Join the event
            </span>
            <h2 className="text-xl font-bold tracking-tight text-white">Enter your code</h2>
            <p className="max-w-[46ch] text-sm text-white/60">
              It is on your invitation. It unlocks the video, the languages and joining
              with your camera; your camera turns on only after you press Join.
            </p>
          </div>

          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={12}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="XXXX-00"
            aria-label="Participant code"
            className="w-full rounded-lg border border-white/12 bg-[#0B1319] px-4 py-3 text-center font-mono text-xl tracking-[0.28em] text-white outline-none placeholder:text-white/30 focus:ring-2 focus:ring-emerald-500"
          />

          {locked && (
            <p role="status" className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              Joining is not open yet. Your code will work as soon as the moderators open it; this
              page opens by itself.
            </p>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={!code.trim() || checking || locked}
            className="rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {checking ? "Checking…" : locked ? "Waiting to open…" : "Continue"}
          </button>

          {/* Already listening: the speaker can be chosen before the code. */}
          <DeviceSettings
            devices={devices}
            choice={choice}
            onChange={setChoice}
            show={{ camera: false, mic: false, speaker: true }}
            onTestSpeaker={testSpeaker}
          />
        </form>
      ) : (
        <div className="flex flex-col gap-4 rounded-xl border border-white/12 bg-[#141C22] p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-col">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
                Slot {slot.slot}
              </span>
              <h2 className="text-xl font-bold tracking-tight text-white">{slot.name}</h2>
            </div>
            <span
              className={[
                "rounded px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em]",
                live ? "bg-red-600 text-white" : "border border-white/12 text-white/60",
              ].join(" ")}
            >
              {live ? "Live" : "Off"}
            </span>
          </div>

          <div className="relative aspect-video overflow-hidden rounded-lg border border-white/12 bg-black">
            <video
              ref={videoRef}
              playsInline
              autoPlay
              muted
              className="h-full w-full scale-x-[-1] object-cover"
            />
            {!shown && (
              <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] uppercase tracking-[0.14em] text-white/50">
                camera off
              </span>
            )}
            {preview && !pub.localStream && (
              <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/80">
                Preview · not live
              </span>
            )}
          </div>

          {shown && (
            <div className="flex items-center gap-2 text-xs text-white/60">
              <span>Mic</span>
              <AudioMeter stream={shown} />
            </div>
          )}

          <DeviceSettings devices={devices} choice={choice} onChange={setChoice} onTestSpeaker={testSpeaker} />
          {live && <p className="text-xs text-white/45">Changes apply straight away; you stay live.</p>}
          {previewError && <p className="text-sm text-red-400">{previewError}</p>}

          <p className="text-sm text-white/60">{statusLine}</p>
          {pub.error && <p className="text-sm text-red-400">{pub.error}</p>}
          {slot.rejoined && !pub.error && (
            <p className="text-xs text-white/45">Welcome back — this is your slot from earlier.</p>
          )}

          <div className="flex flex-wrap gap-2">
            {!live && pub.state !== "connecting" && pub.state !== "requesting-camera" ? (
              <>
                <button
                  type="button"
                  onClick={joinWithCamera}
                  className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500"
                >
                  Join with camera
                </button>
                <button
                  type="button"
                  onClick={() => setTesting((t) => !t)}
                  className="rounded-lg border border-white/12 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  {testing ? "Stop preview" : "Preview camera & mic"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={pub.toggleMic}
                  className="rounded-lg border border-white/12 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  {pub.micOn ? "Mute mic" : "Unmute mic"}
                </button>
                <button
                  type="button"
                  onClick={pub.toggleCam}
                  className="rounded-lg border border-white/12 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  {pub.camOn ? "Stop camera" : "Start camera"}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={leave}
              className="ml-auto rounded-lg border border-white/12 px-4 py-2.5 text-sm font-medium text-white/60 transition hover:bg-white/10"
            >
              Leave
            </button>
          </div>

          <p className="font-mono text-[11px] text-white/45">
            {slot.streamId} · 320×240 · 15 fps
          </p>
        </div>
      )}
      </div>
    </div>
  );
}
