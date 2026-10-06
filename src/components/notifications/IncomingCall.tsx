"use client";

// The incoming-call screen: a group meeting is ringing you. Shows the group,
// the meeting and who is calling, with Answer and Decline; plays a ring tone
// made with Web Audio (no audio file) and vibrates where the device can.
// Each ring goes away by itself when it expires (45 s). Several can stack.
//
// Rings arrive two ways: a push relayed by the service worker while a tab is
// open (PushRegistrar), and — for a tab that was asleep or just opened — an
// unexpired ring in the bell's list, checked on load and on focus.
//
// Mounted in the root layout. Renders nothing while nothing is ringing.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Phone, PhoneOff } from "lucide-react";
import { NOTIFICATIONS_CHANGED } from "@/lib/pushClient";
import { useModal } from "@/components/ui/useModal";

interface Ring {
  ringId: string;
  eventSlug: string;
  groupName: string;
  meetingTitle: string;
  caller: string;
  url: string;
  expiresAt: number;
  /** The bell entry, marked read once the ring is answered or declined. */
  notificationId?: string;
}

/** A two-tone phone ring: 0.4 s on, 0.2 s off, 0.4 s on, then 2 s quiet. */
function startTone(): () => void {
  const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
    | typeof AudioContext
    | undefined;
  if (!Ctx) return () => {};
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return () => {};
  }
  void ctx.resume().catch(() => undefined);
  const burst = (at: number) => {
    for (const freq of [440, 480]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.08, at + 0.02);
      gain.gain.setValueAtTime(0.08, at + 0.38);
      gain.gain.linearRampToValueAtTime(0, at + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.42);
    }
  };
  const cycle = () => {
    const t = ctx.currentTime + 0.05;
    burst(t);
    burst(t + 0.6);
    if (typeof navigator.vibrate === "function") navigator.vibrate([400, 200, 400]);
  };
  cycle();
  const id = window.setInterval(cycle, 3000);
  return () => {
    window.clearInterval(id);
    if (typeof navigator.vibrate === "function") navigator.vibrate(0);
    void ctx.close().catch(() => undefined);
  };
}

function fromPayload(p: Record<string, unknown>): Ring | null {
  if (p.type !== "ring" || typeof p.ringId !== "string" || typeof p.eventSlug !== "string") return null;
  const expiresAt = typeof p.expiresAt === "number" ? p.expiresAt : 0;
  if (expiresAt <= Date.now()) return null;
  return {
    ringId: p.ringId,
    eventSlug: p.eventSlug,
    groupName: typeof p.groupName === "string" ? p.groupName : "",
    meetingTitle: typeof p.meetingTitle === "string" ? p.meetingTitle : typeof p.title === "string" ? p.title : "",
    caller: typeof p.caller === "string" ? p.caller : "",
    url: typeof p.url === "string" && p.url.startsWith("/") ? p.url : `/${p.eventSlug}`,
    expiresAt,
    ...(typeof p.id === "string" ? { notificationId: p.id } : {}),
  };
}

