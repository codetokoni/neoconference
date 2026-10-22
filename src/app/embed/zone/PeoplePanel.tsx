"use client";

// The zone's leaders' list of people in the embed: Mute all, and Mute for
// each person whose microphone is on. Shown only to a leader (the join
// said so); the server checks again on every mute
// (src/lib/partners/moderation.ts). No one is unmuted from here.

import { useState } from "react";
import { useRemoteParticipants } from "@livekit/components-react";
import { RoomEvent, type RemoteParticipant } from "livekit-client";
import { Mic, MicOff, X } from "lucide-react";

const EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.ParticipantMetadataChanged,
  RoomEvent.ParticipantNameChanged,
];

function roleOf(p: RemoteParticipant): string | undefined {
  try {
    const md = p.metadata ? (JSON.parse(p.metadata) as { role?: unknown }) : {};
    return typeof md.role === "string" ? md.role : undefined;
  } catch {
    return undefined;
  }
}

function isPerson(p: RemoteParticipant): boolean {
  if (p.isAgent) return false;
  const id = p.identity.toLowerCase();
  return !id.startsWith("agent-") && !id.startsWith("neo-captions");
}

async function moderate(session: string, body: { action: "mute"; identity: string } | { action: "mute-all" }): Promise<{ muted: number }> {
  const res = await fetch("/api/partner/embed/moderate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, ...body }),
    cache: "no-store",
    credentials: "omit",
  });
  const data = (await res.json().catch(() => ({}))) as { muted?: number; error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message || "Could not mute. Try again.");
  return { muted: data.muted ?? 0 };
}

export function PeoplePanel({ getSession, onClose, onNotice }: { getSession: () => string | null; onClose: () => void; onNotice: (msg: string) => void }) {
  const people = useRemoteParticipants({ updateOnlyOn: EVENTS }).filter(isPerson);
  const [busy, setBusy] = useState<string | null>(null);
  const micOn = people.filter((p) => p.isMicrophoneEnabled).length;

  const run = async (key: string, body: { action: "mute"; identity: string } | { action: "mute-all" }, done: (n: number) => string) => {
    const session = getSession();
    if (!session || busy) return;
    setBusy(key);
    try {
      onNotice(done((await moderate(session, body)).muted));
    } catch (e) {
      onNotice(e instanceof Error ? e.message : "Could not mute. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-room-chrome="true"
      role="dialog"
      aria-label="People"
      style={{
        position: "absolute",
        top: 78,
        right: 8,
        zIndex: 14,
        width: "min(300px, calc(100% - 16px))",
        maxHeight: "calc(100% - 170px)",
        display: "flex",
        flexDirection: "column",
        borderRadius: 12,
        background: "rgba(11,16,32,0.92)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
        color: "#e2e8f0",
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <span className="text-sm font-semibold">People ({people.length + 1})</span>
        <button type="button" onClick={onClose} className="rounded p-1 text-neutral-300 hover:bg-white/10" aria-label="Close">
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="px-3 py-2">
        <button
          type="button"
          disabled={!!busy || micOn === 0}
          onClick={() => void run("all", { action: "mute-all" }, (n) => (n === 0 ? "No one else had their microphone on." : `Muted ${n} ${n === 1 ? "person" : "people"}.`))}
          className="w-full rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-40"
        >
          {busy === "all" ? "Muting…" : "Mute all"}
        </button>
        <p className="mt-1 text-[11px] leading-snug opacity-60">Leaders and hosts stay unmuted. People can unmute themselves.</p>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {people.length === 0 && <li className="px-2 py-3 text-center text-xs opacity-60">No one else is here yet.</li>}
        {people.map((p) => {
          const on = p.isMicrophoneEnabled;
          const role = roleOf(p);
          const label = p.name || "Guest";
          return (
            <li key={p.identity} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
              {on ? <Mic size={14} className="shrink-0 text-emerald-400" aria-label="Microphone on" /> : <MicOff size={14} className="shrink-0 opacity-50" aria-label="Microphone off" />}
              <span className="min-w-0 flex-1 truncate text-sm" title={label}>
                {label}
                {role === "host" && <span className="ml-1.5 text-[10px] opacity-60">host</span>}
                {role === "cohost" && <span className="ml-1.5 text-[10px] opacity-60">leader</span>}
              </span>
              {on && role !== "host" && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void run(p.identity, { action: "mute", identity: p.identity }, () => `Muted ${label}.`)}
                  className="shrink-0 rounded-md border border-white/15 px-2 py-0.5 text-xs hover:bg-white/10 disabled:opacity-40"
                >
                  {busy === p.identity ? "…" : "Mute"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
