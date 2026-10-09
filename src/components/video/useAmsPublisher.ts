"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PublishState =
  | "idle"
  | "requesting-camera"
  | "connecting"
  | "publishing"
  | "reconnecting"
  | "denied"
  | "taken"
  | "failed";

export type PublishSource = "camera" | "screen";

export interface PublisherOptions {
  wsUrl: string;
  streamId: string;
  /** Empty string publishes a standalone stream with no group. */
  mainTrack?: string;
  source?: PublishSource;
  /** Interpreter booths send a mic and nothing else. */
  audioOnly?: boolean;
  /**
   * Specific camera / microphone to use, from
   * navigator.mediaDevices.enumerateDevices(). Empty string means "let
   * the browser pick" — same behaviour as omitting the option. Changing
   * either while publishing swaps the track on the open connection
   * (RTCRtpSender.replaceTrack): no reconnect, the slot stays live.
   */
  videoDeviceId?: string;
  audioDeviceId?: string;
  /** Kept small on purpose: fifty of these share one server. */
  width?: number;
  height?: number;
  frameRate?: number;
  maxBitrateKbps?: number;
}

export interface PublisherResult {
  state: PublishState;
  error: string | null;
  localStream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  start: () => void;
  stop: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  /** The device actually in use for each kind (after a fallback, the default's id). */
  activeVideoDeviceId: string;
  activeAudioDeviceId: string;
}

const ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun1.l.google.com:19302" }],
};

/**
 * Publishes camera + mic to Ant Media over WebRTC.
 *
 * Mirror image of the play loop: on publish the SERVER sends a "start"
 * notification and the CLIENT makes the offer, where on play the server offers
 * and we answer. One peer connection, reused across renegotiations.
 */
