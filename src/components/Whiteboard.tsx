"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRoomContext, useLocalParticipant } from "@livekit/components-react";
import { RoomEvent, type Participant } from "livekit-client";

/**
 * Collaborative whiteboard.
 *
 * Renders a fixed-size canvas overlay above the LiveKit grid. Strokes are
 * captured as a list of points and broadcast over the LiveKit data channel
 * to every other participant. Late joiners get a one-shot "snapshot" of the
 * current canvas from whoever currently has it open.
 *
 * Tools: pen, eraser, 6 colors, clear-all. No persistence — closing the
 * board ends the session for everyone.
 */

type Pt = { x: number; y: number };
type Stroke = {
  id: string;
  color: string;
  size: number;
  erase: boolean;
  points: Pt[];
};

type WBMessage =
  | { type: "wb"; op: "stroke"; stroke: Stroke }
  | { type: "wb"; op: "append"; id: string; points: Pt[] }
  | { type: "wb"; op: "clear" }
  | { type: "wb"; op: "snapshot-request" }
  | { type: "wb"; op: "snapshot"; strokes: Stroke[] };

const COLORS = [
  "#ffffff",
  "#22d3ee",
  "#a78bfa",
  "#f472b6",
  "#facc15",
  "#34d399",
];

export default function Whiteboard({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [color, setColor] = useState<string>("#22d3ee");
  const [size, setSize] = useState<number>(3);
  const [erase, setErase] = useState<boolean>(false);

  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const lastBroadcastIdxRef = useRef<number>(0);

  // Re-render the canvas from the strokes list.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const all = drawingRef.current
      ? [...strokesRef.current, drawingRef.current]
      : strokesRef.current;
    for (const s of all) {
      if (s.points.length === 0) continue;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = s.size;
      if (s.erase) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = s.color;
      }
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x, s.points[i].y);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  }, []);

  // Resize canvas to its CSS box size, preserving the strokes (we redraw).
  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width));
    canvas.height = Math.max(1, Math.floor(rect.height));
    redraw();
  }, [redraw]);

  // Send a data-channel message to everyone (and ignore failures — some
  // participants might not be ready yet).
  const send = useCallback(
    async (msg: WBMessage) => {
      try {
        const payload = new TextEncoder().encode(JSON.stringify(msg));
        await localParticipant.publishData(payload, { reliable: true } as any);
      } catch (e) {
        // ignore
      }
    },
    [localParticipant]
  );

  // Subscribe to whiteboard messages from peers.
  useEffect(() => {
    if (!room || !open) return;
    const onData = (payload: Uint8Array, _participant?: Participant) => {
      let msg: any;
      try {
        msg = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (!msg || msg.type !== "wb") return;
      if (msg.op === "stroke") {
        strokesRef.current.push(msg.stroke);
        redraw();
      } else if (msg.op === "append") {
        const s = strokesRef.current.find((x) => x.id === msg.id);
        if (s) {
          s.points.push(...msg.points);
          redraw();
        }
      } else if (msg.op === "clear") {
        strokesRef.current = [];
        drawingRef.current = null;
        redraw();
      } else if (msg.op === "snapshot-request") {
        // Only respond if we have content; first responder wins is fine.
        if (strokesRef.current.length > 0) {
          send({ type: "wb", op: "snapshot", strokes: strokesRef.current });
        }
      } else if (msg.op === "snapshot") {
        // Adopt only if we don't already have content.
        if (strokesRef.current.length === 0 && Array.isArray(msg.strokes)) {
          strokesRef.current = msg.strokes;
          redraw();
        }
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, open, redraw, send]);

  // On open: ask peers for a snapshot in case someone has been drawing.
  useEffect(() => {
    if (!open) return;
    fitCanvas();
    send({ type: "wb", op: "snapshot-request" });
    const onResize = () => fitCanvas();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, fitCanvas, send]);

  // Pointer handlers (single canvas, no React re-renders during drag).
  const pointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const stroke: Stroke = {
      id:
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 8),
      color,
      size: erase ? size * 4 : size,
      erase,
      points: [pt],
    };
    drawingRef.current = stroke;
    lastBroadcastIdxRef.current = 1;
    // Broadcast the new stroke immediately so the first dot shows up for peers.
    send({ type: "wb", op: "stroke", stroke });
    redraw();
  };

  const pointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    drawingRef.current.points.push(pt);
    redraw();
    // Throttle: every 4 points, broadcast the new tail.
    const total = drawingRef.current.points.length;
    if (total - lastBroadcastIdxRef.current >= 4) {
      const tail = drawingRef.current.points.slice(
        lastBroadcastIdxRef.current
      );
      lastBroadcastIdxRef.current = total;
      send({
        type: "wb",
        op: "append",
        id: drawingRef.current.id,
        points: tail,
      });
    }
  };

  const pointerUp = (_e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = drawingRef.current;
    if (!s) return;
    // Send any remaining tail.
    const total = s.points.length;
    if (total - lastBroadcastIdxRef.current > 0) {
      const tail = s.points.slice(lastBroadcastIdxRef.current);
      send({ type: "wb", op: "append", id: s.id, points: tail });
    }
    strokesRef.current.push(s);
    drawingRef.current = null;
    lastBroadcastIdxRef.current = 0;
    redraw();
  };

  const clearAll = () => {
    if (!confirm("Clear the whiteboard for everyone?")) return;
    strokesRef.current = [];
    drawingRef.current = null;
    redraw();
    send({ type: "wb", op: "clear" });
  };

  if (!open) return null;

  return (
    <div
      data-room-chrome="true"
      style={{
        position: "absolute",
        top: 48,
        left: 8,
        right: 8,
        bottom: 8,
        zIndex: 14,
        background: "rgba(8, 12, 24, 0.96)",
        border: "1px solid rgba(34,211,238,0.25)",
        borderRadius: 12,
        boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ color: "#67e8f9", fontSize: 13 }}>Whiteboard</strong>
        <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>
          live for everyone in this room
        </span>
        <div
          style={{
            display: "flex",
            gap: 4,
            marginLeft: 12,
            alignItems: "center",
          }}
        >
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setColor(c);
                setErase(false);
              }}
              title={c}
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: c,
                border:
                  color === c && !erase
                    ? "2px solid #fff"
                    : "1px solid rgba(255,255,255,0.25)",
                cursor: "pointer",
                padding: 0,
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setErase((v) => !v)}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            border: "1px solid rgba(255,255,255,0.2)",
            background: erase ? "#22d3ee" : "transparent",
            color: erase ? "#000" : "#fff",
            cursor: "pointer",
          }}
        >
          Eraser
        </button>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: "#fff",
            fontSize: 12,
          }}
        >
          Size
          <input
            type="range"
            min={1}
            max={20}
            value={size}
            onChange={(e) => setSize(parseInt(e.target.value, 10) || 3)}
            style={{ width: 90 }}
          />
        </label>
        <button
          type="button"
          onClick={clearAll}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            border: "1px solid rgba(248,113,113,0.4)",
            background: "rgba(248,113,113,0.15)",
            color: "#fca5a5",
            cursor: "pointer",
          }}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginLeft: "auto",
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            border: "1px solid rgba(255,255,255,0.2)",
            background: "transparent",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>
      {/* Canvas */}
      <div
        ref={wrapRef}
        style={{
          flex: 1,
          position: "relative",
          background:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 24px), #0b1220",
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            cursor: erase ? "cell" : "crosshair",
            touchAction: "none",
          }}
        />
      </div>
    </div>
  );
}
