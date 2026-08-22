"use client";

// SpeakerBadge - in-room pill that surfaces the userÃ¢ÂÂs effective role.
// Reads `event` query param from current URL, calls /api/events/role, and renders
// a small floating badge in the top-right when the user is host/cohost/speaker.
// Renders nothing for viewers/guests to keep the UI quiet.

import { useEffect, useState } from "react";

type Role = "owner" | "host" | "cohost" | "speaker" | "viewer" | "guest";

const COLORS: Record<Role, string> = {
  owner: "bg-violet-500/25 text-violet-100 border-violet-300/60",
  host: "bg-cyan-500/20 text-cyan-100 border-cyan-300/50",
  cohost: "bg-emerald-500/20 text-emerald-100 border-emerald-300/50",
  speaker: "bg-violet-500/20 text-violet-100 border-violet-300/50",
  viewer: "bg-slate-700/40 text-slate-200 border-slate-500/40",
  guest: "bg-slate-700/40 text-slate-300 border-slate-500/40",
};

// FRS §1 display: the wire-format role from /api/events/role is still
// "host" for both Owner and Host — the response also carries isOwner so
// the client can promote a "host" wire value to the "Owner" display when
// the caller is the actual event owner. "cohost" surfaces as "Moderator".
const LABEL: Record<Role, string> = {
  owner: "Owner",
  host: "Host",
  cohost: "Moderator",
  speaker: "Speaker",
  viewer: "Viewer",
  guest: "Guest",
};

export default function SpeakerBadge() {
  const [role, setRole] = useState<Role | null>(null);
  const [preApproved, setPreApproved] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Prefer ?event= query param; fall back to /room/<slug> path so renamed
    // instant meetings (no query) still resolve a host badge.
    let slug = new URLSearchParams(window.location.search).get("event");
    if (!slug) {
      const m = window.location.pathname.match(/\/room\/([^/?#]+)/);
      if (m && m[1]) slug = decodeURIComponent(m[1]);
    }
    if (!slug) return;
    let abort = false;
    // Retry on viewer/guest a few times Ã¢ÂÂ handles Clerk session hydration race
    // and KV eventual-consistency right after instant-meeting creation.
    const delays = [0, 400, 900, 1800, 3500];
    let attempt = 0;
    const tick = () => {
      if (abort) return;
      fetch("/api/events/role?slug=" + encodeURIComponent(slug), { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (abort) return;
          if (j && typeof j.role === "string") {
            // Owner distinction: the API returns role="host" for the owner
            // (via toLegacyRole collapse) plus isOwner=true. Promote the
            // display to "Owner" when both hold.
            const promoted: Role = j.isOwner === true && j.role === "host" ? "owner" : (j.role as Role);
            setRole(promoted);
            setPreApproved(Boolean(j.preApproved));
            const isElevated = promoted === "owner" || promoted === "host" || promoted === "cohost" || promoted === "speaker";
            if (!isElevated && attempt < delays.length - 1) {
              attempt += 1;
              setTimeout(tick, delays[attempt]);
            }
          } else if (attempt < delays.length - 1) {
            attempt += 1;
            setTimeout(tick, delays[attempt]);
          }
        })
        .catch(() => {
          if (!abort && attempt < delays.length - 1) {
            attempt += 1;
            setTimeout(tick, delays[attempt]);
          }
        });
    };
    tick();
    return () => {
      abort = true;
    };
  }, []);

  // Stay quiet for viewers/guests.
  if (!role || role === "viewer" || role === "guest") return null;

  return (
    <div className="fixed top-4 right-16 sm:right-4 sm:top-4 z-40 flex items-center gap-1.5 pointer-events-none">
      <span
        className={
          "px-2.5 py-1 rounded-full border text-[11px] font-medium uppercase tracking-wider " +
          COLORS[role]
        }
      >
        {LABEL[role]}
      </span>
      {preApproved && role !== "host" && role !== "owner" ? (
        <span className="px-2 py-0.5 rounded-full border border-cyan-400/30 bg-cyan-500/10 text-cyan-200 text-[10px] uppercase tracking-wider">
          Approved
        </span>
      ) : null}
    </div>
  );
}
