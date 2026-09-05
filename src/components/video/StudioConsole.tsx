"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAmsPublisher, type PublishSource } from "./useAmsPublisher";
import {
  SIMULCAST_CHANNELS,
  SIMULCAST_MAIN,
  VIDEO_CHANNEL,
  type SimulcastChannel,
} from "@/lib/simulcast";

/**
 * Quality presets.
 *
 * The default is deliberately modest: the measured path from the venue to the
 * ingest droplet carried about 640 kbps, and an encoder that outruns the pipe
 * does not degrade gracefully — it falls behind in real time and never
 * catches up. Move up only after watching `speed` hold at 1.0x.
 */
const PRESETS = [
  { id: "safe", label: "360p · 500 kbps", width: 640, height: 360, fps: 25, kbps: 500 },
  { id: "standard", label: "540p · 1.2 Mbps", width: 960, height: 540, fps: 25, kbps: 1200 },
  { id: "full", label: "720p · 2.5 Mbps", width: 1280, height: 720, fps: 30, kbps: 2500 },
] as const;

type PresetId = (typeof PRESETS)[number]["id"];

const BOOTHS: SimulcastChannel[] = SIMULCAST_CHANNELS.filter((c) => !c.video);

export default function StudioConsole({ room = SIMULCAST_MAIN }: { room?: string }) {
  const [mode, setMode] = useState<"programme" | "booth">("programme");
  const [source, setSource] = useState<PublishSource>("camera");
  const [presetId, setPresetId] = useState<PresetId>("safe");
  const [boothId, setBoothId] = useState(BOOTHS[0]?.id ?? "");
  const [live, setLive] = useState<{ ids: Set<string>; viewers: number }>({
    ids: new Set(),
    viewers: 0,
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];

  const booth = mode === "booth";
  const streamId = booth ? boothId : VIDEO_CHANNEL.id;

  const pub = useAmsPublisher({
    wsUrl: process.env.NEXT_PUBLIC_AMS_WS ?? "",
    streamId,
    mainTrack: room,
    source,
    audioOnly: booth,
    width: preset.width,
    height: preset.height,
    frameRate: preset.fps,
    maxBitrateKbps: preset.kbps,
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

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/video/status?room=${encodeURIComponent(room)}`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (!j.ok) return;
      setLive({
        ids: new Set(
          (j.channels as { id: string; live: boolean }[]).filter((c) => c.live).map((c) => c.id),
        ),
        viewers: j.viewers ?? 0,
      });
    } catch {
      /* transient */
    }
  }, [room]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 10000);
    return () => clearInterval(t);
  }, [poll]);

  const publishing = pub.state === "publishing";
  const busy = pub.state === "connecting" || pub.state === "requesting-camera";

  const status = (() => {
    switch (pub.state) {
      case "requesting-camera":
        return source === "screen" && !booth ? "Choose what to share…" : "Asking for your devices…";
      case "connecting":
        return "Connecting to ingest…";
      case "publishing":
        return booth ? "Booth is live." : "Programme feed is live.";
      case "reconnecting":
        return "Dropped — reconnecting…";
      case "denied":
        return "Access refused.";
      case "taken":
        return "That stream id is already publishing elsewhere.";
      default:
        return "Ready.";
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-white/12 p-0.5">
          {(["programme", "booth"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={publishing || busy}
              onClick={() => setMode(m)}
              className={[
                "rounded-md px-3.5 py-1.5 text-sm font-medium transition disabled:opacity-40",
                mode === m
                  ? "bg-emerald-600 text-white"
                  : "text-white/60 hover:bg-white/10",
              ].join(" ")}
            >
              {m === "programme" ? "Programme" : "Interpreter booth"}
            </button>
          ))}
        </div>

        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/45">
          {streamId} · {live.ids.has(streamId) ? "on air" : "off air"} · {live.viewers} watching
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-3">
          <div className="relative aspect-video overflow-hidden rounded-xl border border-white/12 bg-black">
            {!booth ? (
              <video
                ref={videoRef}
                playsInline
                autoPlay
                muted
                className={[
                  "h-full w-full object-contain",
                  source === "camera" ? "scale-x-[-1]" : "",
                ].join(" ")}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/45">
                  audio only
                </span>
              </div>
            )}

            {publishing && (
              <span className="absolute left-3 top-3 inline-flex items-center gap-2 rounded bg-red-600 px-2 py-1 font-mono text-[10.5px] tracking-[0.14em] text-white">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                ON AIR
              </span>
            )}

            {!pub.localStream && !busy && (
              <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] uppercase tracking-[0.14em] text-white/40">
                not started
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!publishing ? (
              <button
                type="button"
                disabled={busy || !streamId}
                onClick={pub.start}
                className="rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-40"
              >
                {busy ? "Starting…" : booth ? "Go live (audio)" : "Go live"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={pub.stop}
                  className="rounded-lg border border-red-500/50 px-5 py-2.5 text-sm font-semibold text-red-300 transition hover:bg-red-500/10"
                >
                  Stop
                </button>
                <button
                  type="button"
                  onClick={pub.toggleMic}
                  className="rounded-lg border border-white/12 px-4 py-2.5 text-sm text-white transition hover:bg-white/10"
                >
                  {pub.micOn ? "Mute mic" : "Unmute mic"}
                </button>
                {!booth && (
                  <button
                    type="button"
                    onClick={pub.toggleCam}
                    className="rounded-lg border border-white/12 px-4 py-2.5 text-sm text-white transition hover:bg-white/10"
                  >
                    {pub.camOn ? "Hide video" : "Show video"}
                  </button>
                )}
              </>
            )}

            <span className="text-sm text-white/60">{status}</span>
          </div>

          {pub.error && <p className="text-sm text-red-400">{pub.error}</p>}
        </div>

        <aside className="flex flex-col gap-4 rounded-xl border border-white/12 bg-[#101820] p-4">
          {booth ? (
            <div className="flex flex-col gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/45">
                Language
              </span>
              {BOOTHS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  disabled={publishing || busy}
                  onClick={() => setBoothId(b.id)}
                  className={[
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm text-white transition disabled:opacity-40",
                    boothId === b.id
                      ? "border-emerald-500 bg-emerald-500/10"
                      : "border-white/12 hover:bg-white/10",
                  ].join(" ")}
                >
                  <span className="h-6 w-1.5 rounded-sm" style={{ background: b.color }} />
                  <span className="flex flex-col leading-tight">
                    <b className="font-semibold">{b.label}</b>
                    <small className="font-mono text-[10px] text-white/45">{b.id}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/45">
                  Source
                </span>
                <div className="flex gap-2">
                  {(["camera", "screen"] as const).map((sxx) => (
                    <button
                      key={sxx}
                      type="button"
                      disabled={publishing || busy}
                      onClick={() => setSource(sxx)}
                      className={[
                        "flex-1 rounded-lg border px-3 py-2 text-sm capitalize text-white transition disabled:opacity-40",
                        source === sxx
                          ? "border-emerald-500 bg-emerald-500/10"
                          : "border-white/12 hover:bg-white/10",
                      ].join(" ")}
                    >
                      {sxx}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/45">
                  Quality
                </span>
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={publishing || busy}
                    onClick={() => setPresetId(p.id)}
                    className={[
                      "rounded-lg border px-3 py-2 text-left text-sm text-white transition disabled:opacity-40",
                      presetId === p.id
                        ? "border-emerald-500 bg-emerald-500/10"
                        : "border-white/12 hover:bg-white/10",
                    ].join(" ")}
                  >
                    {p.label}
                    {p.id === "safe" && (
                      <span className="ml-1 text-xs text-white/45">· measured safe</span>
                    )}
                  </button>
                ))}
                <p className="text-xs text-white/45">
                  Start here. Move up only once the feed holds without falling behind.
                </p>
              </div>
            </>
          )}

          <div className="flex flex-col gap-1 border-t border-white/12 pt-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/45">
              Channels
            </span>
            {SIMULCAST_CHANNELS.map((c) => (
              <span key={c.id} className="flex items-center gap-2 text-xs">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: live.ids.has(c.id) ? c.color : "transparent", boxShadow: `inset 0 0 0 1px ${c.color}` }}
                />
                <span className={live.ids.has(c.id) ? "text-white" : "text-white/45"}>{c.label}</span>
              </span>
            ))}
          </div>

          <p className="text-xs text-white/45">
            vMix can push to the same id over RTMP instead — whichever is in front of you wins, but
            not both at once.
          </p>
        </aside>
      </div>
    </div>
  );
}
