"use client";

// src/components/PlatformNotice.tsx
//
// The site-wide banner set in /admin/settings. The root layout renders it
// only while the notice is in its window; this re-checks the window on the
// clock (a page left open past the end time drops it) and remembers a
// dismissal per notice id, so editing the notice shows it again.

import { useEffect, useState } from "react";
import type { PlatformNotice as Notice } from "@/lib/platform/model";

const STYLES: Record<Notice["level"], string> = {
  info: "border-cyan-400/30 bg-cyan-500/15 text-cyan-50",
  warning: "border-amber-400/40 bg-amber-500/20 text-amber-50",
  critical: "border-red-500/50 bg-red-600/30 text-red-50",
};

const ICON: Record<Notice["level"], string> = { info: "ℹ", warning: "⚠", critical: "⛔" };

export default function PlatformNotice({ notice }: { notice: Notice }) {
  const storageKey = `neo_notice_dismissed_${notice.id}`;
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      if (notice.dismissible && window.localStorage.getItem(storageKey) === "1") setHidden(true);
    } catch {
      /* storage blocked: the notice stays */
    }
    if (!notice.endsAt) return;
    const ms = notice.endsAt - Date.now();
    if (ms <= 0) return setHidden(true);
    // Timers longer than ~24 days overflow; such a page will be reloaded first.
    if (ms > 2_000_000_000) return;
    const t = window.setTimeout(() => setHidden(true), ms);
    return () => window.clearTimeout(t);
  }, [notice.dismissible, notice.endsAt, storageKey]);

  if (hidden) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(storageKey, "1");
    } catch {
      /* fine: hidden for this page view */
    }
  };

  return (
    <div
      role={notice.level === "critical" ? "alert" : "status"}
      data-platform-notice={notice.level}
      className={`relative z-50 border-b px-4 py-2 text-sm ${STYLES[notice.level]}`}
    >
      <div className="mx-auto flex max-w-7xl items-start gap-3">
        <span aria-hidden="true">{ICON[notice.level]}</span>
        <p className="min-w-0 flex-1 leading-snug">
          {notice.message}
          {notice.linkUrl && (
            <>
              {" "}
              <a href={notice.linkUrl} className="font-medium underline underline-offset-2" rel="noopener noreferrer">
                {notice.linkLabel || "Learn more"}
              </a>
            </>
          )}
        </p>
        {notice.dismissible && (
          <button type="button" onClick={dismiss} aria-label="Dismiss notice" className="shrink-0 rounded px-1.5 opacity-80 hover:bg-white/10 hover:opacity-100">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
