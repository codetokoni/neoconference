"use client";

// src/components/MeetingScribe.tsx
//
// Sends the meeting's finished caption sentences to the server, so "What did
// I miss?" has a transcript to summarise. Captions reach each browser from
// the LiveKit captions agent and were never kept anywhere; every signed-in
// page now sends what it received, in batches every 10 s, and the server
// keeps each sentence once (src/lib/meetingTranscript.ts). Renders nothing.
// Place inside the <LiveKitRoom> tree.

import { useEffect } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type Participant, type TranscriptionSegment } from "livekit-client";

const FLUSH_MS = 10_000;

export default function MeetingScribe() {
  const room = useRoomContext();

  useEffect(() => {
    if (!room) return;
    const pending: Array<{ id: string; speaker: string; text: string }> = [];
    const sent = new Set<string>();
    let disabled = false;

    const onSegments = (segments: TranscriptionSegment[], participant?: Participant) => {
      for (const s of segments) {
        if (!s.final || !s.text?.trim() || sent.has(s.id)) continue;
        sent.add(s.id);
        pending.push({ id: s.id, speaker: participant?.name || participant?.identity?.split("#")[0] || "", text: s.text });
      }
    };

    const flush = async () => {
      if (disabled || !pending.length || !room.name) return;
      const batch = pending.splice(0, 50);
      try {
        const r = await fetch(`/api/meeting-transcript?room=${encodeURIComponent(room.name)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segments: batch }),
          keepalive: true,
        });
        // A guest without an account cannot send; the others' pages do.
        if (r.status === 401) disabled = true;
      } catch {
        /* offline for a moment: the other pages in the meeting send it too */
      }
    };

    room.on(RoomEvent.TranscriptionReceived, onSegments);
    const timer = setInterval(() => void flush(), FLUSH_MS);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, onSegments);
      clearInterval(timer);
      void flush();
    };
  }, [room]);

  return null;
}