export default function IncomingCall() {
  const { isLoaded, isSignedIn } = useAuth();
  const pathname = usePathname();
  const [rings, setRings] = useState<Ring[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const handled = useRef<Set<string>>(new Set());
  const answerRef = useRef<HTMLButtonElement>(null);

  const add = useCallback((r: Ring) => {
    if (handled.current.has(r.ringId)) return;
    setRings((prev) => (prev.some((x) => x.ringId === r.ringId) ? prev : [...prev, r]));
  }, []);

  const drop = useCallback((ringId: string) => {
    handled.current.add(ringId);
    setRings((prev) => prev.filter((r) => r.ringId !== ringId));
  }, []);

  // Rings that arrived while this tab was asleep, or before it opened.
  const checkList = useCallback(async () => {
    try {
      const res = await fetch("/api/me/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: Array<Record<string, unknown>> };
      for (const item of data.items) {
        if (item.read === true) continue;
        const r = fromPayload(item);
        if (r) add(r);
      }
    } catch {
      /* next focus tries again */
    }
  }, [add]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    void checkList();
    const onPush = (e: Event) => {
      const p = (e as CustomEvent).detail;
      if (p && typeof p === "object") {
        const r = fromPayload(p as Record<string, unknown>);
        if (r) add(r);
      }
    };
    const onFocus = () => void checkList();
    window.addEventListener(NOTIFICATIONS_CHANGED, onPush);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED, onPush);
      window.removeEventListener("focus", onFocus);
    };
  }, [isLoaded, isSignedIn, add, checkList]);

  // Someone already in that meeting's room is not rung into it.
  const shown = rings.filter((r) => !pathname?.startsWith(`/room/${r.eventSlug}`));

  // Expire rings on time.
  useEffect(() => {
    if (rings.length === 0) return;
    const next = Math.min(...rings.map((r) => r.expiresAt));
    const id = window.setTimeout(() => {
      const now = Date.now();
      setRings((prev) => prev.filter((r) => r.expiresAt > now));
    }, Math.max(0, next - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [rings]);

  // Ring while anything is ringing.
  const ringing = shown.length > 0;
  useEffect(() => {
    if (!ringing) return;
    const stop = startTone();
    return stop;
  }, [ringing]);

  // Keyboard: focus stays on the call while it rings; Escape declines the
  // first one. Answer gets focus, so Enter answers.
  const boxRef = useRef<HTMLDivElement>(null);
  useModal(boxRef, () => {
    if (shown[0]) void respond(shown[0], "decline");
  }, { open: ringing });
  useEffect(() => {
    if (ringing) answerRef.current?.focus();
  }, [ringing]);

  async function respond(r: Ring, action: "answer" | "decline") {
    setBusy(r.ringId);
    let roomUrl = r.url;
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(r.eventSlug)}/call-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ringId: r.ringId }),
      });
      if (res.ok) {
        const data = (await res.json()) as { roomUrl?: string };
        if (data.roomUrl) roomUrl = data.roomUrl;
      }
      if (r.notificationId) {
        void fetch("/api/me/notifications", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: [r.notificationId] }),
        }).catch(() => undefined);
      }
    } catch {
      /* answering still goes to the room; declining just closes */
    }
    drop(r.ringId);
    setBusy(null);
    if (action === "answer") window.location.assign(roomUrl);
  }

  if (!ringing) return null;

  return (
    <div
      ref={boxRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="incoming-call-title"
      className="fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-3 p-3 sm:p-4 pointer-events-none"
    >
      <div aria-live="assertive" className="sr-only">
        {shown.map((r) => `${r.caller || "Someone"} is calling you into ${r.meetingTitle}.`).join(" ")}
      </div>
      {shown.map((r, i) => (
        <div
          key={r.ringId}
          className="pointer-events-auto w-full max-w-md rounded-2xl border border-emerald-400/40 bg-[#07130f] text-slate-100 shadow-[0_20px_60px_rgba(0,0,0,0.6)] p-4"
        >
          <div className="flex items-center gap-3">
            <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-200">
              <span className="absolute inset-0 rounded-full border border-emerald-400/60 animate-ping" aria-hidden />
              <Phone className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-widest text-emerald-200/80 truncate">{r.groupName || "Group call"}</p>
              <h2 id={i === 0 ? "incoming-call-title" : undefined} className="truncate text-base font-semibold text-slate-100">
                {r.meetingTitle}
              </h2>
              <p className="truncate text-sm text-slate-300">{r.caller ? `${r.caller} is calling` : "Incoming call"}</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => respond(r, "decline")}
              disabled={busy === r.ringId}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-400 transition disabled:opacity-60"
            >
              <PhoneOff className="h-4 w-4" aria-hidden /> Decline
            </button>
            <button
              ref={i === 0 ? answerRef : undefined}
              type="button"
              onClick={() => respond(r, "answer")}
              disabled={busy === r.ringId}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 transition disabled:opacity-60"
            >
              <Phone className="h-4 w-4" aria-hidden /> Answer
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
