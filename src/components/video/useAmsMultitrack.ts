"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AMS_WS, normaliseTrackId } from "@/lib/simulcast";

export type ConnState = "connecting" | "waiting" | "playing" | "reconnecting";

export interface MultitrackResult {
  state: ConnState;
  /** Most recent video track. Fine when a group carries exactly one. */
  videoStream: MediaStream | null;
  /** Every video track, keyed by subtrack id — the control room needs all 50. */
  videoStreams: Record<string, MediaStream>;
  audioStreams: Record<string, MediaStream>;
  liveTrackIds: string[];
  /** Ask AMS to start/stop sending one subtrack. Optional bandwidth control. */
  setTrackEnabled: (trackId: string, enabled: boolean) => void;
  restart: () => void;
}

const ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun1.l.google.com:19302" }],
  // Add a TURN entry here if strict-NAT viewers report a black frame.
};

/**
 * Plays one AMS stream id over a single peer connection.
 *
 * Used twice on the watch page: once for the broadcast main track (where
 * `trackList` names the subtracks we are willing to receive) and once for a
 * featured participant's own stream id (where it plays alone). Naming the
 * tracks matters — an empty list means "send everything", which is correct
 * for five subtracks and ruinous once participant cameras share a server.
 */
export function useAmsMultitrack(
  mainTrack: string,
  enabled: boolean,
  trackList: string[] = [],
): MultitrackResult {
  const trackKey = trackList.join(",");
  const [state, setState] = useState<ConnState>("connecting");
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [videoStreams, setVideoStreams] = useState<Record<string, MediaStream>>({});
  const [audioStreams, setAudioStreams] = useState<Record<string, MediaStream>>({});
  const [liveTrackIds, setLiveTrackIds] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const idMapRef = useRef<Record<string, string>>({});
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadRef = useRef(false);

  const restart = useCallback(() => setNonce((n) => n + 1), []);

  const setTrackEnabled = useCallback(
    (trackId: string, on: boolean) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ command: "enableTrack", streamId: mainTrack, trackId, enabled: on }),
        );
      }
    },
    [mainTrack],
  );

  useEffect(() => {
    if (!enabled || !mainTrack) return;
    deadRef.current = false;

    let attempt = 0;

    const teardown = () => {
      if (pingRef.current) {
        clearInterval(pingRef.current);
        pingRef.current = null;
      }
      try { pcRef.current?.close(); } catch { /* already closed */ }
      pcRef.current = null;
      try { wsRef.current?.close(); } catch { /* already closed */ }
      wsRef.current = null;
      idMapRef.current = {};
      pendingIceRef.current = [];
    };

    const scheduleRetry = () => {
      if (deadRef.current) return;
      attempt += 1;
      const delay = Math.min(2000 * attempt, 15000);
      setState((s) => (s === "waiting" ? "waiting" : "reconnecting"));
      retryRef.current = setTimeout(connect, delay);
    };

    const send = (o: unknown) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(o));
    };

    const ensurePc = () => {
      if (pcRef.current) return pcRef.current;
      const pc = new RTCPeerConnection(ICE);
      pcRef.current = pc;

      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        send({
          command: "takeCandidate",
          streamId: mainTrack,
          label: e.candidate.sdpMLineIndex,
          id: e.candidate.sdpMid,
          candidate: e.candidate.candidate,
        });
      };

      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === "connected" || s === "completed") {
          attempt = 0;
          setState("playing");
        } else if (s === "failed" || s === "disconnected") {
          // "closed" is intentionally excluded: pc.close() inside teardown()
          // fires this event, which would otherwise re-enter teardown and
          // schedule a second retry, leaking the first setTimeout handle.
          teardown();
          scheduleRetry();
        }
      };

      pc.ontrack = (e) => {
        const mid = e.transceiver?.mid ?? "";
        const mapped = idMapRef.current[mid];
        const rawId = mapped || e.streams[0]?.id || `${e.track.kind}-${mid}`;
        const id = normaliseTrackId(rawId);
        const stream = e.streams[0] ?? new MediaStream([e.track]);

        if (e.track.kind === "video") {
          setVideoStream(stream);
          setVideoStreams((prev) => (prev[id] === stream ? prev : { ...prev, [id]: stream }));
        } else {
          setAudioStreams((prev) => (prev[id] === stream ? prev : { ...prev, [id]: stream }));
        }
        setLiveTrackIds((prev) => (prev.includes(id) ? prev : [...prev, id]));

        e.track.onended = () => {
          setLiveTrackIds((prev) => prev.filter((t) => t !== id));
          if (e.track.kind === "audio") {
            setAudioStreams((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
          } else {
            setVideoStreams((prev) => {
              if (!(id in prev)) return prev;
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }
        };
      };

      return pc;
    };

    function connect() {
      if (deadRef.current) return;
      teardown();
      setState((s) => (s === "playing" ? "reconnecting" : s));

      let ws: WebSocket;
      try {
        ws = new WebSocket(AMS_WS);
      } catch {
        scheduleRetry();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        pingRef.current = setInterval(() => send({ command: "ping" }), 3000);
        send({
          command: "play",
          streamId: mainTrack,
          token: "",
          trackList: trackKey ? trackKey.split(",") : [],
        });
      };

      ws.onmessage = async (ev) => {
        let m: {
          command?: string;
          type?: string;
          sdp?: string;
          definition?: string;
          candidate?: string;
          label?: number;
          id?: string;
          idMapping?: Record<string, string>;
        };
        try {
          m = JSON.parse(ev.data as string);
        } catch {
          return;
        }

        if (m.command === "takeConfiguration" && m.type === "offer") {
          if (m.idMapping && typeof m.idMapping === "object") idMapRef.current = m.idMapping;
          const pc = ensurePc();
          try {
            await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            // Flush candidates that arrived before the remote description was set.
            const queued = pendingIceRef.current;
            pendingIceRef.current = [];
            for (const init of queued) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(init));
              } catch {
                /* transient state; AMS resends critical candidates */
              }
            }
            send({
              command: "takeConfiguration",
              streamId: mainTrack,
              type: "answer",
              sdp: answer.sdp,
            });
          } catch {
            teardown();
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
          if (!pcRef.current?.remoteDescription) {
            // Setting addIceCandidate before setRemoteDescription throws
            // InvalidStateError. Queue and flush after the answer.
            pendingIceRef.current.push(init);
            return;
          }
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(init));
          } catch {
            /* addIceCandidate can still fail on transient churn */
          }
          return;
        }

        if (m.command === "error") {
          // no_stream_exist: the venue has not started pushing yet
          setState("waiting");
          teardown();
          scheduleRetry();
          return;
        }

        if (
          m.command === "notification" &&
          (m.definition === "play_finished" || m.definition === "streaming_finished")
        ) {
          setVideoStream(null);
          setVideoStreams({});
          setAudioStreams({});
          setLiveTrackIds([]);
          setState("waiting");
          teardown();
          scheduleRetry();
        }
      };

      ws.onclose = () => {
        if (deadRef.current) return;
        teardown();
        scheduleRetry();
      };
    }

    connect();

    return () => {
      deadRef.current = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      teardown();
    };
  }, [mainTrack, enabled, nonce, trackKey]);

  return { state, videoStream, videoStreams, audioStreams, liveTrackIds, setTrackEnabled, restart };
}
