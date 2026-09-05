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

export interface PublisherOptions {
  wsUrl: string;
  streamId: string;
  mainTrack: string;
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
    mainTrack,
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
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadRef = useRef(false);

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

      if (dropCamera && streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
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
        try {
          const s = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: width },
              height: { ideal: height },
              frameRate: { ideal: frameRate, max: frameRate },
            },
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          if (deadRef.current) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = s;
          setLocalStream(s);
          setMicOn(true);
          setCamOn(true);
        } catch {
          setState("denied");
          setError("Camera or microphone access was refused. Allow it and try again.");
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
          mainTrack,
          video: true,
          audio: true,
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
        if (m.command === "notification" && m.definition === "start") {
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
  }, [running, runToken, streamId, mainTrack, wsUrl, width, height, frameRate, maxBitrateKbps]);

  return { state, error, localStream, micOn, camOn, start, stop, toggleMic, toggleCam };
}
