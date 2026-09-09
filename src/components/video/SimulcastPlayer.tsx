"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AudioMeter from "./AudioMeter";
import ChannelRail from "./ChannelRail";
import LiveChat from "./LiveChat";
import TranslationOverlay from "./TranslationOverlay";
import { useAmsMultitrack } from "./useAmsMultitrack";
import {
  SIMULCAST_MAIN,
  channelById as channelByIdInList,
  channelsForRoom,
  channelTrackIdsForRoom,
  hlsUrl,
  videoChannelForRoom,
  type FeaturedState,
  type SimulcastChannel,
} from "@/lib/simulcast";

// `channelByIdInList` is the exported helper; imported under an alias so the
// local callback below can be named `channelById` for readability.

/** true = also ask AMS to stop sending unselected audio subtracks (saves bandwidth, ~1s switch). */
const BANDWIDTH_SAVER = false;

/** How long WebRTC gets before we fall back to HLS. */
const WEBRTC_TIMEOUT_MS = 8000;

type Destroyable = { destroy: () => void };

export interface SimulcastPlayerProps {
  /** Show the LiveChat column beside the player. Default true. */
  showChat?: boolean;
  /** Room slug — governs which mainTrack is subscribed and which
   *  language subtracks are named. Defaults to the app's default room. */
  room?: string;
}