export function useAmsPublisher(opts: PublisherOptions): PublisherResult {
  const {
    wsUrl,
    streamId,
    mainTrack = "",
    source = "camera",
    audioOnly = false,
    videoDeviceId = "",
    audioDeviceId = "",
    width = 320,
    height = 240,
    frameRate = 15,
    maxBitrateKbps = 250,
  } = opts;

  const [state, setState] = useState<PublishState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [runToken, setRunToken] = useState(0);
  const [running, setRunning] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Everything getUserMedia/getDisplayMedia handed us, so stop() is complete. */
  const sourcesRef = useRef<MediaStream[]>([]);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadRef = useRef(false);
  // Read when the camera is opened; changes later are switched live below,
  // so they are not dependencies of the publish effect (which would tear
  // the broadcast down and start it again).
  const videoDeviceRef = useRef(videoDeviceId);
  const audioDeviceRef = useRef(audioDeviceId);
  const [activeVideoDeviceId, setActiveVideoDeviceId] = useState("");
  const [activeAudioDeviceId, setActiveAudioDeviceId] = useState("");

  const videoConstraintFor = useCallback(
    (deviceId: string): MediaTrackConstraints => ({
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate, max: frameRate },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }),
    [width, height, frameRate],
  );
  const audioConstraintFor = useCallback((deviceId: string): MediaTrackConstraints => {
    const micBase = { echoCancellation: true, noiseSuppression: true };
    return deviceId ? { ...micBase, deviceId: { exact: deviceId } } : micBase;
  }, []);

  /** What a track is actually reading from, for the pickers to show. */
  const noteActive = useCallback((t: MediaStreamTrack | undefined) => {
    if (!t) return;
    const id = t.getSettings?.().deviceId ?? "";
    if (t.kind === "video") setActiveVideoDeviceId(id);
    else setActiveAudioDeviceId(id);
  }, []);

  /**
   * Swap the camera or mic without dropping the broadcast: open the new
   * device, hand its track to the existing sender, then close the old one.
   * Keeps the mute / camera-off state. On failure the old track stays.
   */
  const switchTrack = useCallback(
    async (kind: "video" | "audio", deviceId: string): Promise<boolean> => {
      const stream = streamRef.current;
      if (!stream) return false;
      if (kind === "video" && (audioOnly || source === "screen")) return false;
      const old = kind === "video" ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
      let fresh: MediaStream;
      try {
        fresh = await navigator.mediaDevices.getUserMedia(
          kind === "video" ? { video: videoConstraintFor(deviceId), audio: false } : { video: false, audio: audioConstraintFor(deviceId) },
        );
      } catch {
        setError(
          kind === "video"
            ? "Could not switch to that camera. It may be in use by another app."
            : "Could not switch to that microphone. It may be in use by another app.",
        );
        return false;
      }
      const track = kind === "video" ? fresh.getVideoTracks()[0] : fresh.getAudioTracks()[0];
      if (!track || streamRef.current !== stream) {
        fresh.getTracks().forEach((t) => t.stop());
        return false;
      }
      track.enabled = old ? old.enabled : true;
      sourcesRef.current.push(fresh);
      // By the transceiver, so a sender whose track is momentarily null is still found.
      const sender = pcRef.current
        ?.getTransceivers()
        .find((t) => t.sender.track?.kind === kind || t.receiver.track?.kind === kind)?.sender;
      try {
        if (sender) await sender.replaceTrack(track);
      } catch {
        track.stop();
        setError("Could not switch device on the live connection.");
        return false;
      }
      if (old) {
        stream.removeTrack(old);
        old.stop();
      }
      stream.addTrack(track);
      // The camera or mic being unplugged mid-broadcast: carry on with the default.
      track.addEventListener("ended", () => {
        if (deadRef.current || streamRef.current !== stream || !stream.getTracks().includes(track)) return;
        void switchTrackRef.current?.(kind, "");
      });
      noteActive(track);
      setError(null);
      // A new stream object so previews (srcObject) pick up the new track.
      setLocalStream(new MediaStream(stream.getTracks()));
      return true;
    },
    [audioOnly, source, videoConstraintFor, audioConstraintFor, noteActive],
  );
  const switchTrackRef = useRef(switchTrack);
  switchTrackRef.current = switchTrack;

  // A device chosen while live: switch it in place.
  useEffect(() => {
    const changed = videoDeviceRef.current !== videoDeviceId;
    videoDeviceRef.current = videoDeviceId;
    if (changed && streamRef.current) void switchTrack("video", videoDeviceId);
  }, [videoDeviceId, switchTrack]);
  useEffect(() => {
    const changed = audioDeviceRef.current !== audioDeviceId;
    audioDeviceRef.current = audioDeviceId;
    if (changed && streamRef.current) void switchTrack("audio", audioDeviceId);
  }, [audioDeviceId, switchTrack]);

  const start = useCallback(() => {
    setError(null);
    setRunning(true);
    setRunToken((n) => n + 1);
  }, []);

  const stop = useCallback(() => {
    setRunning(false);
    setState("idle");
  }, []);

  const toggleMic = useCallback(() => {
    const s = streamRef.current;
    if (!s) return;
    const next = !s.getAudioTracks().every((t) => t.enabled);
    s.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setMicOn(next);
  }, []);

  const toggleCam = useCallback(() => {
    const s = streamRef.current;
    if (!s) return;
    const next = !s.getVideoTracks().every((t) => t.enabled);
    s.getVideoTracks().forEach((t) => {
      t.enabled = next;
    });
    setCamOn(next);
  }, []);

  useEffect(() => {
    if (!running || !streamId || !wsUrl) return;
    deadRef.current = false;
    let attempt = 0;

    const teardown = (dropCamera: boolean) => {
      if (pingRef.current) {
        clearInterval(pingRef.current);
        pingRef.current = null;
      }
      try {
        pcRef.current?.close();
      } catch {
        /* already closed */
      }
      pcRef.current = null;
      try {
        wsRef.current?.close();
      } catch {
        /* already closed */
      }
      wsRef.current = null;
      pendingIceRef.current = [];

      if (dropCamera) {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        sourcesRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
        sourcesRef.current = [];
        streamRef.current = null;
        setLocalStream(null);
      }
    };

    const scheduleRetry = () => {
      if (deadRef.current) return;
      attempt += 1;
      setState("reconnecting");
      retryRef.current = setTimeout(connect, Math.min(2000 * attempt, 15000));
    };

    const send = (o: unknown) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(o));
    };

    /** Caps the outbound encoding so one participant cannot swamp the room. */
    const capBitrate = async (pc: RTCPeerConnection) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = maxBitrateKbps * 1000;
      params.encodings[0].maxFramerate = frameRate;
      try {
        await sender.setParameters(params);
      } catch {
        /* some browsers refuse maxFramerate; bitrate alone is enough */
      }
    };

    const buildPc = async () => {
      if (pcRef.current) return pcRef.current;
      const pc = new RTCPeerConnection(ICE);
      pcRef.current = pc;

      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        send({
          command: "takeCandidate",
          streamId,
          label: e.candidate.sdpMLineIndex,
          id: e.candidate.sdpMid,
          candidate: e.candidate.candidate,
        });
      };

      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === "connected" || s === "completed") {
          attempt = 0;
          setState("publishing");
        } else if (s === "failed" || s === "disconnected") {
          teardown(false);
          scheduleRetry();
        }
      };

      const stream = streamRef.current;
      if (stream) stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      return pc;
    };

    async function connect() {
      if (deadRef.current) return;
      teardown(false);

      if (!streamRef.current) {
        setState("requesting-camera");
        const audioConstraint = audioConstraintFor(audioDeviceRef.current);
        const videoConstraint = videoConstraintFor(videoDeviceRef.current);
        try {
          let s: MediaStream;

          if (audioOnly) {
            // Interpreter booth: a mic and nothing else.
            s = await navigator.mediaDevices.getUserMedia({
              audio: audioConstraint,
              video: false,
            });
            sourcesRef.current.push(s);
          } else if (source === "screen") {
            const disp = await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: { ideal: frameRate, max: frameRate } },
              audio: true,
            });
            sourcesRef.current.push(disp);

            // Prefer the operator's mic; fall back to whatever audio the
            // capture carried, so a shared tab's sound still goes out.
            let voice: MediaStream | null = null;
            try {
              voice = await navigator.mediaDevices.getUserMedia({
                audio: audioConstraint,
                video: false,
              });
              sourcesRef.current.push(voice);
            } catch {
              /* no mic is survivable when sharing a screen */
            }

            s = new MediaStream();
            disp.getVideoTracks().forEach((t) => s.addTrack(t));
            const audioTrack = voice?.getAudioTracks()[0] ?? disp.getAudioTracks()[0];
            if (audioTrack) s.addTrack(audioTrack);

            // The browser's own "stop sharing" button must end the broadcast.
            disp.getVideoTracks()[0]?.addEventListener("ended", () => {
              deadRef.current = true;
              teardown(true);
              setState("idle");
              setRunning(false);
            });
          } else {
            s = await navigator.mediaDevices.getUserMedia({
              video: videoConstraint,
              audio: audioConstraint,
            });
            sourcesRef.current.push(s);
          }

          if (deadRef.current) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = s;
          setLocalStream(s);
          setMicOn(true);
          setCamOn(true);
          noteActive(s.getVideoTracks()[0]);
          noteActive(s.getAudioTracks()[0]);
          // Unplugged mid-broadcast: carry on with the system default.
          if (source !== "screen") {
            for (const t of s.getTracks()) {
              const kind = t.kind as "video" | "audio";
              t.addEventListener("ended", () => {
                if (deadRef.current || streamRef.current !== s || !s.getTracks().includes(t)) return;
                void switchTrackRef.current?.(kind, "");
              });
            }
          }
        } catch {
          setState("denied");
          setError(
            source === "screen"
              ? "Screen sharing was cancelled or refused."
              : "Camera or microphone access was refused. Allow it and try again.",
          );
          return;
        }
      }

      setState("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        scheduleRetry();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        pingRef.current = setInterval(() => send({ command: "ping" }), 3000);
        send({
          command: "publish",
          streamId,
          token: "",
          ...(mainTrack ? { mainTrack } : {}),
          video: !audioOnly,
          audio: true,
          // The websocket reference spells these differently from the SDK;
          // sending both keeps every AMS build happy.
          enablevideo: !audioOnly,
          enableaudio: true,
        });
      };

      ws.onmessage = async (ev) => {
        let m: {
          command?: string;
          definition?: string;
          type?: string;
          sdp?: string;
          candidate?: string;
          label?: number;
          id?: string;
        };
        try {
          m = JSON.parse(ev.data as string);
        } catch {
          return;
        }

        // The server says it is ready; we make the offer.
        //
        // Ant Media sends this in two shapes depending on the build. The play
        // loop gets it as {command:"notification", definition:"start"}, but the
        // publish loop on the current server ships it as a top-level
        // {command:"start", streamId, subscriberId:null}. Match both so we
        // survive either.
        const isStart =
          m.command === "start" ||
          (m.command === "notification" && m.definition === "start");
        if (isStart) {
          const pc = await buildPc();
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            send({ command: "takeConfiguration", streamId, type: "offer", sdp: offer.sdp });
          } catch {
            teardown(false);
            scheduleRetry();
          }
          return;
        }

        if (m.command === "takeConfiguration" && m.type === "answer") {
          const pc = pcRef.current;
          if (!pc) return;
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
            const queued = pendingIceRef.current;
            pendingIceRef.current = [];
            for (const c of queued) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(c));
              } catch {
                /* stale candidate */
              }
            }
            await capBitrate(pc);
          } catch {
            teardown(false);
            scheduleRetry();
          }
          return;
        }

        if (m.command === "takeCandidate") {
          const init: RTCIceCandidateInit = {
            candidate: m.candidate,
            sdpMLineIndex: m.label,
            sdpMid: m.id,
          };
          const pc = pcRef.current;
          if (!pc || !pc.remoteDescription) {
            pendingIceRef.current.push(init);
            return;
          }
          try {
            await pc.addIceCandidate(new RTCIceCandidate(init));
          } catch {
            /* harmless */
          }
          return;
        }

        if (m.command === "notification" && m.definition === "publish_started") {
          attempt = 0;
          setState("publishing");
          return;
        }

        if (m.command === "error") {
          // streamIdInUse means the slot is already publishing somewhere else.
          if (m.definition === "streamIdInUse" || m.definition === "stream_id_in_use") {
            deadRef.current = true;
            teardown(true);
            setState("taken");
            setError("This slot is already live on another device.");
            return;
          }
          teardown(false);
          scheduleRetry();
        }
      };

      ws.onclose = () => {
        if (deadRef.current) return;
        teardown(false);
        scheduleRetry();
      };
    }

    connect();

    return () => {
      deadRef.current = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      teardown(true);
    };
  }, [
    running,
    runToken,
    streamId,
    mainTrack,
    wsUrl,
    source,
    audioOnly,
    width,
    height,
    frameRate,
    maxBitrateKbps,
    videoConstraintFor,
    audioConstraintFor,
    noteActive,
  ]);

  return {
    state,
    error,
    localStream,
    micOn,
    camOn,
    start,
    stop,
    toggleMic,
    toggleCam,
    activeVideoDeviceId,
    activeAudioDeviceId,
  };
}
