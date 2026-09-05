"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAmsPublisher } from "./useAmsPublisher";
import { SIMULCAST_MAIN } from "@/lib/simulcast";

const DEVICE_KEY = "nc:video-device-id";

interface Slot {
  slot: number;
  name: string;
  streamId: string;
  mainTrack: string;
  wsUrl: string;
  rejoined: boolean;
}

/** Stable per-browser id so a participant can rejoin their own slot. */
function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const made = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    return "nostore-" + Math.random().toString(36).slice(2);
  }
}

export default function JoinFlow({ room = SIMULCAST_MAIN }: { room?: string }) {
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  const pub = useAmsPublisher({
    wsUrl: slot?.wsUrl ?? "",
    streamId: slot?.streamId ?? "",
    mainTrack: slot?.mainTrack ?? "",
  });

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (pub.localStream && el.srcObject !== pub.localStream) {
      el.srcObject = pub.localStream;
      el.play().catch(() => {});
    }
    if (!pub.localStream) el.srcObject = null;
  }, [pub.localStream]);

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
          setError(j.error ?? "That code did not work.");
          return;
        }
        setSlot({
          slot: j.slot,
          name: j.name,
          streamId: j.streamId,
          mainTrack: j.mainTrack,
          wsUrl: j.wsUrl,
          rejoined: Boolean(j.rejoined),
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
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {!slot ? (
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-xl border border-black/10 bg-white p-6 dark:border-white/10 dark:bg-neutral-900"
        >
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
              Join the event
            </span>
            <h2 className="text-xl font-bold tracking-tight">Enter your code</h2>
            <p className="max-w-[46ch] text-sm text-neutral-600 dark:text-neutral-400">
              It is on your invitation. Your camera turns on only after you press Join.
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
            className="w-full rounded-lg border border-black/10 bg-white px-4 py-3 text-center font-mono text-xl tracking-[0.28em] outline-none focus:ring-2 focus:ring-emerald-500 dark:border-white/15 dark:bg-neutral-950"
          />

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={!code.trim() || checking}
            className="rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {checking ? "Checking…" : "Continue"}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-4 rounded-xl border border-black/10 bg-white p-6 dark:border-white/10 dark:bg-neutral-900">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-col">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-neutral-500">
                Slot {slot.slot}
              </span>
              <h2 className="text-xl font-bold tracking-tight">{slot.name}</h2>
            </div>
            <span
              className={[
                "rounded px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em]",
                live ? "bg-red-600 text-white" : "border border-black/10 text-neutral-500 dark:border-white/15",
              ].join(" ")}
            >
              {live ? "Live" : "Off"}
            </span>
          </div>

          <div className="relative aspect-video overflow-hidden rounded-lg border border-black/10 bg-black dark:border-white/10">
            <video
              ref={videoRef}
              playsInline
              autoPlay
              muted
              className="h-full w-full scale-x-[-1] object-cover"
            />
            {!pub.localStream && (
              <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] uppercase tracking-[0.14em] text-white/50">
                camera off
              </span>
            )}
          </div>

          <p className="text-sm text-neutral-600 dark:text-neutral-400">{statusLine}</p>
          {pub.error && <p className="text-sm text-red-600 dark:text-red-400">{pub.error}</p>}
          {slot.rejoined && !pub.error && (
            <p className="text-xs text-neutral-500">Welcome back — this is your slot from earlier.</p>
          )}

          <div className="flex flex-wrap gap-2">
            {!live && pub.state !== "connecting" && pub.state !== "requesting-camera" ? (
              <button
                type="button"
                onClick={pub.start}
                className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500"
              >
                Join with camera
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={pub.toggleMic}
                  className="rounded-lg border border-black/10 px-4 py-2.5 text-sm font-medium transition hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                >
                  {pub.micOn ? "Mute mic" : "Unmute mic"}
                </button>
                <button
                  type="button"
                  onClick={pub.toggleCam}
                  className="rounded-lg border border-black/10 px-4 py-2.5 text-sm font-medium transition hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                >
                  {pub.camOn ? "Stop camera" : "Start camera"}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={leave}
              className="ml-auto rounded-lg border border-black/10 px-4 py-2.5 text-sm font-medium text-neutral-600 transition hover:bg-black/5 dark:border-white/15 dark:text-neutral-400 dark:hover:bg-white/10"
            >
              Leave
            </button>
          </div>

          <p className="font-mono text-[11px] text-neutral-500">
            {slot.streamId} · 320×240 · 15 fps
          </p>
        </div>
      )}
    </div>
  );
}