export default function SimulcastPlayer({
  showChat = true,
  room = SIMULCAST_MAIN,
}: SimulcastPlayerProps = {}) {
  // Channels are keyed by the room slug so a second event's streaming
  // link plays that event's programme, not the default's.
  const channels = useMemo<SimulcastChannel[]>(() => channelsForRoom(room), [room]);
  const videoChannel = useMemo(() => videoChannelForRoom(room), [room]);
  const channelTrackIds = useMemo(() => channelTrackIdsForRoom(room), [room]);
  const channelById = useCallback(
    (id: string) => channelByIdInList(id, channels),
    [channels],
  );

  const [active, setActive] = useState(videoChannel.id);
  const [muted, setMuted] = useState(true);
  const [mode, setMode] = useState<"webrtc" | "hls">("webrtc");
  const [serverLive, setServerLive] = useState<Set<string>>(new Set());
  const [viewers, setViewers] = useState(0);
  const [featured, setFeatured] = useState<FeaturedState | null>(null);
  const [timer, setTimer] = useState<{
    label: string;
    durationMs: number;
    startedAt: number;
    paused?: number | null;
    expiresBehaviour: "hold" | "hide";
  } | null>(null);
  // Locally ticks so the displayed digits change every second between
  // server polls. Only advances while a timer is actually running —
  // no wasted renders when there's no overlay.
  const [tickNow, setTickNow] = useState<number>(() => Date.now());

  // Room prop changing (e.g. via a client-side navigation) resets the
  // selected channel to that room's Floor English.
  useEffect(() => {
    setActive(videoChannel.id);
  }, [videoChannel.id]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoBoxRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const featVideoRef = useRef<HTMLVideoElement | null>(null);
  const featAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});

  // Track the browser's fullscreen state so the button label and icon
  // reflect reality when the user presses Esc to exit.
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = videoBoxRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  }, []);
  const fallbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const hlsVideo = useRef<Destroyable | null>(null);
  const hlsAudio = useRef<Destroyable | null>(null);

  const { state, videoStream, audioStreams, liveTrackIds, setTrackEnabled, restart } =
    useAmsMultitrack(room, mode === "webrtc", channelTrackIds);

  /**
   * A featured participant is played on its OWN connection, straight to their
   * stream id. The programme connection is never dropped, so clearing the
   * feature is instant and nothing is re-encoded anywhere.
   */
  const feat = useAmsMultitrack(featured?.streamId ?? "", !!featured && mode === "webrtc");
  const featStream = feat.videoStream;
  const onAir = Boolean(featured && featStream);

  const activeChannel = channelById(active) ?? videoChannel;

  // The audio stream feeding the speakers right now. When a participant
  // is featured to air, their mic replaces the floor and every language
  // channel goes quiet — reflect that by tapping the featured stream
  // instead. HLS fallback isn't tapped here; the WebRTC path covers
  // every viewer whose network reached "playing" state.
  const playbackStream = useMemo<MediaStream | null>(() => {
    if (mode !== "webrtc") return null;
    if (onAir) return Object.values(feat.audioStreams)[0] ?? null;
    return audioStreams[active] ?? null;
  }, [mode, onAir, feat.audioStreams, audioStreams, active]);

  /* ---- which booths are actually publishing (server-side AMS REST) ---- */
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/video/status?room=${encodeURIComponent(room)}`, {
          cache: "no-store",
        });
        const j = await r.json();
        if (stopped || !j.ok) return;
        setServerLive(
          new Set(
            (j.channels as { id: string; live: boolean }[])
              .filter((c) => c.live)
              .map((c) => c.id),
          ),
        );
        setViewers(j.viewers ?? 0);
        setFeatured((prev) => {
          const next = (j.featured ?? null) as FeaturedState | null;
          if (prev?.streamId === next?.streamId) return prev;
          return next;
        });
      } catch {
        /* transient */
      }
    };
    tick();
    const t = setInterval(tick, 15000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [room]);

  // Programme-feed timer. Polled every 5s so an operator setting a
  // fresh segment from the admin panel sees the overlay within one
  // heartbeat on viewers' screens. The `tickNow` interval below
  // handles second-by-second updates in between.
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/video/room/timer?room=${encodeURIComponent(room)}`, {
          cache: "no-store",
        });
        const j = await r.json();
        if (stopped || !j.ok) return;
        setTimer(j.timer ?? null);
      } catch {
        /* transient */
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [room]);

  // 1 Hz local tick, but only while the timer is running. A paused
  // timer holds its digits, and no timer at all means no interval.
  useEffect(() => {
    if (!timer) return;
    if (typeof timer.paused === "number") return;
    const t = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timer]);

  /**
   * Selectable if:
   *   - AMS says the subtrack is publishing (a real interpreter booth is live), or
   *   - the WebRTC track has already arrived, or
   *   - the translation worker is configured (NEXT_PUBLIC_TRANSLATION_SSE) —
   *     in which case every non-source language becomes selectable and
   *     the SSE overlay speaks the translated captions.
   */
  const translationEnabled =
    typeof process !== "undefined" &&
    Boolean(process.env.NEXT_PUBLIC_TRANSLATION_SSE);
  const live = useMemo(() => {
    const s = new Set<string>(serverLive);
    liveTrackIds.forEach((id) => s.add(id));
    if (translationEnabled) {
      // Floor / source channel still needs a real broadcast to be
      // selectable — no translation for it. Every other channel opens
      // up to translation-driven captions.
      for (const c of channels) if (!c.video) s.add(c.id);
    }
    return s;
  }, [serverLive, liveTrackIds, translationEnabled, channels]);

  /** If the selected booth drops off air, fall back to the floor. */
  useEffect(() => {
    if (live.size > 0 && !live.has(active)) setActive(videoChannel.id);
  }, [live, active, videoChannel.id]);

  /* ---- fall back to HLS if WebRTC never reaches playing ----
     "waiting" means AMS says no stream exists yet, so HLS would 404 too:
     stay on WebRTC and let the reconnect loop pick the feed up. ---- */
  useEffect(() => {
    if (mode !== "webrtc") return;
    if (state === "playing" || state === "waiting") return;
    const t = setTimeout(() => setMode("hls"), WEBRTC_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [mode, state]);

  /* ---- once the feed goes off air, go back to preferring WebRTC ---- */
  useEffect(() => {
    if (mode === "hls" && live.size === 0) setMode("webrtc");
  }, [mode, live]);

  /* ---- WebRTC: bind the video track ---- */
  useEffect(() => {
    const el = videoRef.current;
    if (!el || mode !== "webrtc") return;
    if (videoStream && el.srcObject !== videoStream) {
      el.srcObject = videoStream;
      el.play().catch(() => {
        /* autoplay policy: stays muted until the viewer taps */
      });
    }
  }, [videoStream, mode]);

  /* ---- featured participant: bind its own media ---- */
  useEffect(() => {
    const el = featVideoRef.current;
    if (!el) return;
    if (featStream && el.srcObject !== featStream) {
      el.srcObject = featStream;
      el.play().catch(() => {});
    }
    if (!featStream) el.srcObject = null;
  }, [featStream]);

  useEffect(() => {
    const el = featAudioRef.current;
    if (!el) return;
    const stream = Object.values(feat.audioStreams)[0] ?? null;
    if (stream && el.srcObject !== stream) el.srcObject = stream;
    if (!stream) {
      el.srcObject = null;
      return;
    }
    el.muted = muted || !onAir;
    if (!el.muted) el.play().catch(() => setMuted(true));
  }, [feat.audioStreams, muted, onAir]);

  /* ---- WebRTC: exactly one audio element unmuted ----
     While a participant is on air their mic replaces the floor, so every
     language element goes quiet. The booths are still interpreting the host,
     which is why featuring is meant to be short. ---- */
  useEffect(() => {
    if (mode !== "webrtc") return;
    if (videoRef.current) videoRef.current.muted = true;

    Object.entries(audioRefs.current).forEach(([id, el]) => {
      if (!el) return;
      const shouldPlay = id === active && !muted && !onAir;
      el.muted = !shouldPlay;
      el.volume = 1;
      if (shouldPlay) {
        el.play().catch(() => setMuted(true));
      }
    });
  }, [active, muted, audioStreams, mode, onAir]);

  /* ---- optional: stop receiving the languages nobody is listening to ---- */
  useEffect(() => {
    if (!BANDWIDTH_SAVER || mode !== "webrtc") return;
    const t = setTimeout(() => {
      channels.forEach((c) => {
        if (c.video) return;
        setTrackEnabled(c.id, c.id === active);
      });
    }, 2000);
    return () => clearTimeout(t);
  }, [active, mode, setTrackEnabled]);

  /* ---- HLS fallback: the picture ---- */
  useEffect(() => {
    if (mode !== "hls") return;
    const el = videoRef.current;
    if (!el) return;

    let cancelled = false;
    el.srcObject = null;

    (async () => {
      const src = hlsUrl(videoChannel.id);
      if (el.canPlayType("application/vnd.apple.mpegurl")) {
        el.src = src;
      } else {
        const Hls = (await import("hls.js")).default;
        if (cancelled || !Hls.isSupported()) return;
        const h = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 3 });
        h.loadSource(src);
        h.attachMedia(el);
        hlsVideo.current = h;
      }
      el.play().catch(() => {});
    })();

    return () => {
      cancelled = true;
      hlsVideo.current?.destroy();
      hlsVideo.current = null;
    };
  }, [mode, videoChannel.id]);

  /* ---- HLS fallback: the language audio, kept near the picture ---- */
  useEffect(() => {
    if (mode !== "hls") return;
    const video = videoRef.current;
    const audio = fallbackAudioRef.current;
    if (!video || !audio) return;

    const onFloor = active === videoChannel.id;
    video.muted = muted || !onFloor;

    hlsAudio.current?.destroy();
    hlsAudio.current = null;

    if (onFloor) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      return;
    }

    let cancelled = false;

    (async () => {
      const src = hlsUrl(active);
      if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        audio.src = src;
      } else {
        const Hls = (await import("hls.js")).default;
        if (cancelled || !Hls.isSupported()) return;
        const h = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 3 });
        h.loadSource(src);
        h.attachMedia(audio);
        hlsAudio.current = h;
      }
      audio.muted = muted;
      if (!muted) audio.play().catch(() => setMuted(true));
    })();

    // keep interpretation within ~1.5s of the picture
    const sync = setInterval(() => {
      if (!video.seekable.length || !audio.seekable.length) return;
      const vBehind = video.seekable.end(video.seekable.length - 1) - video.currentTime;
      const aBehind = audio.seekable.end(audio.seekable.length - 1) - audio.currentTime;
      if (Math.abs(vBehind - aBehind) > 1.5) {
        audio.currentTime = audio.seekable.end(audio.seekable.length - 1) - vBehind;
      }
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(sync);
      hlsAudio.current?.destroy();
      hlsAudio.current = null;
    };
  }, [mode, active, muted, videoChannel.id]);

  const unmute = useCallback(() => setMuted(false), []);

  const statusLabel =
    mode === "hls"
      ? "HLS fallback"
      : state === "playing"
        ? "WebRTC · low latency"
        : state === "waiting"
          ? "Waiting for the feed"
          : state === "reconnecting"
            ? "Reconnecting…"
            : "Connecting…";

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#101A20] shadow-2xl">
      <div className={showChat ? "grid lg:grid-cols-[minmax(0,1fr)_320px]" : ""}>
        <div className="flex min-w-0 flex-col gap-4 p-4">
          <div
            ref={videoBoxRef}
            className={
              isFullscreen
                ? "relative h-full w-full overflow-hidden bg-black"
                : "relative aspect-video overflow-hidden rounded-lg border border-white/10 bg-black"
            }
          >
            <video
              ref={videoRef}
              playsInline
              autoPlay
              muted
              className="h-full w-full object-contain"
              style={onAir ? { visibility: "hidden" } : undefined}
            />

            {/* Featured participant replaces the programme picture while on air.
                The programme connection keeps running underneath. */}
            <video
              ref={featVideoRef}
              playsInline
              autoPlay
              muted
              className="absolute inset-0 h-full w-full object-contain"
              style={{ display: onAir ? "block" : "none" }}
            />
            <audio ref={featAudioRef} autoPlay muted />

            {/* Programme timer. Producer sets a countdown from the
                admin panel; every viewer sees the same digits ticking
                because they're computed from startedAt+duration, not
                from server-side heartbeats. Hidden when no timer is
                set OR when expiresBehaviour === "hide" and remaining
                is zero. Turns amber under 60s, red under 10s. */}
            {timer && (() => {
              const remaining =
                typeof timer.paused === "number"
                  ? Math.max(0, timer.paused)
                  : Math.max(0, timer.durationMs - (tickNow - timer.startedAt));
              const expired = remaining === 0 && timer.paused == null;
              if (expired && timer.expiresBehaviour === "hide") return null;
              const totalSec = Math.floor(remaining / 1000);
              const hh = Math.floor(totalSec / 3600);
              const mm = Math.floor((totalSec % 3600) / 60);
              const ss = totalSec % 60;
              const pad = (n: number) => String(n).padStart(2, "0");
              const digits = hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
              const tone = expired
                ? "border-red-500/70 bg-red-500/25 text-red-100"
                : remaining <= 10_000
                  ? "border-red-500/60 bg-red-500/20 text-red-100"
                  : remaining <= 60_000
                    ? "border-amber-400/60 bg-amber-500/20 text-amber-100"
                    : "border-white/20 bg-black/60 text-white";
              return (
                <div
                  className={
                    "pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 flex-col items-center gap-0.5 rounded-md border px-3 py-1.5 backdrop-blur " +
                    tone +
                    (expired && !timer.paused ? " animate-pulse" : "")
                  }
                >
                  <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] opacity-80">
                    {typeof timer.paused === "number"
                      ? `${timer.label} · paused`
                      : expired
                        ? `${timer.label} · time's up`
                        : timer.label}
                  </span>
                  <span className="font-mono text-lg font-bold leading-tight tabular-nums sm:text-xl">
                    {digits}
                  </span>
                </div>
              );
            })()}

            {/* Lower third. Rendered only when featured is on air —
                otherwise the programme feed carries its own graphics
                and shouldn't have a name banner over it. Condition and
                country come from the roster meta captured at feature
                time, so this is a zero-network overlay: the info is
                already in `featured`. */}
            {onAir && featured && (
              <div className="pointer-events-none absolute inset-x-4 bottom-4 z-10 flex flex-col gap-1 rounded-md border-l-[3px] border-l-emerald-400 bg-gradient-to-r from-black/85 via-black/70 to-transparent px-4 py-2.5 sm:inset-x-6 sm:bottom-6 sm:max-w-[52ch] sm:px-5 sm:py-3">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-lg font-bold uppercase tracking-wide text-white sm:text-xl">
                    {featured.label}
                  </span>
                  {featured.country && (
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-white/70">
                      {featured.country}
                    </span>
                  )}
                </div>
                {featured.condition && (
                  <span className="line-clamp-2 text-sm font-medium text-white/85 sm:text-[15px]">
                    {featured.condition}
                  </span>
                )}
              </div>
            )}

            {/* one audio element per language subtrack (WebRTC mode) */}
            {Object.entries(audioStreams).map(([id, stream]) => (
              <audio
                key={id}
                lang={channelById(id)?.lang}
                autoPlay
                muted
                ref={(el) => {
                  audioRefs.current[id] = el;
                  if (el && el.srcObject !== stream) el.srcObject = stream;
                }}
              />
            ))}

            {/* language audio for HLS mode */}
            <audio ref={fallbackAudioRef} />

            <div className="absolute left-3 top-3 flex items-center gap-2">
              {live.size > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded bg-red-600 px-2 py-1 font-mono text-[10.5px] tracking-[0.14em] text-white">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                  ON AIR
                </span>
              ) : (
                <span className="rounded border border-white/15 bg-black/60 px-2 py-1 font-mono text-[10.5px] text-white/70">
                  OFF AIR
                </span>
              )}
              {viewers > 0 && (
                <span className="rounded border border-white/15 bg-black/60 px-2 py-1 font-mono text-[10.5px] text-white/70">
                  {viewers.toLocaleString()} watching
                </span>
              )}
            </div>

            <span className="absolute bottom-3 right-3 rounded border border-white/15 bg-black/60 px-2 py-1 font-mono text-[10.5px] text-white/70">
              {statusLabel}
            </span>

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-black/60 text-white/80 transition hover:bg-white/10"
            >
              {isFullscreen ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 3v4H5" />
                  <path d="M15 3v4h4" />
                  <path d="M9 21v-4H5" />
                  <path d="M15 21v-4h4" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8V3h5" />
                  <path d="M21 8V3h-5" />
                  <path d="M3 16v5h5" />
                  <path d="M21 16v5h-5" />
                </svg>
              )}
            </button>

            <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-md border border-white/15 bg-black/70 px-3 py-1.5 backdrop-blur">
              <span className="h-5 w-2 rounded-sm" style={{ background: activeChannel.color }} />
              <span className="flex flex-col leading-tight">
                <small className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-white/50">
                  {onAir ? "On air" : "Listening in"}
                </small>
                <span className="text-[13px] font-semibold text-white">
                  {onAir ? `${featured?.label} — live` : activeChannel.label}
                </span>
              </span>
              {/*
                Live playback meter. Bar animates whenever there's audio
                on the wire — confirms sound is actually leaving the app
                even before the viewer has turned their speakers up. Goes
                flat when muted (no stream tapped) or when the selected
                language isn't broadcasting.
              */}
              <AudioMeter stream={muted ? null : playbackStream} />
            </div>

            {/*
              Translation overlay + browser-TTS. Mounts only when the
              viewer has picked a non-source language. Speaks silently
              when a real interpreter booth is publishing that language
              (audioStreams[active] present) so we don't talk over a
              human interpreter — captions still show, TTS stays muted.
            */}
            {active !== videoChannel.id && !onAir && (
              <TranslationOverlay
                room={room}
                lang={activeChannel.lang}
                active={!muted}
                muted={muted || Boolean(audioStreams[active])}
              />
            )}

            {muted && (
              <button
                type="button"
                onClick={unmute}
                className="absolute inset-0 flex items-center justify-center bg-black/45 backdrop-blur-[2px]"
              >
                <span className="rounded-full bg-white/95 px-5 py-2.5 text-sm font-semibold text-neutral-900">
                  Tap to unmute
                </span>
              </button>
            )}

            {mode === "webrtc" && state === "waiting" && !videoStream && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 text-center">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/60">
                  The broadcast has not started
                </p>
                <button
                  type="button"
                  onClick={restart}
                  className="rounded-md border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:bg-white/10"
                >
                  Try again
                </button>
              </div>
            )}
          </div>

          <div style={onAir ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
            <ChannelRail channels={channels} live={live} active={active} onSelect={setActive} />
          </div>
          {onAir && (
            <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-amber-400/80">
              Language channels resume when the programme returns
            </p>
          )}
        </div>

        {showChat && <LiveChat room={room} code={activeChannel.code} />}
      </div>
    </div>
  );
}
